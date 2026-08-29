import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { platformRequest } from "./platform-client";

type Captured = { url: string; headers: Headers; body: BodyInit | null | undefined };

let captured: Captured[];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
    captured = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        captured.push({ url: String(input), headers: new Headers(init.headers), body: init.body });
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }) as typeof globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("platform request content type", () => {
    /**
     * Fastify parses a request that declares a JSON body. A bodyless DELETE that still claims
     * `application/json` is rejected with 400 before the route runs, so a canvas deletion never
     * reaches the service and never returns its durable receipt.
     */
    it("omits the JSON content type when the request has no body", async () => {
        await platformRequest("/workspaces/w1/canvases/c1", { method: "DELETE" });
        await platformRequest("/workspaces/w1");

        expect(captured).toHaveLength(2);
        for (const request of captured) {
            expect(request.body ?? null).toBeNull();
            expect(request.headers.has("Content-Type")).toBe(false);
        }
    });

    it("still declares the JSON content type for requests that carry a body", async () => {
        await platformRequest("/workspaces", { method: "POST", body: JSON.stringify({ name: "w" }) });
        await platformRequest("/workspaces/w1/canvases/c1", { method: "PUT", body: JSON.stringify({ baseRevision: 1 }) });

        expect(captured).toHaveLength(2);
        for (const request of captured) {
            expect(request.headers.get("Content-Type")).toBe("application/json");
        }
    });

    it("keeps an explicit content type the caller already set", async () => {
        await platformRequest("/workspaces", { method: "POST", body: "raw", headers: { "Content-Type": "text/plain" } });

        expect(captured[0].headers.get("Content-Type")).toBe("text/plain");
    });
});
