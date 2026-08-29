import COS from "cos-nodejs-sdk-v5";

import type { TencentCosConfig } from "../../config.js";
import { ObjectStorageVerificationError, type ObjectStorage, type StoredObject } from "./types.js";

type CosObjectMetadata = { contentType: string; byteSize: number; etag?: string };

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
    return { contentType, byteSize, ...(data.ETag ? { etag: data.ETag } : {}) };
}

function assertMetadata(actual: CosObjectMetadata, expectedContentType: string, expectedByteSize?: number): void {
    if (actual.contentType !== expectedContentType || (expectedByteSize !== undefined && actual.byteSize !== expectedByteSize)) {
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

    const verified = async (key: string, expectedContentType: string, expectedByteSize?: number): Promise<StoredObject> => {
        const found = metadata(await client.headObject(object(key)));
        assertMetadata(found, expectedContentType, expectedByteSize);
        return { key, ...found };
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

        async putResult({ key, contentType, bytes }) {
            await client.putObject({
                ...object(key),
                Body: Buffer.from(bytes),
                ContentLength: bytes.byteLength,
                ContentType: contentType,
            });
            return verified(key, contentType, bytes.byteLength);
        },
    };
}
