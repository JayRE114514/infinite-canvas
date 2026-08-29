import { beforeEach, describe, expect, it, vi } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { PlatformApiError } from "../api/platform-client";
import { createRecoveryDatabase } from "../canvas-recovery/database";
import { buildRecoveryScopeId } from "../canvas-recovery/scope";
import { createCanvasRecoveryStore, type CanvasRecoveryStore } from "../canvas-recovery/store";
import { createCanvasSyncManager } from "./canvas-sync-manager";
import type { CanvasSyncRepository } from "./types";
import type { CanvasProject } from "@/types/canvas";

const scope = { userId: "u1", workspaceId: "w1" };
const scopeId = buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })!;

const project = (id = "c1"): CanvasProject => ({
    id,
    title: "T",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "dots",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
});

function repository(overrides: Partial<CanvasSyncRepository> = {}): CanvasSyncRepository {
    return {
        list: async () => [],
        load: async (_workspaceId, canvasId) => ({ project: project(canvasId), revision: 1 }),
        create: async () => ({ project: project(), revision: 1 }),
        importProject: async () => ({ project: project(), revision: 1 }),
        save: async (_workspaceId, _canvasId, input) => ({ project: project(), revision: input.baseRevision + 1 }),
        remove: async () => ({ status: "deleted", receipt: { canvasId: "c1", deletionReceipt: "receipt", deletedAt: new Date(0).toISOString() } }),
        ...overrides,
    };
}

const draftEnvelope = { document: { title: "foreign", baseRevision: 1, snapshot: { viewport: { x: 0, y: 0, k: 1 } } }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} };

const offlineRepository = () =>
    repository({
        save: async () => {
            throw new PlatformApiError("platform_network_error", 0, true);
        },
    });

const draftNodeIds = (snapshot: { nodes?: { id: string }[] }) => (snapshot.nodes ?? []).map((node) => node.id);

