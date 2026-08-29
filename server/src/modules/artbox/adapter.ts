import type { ArtBoxGenerationError, AssetKind } from "@infinite-canvas/contracts";

export type ArtBoxAdapterConfig = {
    baseUrl: string;
    apiKey: string;
    videoModels: readonly string[];
    requestTimeoutMs: number;
};

export type ArtBoxCreateInput = {
    model: string;
    promptTemplate: string;
    bindings: readonly { nodeId: string; kind: AssetKind; url: string }[];
    seconds: string;
    aspectRatio?: string;
    resolution?: string;
    generateAudio: boolean;
};

export type ArtBoxCreateOutcome =
    | { kind: "submitted"; remoteTaskId: string }
    | { kind: "failed" | "reconciling"; error: ArtBoxGenerationError };

export type ArtBoxPollOutcome =
    | { kind: "queued" | "processing" }
    | { kind: "succeeded"; resultUrl: string }
    | { kind: "failed" | "reconciling" | "retryable"; error: ArtBoxGenerationError };

export type ArtBoxAdapter = {
    create(input: ArtBoxCreateInput): Promise<ArtBoxCreateOutcome>;
    poll(remoteTaskId: string): Promise<ArtBoxPollOutcome>;
};

type JsonRecord = Record<string, unknown>;

const errors = {
    model: (): ArtBoxGenerationError => ({
        code: "provider_model_not_allowed",
        message: "当前模型未配置",
        retryable: false,
    }),
    configuration: (): ArtBoxGenerationError => ({
        code: "provider_configuration_error",
        message: "生成服务配置无效",
        retryable: false,
    }),
    request: (): ArtBoxGenerationError => ({
        code: "provider_request_error",
        message: "生成请求被服务拒绝",
        retryable: false,
    }),
    uncertain: (): ArtBoxGenerationError => ({
        code: "provider_submission_uncertain",
        message: "生成请求状态需要人工核对",
        retryable: false,
    }),
    unavailable: (): ArtBoxGenerationError => ({
        code: "provider_temporarily_unavailable",
        message: "生成服务暂时不可用",
        retryable: true,
    }),
    generationFailed: (): ArtBoxGenerationError => ({
        code: "provider_generation_failed",
        message: "视频生成失败",
        retryable: false,
    }),
    contentModeration: (): ArtBoxGenerationError => ({
        code: "provider_content_moderation",
        message: "内容审核未通过，请调整提示词或参考素材后重试",
        retryable: false,
    }),
    unknown: (): ArtBoxGenerationError => ({
        code: "provider_state_unknown",
        message: "生成状态需要人工核对",
        retryable: false,
    }),
    duplicateBinding: (): ArtBoxGenerationError => ({
        code: "duplicate_media_binding",
        message: "同一节点不能重复绑定素材",
        retryable: false,
    }),
    unresolvedBinding: (): ArtBoxGenerationError => ({
        code: "unresolved_media_binding",
        message: "提示词包含未绑定素材",
        retryable: false,
    }),
};

function hasDuplicateNodeIds(bindings: ArtBoxCreateInput["bindings"]): boolean {
    const nodeIds = new Set<string>();
    for (const binding of bindings) {
        if (nodeIds.has(binding.nodeId)) return true;
        nodeIds.add(binding.nodeId);
    }
    return false;
}

function record(value: unknown): JsonRecord | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function envelope(payload: unknown): { root: JsonRecord; data?: JsonRecord } | undefined {
    const root = record(payload);
    if (!root) return undefined;
    return { root, data: record(root.data) };
}

function firstString(records: readonly (JsonRecord | undefined)[], names: readonly string[]): string | undefined {
    for (const source of records) {
        if (!source) continue;
        for (const name of names) {
            const value = source[name];
            if (typeof value === "string" && value.trim()) return value;
        }
    }
    return undefined;
}

async function requestJson(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit,
    timeoutMs: number,
): Promise<{ response: Response; payload?: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        if (!response.ok) return { response };
        try {
            return { response, payload: await response.json() };
        } catch {
            return { response };
        }
    } finally {
        clearTimeout(timer);
    }
}

