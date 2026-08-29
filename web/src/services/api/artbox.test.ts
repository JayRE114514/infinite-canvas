import type { CreateArtBoxVideoGenerationBody } from "@infinite-canvas/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createArtBoxVideoGeneration, pollArtBoxVideoGeneration } from "./artbox";

const generation = {
    id: "10000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    status: "processing" as const,
    resultAssetId: null,
    error: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
};

let originalFetch: typeof globalThis.fetch;
let requests: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ url: String(input), init });
        return { ok: true, status: 200, json: async () => ({ generation }) } as Response;
    }) as typeof globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("ArtBox platform API", () => {
    it("creates and polls through same-origin authenticated routes", async () => {
        const body: CreateArtBoxVideoGenerationBody = {
            model: "Artdance 2 Mini-480p",
            promptTemplate: "follow @[node:image-1]",
            bindings: [{ nodeId: "image-1", kind: "image", assetId: "10000000-0000-4000-8000-000000000003" }],
            seconds: "5",
            aspectRatio: "16:9",
            resolution: "480p",
            generateAudio: true,
        };

        expect(await createArtBoxVideoGeneration(generation.workspaceId, body, "idem-1")).toEqual(generation);
        expect(await pollArtBoxVideoGeneration(generation.workspaceId, generation.id)).toEqual(generation);

        expect(requests.map((request) => request.url)).toEqual([
            `/api/v1/workspaces/${generation.workspaceId}/integrations/artbox/video-generations`,
            `/api/v1/workspaces/${generation.workspaceId}/integrations/artbox/video-generations/${generation.id}/poll`,
        ]);
        expect(requests[0].init.credentials).toBe("include");
        expect(new Headers(requests[0].init.headers).get("Idempotency-Key")).toBe("idem-1");
        expect(requests[1].init.credentials).toBe("include");
    });

    it("serializes only the closed provider-neutral body", async () => {
        const body: CreateArtBoxVideoGenerationBody = {
            model: "Artdance 2 Mini-480p",
            promptTemplate: "@[node:image-1]",
            bindings: [{ nodeId: "image-1", kind: "image", assetId: "10000000-0000-4000-8000-000000000003" }],
            seconds: "5",
            generateAudio: false,
        };
        await createArtBoxVideoGeneration(generation.workspaceId, body, "idem-2");

        const payload = JSON.parse(String(requests[0].init.body)) as unknown;
        expect(payload).toEqual(body);
        const forbidden = /(^|_)(url|urls|storageKey|blob|dataUrl|objectKey|apiKey|authorization)($|_)/i;
        const scan = (value: unknown): string[] => {
            if (!value || typeof value !== "object") return [];
            return Object.entries(value).flatMap(([key, child]) => (forbidden.test(key) ? [key] : scan(child)));
        };
        expect(scan(payload)).toEqual([]);
        expect(JSON.stringify(payload)).not.toContain("data:");
        expect(JSON.stringify(payload)).not.toContain("blob:");
    });
});
