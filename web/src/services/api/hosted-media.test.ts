import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeAsset, createAsset, readAsset, uploadAsset } from "./assets";

const asset = {
    id: "10000000-0000-4000-8000-000000000003",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    kind: "video" as const,
    status: "ready" as const,
    fileName: "clip.mp4",
    contentType: "video/mp4",
    byteSize: 3,
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
        if (String(input) === "https://upload.example/signed") return { ok: true, status: 200 } as Response;
        if (init.method === "POST" && String(input).endsWith("/assets")) return { ok: true, status: 201, json: async () => ({ asset: { ...asset, status: "staging" }, upload: { url: "https://upload.example/signed", headers: { "x-upload": "required" } } }) } as Response;
        if (String(input).endsWith("/complete")) return { ok: true, status: 200, json: async () => ({ asset }) } as Response;
        return { ok: true, status: 200, json: async () => ({ asset, displayUrl: "https://display.example/signed" }) } as Response;
    }) as typeof globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("Asset platform API", () => {
    it("uses same-origin authenticated metadata calls and an uncredentialed exact-blob upload", async () => {
        const created = await createAsset(asset.workspaceId, { kind: "video", fileName: asset.fileName, contentType: asset.contentType });
        const blob = new Blob(["raw"], { type: "video/mp4" });
        await uploadAsset(created.upload, blob);
        expect(await completeAsset(asset.workspaceId, asset.id)).toEqual(asset);
        expect(await readAsset(asset.workspaceId, asset.id)).toEqual({ asset, displayUrl: "https://display.example/signed" });

        expect(requests[0].url).toBe(`/api/v1/workspaces/${asset.workspaceId}/assets`);
        expect(requests[0].init.credentials).toBe("include");
        expect(requests[1].url).toBe("https://upload.example/signed");
        expect(requests[1].init.credentials).toBe("omit");
        expect(requests[1].init.body).toBe(blob);
        expect(new Headers(requests[1].init.headers).get("x-upload")).toBe("required");
        expect(requests[2].url).toBe(`/api/v1/workspaces/${asset.workspaceId}/assets/${asset.id}/complete`);
        expect(requests[3].url).toBe(`/api/v1/workspaces/${asset.workspaceId}/assets/${asset.id}`);
    });
});