function providerBody(input: ArtBoxCreateInput): JsonRecord {
    let prompt = input.promptTemplate;
    const urls: Record<AssetKind, string[]> = { image: [], video: [], audio: [] };
    const labels: Record<AssetKind, string> = { image: "图片", video: "视频", audio: "音频" };

    for (const binding of input.bindings) {
        const list = urls[binding.kind];
        list.push(binding.url);
        prompt = prompt.replaceAll(`@[node:${binding.nodeId}]`, `@${labels[binding.kind]}${list.length}`);
    }

    return {
        model: input.model,
        prompt,
        seconds: input.seconds,
        ...(input.aspectRatio === undefined ? {} : { aspect_ratio: input.aspectRatio }),
        ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
        ...(urls.image.length === 0 ? {} : { image_urls: urls.image }),
        ...(urls.video.length === 0 ? {} : { video_urls: urls.video }),
        ...(urls.audio.length === 0 ? {} : { audio_urls: urls.audio }),
        generate_audio: input.generateAudio,
    };
}

function pollOutcome(payload: unknown): ArtBoxPollOutcome {
    const parsed = envelope(payload);
    if (!parsed) return { kind: "reconciling", error: errors.unknown() };
    const sources = [parsed.data, parsed.root];
    const rawStatus = firstString(sources, ["status", "state"]);
    const status = rawStatus?.toLowerCase();
    const providerError = record(record(parsed.data?.data)?.error);

    if (["queued", "pending", "not_start", "submitted"].includes(status ?? "")) return { kind: "queued" };
    if (status === "processing" || status === "running" || status === "in_progress") return { kind: "processing" };
    if (status === "completed" || status === "succeeded" || status === "success") {
        const resultUrl = firstString(sources, ["video_url", "result_url", "url"]);
        return resultUrl
            ? { kind: "succeeded", resultUrl }
            : { kind: "reconciling", error: errors.unknown() };
    }
    if (["failed", "failure", "error", "cancelled", "canceled", "rejected", "timed_out"].includes(status ?? "")) {
        if (firstString([providerError], ["code"])?.toLowerCase() === "content_moderation") {
            return { kind: "failed", error: errors.contentModeration() };
        }
        return { kind: "failed", error: errors.generationFailed() };
    }
    return { kind: "reconciling", error: errors.unknown() };
}

export function createArtBoxAdapter(config: ArtBoxAdapterConfig, fetchImpl: typeof fetch = fetch): ArtBoxAdapter {
    const authorization = `Bearer ${config.apiKey}`;

    return {
        async create(input) {
            if (hasDuplicateNodeIds(input.bindings)) return { kind: "failed", error: errors.duplicateBinding() };
            if (!config.videoModels.includes(input.model)) return { kind: "failed", error: errors.model() };
            const body = providerBody(input);
            if (/@\[node:[^\]]*\]/.test(String(body.prompt))) {
                return { kind: "failed", error: errors.unresolvedBinding() };
            }
            try {
                const { response, payload } = await requestJson(
                    fetchImpl,
                    `${config.baseUrl}/v1/video/generations`,
                    {
                        method: "POST",
                        headers: { Authorization: authorization, "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                    },
                    config.requestTimeoutMs,
                );
                if (response.status === 401 || response.status === 403) {
                    return { kind: "failed", error: errors.configuration() };
                }
                if (!response.ok) {
                    if (response.status === 429 || response.status >= 500) {
                        return { kind: "reconciling", error: errors.uncertain() };
                    }
                    return { kind: "failed", error: errors.request() };
                }
                const parsed = envelope(payload);
                const remoteTaskId = parsed
                    ? firstString([parsed.root, parsed.data], ["task_id"])
                    : undefined;
                return remoteTaskId
                    ? { kind: "submitted", remoteTaskId }
                    : { kind: "reconciling", error: errors.uncertain() };
            } catch {
                return { kind: "reconciling", error: errors.uncertain() };
            }
        },

        async poll(remoteTaskId) {
            try {
                const { response, payload } = await requestJson(
                    fetchImpl,
                    `${config.baseUrl}/v1/video/generations/${encodeURIComponent(remoteTaskId)}`,
                    { method: "GET", headers: { Authorization: authorization } },
                    config.requestTimeoutMs,
                );
                if (response.status === 401 || response.status === 403) {
                    return { kind: "failed", error: errors.configuration() };
                }
                if (response.status === 429 || response.status >= 500) {
                    return { kind: "retryable", error: errors.unavailable() };
                }
                if (!response.ok) return { kind: "failed", error: errors.request() };
                return pollOutcome(payload);
            } catch {
                return { kind: "retryable", error: errors.unavailable() };
            }
        },
    };
}
