import { beforeEach, describe, expect, it, vi } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { PlatformApiError } from "../api/platform-client";
import { createRecoveryDatabase } from "../canvas-recovery/database";
import { buildRecoveryScopeId } from "../canvas-recovery/scope";
import { createCanvasRecoveryStore, type CanvasRecoveryStore } from "../canvas-recovery/store";
import { resolveCanvasOpenRecovery } from "./canvas-recovery-coordinator";
import { cleanResolution, createCanvasSyncSession } from "./canvas-sync-session";
import type { CanvasLoadResult, CanvasSessionRecoveryCoordinator, CanvasSyncRepository } from "./types";
import type { CanvasProject } from "@/types/canvas";

const scope = { userId: "u1", workspaceId: "w1" };
const scopeId = buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })!;

const project = (viewport = { x: 0, y: 0, k: 1 }): CanvasProject => ({
    id: "c1",
    title: "T",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "dots",
    showImageInfo: false,
    viewport,
});

const load = (): CanvasLoadResult => ({ project: project(), revision: 1 });

function repository(save: CanvasSyncRepository["save"] = async () => load()): CanvasSyncRepository {
    return {
        list: async () => [],
        load: async () => load(),
        create: async () => load(),
        importProject: async () => load(),
        save,
        remove: async () => ({ status: "indeterminate", reason: "unknown", messageKey: "canvas.delete.unconfirmed" }),
    };
}

const coordinator: CanvasSessionRecoveryCoordinator = {
    publishConflict: async () => ({ status: "published", extraDraftCount: 0 }),
    retryRecovery: async () => ({ status: "failed" }),
    exportConflictDrafts: async () => null,
    retireSupersededDrafts: async () => undefined,
};

describe("session transactional draft CAS", () => {
    let store: CanvasRecoveryStore;

    beforeEach(() => {
        store = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
    });

    /** 会话独占自己的草稿行，因此序号从自己开始，永不接管别人的行。 */
    it("opens a session-owned draft row starting from its own sequence", async () => {
        const resolution = await resolveCanvasOpenRecovery(store, scopeId, load(), () => "mine");
        const writes: number[] = [];
        const writeDraft: CanvasRecoveryStore["upsertDraft"] = async (input, signal) => {
            writes.push(input.writeSeq);
            return store.upsertDraft(input, signal);
        };
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution },
            { repository: repository(), writeDraft, coordinator, now: () => 1_000, isDev: false },
        );
        session.install(resolution.content);
        expect(session.draftId).toBe("mine");

        session.update({ nodes: [{ id: "first" }] as never });
        await session.flush();
        expect(writes[0]).toBe(1);
        await session.dispose("forced");
    });

    /**
     * superseded 意味着这一行已被别的写者接管。本会话必须转为 degraded 并保留对方内容，
     * 绝不能用自己的快照覆盖回去。
     */
    it("never overwrites a draft row another writer already owns", async () => {
        const foreign = { document: { title: "foreign", baseRevision: 1, snapshot: { viewport: { x: 0, y: 0, k: 1 } } }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} };
        await store.upsertDraft({ scopeId, draftId: "shared", writeSeq: 5, expectedDeletionGeneration: 0, state: "pending", envelope: foreign, savedAt: new Date(0).toISOString() });
        const save = vi.fn(async () => {
            throw new PlatformApiError("platform_network_error", 0, true);
        });
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(), "shared", { coordinationRevision: 0, deletionGeneration: 0 }) },
            { repository: repository(save), writeDraft: store.upsertDraft, coordinator, now: () => 1_000, isDev: false },
        );
        session.install(load().project);

        session.update({ nodes: [{ id: "mine" }] as never });
        await session.flush();

        expect(session.view.localPersist).toBe("degraded");
        const opened = await store.readOpenSnapshot(scopeId);
        if (opened.status !== "ok") throw new Error("expected ok");
        expect(opened.snapshot.drafts).toHaveLength(1);
        expect(opened.snapshot.drafts[0]).toMatchObject({ draftId: "shared", writeSeq: 5 });
        expect(opened.snapshot.drafts[0].envelope.document.title).toBe("foreign");
        await session.dispose("forced");
    });

    it("reports unavailable persistence as degraded and a tombstone as terminal", async () => {
        const build = (writeDraft: CanvasRecoveryStore["upsertDraft"]) => {
            const session = createCanvasSyncSession(
                { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }) },
                { repository: repository(), writeDraft, coordinator, now: () => 1_000, isDev: false },
            );
            session.install(load().project);
            return session;
        };

        const degraded = build(async () => ({ status: "unavailable", reason: "timeout" }));
        degraded.update({ nodes: [{ id: "second" }] as never });
        await degraded.flush();
        expect(degraded.view.localPersist).toBe("degraded");
        await degraded.dispose("forced");

        const tombstoned = build(async () => ({ status: "tombstoned" }));
        tombstoned.update({ nodes: [{ id: "third" }] as never });
        await tombstoned.flush();
        expect(tombstoned.view).toMatchObject({ phase: "tombstoned", localPersist: "tombstoned" });
    });

    it("persists live viewport locally without editing or saving it as the canonical document viewport", async () => {
        const save = vi.fn(async (_workspaceId: string, _canvasId: string, input: Parameters<CanvasSyncRepository["save"]>[2]) => ({ project: project(), revision: input.baseRevision + 1 }));
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }) },
            { repository: repository(save), writeDraft: store.upsertDraft, coordinator, now: () => 1_000, isDev: false },
        );
        session.install(project());

        expect(session.update({ viewport: { x: 90, y: 45, k: 2 } })).toBe(false);
        await session.flush();
        expect(save).not.toHaveBeenCalled();
        expect(session.view.hasUnsavedEdits).toBe(false);

        session.update({ nodes: [{ id: "edited" }] as never });
        await session.flush();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][2].snapshot.viewport).toEqual({ x: 0, y: 0, k: 1 });

        const opened = await store.readOpenSnapshot(scopeId);
        if (opened.status !== "ok") throw new Error("expected ok");
        expect(opened.snapshot.drafts[0].envelope.document.snapshot.viewport).toEqual({ x: 0, y: 0, k: 1 });
        expect(opened.snapshot.drafts[0].envelope.localUi.viewport).toEqual({ x: 90, y: 45, k: 2 });
        await session.dispose("forced");
    });
});
