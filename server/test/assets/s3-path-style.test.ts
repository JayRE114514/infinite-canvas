import { createServer } from "node:http";

import { afterEach, expect, it } from "vitest";

import { S3ObjectStoreAdapter } from "../../src/modules/assets/object-store.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

it("addresses a self-hosted S3 bucket with path-style URLs", async () => {
    let request: { host?: string; url?: string } | undefined;
    const server = createServer((incoming, response) => {
        request = { host: incoming.headers.host, url: incoming.url };
        incoming.resume();
        incoming.on("end", () => response.writeHead(200).end());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");

    const store = new S3ObjectStoreAdapter({
        endpoint: `http://127.0.0.1:${address.port}`,
        region: "us-east-1",
        bucket: "acceptance-assets",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        requestTimeoutMs: 1_000,
        maxAttempts: 1,
    });
    await store.putIfAbsent({
        key: "generated/result.png",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        sha256: "a".repeat(64),
    });

    expect(request).toEqual({
        host: `127.0.0.1:${address.port}`,
        url: "/acceptance-assets/generated/result.png?x-id=PutObject",
    });
});
