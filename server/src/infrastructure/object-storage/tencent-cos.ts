import COS from "cos-nodejs-sdk-v5";

import type { TencentCosConfig } from "../../config.js";
import type { ObjectStorage, StoredObject } from "./types.js";

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
        throw new Error("COS object metadata is incomplete");
    }
    return { contentType, byteSize, ...(data.ETag ? { etag: data.ETag } : {}) };
}

function assertMetadata(actual: CosObjectMetadata, expectedContentType: string, expectedByteSize?: number): void {
    if (actual.contentType !== expectedContentType || (expectedByteSize !== undefined && actual.byteSize !== expectedByteSize)) {
        throw new Error("COS object verification failed");
    }
}

function encodeCopySource(bucket: string, region: string, key: string): string {
    return `${bucket}.cos.${region}.myqcloud.com/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function createTencentCosStorage(
    config: TencentCosConfig,
    client = new COS({ SecretId: config.secretId, SecretKey: config.secretKey }),
): ObjectStorage {
    const object = (Key: string) => ({ Bucket: config.bucket, Region: config.region, Key });
    const signedUrl = (Key: string, Method: "GET" | "PUT", Expires: number, Headers?: COS.Headers): string =>
        client.getObjectUrl({ ...object(Key), Method, Expires, Headers, Sign: true, Protocol: "https:" });

    const verified = async (key: string, expectedContentType: string, expectedByteSize?: number): Promise<StoredObject> => {
        const found = metadata(await client.headObject(object(key)));
        assertMetadata(found, expectedContentType, expectedByteSize);
        return { key, ...found };
    };

    return {
        async createUpload({ stagingKey, contentType, expiresInSeconds }) {
            const headers = { "content-type": contentType };
            return { url: signedUrl(stagingKey, "PUT", expiresInSeconds, headers), headers };
        },

        async completeUpload({ stagingKey, finalKey, expectedContentType }) {
            if (stagingKey === finalKey) throw new Error("COS staging and final keys must differ");
            const staging = metadata(await client.headObject(object(stagingKey)));
            assertMetadata(staging, expectedContentType);
            await client.putObjectCopy({
                ...object(finalKey),
                CopySource: encodeCopySource(config.bucket, config.region, stagingKey),
                MetadataDirective: "Copy",
            });
            const stored = await verified(finalKey, expectedContentType, staging.byteSize);
            await client.deleteObject(object(stagingKey)).catch(() => {});
            return stored;
        },

        async createReadUrl({ key, expiresInSeconds }) {
            return signedUrl(key, "GET", expiresInSeconds);
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
