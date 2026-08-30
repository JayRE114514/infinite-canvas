import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Readable } from "node:stream";

export interface ObjectStoreAdapter {
    putIfAbsent(input: { key: string; bytes: Uint8Array; mediaType: string; sha256: string }): Promise<void>;
    get(key: string): Promise<Uint8Array>;
    open(key: string, signal: AbortSignal): Promise<Readable>;
}

export type S3ObjectStoreConfig = {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    requestTimeoutMs: number;
    maxAttempts: number;
};

export class S3ObjectStoreAdapter implements ObjectStoreAdapter {
    readonly #bucket: string;
    readonly #client: S3Client;

    constructor(config: S3ObjectStoreConfig) {
        if (config.requestTimeoutMs <= 0 || config.maxAttempts < 1) {
            throw new Error("S3 requestTimeoutMs and maxAttempts must be explicitly positive");
        }
        this.#bucket = config.bucket;
        this.#client = new S3Client({
            endpoint: config.endpoint,
            region: config.region,
            credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
            forcePathStyle: true,
            maxAttempts: config.maxAttempts,
            requestHandler: new NodeHttpHandler({ requestTimeout: config.requestTimeoutMs }),
        });
    }

    async putIfAbsent(input: { key: string; bytes: Uint8Array; mediaType: string; sha256: string }): Promise<void> {
        try {
            await this.#client.send(
                new PutObjectCommand({
                    Bucket: this.#bucket,
                    Key: input.key,
                    Body: input.bytes,
                    ContentType: input.mediaType,
                    Metadata: { sha256: input.sha256 },
                    IfNoneMatch: "*",
                }),
            );
        } catch (error) {
            const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
            // Gate A 已确认目标端点以 412 表达条件未满足；其余错误必须上抛，绝不退化成无条件覆盖。
            if (candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412) return;
            throw error;
        }
    }

    async get(key: string): Promise<Uint8Array> {
        const response = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
        if (!response.Body) throw new Error("S3 object body is missing");
        return response.Body.transformToByteArray();
    }

    async open(key: string, signal: AbortSignal): Promise<Readable> {
        const response = await this.#client.send(
            new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
            { abortSignal: signal },
        );
        if (!(response.Body instanceof Readable)) throw new Error("S3 object body is not a Node stream");
        return response.Body;
    }
}

export class MemoryObjectStoreAdapter implements ObjectStoreAdapter {
    readonly #objects = new Map<string, Uint8Array>();

    async putIfAbsent(input: { key: string; bytes: Uint8Array }): Promise<void> {
        if (!this.#objects.has(input.key)) this.#objects.set(input.key, input.bytes.slice());
    }

    async get(key: string): Promise<Uint8Array> {
        const bytes = this.#objects.get(key);
        if (!bytes) throw new Error("Object does not exist");
        return bytes.slice();
    }

    async open(key: string, signal: AbortSignal): Promise<Readable> {
        const bytes = this.#objects.get(key);
        if (!bytes) throw new Error("Object does not exist");
        const stream = Readable.from([bytes.slice()]);
        if (signal.aborted) stream.destroy(new Error("Asset content request aborted"));
        else signal.addEventListener("abort", () => stream.destroy(new Error("Asset content request aborted")), { once: true });
        return stream;
    }
}
