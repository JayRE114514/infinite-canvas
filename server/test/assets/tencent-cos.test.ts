import COS from "cos-nodejs-sdk-v5";
import { describe, expect, it } from "vitest";

import { createTencentCosStorage } from "../../src/infrastructure/object-storage/tencent-cos.js";

const config = {
    secretId: "secret-id",
    secretKey: "secret-key",
    bucket: "assets-1250000000",
    region: "ap-guangzhou",
    signedUrlTtlSeconds: 300,
};

function fakeClient() {
    const calls: { method: string; input: Record<string, unknown> }[] = [];
    const heads = [
        { ETag: "staging-etag", headers: { "content-type": "image/png", "content-length": "12" } },
        { ETag: "final-etag", headers: { "Content-Type": "image/png", "Content-Length": 12 } },
    ];
    const client = {
        getObjectUrl(input: Record<string, unknown>) {
            calls.push({ method: "getObjectUrl", input });
            return "https://signed.example/object";
        },
        async headObject(input: Record<string, unknown>) {
            calls.push({ method: "headObject", input });
            const result = heads.shift();
            if (!result) throw new Error("missing fake HEAD result");
            return result;
        },
        async putObjectCopy(input: Record<string, unknown>) {
            calls.push({ method: "putObjectCopy", input });
            return {};
        },
        async deleteObject(input: Record<string, unknown>) {
            calls.push({ method: "deleteObject", input });
            return {};
        },
        async putObject(input: Record<string, unknown>) {
            calls.push({ method: "putObject", input });
            return {};
        },
    };
    return { calls, heads, client: client as unknown as COS };
}

describe("Tencent COS storage", () => {
    it("signs uploads with the exact configured expiry and content type header", async () => {
        const fake = fakeClient();
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.createUpload({ stagingKey: "assets/staging/id/upload", contentType: "image/png", expiresInSeconds: 300 }),
        ).resolves.toEqual({
            url: "https://signed.example/object",
            headers: { "content-type": "image/png" },
        });
        expect(fake.calls).toEqual([
            {
                method: "getObjectUrl",
                input: expect.objectContaining({
                    Key: "assets/staging/id/upload",
                    Method: "PUT",
                    Expires: 300,
                    Headers: { "content-type": "image/png" },
                    Sign: true,
                    Protocol: "https:",
                }),
            },
        ]);
    });

    it("HEAD-checks staging, copies to a distinct final key, verifies it, then deletes only staging", async () => {
        const fake = fakeClient();
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.completeUpload({
                stagingKey: "assets/staging/id/源.png",
                finalKey: "assets/final/id/object",
                expectedContentType: "image/png",
            }),
        ).resolves.toEqual({
            key: "assets/final/id/object",
            contentType: "image/png",
            byteSize: 12,
            etag: "final-etag",
        });
        expect(fake.calls.map((call) => call.method)).toEqual(["headObject", "putObjectCopy", "headObject", "deleteObject"]);
        expect(fake.calls[1]?.input).toMatchObject({
            Key: "assets/final/id/object",
            CopySource: "assets-1250000000.cos.ap-guangzhou.myqcloud.com/assets/staging/id/%E6%BA%90.png",
            MetadataDirective: "Copy",
        });
        expect(fake.calls[3]?.input).toMatchObject({ Key: "assets/staging/id/源.png" });
    });

    it("keeps staging when final verification fails", async () => {
        const fake = fakeClient();
        fake.heads[1] = { ETag: "wrong", headers: { "content-type": "image/png", "content-length": "11" } };
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.completeUpload({ stagingKey: "staging", finalKey: "final", expectedContentType: "image/png" }),
        ).rejects.toThrow("verification");
        expect(fake.calls.map((call) => call.method)).toEqual(["headObject", "putObjectCopy", "headObject"]);
    });

    it("verifies putResult and signs fresh reads", async () => {
        const fake = fakeClient();
        fake.heads.splice(0, 2, { ETag: "result-etag", headers: { "content-type": "video/mp4", "content-length": "3" } });
        const storage = createTencentCosStorage(config, fake.client);

        await expect(storage.putResult({ key: "result", contentType: "video/mp4", bytes: new Uint8Array([1, 2, 3]) })).resolves.toEqual({
            key: "result",
            contentType: "video/mp4",
            byteSize: 3,
            etag: "result-etag",
        });
        await expect(storage.createReadUrl({ key: "result", expiresInSeconds: 300 })).resolves.toBe(
            "https://signed.example/object",
        );
        expect(fake.calls[0]).toMatchObject({ method: "putObject", input: { Key: "result", ContentLength: 3, ContentType: "video/mp4" } });
        expect(fake.calls.at(-1)).toMatchObject({ method: "getObjectUrl", input: { Key: "result", Method: "GET", Expires: 300 } });
    });
});
