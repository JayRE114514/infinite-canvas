import { beforeEach, describe, expect, it } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { projectToSnapshot } from "@/lib/canvas/canvas-snapshot";
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
