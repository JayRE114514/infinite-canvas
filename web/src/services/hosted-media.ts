import type { ArtBoxVideoGeneration, CreateArtBoxVideoGenerationBody, HostedMediaBinding, ReadAssetResponse } from "@infinite-canvas/contracts";
import { nanoid } from "nanoid";

import { completeAsset, createAsset, readAsset, uploadAsset } from "@/services/api/assets";
import { createArtBoxVideoGeneration, pollArtBoxVideoGeneration } from "@/services/api/artbox";
import { VIDEO_GENERATION_POLL_ATTEMPTS, VIDEO_GENERATION_POLL_INTERVAL_MS } from "@/services/api/video";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { HOSTED_ARTBOX_VIDEO_MODEL, HOSTED_ARTBOX_VIDEO_MODEL_OPTION, isHostedArtBoxModel } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { HostedMediaSource } from "@/types/media";

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
        readonly code: "hosted_media_bytes_missing" | "hosted_asset_not_ready" | "hosted_generation_failed" | "hosted_generation_reconciling" | "hosted_generation_timeout" | "hosted_generation_result_missing",
        message: string,
    ) {
        super(message);
        this.name = "HostedMediaError";
    }
}

export async function ensureAssetReady(workspaceId: string, source: HostedMediaSource, deps: HostedMediaDependencies = defaultDependencies, signal?: AbortSignal) {
    if (source.assetId) return source.assetId;
    const blob = source.storageKey ? await (source.kind === "image" ? deps.getImageBlob(source.storageKey) : deps.getMediaBlob(source.storageKey)) : null;
    if (!blob) throw new HostedMediaError("hosted_media_bytes_missing", `Local ${source.kind} bytes are missing for node ${source.nodeId}`);
    const created = await deps.createAsset(workspaceId, { kind: source.kind, fileName: source.fileName, contentType: source.contentType });
    await deps.uploadAsset(created.upload, blob, signal);
    const completed = await deps.completeAsset(workspaceId, created.asset.id);
    if (completed.status !== "ready") throw new HostedMediaError("hosted_asset_not_ready", `Asset is not ready for node ${source.nodeId}`);
    return completed.id;
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
    idempotencyKey?: string;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
    create?: typeof createArtBoxVideoGeneration;
    poll?: typeof pollArtBoxVideoGeneration;
    read?: typeof readAsset;
};

export async function requestHostedArtBoxVideo(workspaceId: string, body: CreateArtBoxVideoGenerationBody, options: HostedVideoRequestOptions = {}): Promise<ReadAssetResponse> {
    const create = options.create || createArtBoxVideoGeneration;
    const poll = options.poll || pollArtBoxVideoGeneration;
    const read = options.read || readAsset;
    const wait = options.wait || delay;
    let generation = await create(workspaceId, body, options.idempotencyKey || nanoid(), options.signal);
    for (let attempt = 0; attempt < VIDEO_GENERATION_POLL_ATTEMPTS; attempt += 1) {
        const resultAssetId = terminalResult(generation);
        if (resultAssetId) return read(workspaceId, resultAssetId);
        if (generation.status === "reconciling") throw new HostedMediaError("hosted_generation_reconciling", generation.error?.message || "Hosted video generation requires reconciliation");
        if (generation.status === "failed") throw new HostedMediaError("hosted_generation_failed", generation.error?.message || "Hosted video generation failed");
        if (attempt === VIDEO_GENERATION_POLL_ATTEMPTS - 1) throw new HostedMediaError("hosted_generation_timeout", "Hosted video generation timed out");
        await wait(VIDEO_GENERATION_POLL_INTERVAL_MS, options.signal);
        generation = await poll(workspaceId, generation.id, options.signal);
    }
    throw new HostedMediaError("hosted_generation_timeout", "Hosted video generation timed out");
}

export function videoGenerationRoute(model: string, savedRequest?: CreateArtBoxVideoGenerationBody | null) {
    return savedRequest || isHostedArtBoxModel(model) ? "hosted" : "local";
}

export function resolveHostedVideoRequest(node: CanvasNodeData, fallback: CreateArtBoxVideoGenerationBody | null) {
    return isCompleteHostedVideoRequest(node.metadata?.hostedRequest) ? node.metadata.hostedRequest : fallback;
}

export function saveHostedVideoRequest(nodes: CanvasNodeData[], targetNodeId: string, request: CreateArtBoxVideoGenerationBody) {
    return nodes.map((node) => (node.id === targetNodeId ? { ...node, metadata: { ...node.metadata, hostedRequest: request } } : node));
}

export type CanvasVideoGenerationOperations = {
    model: string;
    savedRequest: CreateArtBoxVideoGenerationBody | null;
    prepareHostedRequest: () => Promise<CreateArtBoxVideoGenerationBody>;
    persistHostedRequest: (request: CreateArtBoxVideoGenerationBody) => Promise<void>;
    generateHosted: (request: CreateArtBoxVideoGenerationBody) => Promise<ReadAssetResponse>;
    applyHostedResult: (result: ReadAssetResponse, request: CreateArtBoxVideoGenerationBody) => void | Promise<void>;
    generateLocal: () => Promise<void>;
};

export async function runCanvasVideoGeneration(operations: CanvasVideoGenerationOperations) {
    if (videoGenerationRoute(operations.model, operations.savedRequest) === "local") {
        await operations.generateLocal();
        return "local" as const;
    }
    const request = operations.savedRequest || (await operations.prepareHostedRequest());
    await operations.persistHostedRequest(request);
    const result = await operations.generateHosted(request);
    await operations.applyHostedResult(result, request);
    return "hosted" as const;
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
