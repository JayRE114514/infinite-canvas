import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/infrastructure/database/client.js";
import { withTenantTransaction, withWorkerTransaction } from "../../src/infrastructure/database/transactions.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { MemoryObjectStoreAdapter } from "../../src/modules/assets/object-store.js";
import { AssetModule } from "../../src/modules/assets/service.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
);

let postgres: StartedRoleDatabase | undefined;
let api: DatabaseHandle | undefined;
let worker: DatabaseHandle | undefined;
let admin: Pool | undefined;
let userId = "";
let workspaceId = "";

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
    api = createDatabase({ url: postgres.api, poolMax: 2, expectedRole: "app_api" });
    worker = createDatabase({ url: postgres.worker, poolMax: 2, expectedRole: "app_worker" });
    admin = new Pool({ connectionString: postgres.admin, max: 2 });
    userId = randomUUID();
    workspaceId = randomUUID();
    await admin.query("begin");
    try {
        await admin.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            userId,
            "asset owner",
            `asset-${userId}@example.com`,
        ]);
        await admin.query(
            "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, 'Assets', $2, 'team', $3, 'active')",
            [workspaceId, `assets-${workspaceId}`, userId],
        );
        await admin.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
            [randomUUID(), workspaceId, userId],
        );
        await admin.query("commit");
    } catch (error) {
        await admin.query("rollback").catch(() => {});
        throw error;
    }
}, 180_000);

afterAll(async () => {
    await api?.pool.end().catch(() => {});
    await worker?.pool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await postgres?.stop().catch(() => {});
}, 60_000);

describe("Asset Module", () => {
    it("keeps an immutable object key and exposes output only after stored bytes are verified and ready", async () => {
        const objectStore = new MemoryObjectStoreAdapter();
        const assets = new AssetModule(worker!.db, objectStore);
        const create = (displayName: string) =>
            withWorkerTransaction(
                worker!.db,
                { workspaceId, verify: async () => ({ workspaceId }) },
                (tx) => assets.createStagingAsset(tx, { workspaceId, displayName }),
            );

        const { assetId } = await create("result.png");
        const before = await admin!.query("select status, object_key from public.assets where id = $1", [assetId]);
        await assets.storeAndVerifyOutput({ workspaceId, assetId, output: { bytes: PNG_1X1, mediaType: "image/png" } });
        await assets.storeAndVerifyOutput({ workspaceId, assetId, output: { bytes: PNG_1X1, mediaType: "image/png" } });
        const ready = await withTenantTransaction(api!.db, { userId, workspaceId }, (tx) =>
            assets.getReadyAsset(tx, { workspaceId, assetId }),
        );
        const after = await admin!.query("select status, object_key from public.assets where id = $1", [assetId]);

        expect(ready).toMatchObject({ assetId, mediaType: "image/png", byteSize: BigInt(PNG_1X1.byteLength) });
        expect(after.rows).toEqual([{ status: "ready", object_key: before.rows[0]!.object_key }]);
        const content = await new AssetModule(api!.db, objectStore).openReadyAssetContent({
            userId,
            assetId,
            signal: new AbortController().signal,
        });
        const chunks: Buffer[] = [];
        for await (const chunk of content.stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(PNG_1X1);
        expect(content).toMatchObject({ mediaType: "image/png", byteSize: BigInt(PNG_1X1.byteLength), sha256: ready.sha256 });

        const invalid = await create("invalid.png");
        await expect(
            assets.storeAndVerifyOutput({
                workspaceId,
                assetId: invalid.assetId,
                output: { bytes: new TextEncoder().encode("not an image"), mediaType: "image/png" },
            }),
        ).rejects.toThrow("media type mismatch");
        await expect(
            withTenantTransaction(api!.db, { userId, workspaceId }, (tx) =>
                assets.getReadyAsset(tx, { workspaceId, assetId: invalid.assetId }),
            ),
        ).rejects.toMatchObject({ code: "asset_not_ready" });
        expect((await admin!.query("select status from public.assets where id = $1", [invalid.assetId])).rows).toEqual([
            { status: "failed" },
        ]);
        await expect(
            new AssetModule(api!.db, objectStore).openReadyAssetContent({
                userId,
                assetId: invalid.assetId,
                signal: new AbortController().signal,
            }),
        ).rejects.toMatchObject({ code: "asset_not_ready", statusCode: 409 });

        const unavailableStore = {
            putIfAbsent: objectStore.putIfAbsent.bind(objectStore),
            get: objectStore.get.bind(objectStore),
            open: async () => { throw new Error("internal endpoint and object key must stay hidden"); },
        };
        await expect(
            new AssetModule(api!.db, unavailableStore).openReadyAssetContent({
                userId,
                assetId,
                signal: new AbortController().signal,
            }),
        ).rejects.toMatchObject({ code: "asset_content_unavailable", statusCode: 503 });
    }, 90_000);
});
