import type { ArtBoxVideoGeneration, CreateArtBoxVideoGenerationBody, HostedMediaBinding, ReadAssetResponse } from "@infinite-canvas/contracts";

import { completeAsset, createAsset, readAsset, uploadAsset } from "@/services/api/assets";
import { createArtBoxVideoGeneration, pollArtBoxVideoGeneration } from "@/services/api/artbox";
import { PlatformApiError } from "@/services/api/platform-client";
import { VIDEO_GENERATION_POLL_ATTEMPTS, VIDEO_GENERATION_POLL_INTERVAL_MS } from "@/services/api/video";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { HOSTED_ARTBOX_VIDEO_MODEL, HOSTED_ARTBOX_VIDEO_MODEL_OPTION, isHostedArtBoxModel } from "@/stores/use-config-store";
import type { CanvasNodeData, CanvasProject, HostedVideoAttempt } from "@/types/canvas";
import type { HostedMediaSource } from "@/types/media";
import type { CanvasSyncView } from "@/services/canvas-sync/types";

export type HostedMediaDependencies = {
    createAsset: typeof createAsset;
    uploadAsset: typeof uploadAsset;
    completeAsset: typeof completeAsset;
    getImageBlob: typeof getImageBlob;
    getMediaBlob: typeof getMediaBlob;
};

const defaultDependencies: HostedMediaDependencies = { createAsset, uploadAsset, completeAsset, getImageBlob, getMediaBlob };

export class HostedMediaError extends Error {
    constructor(
        readonly code:
            | "hosted_media_bytes_missing"
            | "hosted_asset_not_ready"
            | "hosted_asset_storage_configuration"
            | "hosted_provider_configuration"
            | "hosted_attempt_not_durable"
            | "hosted_generation_failed"
            | "hosted_generation_reconciling"
            | "hosted_generation_safe_new_attempt"
            | "hosted_generation_timeout"
            | "hosted_generation_result_missing",
        message: string,
    ) {
        super(message);
        this.name = "HostedMediaError";
    }
}

export async function ensureAssetReady(workspaceId: string, source: HostedMediaSource, deps: HostedMediaDependencies = defaultDependencies, signal?: AbortSignal) {
    try {
        if (source.assetId) return source.assetId;
        const blob = source.storageKey ? await (source.kind === "image" ? deps.getImageBlob(source.storageKey) : deps.getMediaBlob(source.storageKey)) : null;
        if (!blob) throw new HostedMediaError("hosted_media_bytes_missing", `Local ${source.kind} bytes are missing for node ${source.nodeId}`);
        const created = await deps.createAsset(workspaceId, { kind: source.kind, fileName: source.fileName, contentType: source.contentType });
        await deps.uploadAsset(created.upload, blob, signal);
        const completed = await deps.completeAsset(workspaceId, created.asset.id);
        if (completed.status !== "ready") throw new HostedMediaError("hosted_asset_not_ready", `Asset is not ready for node ${source.nodeId}`);
        return completed.id;
    } catch (error) {
        throw hostedPlatformError(error);
    }
}

export type BuildHostedVideoRequest = {
    workspaceId: string;
    model: string;
    promptTemplate: string;
    media: HostedMediaSource[];
    seconds: string;
    generateAudio: boolean;
};

export async function buildHostedVideoRequest(
    input: BuildHostedVideoRequest,
    deps: HostedMediaDependencies = defaultDependencies,
    onAssetReady?: (source: HostedMediaSource, assetId: string) => void,
    signal?: AbortSignal,
): Promise<CreateArtBoxVideoGenerationBody> {
    const bindings: HostedMediaBinding[] = [];
    for (const source of input.media) {
        const assetId = await ensureAssetReady(input.workspaceId, source, deps, signal);
        onAssetReady?.(source, assetId);
        bindings.push({ nodeId: source.nodeId, kind: source.kind, assetId });
    }
    return {
        model: input.model,
        promptTemplate: input.promptTemplate,
        bindings,
        seconds: input.seconds,
        generateAudio: input.generateAudio,
    };
}

