import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
});

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { projectToSnapshot } from "@/lib/canvas/canvas-snapshot";
import { audioMetadata, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { createRecoveryDatabase } from "./database";
import { buildRecoveryScopeId } from "./scope";
import { createCanvasRecoveryStore, type CanvasRecoveryStore } from "./store";
import { asDraftRecord } from "./types";
import type { CanvasNodeData, CanvasProject } from "@/types/canvas";

const scopeId = buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })!;

/**
 * Exactly the shape `handleNodeContentChange` produces for an ordinary text node: the node has no
 * `texts` array, so spreading and reassigning it leaves an explicit own `texts: undefined` property.
 */
function editedTextNode(): CanvasNodeData {
    const existing = { id: "n1", type: "text", title: "T", x: 0, y: 0, metadata: { content: "before" } } as unknown as CanvasNodeData;
    return {
        ...existing,
        metadata: { ...existing.metadata, content: "after", texts: existing.metadata?.texts?.map((text) => text) },
    } as CanvasNodeData;
}

function project(node: CanvasNodeData): CanvasProject {
    return {
        id: "c1",
        title: "T",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        nodes: [node],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
    };
}

describe("canonical draft snapshot", () => {
    let store: CanvasRecoveryStore;

    beforeEach(() => {
        store = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
    });

    it("keeps an ordinary text edit persistable in local recovery", async () => {
        const snapshot = projectToSnapshot(project(editedTextNode()));
        const envelope = { document: { title: "T", baseRevision: 1, snapshot }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} };

        expect(asDraftRecord({ scopeId, draftId: "d1", writeSeq: 1, deletionGeneration: 0, state: "pending", envelope, savedAt: new Date(0).toISOString() }, scopeId)).not.toBeNull();
        expect(await store.upsertDraft({ scopeId, draftId: "d1", writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope, savedAt: new Date(0).toISOString() })).toEqual({
            status: "written",
            writeSeq: 1,
        });
    });

    /**
     * Cloud persistence serializes through JSON, so the local envelope must already be that exact
     * value. `toStrictEqual` is required here: `toEqual` ignores own `undefined` properties and would
     * pass even while the two representations diverge.
     */
    it("produces the same value cloud JSON persistence would store", () => {
        const snapshot = projectToSnapshot(project(editedTextNode()));
        expect(snapshot).toStrictEqual(JSON.parse(JSON.stringify(snapshot)));
    });

    it("drops transient generated images that have no stable storage identity", () => {
        const node = {
            id: "n1",
            type: "image",
            metadata: {
                images: [
                    { id: "temporary", status: "completed", content: "blob:temporary", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" },
                    { id: "stored", status: "completed", content: "blob:stored", storageKey: "image:stored", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" },
                ],
            },
        } as unknown as CanvasNodeData;

        const [snapshotNode] = (projectToSnapshot(project(node)) as unknown as { nodes: CanvasNodeData[] }).nodes;
        expect(snapshotNode.metadata?.images).toEqual([
            { id: "stored", status: "completed", content: "image:stored", storageKey: "image:stored", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" },
        ]);
    });

    it("deeply strips locations only from Asset-backed media", () => {
        const node = {
            id: "n1",
            type: "image",
            title: "asset",
            position: { x: 0, y: 0 },
            width: 1,
            height: 1,
            metadata: {
                assetId: "10000000-0000-4000-8000-000000000001",
                content: "https://display/temporary",
                storageKey: "image:local-copy",
                mimeType: "image/png",
                images: [
                    { id: "nested", assetId: "10000000-0000-4000-8000-000000000002", content: "blob:nested", storageKey: "image:nested", status: "success", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" },
                ],
            },
        } as unknown as CanvasNodeData;
        const local = { ...node, id: "local", metadata: { content: "https://local.example/image.png", storageKey: "image:local", mimeType: "image/png" } } as CanvasNodeData;

        const snapshot = projectToSnapshot({ ...project(node), nodes: [node, local] }) as unknown as { nodes: CanvasNodeData[] };
        expect(snapshot.nodes[0].metadata).toEqual({
            assetId: "10000000-0000-4000-8000-000000000001",
            mimeType: "image/png",
            images: [{ id: "nested", assetId: "10000000-0000-4000-8000-000000000002", status: "success", naturalWidth: 1, naturalHeight: 1, bytes: 1, mimeType: "image/png" }],
        });
        expect(snapshot.nodes[1].metadata).toEqual(local.metadata);
    });

    it("strips display locations from Asset-backed image, video, and audio nodes", () => {
        const nodes = (["image", "video", "audio"] as const).map((type, index) => ({
            id: type,
            type,
            title: type,
            position: { x: 0, y: 0 },
            width: 1,
            height: 1,
            metadata: { assetId: `10000000-0000-4000-8000-00000000000${index + 1}`, content: `https://display/${type}`, storageKey: `${type}:local`, mimeType: `${type}/test` },
        })) as CanvasNodeData[];

        const snapshot = projectToSnapshot({ ...project(nodes[0]), nodes }) as unknown as { nodes: CanvasNodeData[] };
        expect(snapshot.nodes.map((node) => node.metadata)).toEqual(nodes.map((node) => ({ assetId: node.metadata?.assetId, mimeType: node.metadata?.mimeType })));
    });

    it("keeps new local image, video, and audio bytes after replacing stale Asset identities", () => {
        const replacements = [
            ["image", imageMetadata({ url: "blob:new-image", storageKey: "image:new", width: 1, height: 1, bytes: 1, mimeType: "image/png" })],
            ["video", videoMetadata({ url: "blob:new-video", storageKey: "video:new", bytes: 1, mimeType: "video/mp4" })],
            ["audio", audioMetadata({ url: "blob:new-audio", storageKey: "audio:new", bytes: 1, mimeType: "audio/mpeg" })],
        ] as const;
        const nodes = replacements.map(([type, replacement], index) => ({
            id: type,
            type,
            title: type,
            position: { x: 0, y: 0 },
            width: 1,
            height: 1,
            metadata: { assetId: `10000000-0000-4000-8000-00000000000${index + 1}`, ...replacement },
        })) as CanvasNodeData[];

        const snapshot = projectToSnapshot({ ...project(nodes[0]), nodes }) as unknown as { nodes: CanvasNodeData[] };
        expect(snapshot.nodes.map((node) => node.metadata?.assetId)).toEqual([undefined, undefined, undefined]);
        expect(snapshot.nodes.map((node) => node.metadata?.content)).toEqual(["image:new", "video:new", "audio:new"]);
        expect(snapshot.nodes.map((node) => node.metadata?.storageKey)).toEqual(["image:new", "video:new", "audio:new"]);
    });

    /**
     * Canonicalization only drops `undefined` own properties. Everything else that is not JSON must
     * still reach the validator and be refused, and a cyclic snapshot must be refused rather than
     * crashing the serializer.
     */
    it("still refuses every non-JSON snapshot value instead of rewriting it", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const accessor = {};
        Object.defineProperty(accessor, "computed", { get: () => 1, enumerable: true });
        const sparse = new Array(1);

        const cases: unknown[] = [new Date(), new Map(), new Set(), /re/, () => undefined, Symbol("bad"), Number.NaN, Number.POSITIVE_INFINITY, sparse, cyclic, accessor, BigInt(1)];

        for (const value of cases) {
            const node = { id: "n1", type: "text", metadata: { content: "x", bad: value } } as unknown as CanvasNodeData;
            const snapshot = projectToSnapshot(project(node));
            const envelope = { document: { title: "T", baseRevision: 1, snapshot }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} };
            expect(asDraftRecord({ scopeId, draftId: "d1", writeSeq: 1, deletionGeneration: 0, state: "pending", envelope, savedAt: new Date(0).toISOString() }, scopeId)).toBeNull();
        }
    });
});
