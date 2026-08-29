import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { S3ObjectStoreAdapter } from "../../src/modules/assets/object-store.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
    return `http://127.0.0.1:${address.port}`;
}

function createStore(endpoint: string) {
    return new S3ObjectStoreAdapter({
        endpoint,
        region: "us-east-1",
        bucket: "acceptance-assets",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        requestTimeoutMs: 1_000,
        maxAttempts: 1,
    });
}

const input = {
    key: "generated/result.png",
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: "image/png",
    sha256: "a".repeat(64),
};

describe("S3 putIfAbsent", () => {
    it("treats the confirmed 412 PreconditionFailed response as an idempotent hit", async () => {
        const conditions: Array<string | undefined> = [];
        const endpoint = await listen((request, response) => {
            conditions.push(request.headers["if-none-match"]);
            request.resume();
            request.on("end", () => {
                if (conditions.length === 1) return response.writeHead(200).end();
                response.writeHead(412, { "content-type": "application/xml", "x-amz-request-id": "test-412" });
                response.end("<Error><Code>PreconditionFailed</Code><Message>condition failed</Message><RequestId>test-412</RequestId></Error>");
            });
        });
        const store = createStore(endpoint);

        await store.putIfAbsent(input);
        await expect(store.putIfAbsent(input)).resolves.toBeUndefined();

        expect(conditions).toEqual(["*", "*"]);
    });

    it("propagates unsupported conditional writes without retrying an unconditional PUT", async () => {
        const conditions: Array<string | undefined> = [];
        const endpoint = await listen((request, response) => {
            conditions.push(request.headers["if-none-match"]);
            request.resume();
            request.on("end", () => {
                response.writeHead(501, { "content-type": "application/xml", "x-amz-request-id": "test-501" });
                response.end("<Error><Code>NotImplemented</Code><Message>conditional writes unsupported</Message><RequestId>test-501</RequestId></Error>");
            });
        });
        const store = createStore(endpoint);

        await expect(store.putIfAbsent(input)).rejects.toMatchObject({
            name: "NotImplemented",
            $metadata: { httpStatusCode: 501 },
        });
        expect(conditions).toEqual(["*"]);
    });
});
