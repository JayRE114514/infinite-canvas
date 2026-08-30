import { describe, expect, it, vi } from "vitest";

import { assertProviderCapabilities, type ProviderFetch, type ProviderResult } from "../../src/modules/providers/adapter.js";
import { GeminiImagesAdapter, type GeminiImagesAdapterOptions } from "../../src/modules/providers/gemini-images.js";
import { OpenAIImagesAdapter } from "../../src/modules/providers/openai-images.js";
import { createOwnerProviderAdapter } from "../../src/modules/providers/registry.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
const API_KEY = "gemini-owner-secret";

function createAdapter(fetch: ProviderFetch, overrides: Partial<GeminiImagesAdapterOptions> = {}) {
    return new GeminiImagesAdapter({
        baseUrl: "https://provider.example",
        apiKey: API_KEY,
        adapterId: "gemini-images-v1",
        adapterVersion: "1",
        capabilityId: "image.generate",
        exactModelId: "gemini-3-pro-image-preview",
        fetch,
        ...overrides,
    });
}

function submit(adapter: GeminiImagesAdapter) {
    return adapter.submit(
        { prompt: "一只纸鹤" },
        { providerIdempotencyKey: "task-attempt-1", signal: new AbortController().signal },
    );
}

function expectFailure(result: ProviderResult, kind: "ambiguous" | "safe_retry" | "terminal") {
    expect(result.kind).toBe(kind);
    if (result.kind === "success" || result.kind === "provider_processing") throw new Error("expected Provider failure");
    expect(JSON.stringify(result)).not.toMatch(/gemini-owner-secret|provider\.example|upstream-secret|fileUri/);
}

describe("Gemini native image Provider Adapter", () => {
    it("uses the exact native endpoint, API-key header and prompt-only TEXT/IMAGE request", async () => {
        const fetch = vi.fn<ProviderFetch>().mockResolvedValue(new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: "说明" }, { inlineData: { mimeType: "image/png", data: PNG_BASE64 } }] } }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 11 },
        }), { status: 200, headers: { "x-request-id": "gemini-request-1" } }));
        const adapter = createAdapter(fetch);

        const result = await submit(adapter);

        const [url, init] = fetch.mock.calls[0]!;
        expect(String(url)).toBe("https://provider.example/v1beta/models/gemini-3-pro-image-preview:generateContent");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-goog-api-key")).toBe(API_KEY);
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.has("authorization")).toBe(false);
        expect(JSON.parse(String(init?.body))).toEqual({
            contents: [{ role: "user", parts: [{ text: "一只纸鹤" }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        });
        expect(result.kind).toBe("success");
        if (result.kind !== "success") throw new Error("expected success");
        expect(result.output.mediaType).toBe("image/png");
        expect(result.billing).toEqual({
            providerRequestId: "gemini-request-1",
            usage: { promptTokenCount: "7", candidatesTokenCount: "11" },
        });
        expect(result.billing).not.toHaveProperty("amount");
        expect(adapter.descriptor).toMatchObject({ supportsPolling: false, supportsCancellation: false });
        expect("poll" in adapter).toBe(false);
        expect("cancel" in adapter).toBe(false);
        expect(() => assertProviderCapabilities(adapter)).not.toThrow();
    });

    it("accepts snake_case inline_data, ignores text, and trusts detected bytes instead of declared MIME", async () => {
        const adapter = createAdapter(async () => new Response(JSON.stringify({
            candidates: [{ content: { parts: [
                { text: "ignore me" },
                { inline_data: { mime_type: "image/jpeg", data: PNG_BASE64 } },
            ] } }],
        }), { status: 200, headers: { "request-id": "gemini-request-2" } }));

        const result = await submit(adapter);

        expect(result.kind).toBe("success");
        if (result.kind !== "success") throw new Error("expected success");
        expect(result.output.mediaType).toBe("image/png");
        expect(result.output.bytes).toEqual(Uint8Array.from(Buffer.from(PNG_BASE64, "base64")));
        expect(result.billing.providerRequestId).toBe("gemini-request-2");
    });

    it.each([
        ["malformed base64", async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "%%%" } }] } }] }), { status: 200 })],
        ["no image", async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "only text" }, { fileData: { fileUri: "https://provider.example/upstream-secret" } }] } }] }), { status: 200 })],
        ["unknown success shape", async () => new Response(JSON.stringify({ result: "upstream-secret" }), { status: 200 })],
        ["damaged JSON", async () => new Response("{upstream-secret", { status: 200 })],
        ["network interruption", async () => { throw new Error(`${API_KEY} https://provider.example/upstream-secret`); }],
        ["server failure", async () => new Response(`${API_KEY} upstream-secret`, { status: 503 })],
    ] as const)("classifies %s as ambiguous without leaking upstream details", async (_name, fetch) => {
        expectFailure(await submit(createAdapter(fetch)), "ambiguous");
    });

    it("classifies 429 as safe_retry and explicit 4xx rejection as terminal", async () => {
        expectFailure(await submit(createAdapter(async () => new Response("upstream-secret", { status: 429 }))), "safe_retry");
        expectFailure(await submit(createAdapter(async () => new Response("upstream-secret", { status: 400 }))), "terminal");
    });

    it.each([
        { promptFeedback: { blockReason: "SAFETY" } },
        { candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "blocked" }] } }] },
    ])("classifies an explicit safety rejection as terminal", async (payload) => {
        const result = await submit(createAdapter(async () => new Response(JSON.stringify(payload), { status: 200 })));
        expectFailure(result, "terminal");
        if (result.kind === "terminal") expect(result.error.code).toBe("provider_safety_rejection");
    });

    it("rejects a non-origin Gemini base URL instead of guessing a native path", () => {
        expect(() => createAdapter(async () => new Response(), { baseUrl: "https://provider.example/v1" }))
            .toThrow("Invalid Provider Adapter configuration: baseUrl");
    });

    it("selects only owner-registered Gemini/OpenAI adapters and rejects unknown adapterId", () => {
        const common = {
            apiKey: API_KEY,
            adapterVersion: "1",
            capabilityId: "image.generate" as const,
            exactModelId: "gemini-3-pro-image-preview",
            fetch: async () => new Response(),
        };
        expect(createOwnerProviderAdapter({ ...common, adapterId: "gemini-images-v1", baseUrl: "https://provider.example" }))
            .toBeInstanceOf(GeminiImagesAdapter);
        expect(createOwnerProviderAdapter({ ...common, adapterId: "openai-images-v1", baseUrl: "https://provider.example/v1" }))
            .toBeInstanceOf(OpenAIImagesAdapter);
        expect(() => createOwnerProviderAdapter({ ...common, adapterId: "unknown-images-v1", baseUrl: "https://provider.example" }))
            .toThrow("Provider Adapter is not owner-registered: unknown-images-v1");
    });
});
