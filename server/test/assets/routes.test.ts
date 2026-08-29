import { randomUUID } from "node:crypto";

import type { Asset } from "@infinite-canvas/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    ObjectStorageVerificationError,
    type ObjectStorage,
    type StoredObject,
} from "../../src/infrastructure/object-storage/types.js";
import type { AuthApp, VerifiedUser } from "../helpers/auth.js";
import { createAuthTestHarness, registerVerifiedUser } from "../helpers/auth.js";

const harness = createAuthTestHarness();

class FakeStorage implements ObjectStorage {
    uploads = 0;
    completions = 0;
    reads = 0;
    failCompletion = false;
    beforeCall: () => Promise<void> = async () => {};

    async createUpload(input: { stagingKey: string; contentType: string; expiresInSeconds: number }) {
        await this.beforeCall();
        this.uploads += 1;
        expect(input.expiresInSeconds).toBe(300);
        return {
            url: `https://storage.test/upload/${this.uploads}`,
            headers: { "content-type": input.contentType },
        };
    }

    async completeUpload(input: { stagingKey: string; finalKey: string; expectedContentType: string }): Promise<StoredObject> {
        await this.beforeCall();
        this.completions += 1;
        expect(input.stagingKey).not.toBe(input.finalKey);
        if (this.failCompletion) throw new ObjectStorageVerificationError();
        return { key: input.finalKey, contentType: input.expectedContentType, byteSize: 123, etag: "verified-etag" };
    }

    async createReadUrl(input: { key: string; expiresInSeconds: number }) {
        await this.beforeCall();
        this.reads += 1;
        expect(input.expiresInSeconds).toBe(300);
        return `https://storage.test/read/${this.reads}`;
    }

    async putResult(input: { key: string; contentType: string; bytes: Uint8Array }): Promise<StoredObject> {
        await this.beforeCall();
        return { key: input.key, contentType: input.contentType, byteSize: input.bytes.byteLength };
    }
}

async function createTeam(app: AuthApp, owner: VerifiedUser, label: string) {
    const response = await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: { cookie: owner.cookie },
        payload: { name: label, slug: `${label}-${randomUUID().slice(0, 8)}`.toLowerCase() },
    });
    expect(response.statusCode).toBe(201);
    return response.json().workspace as { id: string };
}

