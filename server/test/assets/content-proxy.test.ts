import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { loadAssetContent, registerAssetRoutes } from "../../src/modules/assets/routes.js";

describe("asset content proxy", () => {
    it("forwards byte ranges and exposes only browser-safe response headers", async () => {
        let receivedRange: string | null = null;
        const fetchImpl: typeof fetch = async (_input, init) => {
            receivedRange = new Headers(init?.headers).get("range");
            return new Response(new Uint8Array([1, 2, 3]), {
                status: 206,
                headers: {
                    "accept-ranges": "bytes",
                    "content-disposition": 'attachment; filename="reference.png"',
                    "content-length": "3",
                    "content-range": "bytes 0-2/9",
                    "content-type": "image/png",
                    etag: '"asset-etag"',
                    "x-cos-request-id": "private-upstream-detail",
                },
            });
        };

        const result = await loadAssetContent("https://storage.test/read/1", "bytes=0-2", fetchImpl);

        expect(receivedRange).toBe("bytes=0-2");
        expect(result.status).toBe(206);
        expect(result.headers).toEqual({
            "accept-ranges": "bytes",
            "cache-control": "private, no-store",
            "content-security-policy": "sandbox; default-src 'none'",
            "content-length": "3",
            "content-range": "bytes 0-2/9",
            "content-type": "image/png",
            etag: '"asset-etag"',
            "x-content-type-options": "nosniff",
        });
        expect(result.headers).not.toHaveProperty("content-disposition");
        expect(result.headers).not.toHaveProperty("x-cos-request-id");
        expect(result.body).not.toBeNull();
    });

    it("does not turn HEAD into a body-fetching GET", async () => {
        const app = Fastify({ logger: false });
        registerAssetRoutes(app);
        try {
            const response = await app.inject({
                method: "HEAD",
                url: "/api/v1/workspaces/00000000-0000-4000-8000-000000000001/assets/00000000-0000-4000-8000-000000000002/content",
            });
            expect(response.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it("preserves an unsatisfiable byte range response", async () => {
        const fetchImpl: typeof fetch = async () =>
            new Response(null, {
                status: 416,
                headers: { "content-range": "bytes */9" },
            });

        const result = await loadAssetContent("https://storage.test/read/1", "bytes=99-100", fetchImpl);

        expect(result.status).toBe(416);
        expect(result.body).toBeNull();
        expect(result.headers["content-range"]).toBe("bytes */9");
    });
});
