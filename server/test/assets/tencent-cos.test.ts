import { createHash } from "node:crypto";

import COS from "cos-nodejs-sdk-v5";
import { describe, expect, it } from "vitest";

import { createTencentCosStorage } from "../../src/infrastructure/object-storage/tencent-cos.js";
import { ObjectStorageVerificationError } from "../../src/infrastructure/object-storage/types.js";

const config = {
    secretId: "secret-id",
    secretKey: "secret-key",
    bucket: "assets-1250000000",
    region: "ap-guangzhou",
    signedUrlTtlSeconds: 300,
};

function fakeClient() {
    const calls: { method: string; input: Record<string, unknown> }[] = [];
    const heads: Array<COS.HeadObjectResult | Error> = [
        { ETag: "staging-etag", headers: { "content-type": "image/png", "content-length": "12" } },
        { ETag: "final-etag", headers: { "Content-Type": "image/png", "Content-Length": 12 } },
    ];
    let signedUrlResult: Partial<COS.GetObjectUrlResult> = { Url: "https://signed.example/object" };
    let signedUrlError: Error | undefined;
    let copyError: Error | undefined;
    let putError: Error | undefined;
    const client = {
        getObjectUrl(
            input: Record<string, unknown>,
            callback: (err: COS.CosError, data: COS.GetObjectUrlResult) => void,
        ) {
            calls.push({ method: "getObjectUrl", input });
            const error = signedUrlError
                ? ({
                      code: "TestError",
                      message: signedUrlError.message,
                      error: signedUrlError,
                      url: "",
                      method: "GET",
                  } as COS.CosSdkError)
                : null;
            callback(error, signedUrlResult as COS.GetObjectUrlResult);
            return undefined as unknown as string;
        },
        async headObject(input: Record<string, unknown>) {
            calls.push({ method: "headObject", input });
            const result = heads.shift();
            if (!result) throw new Error("missing fake HEAD result");
            if (result instanceof Error) throw result;
            return result;
        },
        async putObjectCopy(input: Record<string, unknown>) {
            calls.push({ method: "putObjectCopy", input });
            if (copyError) throw copyError;
            return {};
        },
        async deleteObject(input: Record<string, unknown>) {
            calls.push({ method: "deleteObject", input });
            return {};
        },
        async putObject(input: Record<string, unknown>) {
            calls.push({ method: "putObject", input });
            if (putError) throw putError;
            return {};
        },
    };
    return {
        calls,
        heads,
        client: client as unknown as COS,
        setSignedUrlResult(result: Partial<COS.GetObjectUrlResult>) {
            signedUrlResult = result;
        },
        setSignedUrlError(error: Error) {
            signedUrlError = error;
        },
        setCopyError(error: Error) {
            copyError = error;
        },
        setPutError(error: Error) {
            putError = error;
        },
    };
}

function missingObject() {
    return Object.assign(new Error("not found"), { statusCode: 404, code: "NoSuchKey" });
}

