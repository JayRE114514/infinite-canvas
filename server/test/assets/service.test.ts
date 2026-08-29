import type { AssetKind } from "@infinite-canvas/contracts";
import { describe, expect, it } from "vitest";

import type { AppTransaction } from "../../src/infrastructure/database/types.js";
import { getReadyAssets } from "../../src/modules/assets/service.js";

const workspaceId = "workspace-1";
const imageId = "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192";
const videoId = "7f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708193";

function transactionReturning(rows: object[]): AppTransaction {
    return {
        select: () => ({ from: () => ({ where: async () => rows }) }),
    } as unknown as AppTransaction;
}

function row(id: string, kind: AssetKind, status = "ready") {
    return {
        id,
        workspaceId,
        kind,
        status,
        fileName: `${kind}.bin`,
        contentType: `${kind}/test`,
        byteSize: 12,
        finalObjectKey: `assets/final/${id}`,
        stagingObjectKey: null,
        etag: "etag",
        createdBy: "user-1",
        createdAt: new Date("2026-08-29T10:00:00.000Z"),
        updatedAt: new Date("2026-08-29T10:00:00.000Z"),
    };
}

describe("getReadyAssets", () => {
    it("returns ready internal object bindings in requested order", async () => {
        const ready = await getReadyAssets(transactionReturning([row(videoId, "video"), row(imageId, "image")]), workspaceId, [
            { assetId: imageId, kind: "image" },
            { assetId: videoId, kind: "video" },
        ]);

        expect(ready).toEqual([
            { id: imageId, kind: "image", key: `assets/final/${imageId}`, contentType: "image/test", byteSize: 12 },
            { id: videoId, kind: "video", key: `assets/final/${videoId}`, contentType: "video/test", byteSize: 12 },
        ]);
    });

    it("hides missing and cross-workspace records", async () => {
        await expect(
            getReadyAssets(transactionReturning([]), workspaceId, [{ assetId: imageId, kind: "image" }]),
        ).rejects.toMatchObject({ code: "asset_not_found", statusCode: 404 });
    });

    it("distinguishes kind mismatches from non-ready assets", async () => {
        await expect(
            getReadyAssets(transactionReturning([row(imageId, "image")]), workspaceId, [{ assetId: imageId, kind: "video" }]),
        ).rejects.toMatchObject({ code: "asset_kind_mismatch", statusCode: 422 });
        await expect(
            getReadyAssets(transactionReturning([row(imageId, "image", "staging")]), workspaceId, [
                { assetId: imageId, kind: "image" },
            ]),
        ).rejects.toMatchObject({ code: "asset_not_ready", statusCode: 409 });
    });
});
