import { afterEach, expect, it, vi } from "vitest";

import { createPlatformImageTask, readyAssetContentUrl } from "./ai-tasks";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

it("submits only Workspace, prompt and the caller idempotency key to the platform Task route", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        captured = { url: String(input), init };
        return ({
        ok: true,
        status: 202,
        json: async () => ({ taskId: "d55c26c1-4f62-49ad-9ef4-ddda64bbab5e", status: "queued", estimatedCredits: "25", replayed: false }),
        }) as Response;
    });
    globalThis.fetch = fetch as typeof globalThis.fetch;

    await createPlatformImageTask("workspace-1", "一只纸鹤", "operation-1");

    expect(captured?.url).toBe("/api/v1/ai/tasks");
    expect(new Headers(captured?.init.headers).get("idempotency-key")).toBe("operation-1");
    expect(JSON.parse(String(captured?.init.body))).toEqual({ workspaceId: "workspace-1", prompt: "一只纸鹤" });
    expect(readyAssetContentUrl("asset-1")).toBe("/api/v1/assets/asset-1/content");
});
