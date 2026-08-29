import { describe, expect, it, vi } from "vitest";

import {
    createArtBoxAdapter,
    type ArtBoxAdapterConfig,
    type ArtBoxCreateInput,
} from "../../src/modules/artbox/adapter.js";

const config: ArtBoxAdapterConfig = {
    baseUrl: "https://artbox.test",
    apiKey: "test-api-key-never-print",
    videoModels: ["Artdance 2 Mini-480p"],
    requestTimeoutMs: 250,
};

function response(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function input(bindings: ArtBoxCreateInput["bindings"]): ArtBoxCreateInput {
    return {
        model: "Artdance 2 Mini-480p",
        promptTemplate:
            bindings.length === 0
                ? "无参考素材"
                : "人物 @[node:image-1] 重复 @[node:image-1]，运镜 @[node:video-1]，节奏 @[node:audio-1]，补图 @[node:image-6]",
        bindings,
        seconds: "5",
        aspectRatio: "16:9",
        resolution: "480p",
        generateAudio: true,
    };
}

describe("fixed ArtBox adapter", () => {
    it("posts the exact protocol, rewrites independent media sequences, and never truncates arrays", async () => {
        const fetchImpl = vi.fn(async () => response({ data: { task_id: "remote-task-1" } }));
        const bindings: ArtBoxCreateInput["bindings"] = [
            { nodeId: "image-1", kind: "image", url: "https://media.test/image-1" },
            { nodeId: "video-1", kind: "video", url: "https://media.test/video-1" },
            { nodeId: "image-2", kind: "image", url: "https://media.test/image-2" },
            { nodeId: "audio-1", kind: "audio", url: "https://media.test/audio-1" },
            { nodeId: "image-3", kind: "image", url: "https://media.test/image-3" },
            { nodeId: "image-4", kind: "image", url: "https://media.test/image-4" },
            { nodeId: "image-5", kind: "image", url: "https://media.test/image-5" },
            { nodeId: "image-6", kind: "image", url: "https://media.test/image-6" },
        ];

        await expect(createArtBoxAdapter(config, fetchImpl).create(input(bindings))).resolves.toEqual({
            kind: "submitted",
            remoteTaskId: "remote-task-1",
        });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0]! as unknown as Parameters<typeof fetch>;
        expect(url).toBe("https://artbox.test/v1/video/generations");
        expect(init).toMatchObject({
            method: "POST",
            headers: { Authorization: "Bearer test-api-key-never-print", "Content-Type": "application/json" },
        });
        expect(JSON.parse(String(init?.body))).toEqual({
            model: "Artdance 2 Mini-480p",
            prompt: "人物 @图片1 重复 @图片1，运镜 @视频1，节奏 @音频1，补图 @图片6",
            seconds: "5",
            aspect_ratio: "16:9",
            resolution: "480p",
            image_urls: bindings.filter((binding) => binding.kind === "image").map((binding) => binding.url),
            video_urls: ["https://media.test/video-1"],
            audio_urls: ["https://media.test/audio-1"],
            generate_audio: true,
        });
    });

    it("matches the canonical request by omitting optional fields and empty URL arrays", async () => {
        const fetchImpl = vi.fn(async () => response({ task_id: "top-level-task" }));
        const adapter = createArtBoxAdapter(config, fetchImpl);

        await expect(
            adapter.create({
                model: "Artdance 2 Mini-480p",
                promptTemplate: "人物 @[node:image-1]",
                bindings: [{ nodeId: "image-1", kind: "image", url: "https://media.test/image-1" }],
                seconds: "5",
                generateAudio: false,
            }),
        ).resolves.toEqual({ kind: "submitted", remoteTaskId: "top-level-task" });

        const [, init] = fetchImpl.mock.calls[0]! as unknown as Parameters<typeof fetch>;
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
            model: "Artdance 2 Mini-480p",
            prompt: "人物 @图片1",
            seconds: "5",
            image_urls: ["https://media.test/image-1"],
            generate_audio: false,
        });
        expect(body).not.toHaveProperty("aspect_ratio");
        expect(body).not.toHaveProperty("resolution");
    });

    it("URL-encodes polling ids and normalizes provider envelopes", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(response({ status: "queued" }))
            .mockResolvedValueOnce(response({ data: { status: "running" } }))
            .mockResolvedValueOnce(response({ data: { status: "completed", video_url: "https://results.test/video.mp4" } }))
            .mockResolvedValueOnce(response({ status: "failed" }));
        const adapter = createArtBoxAdapter(config, fetchImpl);

        await expect(adapter.poll("task/with ? chars")).resolves.toEqual({ kind: "queued" });
        await expect(adapter.poll("processing-task")).resolves.toEqual({ kind: "processing" });
        await expect(adapter.poll("complete-task")).resolves.toEqual({
            kind: "succeeded",
            resultUrl: "https://results.test/video.mp4",
        });
        await expect(adapter.poll("failed-task")).resolves.toMatchObject({
            kind: "failed",
            error: { code: "provider_generation_failed", retryable: false },
        });

        expect(fetchImpl.mock.calls[0]![0]).toBe(
            "https://artbox.test/v1/video/generations/task%2Fwith%20%3F%20chars",
        );
        expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
            method: "GET",
            headers: { Authorization: "Bearer test-api-key-never-print" },
        });
    });

    it("normalizes top-level and nested in_progress while preserving genuinely unknown reconciliation", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(response({ status: "in_progress" }))
            .mockResolvedValueOnce(response({ data: { status: "in_progress" } }))
            .mockResolvedValueOnce(response({ data: { status: "future_state" } }));
        const adapter = createArtBoxAdapter(config, fetchImpl);

        await expect(adapter.poll("top-level")).resolves.toEqual({ kind: "processing" });
        await expect(adapter.poll("nested")).resolves.toEqual({ kind: "processing" });
        await expect(adapter.poll("unknown")).resolves.toMatchObject({
            kind: "reconciling",
            error: { code: "provider_state_unknown" },
        });
    });

    it("reconciles unknown states and successful responses without a result URL", async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(response({ data: { status: "new-provider-state" } }))
            .mockResolvedValueOnce(response({ status: "succeeded" }))
            .mockResolvedValueOnce(response({ ok: true }));
        const adapter = createArtBoxAdapter(config, fetchImpl);

        await expect(adapter.poll("unknown")).resolves.toMatchObject({ kind: "reconciling" });
        await expect(adapter.poll("missing-url")).resolves.toMatchObject({ kind: "reconciling" });
        await expect(adapter.create(input([]))).resolves.toMatchObject({ kind: "reconciling" });
    });

    it.each(["failure", "error", "cancelled", "canceled", "rejected", "timed_out"])(
        "normalizes terminal failure status %s",
        async (status) => {
            const adapter = createArtBoxAdapter(config, async () => response({ data: { status } }));
            await expect(adapter.poll("terminal-task")).resolves.toMatchObject({
                kind: "failed",
                error: { code: "provider_generation_failed", retryable: false },
            });
        },
    );

    it("rejects non-allowlisted models before a network call", async () => {
        const fetchImpl = vi.fn(async () => response({ task_id: "must-not-run" }));
        const adapter = createArtBoxAdapter(config, fetchImpl);

        await expect(adapter.create({ ...input([]), model: "unconfigured-model" })).resolves.toMatchObject({
            kind: "failed",
            error: { code: "provider_model_not_allowed", retryable: false },
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
        ["same-kind", { nodeId: "duplicate", kind: "image", url: "https://media.test/image-2" }],
        ["different-kind", { nodeId: "duplicate", kind: "audio", url: "https://media.test/audio-1" }],
    ] as const)("rejects %s duplicate node bindings before network", async (_label, duplicate) => {
        const fetchImpl = vi.fn(async () => response({ task_id: "must-not-run" }));
        const adapter = createArtBoxAdapter(config, fetchImpl);

        await expect(
            adapter.create({
                ...input([]),
                promptTemplate: "参考 @[node:duplicate]",
                bindings: [
                    { nodeId: "duplicate", kind: "image", url: "https://media.test/image-1" },
                    duplicate,
                ],
            }),
        ).resolves.toMatchObject({
            kind: "failed",
            error: { code: "duplicate_media_binding", retryable: false },
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("rejects an unresolved internal node token before network with a sanitized input error", async () => {
        const fetchImpl = vi.fn(async () => response({ task_id: "must-not-run" }));
        const adapter = createArtBoxAdapter(config, fetchImpl);

        const outcome = await adapter.create({
            ...input([]),
            promptTemplate: "参考 @[node:bound] 与 @[node:missing-secret-node]",
            bindings: [{ nodeId: "bound", kind: "image", url: "https://media.test/image-1?token=secret" }],
        });

        expect(outcome).toMatchObject({
            kind: "failed",
            error: { code: "unresolved_media_binding", retryable: false },
        });
        expect(JSON.stringify(outcome)).not.toMatch(/missing-secret-node|token=secret/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("keeps unused bindings in Provider arrays without requiring a prompt token", async () => {
        const fetchImpl = vi.fn(async () => response({ task_id: "unused-binding-task" }));
        const adapter = createArtBoxAdapter(config, fetchImpl);

        await expect(
            adapter.create({
                ...input([]),
                promptTemplate: "无需显式引用素材",
                bindings: [{ nodeId: "unused", kind: "image", url: "https://media.test/unused" }],
            }),
        ).resolves.toEqual({ kind: "submitted", remoteTaskId: "unused-binding-task" });
        const [, init] = fetchImpl.mock.calls[0]! as unknown as Parameters<typeof fetch>;
        expect(JSON.parse(String(init?.body))).toMatchObject({
            prompt: "无需显式引用素材",
            image_urls: ["https://media.test/unused"],
        });
    });

    it.each([
        [401, "failed", "provider_configuration_error", false],
        [429, "reconciling", "provider_submission_uncertain", false],
        [503, "reconciling", "provider_submission_uncertain", false],
    ] as const)("sanitizes create HTTP %s", async (status, kind, code, retryable) => {
        const secretResponse = "raw-upstream-secret https://signed.test/video?token=secret";
        const adapter = createArtBoxAdapter(config, async () => new Response(secretResponse, { status }));
        const outcome = await adapter.create(input([]));

        expect(outcome).toMatchObject({ kind, error: { code, retryable } });
        expect(JSON.stringify(outcome)).not.toContain(secretResponse);
        expect(JSON.stringify(outcome)).not.toContain(config.apiKey);
    });

    it("keeps poll outages retryable and sanitizes network failures", async () => {
        const adapter = createArtBoxAdapter(config, async () => {
            throw new Error("socket failed with test-api-key-never-print and https://signed.test/?token=secret");
        });

        const createOutcome = await adapter.create(input([]));
        const pollOutcome = await adapter.poll("remote-secret-id");
        expect(createOutcome).toMatchObject({
            kind: "reconciling",
            error: { code: "provider_submission_uncertain", retryable: false },
        });
        expect(pollOutcome).toMatchObject({
            kind: "retryable",
            error: { code: "provider_temporarily_unavailable", retryable: true },
        });
        expect(JSON.stringify([createOutcome, pollOutcome])).not.toMatch(/test-api-key|signed\.test|remote-secret-id/);
    });
});