export type HostedVideoRequestOptions = {
    signal?: AbortSignal;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    create?: typeof createArtBoxVideoGeneration;
    poll?: typeof pollArtBoxVideoGeneration;
    read?: typeof readAsset;
};

export async function requestHostedArtBoxVideo(workspaceId: string, body: CreateArtBoxVideoGenerationBody, idempotencyKey: string, options: HostedVideoRequestOptions = {}): Promise<ReadAssetResponse> {
    try {
        const create = options.create || createArtBoxVideoGeneration;
        const poll = options.poll || pollArtBoxVideoGeneration;
        const read = options.read || readAsset;
        const wait = options.wait || delay;
        let generation = await create(workspaceId, body, idempotencyKey, options.signal);
        for (let attempt = 0; attempt < VIDEO_GENERATION_POLL_ATTEMPTS; attempt += 1) {
            const resultAssetId = terminalResult(generation);
            if (resultAssetId) return read(workspaceId, resultAssetId);
            if (generation.status === "reconciling") throw new HostedMediaError("hosted_generation_reconciling", generation.error?.message || "Hosted video generation requires reconciliation");
            if (generation.status === "failed") {
                if (generation.error?.code === "asset_transport_error" && generation.error.retryable === true) throw new HostedMediaError("hosted_generation_safe_new_attempt", generation.error.message);
                throw new HostedMediaError("hosted_generation_failed", generation.error?.message || "Hosted video generation failed");
            }
            if (attempt === VIDEO_GENERATION_POLL_ATTEMPTS - 1) throw new HostedMediaError("hosted_generation_timeout", "Hosted video generation timed out");
            await wait(VIDEO_GENERATION_POLL_INTERVAL_MS, options.signal);
            generation = await poll(workspaceId, generation.id, options.signal);
        }
        throw new HostedMediaError("hosted_generation_timeout", "Hosted video generation timed out");
    } catch (error) {
        throw hostedPlatformError(error);
    }
}

export function attachHostedAssetIfSourceUnchanged(nodes: CanvasNodeData[], source: HostedMediaSource, assetId: string) {
    return nodes.map((node) => {
        if (node.id !== source.nodeId || node.type !== source.kind) return node;
        const metadata = node.metadata || {};
        const sameSource = source.assetId
            ? metadata.assetId === source.assetId
            : source.storageKey
              ? metadata.storageKey === source.storageKey && (!source.content || metadata.content === source.content)
              : Boolean(source.content && metadata.content === source.content);
        return sameSource ? { ...node, metadata: { ...metadata, assetId } } : node;
    });
}

export function videoGenerationRoute(model: string, savedRequest?: CreateArtBoxVideoGenerationBody | null) {
    return savedRequest || isHostedArtBoxModel(model) ? "hosted" : "local";
}

export function resolveHostedVideoRequest(node: CanvasNodeData, fallback: CreateArtBoxVideoGenerationBody | null) {
    const attempt = resolveHostedVideoAttempt(node);
    if (attempt) return attempt.request;
    if (isCompleteHostedVideoRequest(node.metadata?.hostedRequest)) return node.metadata.hostedRequest;
    return isCompleteHostedVideoRequest(fallback) ? fallback : null;
}

export function saveHostedVideoRequest(nodes: CanvasNodeData[], targetNodeId: string, request: CreateArtBoxVideoGenerationBody) {
    return nodes.map((node) => (node.id === targetNodeId ? { ...node, metadata: { ...node.metadata, hostedRequest: request, hostedAttempt: undefined } } : node));
}

export function resolveHostedVideoAttempt(node: CanvasNodeData) {
    return isCompleteHostedVideoAttempt(node.metadata?.hostedAttempt) ? node.metadata.hostedAttempt : null;
}

export function saveHostedVideoAttempt(nodes: CanvasNodeData[], targetNodeId: string, attempt: HostedVideoAttempt) {
    return nodes.map((node) => (node.id === targetNodeId ? { ...node, metadata: { ...node.metadata, hostedRequest: undefined, hostedAttempt: attempt } } : node));
}