function createAsset(app: AuthApp, user: VerifiedUser, workspaceId: string) {
    return app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/assets`,
        headers: { cookie: user.cookie },
        payload: { kind: "image", fileName: "reference.png", contentType: "image/png" },
    });
}

beforeAll(async () => {
    await harness.start();
}, 180_000);

afterEach(async () => {
    await harness.cleanup();
}, 30_000);

afterAll(async () => {
    await harness.stop();
}, 60_000);

describe("asset routes", () => {
    it("creates, completes idempotently, and issues a fresh display URL outside database transactions", async () => {
        const storage = new FakeStorage();
        const { app, mailer, adminPool } = await harness.openAuthApp({}, { objectStorage: storage });
        storage.beforeCall = async () => {
            const active = await adminPool.query<{ count: number }>(`
                select count(*)::int as count from pg_stat_activity
                where usename = 'app_api' and state <> 'idle' and xact_start is not null
            `);
            expect(active.rows[0]?.count).toBe(0);
        };
        const owner = await registerVerifiedUser(app, mailer, { name: "owner", email: "asset-owner@example.com" });
        const workspace = await createTeam(app, owner, "asset-team");

        const created = await createAsset(app, owner, workspace.id);
        expect(created.statusCode).toBe(201);
        expect(created.json()).toMatchObject({
            asset: { workspaceId: workspace.id, kind: "image", status: "staging", byteSize: null },
            upload: { url: "https://storage.test/upload/1", headers: { "content-type": "image/png" } },
        });
        const asset = created.json().asset as Asset;
        expect(Object.keys(created.json())).toEqual(["asset", "upload"]);
        expect(JSON.stringify(created.json())).not.toMatch(/objectKey|stagingKey|finalKey|storageKey/);

        const completed = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/assets/${asset.id}/complete`,
            headers: { cookie: owner.cookie },
        });
        const duplicate = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/assets/${asset.id}/complete`,
            headers: { cookie: owner.cookie },
        });
        expect(completed.statusCode).toBe(200);
        expect(completed.json().asset).toMatchObject({ id: asset.id, status: "ready", byteSize: 123 });
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json()).toEqual(completed.json());
        expect(storage.completions).toBe(1);

        const firstRead = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/assets/${asset.id}`,
            headers: { cookie: owner.cookie },
        });
        const secondRead = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/assets/${asset.id}`,
            headers: { cookie: owner.cookie },
        });
        expect(firstRead.statusCode).toBe(200);
        expect(firstRead.json().displayUrl).toBe("https://storage.test/read/1");
        expect(secondRead.json().displayUrl).toBe("https://storage.test/read/2");
        expect(firstRead.json().asset).toEqual(completed.json().asset);
    }, 90_000);

    it("marks a verified completion failure terminal and never returns a display URL", async () => {
        const storage = new FakeStorage();
        storage.failCompletion = true;
        const { app, mailer, adminPool } = await harness.openAuthApp({}, { objectStorage: storage });
        const owner = await registerVerifiedUser(app, mailer, { name: "owner", email: "failed-asset@example.com" });
        const workspace = await createTeam(app, owner, "failed-asset-team");
        const created = await createAsset(app, owner, workspace.id);
        const asset = created.json().asset as Asset;

        const failed = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/assets/${asset.id}/complete`,
            headers: { cookie: owner.cookie },
        });
        const read = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/assets/${asset.id}`,
            headers: { cookie: owner.cookie },
        });
        const stored = await adminPool.query("select status, byte_size from public.assets where id = $1", [asset.id]);

        expect(failed.statusCode).toBe(422);
        expect(failed.json().error.code).toBe("asset_upload_verification_failed");
        expect(stored.rows).toEqual([{ status: "failed", byte_size: null }]);
        expect(read.statusCode).toBe(409);
        expect(read.json().error.code).toBe("asset_not_ready");
        expect(storage.reads).toBe(0);
    }, 90_000);

    it("denies non-members, hides cross-tenant ids, and installs forced RLS with narrow grants", async () => {
        const storage = new FakeStorage();
        const { app, mailer, adminPool } = await harness.openAuthApp({}, { objectStorage: storage });
        const owner = await registerVerifiedUser(app, mailer, { name: "owner", email: "asset-rls@example.com" });
        const outsider = await registerVerifiedUser(app, mailer, { name: "outsider", email: "asset-outsider@example.com" });
        const first = await createTeam(app, owner, "asset-first");
        const second = await createTeam(app, owner, "asset-second");
        const created = await createAsset(app, owner, first.id);
        const asset = created.json().asset as Asset;

        const forbidden = await createAsset(app, outsider, first.id);
        const cross = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${second.id}/assets/${asset.id}`,
            headers: { cookie: owner.cookie },
        });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json().error.code).toBe("workspace_forbidden");
        expect(cross.statusCode).toBe(404);
        expect(cross.json().error.code).toBe("asset_not_found");

        const rls = await adminPool.query(`
            select relrowsecurity, relforcerowsecurity from pg_class
            where oid = 'public.assets'::regclass
        `);
        expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

        const grants = await adminPool.query<{ grantee: string; privilege_type: string }>(`
            select grantee, privilege_type from information_schema.role_table_grants
            where table_schema = 'public' and table_name = 'assets'
            order by grantee, privilege_type
        `);
        expect(grants.rows).toEqual([
            { grantee: "app_api", privilege_type: "INSERT" },
            { grantee: "app_api", privilege_type: "SELECT" },
        ]);
        const updateColumns = await adminPool.query<{ column_name: string }>(`
            select column_name from information_schema.role_column_grants
            where table_schema = 'public' and table_name = 'assets'
              and grantee = 'app_api' and privilege_type = 'UPDATE'
            order by column_name
        `);
        expect(updateColumns.rows.map((row) => row.column_name)).toEqual([
            "byte_size",
            "etag",
            "staging_object_key",
            "status",
            "updated_at",
        ]);
    }, 90_000);

    it("returns a stable 503 when COS storage is not configured", async () => {
        const { app, mailer } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "owner", email: "asset-no-cos@example.com" });
        const workspace = await createTeam(app, owner, "asset-no-cos");

        const response = await createAsset(app, owner, workspace.id);
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe("asset_storage_configuration_error");
    }, 90_000);
});
