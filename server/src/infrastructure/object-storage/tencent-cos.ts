import { createHash } from "node:crypto";

import COS from "cos-nodejs-sdk-v5";

import type { TencentCosConfig } from "../../config.js";
import { ObjectStorageVerificationError, type ObjectStorage, type StoredObject } from "./types.js";

type CosObjectMetadata = {
    contentType: string;
    byteSize: number;
    etag?: string;
    sha256?: string;
    resultOwner?: string;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function header(headers: COS.Headers | undefined, name: string): unknown {
    if (!headers) return undefined;
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    return entry?.[1];
}

function metadata(data: COS.HeadObjectResult): CosObjectMetadata {
    const contentType = header(data.headers, "content-type");
    const rawByteSize = header(data.headers, "content-length");
    const byteSize = typeof rawByteSize === "number" ? rawByteSize : Number(rawByteSize);
    if (typeof contentType !== "string" || !Number.isSafeInteger(byteSize) || byteSize < 0) {
        throw new ObjectStorageVerificationError();
    }
    const sha256 = header(data.headers, "x-cos-meta-sha256");
    const resultOwner = header(data.headers, "x-cos-meta-result-owner");
    return {
        contentType,
        byteSize,
        ...(data.ETag ? { etag: data.ETag } : {}),
        ...(typeof sha256 === "string" ? { sha256 } : {}),
        ...(typeof resultOwner === "string" ? { resultOwner } : {}),
    };
}

function assertMetadata(
    actual: CosObjectMetadata,
    expectedContentType: string,
    expectedByteSize?: number,
    expectedSha256?: string,
    expectedOwner?: string,
): void {
    if (
        actual.contentType !== expectedContentType ||
        (expectedByteSize !== undefined && actual.byteSize !== expectedByteSize) ||
        (expectedSha256 !== undefined && actual.sha256 !== expectedSha256) ||
        (expectedOwner !== undefined && actual.resultOwner !== expectedOwner)
    ) {
        throw new ObjectStorageVerificationError();
    }
}

function assertAuthoritativeResult(actual: CosObjectMetadata, ownerId: string): void {
    if (
        !actual.contentType.startsWith("video/") ||
        !actual.sha256 ||
        !SHA256_PATTERN.test(actual.sha256) ||
        actual.resultOwner !== ownerId
    ) {
        throw new ObjectStorageVerificationError();
    }
}

function encodeCopySource(bucket: string, region: string, key: string): string {
    return `${bucket}.cos.${region}.myqcloud.com/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function isNotFound(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { statusCode?: unknown; code?: unknown };
    return candidate.statusCode === 404 || candidate.code === "NoSuchKey" || candidate.code === "NotFound";
}

export function createTencentCosStorage(
    config: TencentCosConfig,
    client = new COS({ SecretId: config.secretId, SecretKey: config.secretKey }),
): ObjectStorage {
    const object = (Key: string) => ({ Bucket: config.bucket, Region: config.region, Key });
    const storedObject = (key: string, found: CosObjectMetadata): StoredObject => ({
        key,
        contentType: found.contentType,
        byteSize: found.byteSize,
        ...(found.etag ? { etag: found.etag } : {}),
    });
    const signedUrl = (
        Key: string,
        Method: "GET" | "PUT",
        Expires: number,
        Headers?: COS.Headers,
    ): Promise<string> =>
        new Promise((resolve, reject) => {
            client.getObjectUrl(
                { ...object(Key), Method, Expires, Headers, Sign: true, Protocol: "https:" },
                (error, data) => {
                    const url = data?.Url?.trim();
                    if (error || !url) {
                        reject(new Error("COS signed URL creation failed"));
                        return;
                    }
                    try {
                        if (new URL(url).protocol !== "https:") throw new Error();
                    } catch {
                        reject(new Error("COS signed URL creation failed"));
                        return;
                    }
                    resolve(url);
                },
            );
        });

    const verified = async (
        key: string,
        expectedContentType: string,
        expectedByteSize?: number,
        expectedSha256?: string,
        expectedOwner?: string,
    ): Promise<StoredObject> => {
        const found = metadata(await client.headObject(object(key)));
        assertMetadata(found, expectedContentType, expectedByteSize, expectedSha256, expectedOwner);
        return storedObject(key, found);
    };
    const reconcileFinal = async (
        key: string,
        expectedContentType: string,
        expectedByteSize?: number,
    ): Promise<StoredObject | undefined> => {
        try {
            return await verified(key, expectedContentType, expectedByteSize);
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
        }
    };
    const deleteStaging = async (key: string): Promise<void> => {
        await client.deleteObject(object(key)).catch(() => {});
    };
    const reconcileResult = async (key: string, ownerId: string): Promise<StoredObject | undefined> => {
        try {
            const found = metadata(await client.headObject(object(key)));
            assertAuthoritativeResult(found, ownerId);
            return storedObject(key, found);
        } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
        }
    };

    return {
        async createUpload({ stagingKey, contentType, expiresInSeconds }) {
            const headers = { "content-type": contentType };
            return { url: await signedUrl(stagingKey, "PUT", expiresInSeconds, headers), headers };
        },

        async completeUpload({ stagingKey, finalKey, expectedContentType }) {
            if (stagingKey === finalKey) throw new Error("COS staging and final keys must differ");
            let staging: CosObjectMetadata;
            try {
                staging = metadata(await client.headObject(object(stagingKey)));
            } catch (error) {
                const final = await reconcileFinal(finalKey, expectedContentType);
                if (final) {
                    await deleteStaging(stagingKey);
                    return final;
                }
                if (isNotFound(error)) throw new ObjectStorageVerificationError();
                throw error;
            }
            assertMetadata(staging, expectedContentType);
            try {
                await client.putObjectCopy({
                    ...object(finalKey),
                    CopySource: encodeCopySource(config.bucket, config.region, stagingKey),
                    MetadataDirective: "Copy",
                });
            } catch (error) {
                const final = await reconcileFinal(finalKey, expectedContentType, staging.byteSize);
                if (final) {
                    await deleteStaging(stagingKey);
                    return final;
                }
                throw error;
            }
            const stored = await verified(finalKey, expectedContentType, staging.byteSize);
            await deleteStaging(stagingKey);
            return stored;
        },

        async createReadUrl({ key, expiresInSeconds }) {
            return await signedUrl(key, "GET", expiresInSeconds);
        },

        async putResult({ key, ownerId, contentType, bytes }) {
            const existing = await reconcileResult(key, ownerId);
            if (existing) return existing;

            const sha256 = createHash("sha256").update(bytes).digest("hex");
            try {
                await client.putObject({
                    ...object(key),
                    Body: Buffer.from(bytes),
                    ContentLength: bytes.byteLength,
                    ContentType: contentType,
                    Headers: {
                        "If-None-Match": "*",
                        "x-cos-forbid-overwrite": "true",
                        "x-cos-meta-sha256": sha256,
                        "x-cos-meta-result-owner": ownerId,
                    },
                });
            } catch (error) {
                const reconciled = await reconcileResult(key, ownerId);
                if (reconciled) return reconciled;
                throw error;
            }
            return verified(key, contentType, bytes.byteLength, sha256, ownerId);
        },
    };
}