export function hostedVideoAttemptDurability(
    projectId: string,
    targetNodeId: string,
    attempt: HostedVideoAttempt,
    project: Pick<CanvasProject, "id" | "nodes"> | null,
    sync: Pick<CanvasSyncView, "canvasId" | "phase" | "hasUnsavedEdits" | "localPersist"> | null,
) {
    if (!project || project.id !== projectId || !sync || sync.canvasId !== projectId) return "missing" as const;
    const target = project.nodes.find((node) => node.id === targetNodeId);
    const persisted = target ? resolveHostedVideoAttempt(target) : null;
    if (!persisted || !sameHostedVideoAttempt(persisted, attempt)) return "missing" as const;
    return hostedDurability(sync);
}

export function hostedVideoRequestDurability(
    projectId: string,
    targetNodeId: string,
    request: CreateArtBoxVideoGenerationBody,
    project: Pick<CanvasProject, "id" | "nodes"> | null,
    sync: Pick<CanvasSyncView, "canvasId" | "phase" | "hasUnsavedEdits" | "localPersist"> | null,
) {
    if (!project || project.id !== projectId || !sync || sync.canvasId !== projectId) return "missing" as const;
    const target = project.nodes.find((node) => node.id === targetNodeId);
    if (!target || resolveHostedVideoAttempt(target) || !sameHostedVideoRequest(resolveHostedVideoRequest(target, null), request)) return "missing" as const;
    return hostedDurability(sync);
}

export type CanvasVideoGenerationOperations = {
    model: string;
    savedAttempt: HostedVideoAttempt | null;
    savedRequest: CreateArtBoxVideoGenerationBody | null;
    createIdempotencyKey: () => string;
    prepareHostedRequest: () => Promise<CreateArtBoxVideoGenerationBody>;
    persistHostedAttempt: (attempt: HostedVideoAttempt) => Promise<void>;
    invalidateHostedAttempt: (request: CreateArtBoxVideoGenerationBody) => Promise<void>;
    generateHosted: (attempt: HostedVideoAttempt) => Promise<ReadAssetResponse>;
    applyHostedResult: (result: ReadAssetResponse, attempt: HostedVideoAttempt) => void | Promise<void>;
    generateLocal: () => Promise<void>;
};

export async function runCanvasVideoGeneration(operations: CanvasVideoGenerationOperations) {
    const savedRequest = operations.savedAttempt?.request || operations.savedRequest;
    if (videoGenerationRoute(operations.model, savedRequest) === "local") {
        await operations.generateLocal();
        return "local" as const;
    }
    const attempt = operations.savedAttempt || { request: savedRequest || (await operations.prepareHostedRequest()), idempotencyKey: operations.createIdempotencyKey() };
    await operations.persistHostedAttempt(attempt);
    let result: ReadAssetResponse;
    try {
        result = await operations.generateHosted(attempt);
    } catch (error) {
        if (error instanceof HostedMediaError && (error.code === "hosted_generation_safe_new_attempt" || error.code === "hosted_generation_failed")) await operations.invalidateHostedAttempt(attempt.request);
        throw error;
    }
    await operations.applyHostedResult(result, attempt);
    return "hosted" as const;
}

function isCompleteHostedVideoAttempt(value: unknown): value is HostedVideoAttempt {
    return isExactRecord(value, ["request", "idempotencyKey"], ["request", "idempotencyKey"]) && isCompleteHostedVideoRequest(value.request) && typeof value.idempotencyKey === "string" && IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey);
}

function sameHostedVideoAttempt(left: HostedVideoAttempt, right: HostedVideoAttempt) {
    return left.idempotencyKey === right.idempotencyKey && sameHostedVideoRequest(left.request, right.request);
}

