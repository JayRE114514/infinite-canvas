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
import { defaultConfig, HOSTED_ARTBOX_VIDEO_MODEL, isHostedArtBoxModel, selectableModelsByCapability, withHostedArtBoxVideoModel } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { applyHostedVideoResult, buildHostedVideoRequest, ensureAssetReady, HostedMediaError, requestHostedArtBoxVideo, type HostedMediaDependencies } from "./hosted-media";

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
});

describe("hosted Canvas integration helpers", () => {
    it("recognizes the hosted model and bypasses browser channel credentials", () => {
        expect(isHostedArtBoxModel(HOSTED_ARTBOX_VIDEO_MODEL)).toBe(true);
        const option = selectableModelsByCapability(withHostedArtBoxVideoModel(defaultConfig), "video").find(isHostedArtBoxModel);
        expect(option).toBeTruthy();
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
});

function mediaNode(id: string, type: CanvasNodeType.Image | CanvasNodeType.Video | CanvasNodeType.Audio, storageKey?: string, assetId?: string): CanvasNodeData {
    const content = assetId ? `https://display/${id}` : storageKey ? `blob:${id}` : undefined;
    return {
        id,
        type,
        title: id,
        position: { x: 0, y: 0 },
        width: 1,
        height: 1,
        metadata: { content, storageKey, assetId, mimeType: type === CanvasNodeType.Image ? "image/png" : type === CanvasNodeType.Video ? "video/mp4" : "audio/mpeg" },
    };
}