function resultHead(bytes: Uint8Array, contentType = "video/mp4", ownerId = "generation-1"): COS.HeadObjectResult {
    return {
        ETag: "result-etag",
        headers: {
            "content-type": contentType,
            "content-length": String(bytes.byteLength),
            "x-cos-meta-sha256": createHash("sha256").update(bytes).digest("hex"),
            "x-cos-meta-result-owner": ownerId,
        },
    };
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

    it("reconciles a verified final object when copy succeeded but its response failed", async () => {
        const fake = fakeClient();
        fake.setCopyError(new Error("socket reset after remote copy"));
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.completeUpload({ stagingKey: "staging", finalKey: "final", expectedContentType: "image/png" }),
        ).resolves.toMatchObject({ key: "final", contentType: "image/png", byteSize: 12 });
        expect(fake.calls.map((call) => call.method)).toEqual([
            "headObject",
            "putObjectCopy",
            "headObject",
            "deleteObject",
        ]);
    });

    it("reconciles final metadata when a concurrent caller already deleted staging", async () => {
        const fake = fakeClient();
        const missing = Object.assign(new Error("not found"), { statusCode: 404, code: "NoSuchKey" });
        fake.heads.splice(
            0,
            2,
            missing,
            { ETag: "final-etag", headers: { "content-type": "image/png", "content-length": "12" } },
        );
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.completeUpload({ stagingKey: "staging", finalKey: "final", expectedContentType: "image/png" }),
        ).resolves.toMatchObject({ key: "final", byteSize: 12 });
        expect(fake.calls.map((call) => call.method)).toEqual(["headObject", "headObject", "deleteObject"]);
    });

    it("rejects signed-URL callback errors without exposing a URL", async () => {
        const fake = fakeClient();
        fake.setSignedUrlError(new Error("Region format error."));
        const storage = createTencentCosStorage(config, fake.client);

        await expect(storage.createReadUrl({ key: "private-key", expiresInSeconds: 300 })).rejects.toThrow(
            "COS signed URL creation failed",
        );
    });

    it.each([
        [{}, "missing URL"],
        [{ Url: "http://signed.example/object" }, "non-HTTPS URL"],
    ])("rejects a signed-URL callback with %s", async (result, _label) => {
        const fake = fakeClient();
        fake.setSignedUrlResult(result);
        const storage = createTencentCosStorage(config, fake.client);

        await expect(storage.createReadUrl({ key: "private-key", expiresInSeconds: 300 })).rejects.toThrow(
            "COS signed URL creation failed",
        );
    });

    it("verifies putResult and signs fresh reads", async () => {
        const fake = fakeClient();
        const bytes = new Uint8Array([1, 2, 3]);
        fake.heads.splice(0, 2, missingObject(), resultHead(bytes));
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.putResult({ key: "result", ownerId: "generation-1", contentType: "video/mp4", bytes }),
        ).resolves.toEqual({
            key: "result",
            contentType: "video/mp4",
            byteSize: 3,
            etag: "result-etag",
        });
        await expect(storage.createReadUrl({ key: "result", expiresInSeconds: 300 })).resolves.toBe(
            "https://signed.example/object",
        );
        expect(fake.calls.map((call) => call.method)).toEqual(["headObject", "putObject", "headObject", "getObjectUrl"]);
        expect(fake.calls[1]).toMatchObject({
            method: "putObject",
            input: {
                Key: "result",
                ContentLength: 3,
                ContentType: "video/mp4",
                Headers: {
                    "If-None-Match": "*",
                    "x-cos-forbid-overwrite": "true",
                    "x-cos-meta-sha256": createHash("sha256").update(bytes).digest("hex"),
                    "x-cos-meta-result-owner": "generation-1",
                },
            },
        });
        expect(fake.calls.at(-1)).toMatchObject({
            method: "getObjectUrl",
            input: { Key: "result", Method: "GET", Expires: 300 },
        });
    });

    it("reuses the authoritative object for an identical result replay without another PUT", async () => {
        const fake = fakeClient();
        const bytes = new Uint8Array([1, 2, 3]);
        fake.heads.splice(0, 2, resultHead(bytes));
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.putResult({ key: "result", ownerId: "generation-1", contentType: "video/mp4", bytes }),
        ).resolves.toMatchObject({
            key: "result",
            contentType: "video/mp4",
            byteSize: 3,
        });
        expect(fake.calls.map((call) => call.method)).toEqual(["headObject"]);
    });

    it("keeps the first trustworthy result authoritative when a later download differs", async () => {
        const fake = fakeClient();
        const bytes = new Uint8Array([1, 2, 3]);
        fake.heads.splice(0, 2, resultHead(new Uint8Array([9, 9, 9, 9]), "video/webm"));
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.putResult({ key: "result", ownerId: "generation-1", contentType: "video/mp4", bytes }),
        ).resolves.toMatchObject({ key: "result", contentType: "video/webm", byteSize: 4 });
        expect(fake.calls.map((call) => call.method)).toEqual(["headObject"]);
    });

    it.each([
        [{ "x-cos-meta-sha256": undefined }, "missing digest"],
        [{ "x-cos-meta-result-owner": "another-generation" }, "wrong owner"],
        [{ "content-type": "image/png" }, "non-video content"],
        [{ "x-cos-meta-sha256": "not-a-digest" }, "invalid digest"],
        [{ "content-length": "-1" }, "invalid byte size"],
    ])("rejects an existing result with untrusted metadata: %s", async (changes, _label) => {
        const fake = fakeClient();
        const bytes = new Uint8Array([1, 2, 3]);
        const existing = resultHead(bytes);
        existing.headers = { ...existing.headers, ...changes };
        fake.heads.splice(0, 2, existing);
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.putResult({ key: "result", ownerId: "generation-1", contentType: "video/mp4", bytes }),
        ).rejects.toBeInstanceOf(ObjectStorageVerificationError);
        expect(fake.calls.map((call) => call.method)).toEqual(["headObject"]);
    });

    it.each([
        [409, "FileAlreadyExists", "official COS create-once conflict"],
        [412, "PreconditionFailed", "HTTP precondition conflict"],
        [undefined, undefined, "lost PUT response"],
    ])("reconciles the authoritative object after %s/%s (%s)", async (statusCode, code, _label) => {
        const fake = fakeClient();
        const bytes = new Uint8Array([1, 2, 3]);
        fake.heads.splice(0, 2, missingObject(), resultHead(bytes));
        fake.setPutError(Object.assign(new Error("conditional PUT did not return success"), { statusCode, code }));
        const storage = createTencentCosStorage(config, fake.client);

        await expect(
            storage.putResult({ key: "result", ownerId: "generation-1", contentType: "video/mp4", bytes }),
        ).resolves.toMatchObject({
            key: "result",
            byteSize: 3,
        });
        expect(fake.calls.map((call) => call.method)).toEqual(["headObject", "putObject", "headObject"]);
    });
});
