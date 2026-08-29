import { describe, expect, it, vi } from "vitest";

import { assertProviderCapabilities } from "../../src/modules/providers/adapter.js";
import {
    OpenAIImagesAdapter,
    type OpenAIImagesAdapterOptions,
    type ProviderFetch,
} from "../../src/modules/providers/openai-images.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

function createAdapter(fetch: ProviderFetch): OpenAIImagesAdapter {
    const options: OpenAIImagesAdapterOptions = {
        baseUrl: "https://provider.example/v1?private=owner-secret",
        apiKey: "sk-owner-secret",
        adapterId: "owner-openai-images",
        adapterVersion: "2026-08-29",
        capabilityId: "image.generate",
        exactModelId: "exact-image-model-2026-08",
        fetch,
    };
    return new OpenAIImagesAdapter(options);
}

describe("OpenAI-compatible images Provider Adapter", () => {
    it("maps the request with the exact model, owner credentials, idempotency key, and caller signal", async () => {
        const fetch = vi.fn<ProviderFetch>().mockResolvedValue(new Response(JSON.stringify({
            data: [{ b64_json: PNG_BASE64 }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
        const adapter = createAdapter(fetch);
        const controller = new AbortController();

        await adapter.submit({ prompt: "一只纸鹤" }, {
            providerIdempotencyKey: "provider-operation-1",
            signal: controller.signal,
        });

        expect(fetch).toHaveBeenCalledOnce();
        const [input, init] = fetch.mock.calls[0]!;
        expect(String(input)).toBe("https://provider.example/v1/images/generations");
        expect(init?.method).toBe("POST");
        expect(init?.signal).toBe(controller.signal);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-owner-secret");
        expect(new Headers(init?.headers).get("idempotency-key")).toBe("provider-operation-1");
        expect(JSON.parse(String(init?.body))).toEqual({
            model: "exact-image-model-2026-08",
            prompt: "一只纸鹤",
        });
        expect(adapter.descriptor).toMatchObject({
            adapterId: "owner-openai-images",
            adapterVersion: "2026-08-29",
            capabilityId: "image.generate",
            exactModelId: "exact-image-model-2026-08",
        });
    });

    it("parses base64 output and returns only detected media and upstream billing facts", async () => {
        const adapter = createAdapter(async () => new Response(JSON.stringify({
            data: [{ b64_json: PNG_BASE64 }],
            usage: { total_tokens: 17, input_tokens_details: { text_tokens: 5 } },
        }), { status: 200, headers: { "x-request-id": "provider-request-7" } }));

        const result = await adapter.submit({ prompt: "test" }, {
            providerIdempotencyKey: "operation-7",
            signal: new AbortController().signal,
        });

        expect(result.kind).toBe("success");
        if (result.kind !== "success") throw new Error("expected success");
        expect(result.output.mediaType).toBe("image/png");
        expect(result.output.bytes).toEqual(Uint8Array.from(Buffer.from(PNG_BASE64, "base64")));
        expect(result.billing).toEqual({
            providerRequestId: "provider-request-7",
            usage: { total_tokens: "17", input_tokens_details: '{"text_tokens":5}' },
        });
        expect(result.billing).not.toHaveProperty("amount");
    });

    it("downloads URL output once and determines media type from its bytes", async () => {
        const bytes = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
        const fetch = vi.fn<ProviderFetch>()
            .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: "https://cdn.example/output.png?token=secret" }] }), {
                status: 200,
            }))
            .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } }));
        const adapter = createAdapter(fetch);

        const result = await adapter.submit({ prompt: "test" }, {
            providerIdempotencyKey: "operation-url",
            signal: new AbortController().signal,
        });

        expect(result.kind).toBe("success");
        if (result.kind !== "success") throw new Error("expected success");
        expect(result.output).toEqual({ bytes, mediaType: "image/png" });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls[1]?.[1]?.signal).toBe(fetch.mock.calls[0]?.[1]?.signal);
    });

    it("declares no poll or cancellation methods", () => {
        const adapter = createAdapter(async () => new Response());
        expect(adapter.descriptor.supportsPolling).toBe(false);
        expect(adapter.descriptor.supportsCancellation).toBe(false);
        expect("poll" in adapter).toBe(false);
        expect("cancel" in adapter).toBe(false);
        expect(() => assertProviderCapabilities(adapter)).not.toThrow();
    });

    it.each([
        [400, "terminal"],
        [429, "safe_retry"],
        [408, "ambiguous"],
        [409, "ambiguous"],
    ] as const)("classifies HTTP %i conservatively as %s", async (status, expectedKind) => {
        const adapter = createAdapter(async () => new Response("sk-owner-secret https://provider.example/?token=secret", { status }));
        const result = await adapter.submit({ prompt: "test" }, {
            providerIdempotencyKey: "operation-http",
            signal: new AbortController().signal,
        });
        expect(result.kind).toBe(expectedKind);
        if (result.kind === "success" || result.kind === "provider_processing") throw new Error("expected failure");
        expect(result.error.message).not.toMatch(/owner-secret|provider\.example|token=secret/);
    });

    it("classifies 5xx and abort failures as ambiguous without retrying or leaking details", async () => {
        const serverFailure = vi.fn<ProviderFetch>().mockResolvedValue(new Response(
            "sk-owner-secret https://provider.example/output?token=secret",
            { status: 503 },
        ));
        const aborted = vi.fn<ProviderFetch>().mockRejectedValue(new DOMException(
            "sk-owner-secret https://provider.example/output?token=secret",
            "AbortError",
        ));

        for (const fetch of [serverFailure, aborted]) {
            const result = await createAdapter(fetch).submit({ prompt: "test" }, {
                providerIdempotencyKey: "operation-ambiguous",
                signal: AbortSignal.abort(),
            });
            expect(result.kind).toBe("ambiguous");
            if (result.kind !== "ambiguous") throw new Error("expected ambiguous");
            expect(result.error.message).not.toMatch(/owner-secret|provider\.example|token=secret/);
            expect(fetch).toHaveBeenCalledOnce();
        }
    });
});