describe("manager recovery coordination", () => {
    let store: CanvasRecoveryStore;

    beforeEach(() => {
        store = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
    });

    /**
     * Two tabs on one canvas are two independent editors. Each must own its own draft row, or the
     * second tab's write replaces content the first tab has not synced anywhere.
     */
    it("gives each tab its own draft row so one tab never overwrites another tab's unsynced edits", async () => {
        const openTab = async (draftId: string) => {
            const manager = createCanvasSyncManager({ repository: offlineRepository(), recovery: store, now: () => 1_000, createDraftId: () => draftId, isDev: false });
            manager.setScope(scope);
            const prepared = await manager.prepareOpen("c1");
            manager.commitPrepared(prepared, project());
            return manager.getActiveSession()!;
        };
        const edit = async (session: { update: (patch: never) => boolean; flush: () => Promise<void> }, ids: string[]) => {
            session.update({ nodes: ids.map((id) => ({ id })) } as never);
            await session.flush();
        };

        const tabA = await openTab("draft-a");
        await edit(tabA, ["a1"]);
        const tabB = await openTab("draft-b");
        await edit(tabB, ["a1", "b1"]);
        await edit(tabA, ["a1", "a2"]);

        const opened = await store.readOpenSnapshot(scopeId);
        if (opened.status !== "ok") throw new Error("expected ok");
        const pending = opened.snapshot.drafts.filter((draft) => draft.state === "pending");
        const recoverable = pending.map((draft) => draftNodeIds(draft.envelope.document.snapshot));
        expect(recoverable.some((ids) => ids.includes("a2"))).toBe(true);
        expect(recoverable.some((ids) => ids.includes("b1"))).toBe(true);
        expect(new Set(pending.map((draft) => draft.draftId)).size).toBe(2);
    });

    it("re-reads and retries server-copy conflict cleanup after a coordination race without tombstoning", async () => {
        await store.upsertDraft({ scopeId, draftId: "foreign", writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope: draftEnvelope, savedAt: new Date(0).toISOString() });
        await store.commitCoordination({ scopeId, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [{ draftId: "foreign", baseRevision: 1, savedAt: new Date(0).toISOString() }] });
        const base = store;
        let injected = false;
        const racing = {
            ...base,
            collectGarbage: vi.fn(async () => ({ status: "committed", coordinationRevision: 1 }) as const),
            commitCoordination: vi.fn(async (input, signal) => {
                if (!injected && input.marker === null) {
                    injected = true;
                    const current = await base.readOpenSnapshot(scopeId);
                    if (current.status !== "ok") throw new Error("expected ok");
                    await base.commitCoordination({
                        scopeId,
                        expectedCoordinationRevision: current.snapshot.epoch.coordinationRevision,
                        expectedDeletionGeneration: current.snapshot.epoch.deletionGeneration,
                        marker: current.snapshot.marker?.entries ?? null,
                    });
                }
                return base.commitCoordination(input, signal);
            }),
        } satisfies CanvasRecoveryStore;
        const manager = createCanvasSyncManager({ repository: repository(), recovery: racing, now: () => 1_000, createDraftId: () => "draft-1", isDev: false });
        manager.setScope(scope);
        const opened = await manager.prepareOpen("c1");
        manager.commitPrepared(opened, project());
        const serverCopy = await manager.prepareServerCopy("c1");
        expect(manager.commitServerCopy(serverCopy, project())).toBe("committed");

        await vi.waitFor(async () => {
            const after = await base.readOpenSnapshot(scopeId);
            if (after.status !== "ok") throw new Error("expected ok");
            expect(after.snapshot.marker).toBeNull();
            expect(after.snapshot.drafts.map((draft) => draft.draftId)).not.toContain("foreign");
            expect(after.snapshot.epoch).toMatchObject({ deletionGeneration: 0, tombstonedAt: null });
        });
        expect(racing.commitCoordination).toHaveBeenCalledTimes(2);
    });

    it("preserves recovery for non-proof deletes and unavailable GC, but tombstones a proven deletion", async () => {
        for (const remove of [
            async () => ({ status: "denied", code: "canvas_not_found", messageKey: "canvas.delete.unavailable" }) as const,
            async () => ({ status: "indeterminate", reason: "network", messageKey: "canvas.delete.unconfirmed" }) as const,
        ]) {
            store = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
            const manager = createCanvasSyncManager({ repository: repository({ remove }), recovery: store, now: () => 1_000, createDraftId: () => "draft-1", isDev: false });
            manager.setScope(scope);
            const prepared = await manager.prepareOpen("c1");
            manager.commitPrepared(prepared, project());
            manager.getActiveSession()!.update({ nodes: [{ id: "local" }] as never });
            await manager.getActiveSession()!.flush();
            expect(await manager.deleteCanvases(["c1"])).toEqual({ deleted: [], failed: ["c1"], localCleanupPending: [] });
            const preserved = await store.readOpenSnapshot(scopeId);
            if (preserved.status !== "ok") throw new Error("expected preserved recovery");
            expect(preserved.snapshot.drafts.length).toBeGreaterThan(0);
        }

        const provenStore = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
        const proven = createCanvasSyncManager({ repository: repository(), recovery: provenStore, now: () => 1_000, createDraftId: () => "draft-1", isDev: false });
        proven.setScope(scope);
        const prepared = await proven.prepareOpen("c1");
        proven.commitPrepared(prepared, project());
        expect(await proven.deleteCanvases(["c1"])).toEqual({ deleted: ["c1"], failed: [], localCleanupPending: [] });
        expect(await provenStore.readOpenSnapshot(scopeId)).toEqual({ status: "tombstoned", deletionGeneration: 1 });

        const collectGarbage = vi.fn(async () => ({ status: "committed", coordinationRevision: 1 }) as const);
        const unavailable = { ...provenStore, readOpenSnapshot: vi.fn(async () => ({ status: "unavailable", reason: "timeout" }) as const), collectGarbage };
        const unavailableManager = createCanvasSyncManager({ repository: repository(), recovery: unavailable, now: () => 1_000, createDraftId: () => "draft-1", isDev: false });
        unavailableManager.setScope(scope);
        const unavailablePrepared = await unavailableManager.prepareOpen("c1");
        unavailableManager.commitPrepared(unavailablePrepared, project());
        if (unavailablePrepared.status !== "ready") throw new Error("expected ready");
        await vi.waitFor(() => expect(unavailablePrepared.session.view.localPersist).toBe("degraded"));
        expect(collectGarbage).not.toHaveBeenCalled();
    });

    /**
     * A canvas the server proved deleted is gone, even when the local tombstone cannot be written.
     * Reporting it as "failed" would tell the user their canvas was preserved, which is false, and
     * a retry can never succeed because the second DELETE returns 404.
     */
    it("reports a proven deletion as deleted even when the local tombstone is unavailable", async () => {
        const recovery = {
            ...store,
            confirmDeletion: vi.fn(async () => ({ status: "unavailable", reason: "timeout" }) as const),
        } satisfies CanvasRecoveryStore;
        const manager = createCanvasSyncManager({ repository: repository(), recovery, now: () => 1_000, createDraftId: () => "draft-1", isDev: false });
        manager.setScope(scope);

        expect(await manager.deleteCanvases(["c1"])).toEqual({ deleted: ["c1"], failed: [], localCleanupPending: ["c1"] });
    });

    /**
     * A session copies a recovered draft forward into its own row. Once that copy is durable the
     * source row is redundant, so it must be retired: leaving it pending would make a canvas that
     * saved cleanly reopen as a conflict, and GC may not collect unsynced rows.
     */
    it("retires a recovered draft row once its content is saved, so reopening stays clean", async () => {
        let revision = 1;
        const stateful = repository({
            load: async (_workspaceId, canvasId) => ({ project: project(canvasId), revision }),
            save: async (_workspaceId, _canvasId, input) => {
                revision = input.baseRevision + 1;
                return { project: project(), revision };
            },
        });
        await store.upsertDraft({
            scopeId,
            draftId: "recovered",
            writeSeq: 1,
            expectedDeletionGeneration: 0,
            state: "pending",
            envelope: { document: { title: "T", baseRevision: 1, snapshot: { viewport: { x: 0, y: 0, k: 1 } } }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} },
            savedAt: new Date(0).toISOString(),
        });

        let owned = 0;
        const manager = createCanvasSyncManager({ repository: stateful, recovery: store, now: () => 1_000, createDraftId: () => `own-${++owned}`, isDev: false });
        manager.setScope(scope);
        const first = await manager.prepareOpen("c1");
        manager.commitPrepared(first, project());
        const session = manager.getActiveSession()!;
        await session.flush();
        await vi.waitFor(() => expect(session.view.phase).toBe("clean"));
        await vi.waitFor(async () => {
            const settled = await store.readOpenSnapshot(scopeId);
            if (settled.status !== "ok") throw new Error("expected ok");
            expect(settled.snapshot.drafts.filter((draft) => draft.state === "pending")).toHaveLength(0);
        });

        const second = await manager.prepareOpen("c1");
        if (second.status !== "ready") throw new Error("expected ready");
        manager.commitPrepared(second, project());
        expect(second.session.view.phase).toBe("clean");
        expect(second.session.view.conflict).toBeNull();
    });

    /**
     * The real-Chrome retry path: a session opens while recovery is unavailable, the user keeps
     * editing, the store becomes healthy again, and 重新检查 runs. Unlocking must re-establish
     * trustworthy local ownership — this session's own row under the fresh epoch — before cloud
     * saving resumes. Clearing the phase alone would leave the canvas unrecoverable while claiming
     * it is saved.
     */
    it("re-establishes an owned draft row before retry unlocks cloud saving", async () => {
        let available = false;
        const gated: CanvasRecoveryStore = {
            ...store,
            readOpenSnapshot: async (scopeId, signal) => (available ? store.readOpenSnapshot(scopeId, signal) : { status: "unavailable", reason: "timeout" }),
            upsertDraft: async (input, signal) => (available ? store.upsertDraft(input, signal) : { status: "unavailable", reason: "timeout" }),
            commitCoordination: async (input, signal) => (available ? store.commitCoordination(input, signal) : { status: "unavailable", reason: "timeout" }),
        };

        const saved: string[][] = [];
        const repo = repository({
            save: async (_workspaceId, _canvasId, input) => {
                saved.push(((input.snapshot as { nodes?: { id: string }[] }).nodes ?? []).map((node) => node.id));
                return { project: project(), revision: input.baseRevision + 1 };
            },
        });
        const manager = createCanvasSyncManager({ repository: repo, recovery: gated, now: () => 1_000, createDraftId: () => "own-1", isDev: false });
        manager.setScope(scope);
        const prepared = await manager.prepareOpen("c1");
        manager.commitPrepared(prepared, project());
        const session = manager.getActiveSession()!;
        await vi.waitFor(() => expect(session.view.phase).toBe("recovery-blocked"));

        /** Edits made while recovery is blocked exist only in memory and must survive the retry. */
        session.update({ nodes: [{ id: "blocked-edit" }] as never });
        await session.flush();
        expect(saved).toEqual([]);

        available = true;
        expect(await session.retryRecovery()).toBe("unlocked");

        expect(session.content.nodes.map((node) => node.id)).toEqual(["blocked-edit"]);
        expect(session.view.localPersist).toBe("ok");

        const opened = await store.readOpenSnapshot(scopeId);
        if (opened.status !== "ok") throw new Error("expected ok");
        const own = opened.snapshot.drafts.find((draft) => draft.draftId === session.draftId);
        expect(own).toBeDefined();
        expect(((own!.envelope.document.snapshot as { nodes?: { id: string }[] }).nodes ?? []).map((node) => node.id)).toEqual(["blocked-edit"]);
        expect(own!.deletionGeneration).toBe(opened.snapshot.epoch.deletionGeneration);

        await vi.waitFor(() => expect(saved).toEqual([["blocked-edit"]]));
    });

    /**
     * The two refusal boundaries of that retry. A retry whose own-row write cannot be confirmed must
     * stay blocked rather than report success, and a retry that finds another editor's pending draft
     * must surface a conflict while preserving both copies.
     */
    it("keeps retry blocked without a confirmed own row, and never discards a foreign draft", async () => {
        const openable: CanvasRecoveryStore = { ...store, upsertDraft: async () => ({ status: "unavailable", reason: "timeout" }) };
        const blocked = createCanvasSyncManager({ repository: repository(), recovery: openable, now: () => 1_000, createDraftId: () => "own-1", isDev: false });
        blocked.setScope(scope);
        const first = await blocked.prepareOpen("c1");
        blocked.commitPrepared(first, project());
        const blockedSession = blocked.getActiveSession()!;
        blockedSession.update({ nodes: [{ id: "kept" }] as never });
        await blockedSession.flush();

        /** The store opens fine, so only the unconfirmed own-row write may hold the retry back. */
        expect(await blockedSession.retryRecovery()).toBe("failed");
        expect(blockedSession.view.localPersist).toBe("degraded");
        expect(blockedSession.content.nodes.map((node) => node.id)).toEqual(["kept"]);

        const foreignStore = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
        await foreignStore.upsertDraft({ scopeId, draftId: "foreign", writeSeq: 3, expectedDeletionGeneration: 0, state: "pending", envelope: draftEnvelope, savedAt: new Date(0).toISOString() });
        let reachable = false;
        const gated: CanvasRecoveryStore = {
            ...foreignStore,
            readOpenSnapshot: async (id, signal) => (reachable ? foreignStore.readOpenSnapshot(id, signal) : { status: "unavailable", reason: "timeout" }),
            upsertDraft: async (input, signal) => (reachable ? foreignStore.upsertDraft(input, signal) : { status: "unavailable", reason: "timeout" }),
        };
        const manager = createCanvasSyncManager({ repository: repository(), recovery: gated, now: () => 1_000, createDraftId: () => "own-2", isDev: false });
        manager.setScope(scope);
        const prepared = await manager.prepareOpen("c1");
        manager.commitPrepared(prepared, project());
        const session = manager.getActiveSession()!;
        await vi.waitFor(() => expect(session.view.phase).toBe("recovery-blocked"));
        session.update({ nodes: [{ id: "mine" }] as never });
        await session.flush();

        reachable = true;
        expect(await session.retryRecovery()).toBe("conflict");

        const opened = await foreignStore.readOpenSnapshot(scopeId);
        if (opened.status !== "ok") throw new Error("expected ok");
        const foreign = opened.snapshot.drafts.find((draft) => draft.draftId === "foreign");
        expect(foreign).toMatchObject({ writeSeq: 3, state: "pending" });
        expect(foreign!.envelope.document.title).toBe("foreign");
        expect(opened.snapshot.drafts.some((draft) => draft.draftId === session.draftId)).toBe(true);
    });
});
