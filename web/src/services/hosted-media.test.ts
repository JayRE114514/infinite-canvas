import type { Asset, CreateAssetResponse } from "@infinite-canvas/contracts";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        },
    });
});

import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { hydrateCanvasImages } from "@/lib/canvas/canvas-generation-helpers";
import { audioMetadata, imageMetadata, primaryImageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { defaultConfig, encodeChannelModel, HOSTED_ARTBOX_CHANNEL_ID, HOSTED_ARTBOX_VIDEO_MODEL, HOSTED_ARTBOX_VIDEO_MODEL_OPTION, isHostedArtBoxModel, modelCapabilityOf, selectableModelsByCapability, withHostedArtBoxVideoModel } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { applyHostedVideoResult, buildHostedVideoRequest, ensureAssetReady, HostedMediaError, requestHostedArtBoxVideo, resolveHostedVideoRequest, saveHostedVideoRequest, submitHostedVideoRequest, videoGenerationRoute, type HostedMediaDependencies } from "./hosted-media";

const workspaceId = "10000000-0000-4000-8000-000000000002";
const asset = (id: string, kind: Asset["kind"] = "image", status: Asset["status"] = "ready"): Asset => ({
    id,
    workspaceId,
    kind,
    status,
    fileName: `${kind}.bin`,
    contentType: `${kind}/test`,
    byteSize: 3,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
});

function dependencies(blobs: Record<string, Blob | null> = {}): HostedMediaDependencies {
    let sequence = 0;
    return {
        createAsset: vi.fn(async (_workspaceId, body): Promise<CreateAssetResponse> => {
            sequence += 1;
            const created = asset(`10000000-0000-4000-8000-00000000000${sequence}`, body.kind, "staging");
            return { asset: created, upload: { url: `https://upload/${sequence}`, headers: { "x-sequence": String(sequence) } } };
        }),
        uploadAsset: vi.fn(async () => undefined),
        completeAsset: vi.fn(async (_workspaceId, id) => asset(id)),
        getImageBlob: vi.fn(async (key) => blobs[key] ?? null),
        getMediaBlob: vi.fn(async (key) => blobs[key] ?? null),
    };
}

describe("hosted media preparation", () => {
    it("reuses an existing stable assetId without touching local storage or upload APIs", async () => {
        const deps = dependencies();
        const id = "10000000-0000-4000-8000-000000000009";
        await expect(ensureAssetReady(workspaceId, { nodeId: "image", kind: "image", assetId: id, fileName: "image.png", contentType: "image/png" }, deps)).resolves.toBe(id);
        expect(deps.createAsset).not.toHaveBeenCalled();
        expect(deps.getImageBlob).not.toHaveBeenCalled();
        expect(deps.uploadAsset).not.toHaveBeenCalled();
    });

    it("uploads the exact IndexedDB Blob once for image, video, and audio inputs", async () => {
        const blobs = {
            "image:1": new Blob(["img"], { type: "image/png" }),
            "video:1": new Blob(["vid"], { type: "video/mp4" }),
            "audio:1": new Blob(["aud"], { type: "audio/mpeg" }),
        };
        const deps = dependencies(blobs);
        const sources = [
            { nodeId: "image", kind: "image" as const, storageKey: "image:1", fileName: "image.png", contentType: "image/png" },
            { nodeId: "video", kind: "video" as const, storageKey: "video:1", fileName: "video.mp4", contentType: "video/mp4" },
            { nodeId: "audio", kind: "audio" as const, storageKey: "audio:1", fileName: "audio.mp3", contentType: "audio/mpeg" },
        ];

        for (const source of sources) await ensureAssetReady(workspaceId, source, deps);

        expect(deps.createAsset).toHaveBeenCalledTimes(3);
        expect(deps.completeAsset).toHaveBeenCalledTimes(3);
        expect(deps.uploadAsset).toHaveBeenCalledTimes(3);
        expect(vi.mocked(deps.uploadAsset).mock.calls.map((call) => call[1])).toEqual(Object.values(blobs));
    });

    it("fails explicitly when the exact local bytes are missing", async () => {
        const deps = dependencies();
        await expect(ensureAssetReady(workspaceId, { nodeId: "audio", kind: "audio", storageKey: "audio:missing", fileName: "audio.mp3", contentType: "audio/mpeg" }, deps)).rejects.toMatchObject({ code: "hosted_media_bytes_missing" } satisfies Partial<HostedMediaError>);
        expect(deps.createAsset).not.toHaveBeenCalled();
    });

    it("keeps Composer tokens and every media binding in first-token order", async () => {
        const nodes = [
            mediaNode("image", CanvasNodeType.Image, "image:1", "10000000-0000-4000-8000-000000000001"),
            mediaNode("video", CanvasNodeType.Video, "video:1", "10000000-0000-4000-8000-000000000002"),
            mediaNode("audio", CanvasNodeType.Audio, "audio:1", "10000000-0000-4000-8000-000000000003"),
            { id: "config", type: CanvasNodeType.Config, title: "config", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { composerContent: "yes" } },
        ] satisfies CanvasNodeData[];
        const connections = ["image", "video", "audio"].map((id) => ({ id, fromNodeId: id, toNodeId: "config" })) satisfies CanvasConnection[];
        const promptTemplate = "听 @[node:audio]，参考 @[node:image]，跟随 @[node:video]，再次 @[node:image]";
        const context = buildNodeGenerationContext("config", nodes, connections, promptTemplate);
        const request = await buildHostedVideoRequest(
            { workspaceId, model: HOSTED_ARTBOX_VIDEO_MODEL, promptTemplate: context.promptTemplate, media: context.hostedMedia, seconds: "5", generateAudio: true },
            dependencies(),
        );

        expect(request.promptTemplate).toBe(promptTemplate);
        expect(request.bindings).toEqual([
            { nodeId: "audio", kind: "audio", assetId: "10000000-0000-4000-8000-000000000003" },
            { nodeId: "image", kind: "image", assetId: "10000000-0000-4000-8000-000000000001" },
            { nodeId: "video", kind: "video", assetId: "10000000-0000-4000-8000-000000000002" },
        ]);
    });

    it("builds a Provider template that expands text and group tokens without changing the local prompt", () => {
        const nodes = [
            mediaNode("direct-video", CanvasNodeType.Video, undefined, "10000000-0000-4000-8000-000000000001"),
            textNode("direct-text", "直接文字"),
            { id: "group", type: CanvasNodeType.Group, title: "group", position: { x: 0, y: 0 }, width: 1, height: 1 },
            mediaNode("group-image", CanvasNodeType.Image, undefined, "10000000-0000-4000-8000-000000000002", "group"),
            textNode("group-text", "组内文字", "group"),
            mediaNode("group-audio", CanvasNodeType.Audio, undefined, "10000000-0000-4000-8000-000000000003", "group"),
            { id: "config", type: CanvasNodeType.Config, title: "config", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { composerContent: "yes" } },
        ] satisfies CanvasNodeData[];
        const connections = ["direct-video", "direct-text", "group"].map((id) => ({ id, fromNodeId: id, toNodeId: "config" })) satisfies CanvasConnection[];
        const prompt = "直接 @[node:direct-video]；文字 @[node:direct-text]；组合 @[node:group]";
        const context = buildNodeGenerationContext("config", nodes, connections, prompt);

        expect(context.promptTemplate).toBe("直接 @[node:direct-video]；文字 直接文字；组合 @[node:group-image]、组内文字、@[node:group-audio]");
        expect(context.hostedMedia.map(({ nodeId, kind }) => ({ nodeId, kind }))).toEqual([
            { nodeId: "direct-video", kind: "video" },
            { nodeId: "group-image", kind: "image" },
            { nodeId: "group-audio", kind: "audio" },
        ]);
        expect(context.prompt).toContain("直接文字");
        expect(context.prompt).toContain("组内文字");
        expect(context.prompt).not.toContain("@[node:");
    });

    it("clears stale Asset identity for local bytes and adopts an Asset-backed batch primary", async () => {
        const oldAssetId = "10000000-0000-4000-8000-000000000009";
        const replacements = [
            imageMetadata({ url: "blob:new-image", storageKey: "image:new", width: 1, height: 1, bytes: 1, mimeType: "image/png" }),
            videoMetadata({ url: "blob:new-video", storageKey: "video:new", bytes: 1, mimeType: "video/mp4" }),
            audioMetadata({ url: "blob:new-audio", storageKey: "audio:new", bytes: 1, mimeType: "audio/mpeg" }),
        ];
        expect(replacements.map((metadata) => ({ ...{ assetId: oldAssetId }, ...metadata }).assetId)).toEqual([undefined, undefined, undefined]);

        const batchAssetId = "10000000-0000-4000-8000-000000000008";
        expect(primaryImageMetadata({ id: "batch", status: "success", content: "https://display/batch", assetId: batchAssetId, naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" }).assetId).toBe(batchAssetId);

        const node = { ...mediaNode("image", CanvasNodeType.Image), metadata: { assetId: oldAssetId, ...replacements[0] } };
        const config = { id: "config", type: CanvasNodeType.Config, title: "config", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { composerContent: "yes" } } satisfies CanvasNodeData;
        const context = buildNodeGenerationContext("config", [node, config], [{ id: "edge", fromNodeId: node.id, toNodeId: config.id }], "@[node:image]");
        const deps = dependencies({ "image:new": new Blob(["new"], { type: "image/png" }) });
        await buildHostedVideoRequest({ workspaceId, model: HOSTED_ARTBOX_VIDEO_MODEL, promptTemplate: context.promptTemplate, media: context.hostedMedia, seconds: "5", generateAudio: true }, deps);
        expect(context.hostedMedia[0].assetId).toBeUndefined();
        expect(deps.createAsset).toHaveBeenCalledOnce();
    });
});

describe("hosted Canvas integration helpers", () => {
    it("recognizes the hosted model and bypasses browser channel credentials", () => {
        const customValue = encodeChannelModel("custom", HOSTED_ARTBOX_VIDEO_MODEL);
        const config = {
            ...defaultConfig,
            channels: [...defaultConfig.channels, { id: "custom", name: "custom", baseUrl: "https://custom", apiKey: "key", apiFormat: "openai" as const, models: [{ name: HOSTED_ARTBOX_VIDEO_MODEL, capability: "audio" as const }] }],
        };
        const withHosted = withHostedArtBoxVideoModel(config);
        expect(isHostedArtBoxModel(HOSTED_ARTBOX_VIDEO_MODEL_OPTION)).toBe(true);
        expect(isHostedArtBoxModel(HOSTED_ARTBOX_VIDEO_MODEL)).toBe(false);
        expect(isHostedArtBoxModel(customValue)).toBe(false);
        expect(modelCapabilityOf(config, customValue)).toBe("audio");
        expect(withHosted.channels.find((channel) => channel.id === HOSTED_ARTBOX_CHANNEL_ID)).toBeTruthy();
        expect(selectableModelsByCapability(withHosted, "video")).toContain(HOSTED_ARTBOX_VIDEO_MODEL_OPTION);
        expect(withHosted.channels.filter((channel) => channel.models.some((model) => model.name === HOSTED_ARTBOX_VIDEO_MODEL))).toHaveLength(2);
    });

    it("selects hosted and local orchestration without hijacking a same-named custom model", () => {
        expect(videoGenerationRoute(HOSTED_ARTBOX_VIDEO_MODEL_OPTION)).toBe("hosted");
        expect(videoGenerationRoute(encodeChannelModel("custom", HOSTED_ARTBOX_VIDEO_MODEL))).toBe("local");
        expect(videoGenerationRoute("default::grok-imagine-video")).toBe("local");
    });

    it("keeps a saved hosted request on the hosted retry route and rejects corrupted model identity", () => {
        const request = { model: HOSTED_ARTBOX_VIDEO_MODEL, promptTemplate: "saved", bindings: [], seconds: "5", generateAudio: true };
        const saved = saveHostedVideoRequest([mediaNode("target", CanvasNodeType.Video)], "target", request)[0];
        const resolved = resolveHostedVideoRequest(saved, null);
        expect(resolved).toEqual(request);
        expect(videoGenerationRoute("default::grok-imagine-video", resolved)).toBe("hosted");

        const corrupted = { ...saved, metadata: { ...saved.metadata, hostedRequest: { ...request, model: "arbitrary-model" } } };
        expect(resolveHostedVideoRequest(corrupted, null)).toBeNull();
        const corruptedBinding = { ...saved, metadata: { ...saved.metadata, hostedRequest: { ...request, bindings: [{ nodeId: "image", kind: "image", assetId: "10000000-0000-4000-8000-000000000001", url: "https://forbidden" }] } } } as unknown as CanvasNodeData;
        expect(resolveHostedVideoRequest(corruptedBinding, null)).toBeNull();
    });

    it("hydrates Asset-backed image, video, and audio nodes with fresh display URLs", async () => {
        const nodes = [
            mediaNode("image", CanvasNodeType.Image, undefined, "10000000-0000-4000-8000-000000000001"),
            mediaNode("video", CanvasNodeType.Video, undefined, "10000000-0000-4000-8000-000000000002"),
            mediaNode("audio", CanvasNodeType.Audio, undefined, "10000000-0000-4000-8000-000000000003"),
        ];
        const read = vi.fn(async (_workspaceId: string, assetId: string) => ({ asset: asset(assetId, nodes.find((node) => node.metadata?.assetId === assetId)!.type as "image" | "video" | "audio"), displayUrl: `https://display/${assetId}` }));
        const hydrated = await hydrateCanvasImages(nodes, workspaceId, read);
        expect(read).toHaveBeenCalledTimes(3);
        expect(hydrated.map((node) => node.metadata?.content)).toEqual(nodes.map((node) => `https://display/${node.metadata?.assetId}`));
    });

    it("polls the local generation, reads the result Asset, and updates only the pre-created target", async () => {
        const resultAssetId = "10000000-0000-4000-8000-000000000008";
        const create = vi.fn(async () => ({ id: "g1", workspaceId, status: "processing" as const, resultAssetId: null, error: null, createdAt: "", updatedAt: "" }));
        const poll = vi.fn(async () => ({ id: "g1", workspaceId, status: "succeeded" as const, resultAssetId, error: null, createdAt: "", updatedAt: "" }));
        const read = vi.fn(async () => ({ asset: asset(resultAssetId, "video"), displayUrl: "https://display/result" }));
        const request = { model: HOSTED_ARTBOX_VIDEO_MODEL, promptTemplate: "go", bindings: [], seconds: "5", generateAudio: true };
        const result = await requestHostedArtBoxVideo(workspaceId, request, { idempotencyKey: "idem", wait: vi.fn(async () => undefined), create, poll, read });
        const initial = [mediaNode("source", CanvasNodeType.Image, "image:1"), mediaNode("target", CanvasNodeType.Video)];
        const once = applyHostedVideoResult(initial, "target", result);
        const twice = applyHostedVideoResult(once, "target", result);

        expect(create).toHaveBeenCalledOnce();
        expect(poll).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledWith(workspaceId, resultAssetId);
        expect(twice).toHaveLength(2);
        expect(twice.filter((node) => node.id === "target")).toHaveLength(1);
        expect(twice[1].metadata).toMatchObject({ assetId: resultAssetId, content: "https://display/result", status: "success" });
    });

    it("stops immediately on create-time and poll-time reconciliation with the public error", async () => {
        const request = { model: HOSTED_ARTBOX_VIDEO_MODEL, promptTemplate: "go", bindings: [], seconds: "5", generateAudio: true };
        const publicError = { code: "provider_submission_uncertain", message: "需要人工核对", retryable: false };
        const waitAtCreate = vi.fn(async () => undefined);
        const pollAtCreate = vi.fn();
        await expect(
            requestHostedArtBoxVideo(workspaceId, request, {
                create: vi.fn(async () => ({ id: "g1", workspaceId, status: "reconciling" as const, resultAssetId: null, error: publicError, createdAt: "", updatedAt: "" })),
                poll: pollAtCreate,
                wait: waitAtCreate,
            }),
        ).rejects.toMatchObject({ code: "hosted_generation_reconciling", message: publicError.message });
        expect(waitAtCreate).not.toHaveBeenCalled();
        expect(pollAtCreate).not.toHaveBeenCalled();

        const waitAtPoll = vi.fn(async () => undefined);
        const pollAtPoll = vi.fn(async () => ({ id: "g2", workspaceId, status: "reconciling" as const, resultAssetId: null, error: publicError, createdAt: "", updatedAt: "" }));
        await expect(
            requestHostedArtBoxVideo(workspaceId, request, {
                create: vi.fn(async () => ({ id: "g2", workspaceId, status: "processing" as const, resultAssetId: null, error: null, createdAt: "", updatedAt: "" })),
                poll: pollAtPoll,
                wait: waitAtPoll,
            }),
        ).rejects.toMatchObject({ code: "hosted_generation_reconciling", message: publicError.message });
        expect(waitAtPoll).toHaveBeenCalledOnce();
        expect(pollAtPoll).toHaveBeenCalledOnce();
    });

    it("saves the complete request before submission and uses it as retry authority", async () => {
        const request = {
            model: HOSTED_ARTBOX_VIDEO_MODEL,
            promptTemplate: "saved @[node:image]",
            bindings: [{ nodeId: "image", kind: "image" as const, assetId: "10000000-0000-4000-8000-000000000001" }],
            seconds: "5",
            aspectRatio: "16:9",
            resolution: "480p",
            generateAudio: true,
        };
        const initial = [mediaNode("source", CanvasNodeType.Image), mediaNode("target", CanvasNodeType.Video)];
        const saved = saveHostedVideoRequest(initial, "target", request);
        const changedGraphRequest = { ...request, promptTemplate: "changed", bindings: [] };
        expect(resolveHostedVideoRequest(saved[1], changedGraphRequest)).toEqual(request);
        expect(saved).toHaveLength(2);
        expect(saved[0]).toBe(initial[0]);
        expect(saved[1].metadata?.hostedRequest).toEqual(request);

        const order: string[] = [];
        await expect(
            submitHostedVideoRequest(workspaceId, request, (prepared) => {
                order.push("save");
                expect(prepared).toEqual(request);
            }, {
                create: vi.fn(async () => {
                    order.push("submit");
                    return { id: "g1", workspaceId, status: "reconciling" as const, resultAssetId: null, error: { code: "uncertain", message: "manual", retryable: false }, createdAt: "", updatedAt: "" };
                }),
                wait: vi.fn(async () => undefined),
            }),
        ).rejects.toMatchObject({ code: "hosted_generation_reconciling" });
        expect(order).toEqual(["save", "submit"]);
    });
});

function mediaNode(id: string, type: CanvasNodeType.Image | CanvasNodeType.Video | CanvasNodeType.Audio, storageKey?: string, assetId?: string, groupId?: string): CanvasNodeData {
    const content = assetId ? `https://display/${id}` : storageKey ? `blob:${id}` : undefined;
    return {
        id,
        type,
        title: id,
        position: { x: 0, y: 0 },
        width: 1,
        height: 1,
        metadata: { content, storageKey, assetId, groupId, mimeType: type === CanvasNodeType.Image ? "image/png" : type === CanvasNodeType.Video ? "video/mp4" : "audio/mpeg" },
    };
}

function textNode(id: string, content: string, groupId?: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { content, groupId } };
}