function sameHostedVideoRequest(left: CreateArtBoxVideoGenerationBody | null, right: CreateArtBoxVideoGenerationBody) {
    return Boolean(
        left &&
        left.model === right.model &&
        left.promptTemplate === right.promptTemplate &&
        left.seconds === right.seconds &&
        left.generateAudio === right.generateAudio &&
        left.bindings.length === right.bindings.length &&
        left.bindings.every((binding, index) => binding.nodeId === right.bindings[index].nodeId && binding.kind === right.bindings[index].kind && binding.assetId === right.bindings[index].assetId),
    );
}

function hostedDurability(sync: Pick<CanvasSyncView, "phase" | "hasUnsavedEdits" | "localPersist">) {
    return sync.localPersist === "ok" || (sync.phase === "clean" && !sync.hasUnsavedEdits) ? ("durable" as const) : ("unsafe" as const);
}

function hostedPlatformError(error: unknown) {
    if (!(error instanceof PlatformApiError)) return error;
    if (error.code === "asset_storage_configuration_error") return new HostedMediaError("hosted_asset_storage_configuration", "素材存储服务未配置，请联系管理员");
    if (error.code === "provider_configuration_error") return new HostedMediaError("hosted_provider_configuration", "视频生成服务未配置，请联系管理员");
    return error;
}

function isCompleteHostedVideoRequest(value: unknown): value is CreateArtBoxVideoGenerationBody {
    if (!isExactRecord(value, ["model", "promptTemplate", "bindings", "seconds", "generateAudio"], ["model", "promptTemplate", "bindings", "seconds", "generateAudio"])) return false;
    const request = value as Partial<CreateArtBoxVideoGenerationBody>;
    return (
        request.model === HOSTED_ARTBOX_VIDEO_MODEL &&
        typeof request.promptTemplate === "string" &&
        Boolean(request.promptTemplate.trim()) &&
        typeof request.seconds === "string" &&
        Boolean(request.seconds.trim()) &&
        typeof request.generateAudio === "boolean" &&
        isDenseArray(request.bindings) &&
        request.bindings.every(
            (binding) =>
                isExactRecord(binding, ["nodeId", "kind", "assetId"], ["nodeId", "kind", "assetId"]) &&
                typeof binding.nodeId === "string" &&
                Boolean(binding.nodeId.trim()) &&
                typeof binding.assetId === "string" &&
                UUID_PATTERN.test(binding.assetId) &&
                (binding.kind === "image" || binding.kind === "video" || binding.kind === "audio"),
        )
    );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{21}$/;

function isExactRecord(value: unknown, allowedKeys: string[], requiredKeys: string[]): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    return keys.every((key) => typeof key === "string" && allowedKeys.includes(key) && "value" in Object.getOwnPropertyDescriptor(value, key)!) && requiredKeys.every((key) => keys.includes(key));
}

function isDenseArray(value: unknown): value is HostedMediaBinding[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) return false;
    }
    return true;
}

function terminalResult(generation: ArtBoxVideoGeneration) {
    if (generation.status !== "succeeded") return null;
    if (!generation.resultAssetId) throw new HostedMediaError("hosted_generation_result_missing", "Hosted video generation returned no result Asset");
    return generation.resultAssetId;
}

export function applyHostedVideoResult(nodes: CanvasNodeData[], targetNodeId: string, result: ReadAssetResponse, request?: CreateArtBoxVideoGenerationBody) {
    return nodes.map((node) => {
        if (node.id !== targetNodeId) return node;
        const { storageKey: _storageKey, ...metadata } = node.metadata || {};
        return {
            ...node,
            metadata: {
                ...metadata,
                ...(request
                    ? {
                          model: HOSTED_ARTBOX_VIDEO_MODEL_OPTION,
                          seconds: request.seconds,
                          generateAudio: String(request.generateAudio),
                          vquality: undefined,
                          watermark: undefined,
                      }
                    : {}),
                assetId: result.asset.id,
                content: result.displayUrl,
                status: "success" as const,
                errorDetails: undefined,
                mimeType: result.asset.contentType,
                bytes: result.asset.byteSize ?? undefined,
            },
        };
    });
}

function delay(milliseconds: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(resolve, milliseconds);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
