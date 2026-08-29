import {
    AssetPathSchema,
    AssetSchema,
    CompleteAssetResponseSchema,
    CreateAssetBodySchema,
    CreateAssetResponseSchema,
    ReadAssetResponseSchema,
} from "@infinite-canvas/contracts";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

const assetId = "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192";
const timestamp = "2026-08-29T10:00:00.000Z";
const asset = {
    id: assetId,
    workspaceId: "workspace-opaque-id",
    kind: "image" as const,
    status: "staging" as const,
    fileName: "reference.png",
    contentType: "image/png",
    byteSize: null,
    createdAt: timestamp,
    updatedAt: timestamp,
};

describe("asset contracts", () => {
    it("requires UUID asset ids in records and paths", () => {
        expect(Value.Check(AssetSchema, asset)).toBe(true);
        expect(Value.Check(AssetSchema, { ...asset, id: "asset-1" })).toBe(false);
        expect(Value.Check(AssetPathSchema, { workspaceId: asset.workspaceId, assetId })).toBe(true);
        expect(Value.Check(AssetPathSchema, { workspaceId: asset.workspaceId, assetId: "asset-1" })).toBe(false);
    });

    it.each(["image", "video", "audio"] as const)("accepts the %s kind", (kind) => {
        expect(Value.Check(CreateAssetBodySchema, { kind, fileName: "media.bin", contentType: "application/octet-stream" })).toBe(true);
    });

    it("rejects unsupported kinds and unknown create fields", () => {
        expect(Value.Check(CreateAssetBodySchema, { kind: "document", fileName: "file.pdf", contentType: "application/pdf" })).toBe(false);
        expect(Value.Check(CreateAssetBodySchema, { kind: "image", fileName: "a.png", contentType: "image/png", byteSize: 1 })).toBe(false);
    });

    it("keeps object keys out of every response contract", () => {
        const upload = { url: "https://cos.example/upload", headers: { "content-type": "image/png" } };
        expect(Value.Check(CreateAssetResponseSchema, { asset, upload })).toBe(true);
        expect(Value.Check(CompleteAssetResponseSchema, { asset: { ...asset, status: "ready", byteSize: 12 } })).toBe(true);
        expect(Value.Check(ReadAssetResponseSchema, { asset: { ...asset, status: "ready", byteSize: 12 }, displayUrl: "https://cos.example/read" })).toBe(true);

        for (const key of ["objectKey", "stagingKey", "finalKey", "storageKey"]) {
            expect(Value.Check(CreateAssetResponseSchema, { asset: { ...asset, [key]: "secret" }, upload })).toBe(false);
            expect(Value.Check(CreateAssetResponseSchema, { asset, upload, [key]: "secret" })).toBe(false);
            expect(Value.Check(CompleteAssetResponseSchema, { asset, [key]: "secret" })).toBe(false);
            expect(Value.Check(ReadAssetResponseSchema, { asset, displayUrl: "https://cos.example/read", [key]: "secret" })).toBe(false);
        }
    });
});
