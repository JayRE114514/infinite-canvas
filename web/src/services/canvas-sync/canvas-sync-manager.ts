import { nanoid } from "nanoid";

import { clampCanvasTitle, projectToImportBody, projectToSnapshot, projectToSummary } from "@/lib/canvas/canvas-snapshot";
import { platformErrorTranslationKey } from "@/services/api/platform-client";
import { buildRecoveryScopeId, type RecoveryScopeId } from "@/services/canvas-recovery/scope";
import { browserCanvasRecoveryStore, type CanvasRecoveryStore } from "@/services/canvas-recovery/store";
import { canvasRepository, classifyCanvasOpenError, classifyCanvasSaveError } from "@/services/canvas-repository";
import { coordinateOpenRepairs, createSessionRecoveryCoordinator, resolveCanvasOpenRecovery, serverCopyResolution } from "@/services/canvas-sync/canvas-recovery-coordinator";
import { createCanvasSyncSession, type CanvasSyncSessionDeps } from "@/services/canvas-sync/canvas-sync-session";
import {
    DRAFT_GC_MIN_AGE_MS,
    EXPORT_BATCH_SIZE,
    MAX_COORDINATION_ATTEMPTS,
    MAX_DETACHED_SESSIONS,
    sameCanvasScope,
    type CanvasCommitServerCopyResult,
    type CanvasCreateResult,
    type CanvasDeleteResult,
    type CanvasDisposeReason,
    type CanvasListResult,
    type CanvasLoadResult,
    type CanvasRecoveryResolution,
    type CanvasRenameResult,
    type CanvasSyncManager,
    type CanvasSyncRepository,
    type CanvasSyncSession,
    type PreparedCanvasOpen,
} from "@/services/canvas-sync/types";
import type { CanvasProject, CanvasScope } from "@/types/canvas";

export type CanvasSyncManagerDeps = {
    repository: CanvasSyncRepository;
    recovery: CanvasRecoveryStore;
    now: () => number;
    createDraftId: () => string;
    isDev: boolean;
};

type PreparedRecovery = { scopeId: RecoveryScopeId; load: CanvasLoadResult; resolution: CanvasRecoveryResolution };
type ScopeIdResult = { status: "ready"; scopeId: RecoveryScopeId } | { status: "invalid-scope"; messageKey: "canvas.recovery.invalidScope" };

/** Current cloud canvases use account scope; local scope remains reserved for a future local-only entrypoint. */
function scopeIdFor(current: CanvasScope, canvasId: string): ScopeIdResult {
    const scopeId = buildRecoveryScopeId({ kind: "account", userId: current.userId, workspaceId: current.workspaceId, canvasId });
    return scopeId ? { status: "ready", scopeId } : { status: "invalid-scope", messageKey: "canvas.recovery.invalidScope" };
}

/** 唯一的会话所有者：Session 只持有 draft writer，所有跨草稿协调都集中在这里。 */
export function createCanvasSyncManager(deps: CanvasSyncManagerDeps): CanvasSyncManager {
    let scope: CanvasScope | null = null;
    let scopeToken = 0;
    let openToken = 0;
    let sessionSeq = 0;
    let active: CanvasSyncSession | null = null;
    let activeUnsubscribe: (() => void) | null = null;
    const detached = new Set<CanvasSyncSession>();
    const preparedRecovery = new WeakMap<CanvasSyncSession, PreparedRecovery>();
    const listeners = new Set<() => void>();

    const notify = () => listeners.forEach((listener) => listener());
    const isStale = (token: number, open: number) => token !== scopeToken || open !== openToken;

    function sessionDeps(scopeId: RecoveryScopeId): CanvasSyncSessionDeps {
        return {
            repository: deps.repository,
            writeDraft: (input, signal) => deps.recovery.upsertDraft(input, signal),
            coordinator: createSessionRecoveryCoordinator(deps.recovery, scopeId, deps.createDraftId),
            now: deps.now,
            isDev: deps.isDev,
        };
    }

    /** Native transactions abort as a unit, so disposal needs no late-settlement watcher or compensation pass. */
    function detach(session: CanvasSyncSession, reason: CanvasDisposeReason) {
        detached.add(session);
        while (detached.size > MAX_DETACHED_SESSIONS) {
            const oldest = detached.values().next().value as CanvasSyncSession | undefined;
            if (!oldest || oldest === session) break;
            detached.delete(oldest);
            void oldest.dispose("forced");
        }
        void session.dispose(reason).finally(() => detached.delete(session));
    }

    function installSession(session: CanvasSyncSession, content: CanvasProject, previousReason: CanvasDisposeReason) {
        const previous = active;
        activeUnsubscribe?.();
        active = session;
        activeUnsubscribe = session.subscribe(notify);
        session.install(content);
        if (previous) detach(previous, previousReason);
        notify();
    }

    function setScope(next: CanvasScope | null) {
        const unchanged = scopeToken > 0 && ((scope === null && next === null) || sameCanvasScope(scope, next));
        if (unchanged) return;
        scopeToken += 1;
        openToken += 1;
        scope = next;
        const previous = active;
        activeUnsubscribe?.();
        activeUnsubscribe = null;
        active = null;
        if (previous) detach(previous, "scope-changed");
        notify();
    }

    async function prepare(canvasId: string, withRecovery: boolean): Promise<PreparedCanvasOpen> {
        const current = scope;
        if (!current) return { status: "cancelled" };
        const scopeResult = scopeIdFor(current, canvasId);
        if (scopeResult.status === "invalid-scope") return { status: "failed", messageKey: scopeResult.messageKey };
        const token = scopeToken;
        const open = ++openToken;
        let load: CanvasLoadResult;
        try {
            load = await deps.repository.load(current.workspaceId, canvasId);
        } catch (error) {
            if (isStale(token, open)) return { status: "cancelled" };
            const failure = classifyCanvasOpenError(error);
            return failure.kind === "missing" ? { status: "missing" } : { status: "failed", messageKey: failure.messageKey };
        }
        if (isStale(token, open)) return { status: "cancelled" };
        if (load.project.id !== canvasId) return { status: "missing" };

        let resolution: CanvasRecoveryResolution;
        if (withRecovery) {
            resolution = await resolveCanvasOpenRecovery(deps.recovery, scopeResult.scopeId, load, deps.createDraftId);
        } else {
            const opened = await deps.recovery.readOpenSnapshot(scopeResult.scopeId);
            if (opened.status === "ok") {
                resolution = serverCopyResolution(load, deps.createDraftId(), {
                    coordinationRevision: opened.snapshot.epoch.coordinationRevision,
                    deletionGeneration: opened.snapshot.epoch.deletionGeneration,
                });
            } else if (opened.status === "tombstoned") {
                resolution = { ...serverCopyResolution(load, deps.createDraftId(), { coordinationRevision: 0, deletionGeneration: opened.deletionGeneration }), phase: "tombstoned" };
            } else {
                resolution = { ...serverCopyResolution(load, deps.createDraftId(), { coordinationRevision: 0, deletionGeneration: 0 }), phase: "recovery-blocked" };
            }
        }
        if (isStale(token, open)) return { status: "cancelled" };

        const session = createCanvasSyncSession(
            { sessionId: ++sessionSeq, scope: current, scopeToken: token, openToken: open, canvasId, scopeId: scopeResult.scopeId, resolution },
            sessionDeps(scopeResult.scopeId),
        );
        preparedRecovery.set(session, { scopeId: scopeResult.scopeId, load, resolution });
        return { status: "ready", canvasId, project: resolution.content, session };
    }

    function commitAllowed(prepared: Extract<PreparedCanvasOpen, { status: "ready" }>, content: CanvasProject) {
        const session = prepared.session;
        return session.scopeToken === scopeToken && session.openToken === openToken && sameCanvasScope(session.scope, scope) && content.id === session.canvasId;
    }

    async function finishOpenCoordination(session: CanvasSyncSession, metadata: PreparedRecovery) {
        const outcome = await coordinateOpenRepairs(deps.recovery, metadata.scopeId, metadata.load, metadata.resolution, deps.createDraftId);
        if (outcome.status === "tombstoned") session.reportRecoveryState({ status: "tombstoned" });
        else if (outcome.status === "unavailable") session.reportRecoveryState({ status: "degraded" });
        else if (outcome.status === "conflict") session.reportRecoveryState({ status: "conflict", conflict: outcome.conflict });
        if (outcome.status === "settled" || outcome.status === "conflict") await collectDraftGarbage(session, metadata.scopeId);
    }

    function commitPrepared(prepared: PreparedCanvasOpen, content: CanvasProject) {
        if (prepared.status !== "ready" || !commitAllowed(prepared, content)) return false;
        const metadata = preparedRecovery.get(prepared.session);
        if (!metadata) return false;
        installSession(prepared.session, content, "replaced");
        void finishOpenCoordination(prepared.session, metadata);
        return true;
    }

    function commitServerCopy(prepared: PreparedCanvasOpen, content: CanvasProject): CanvasCommitServerCopyResult {
        if (prepared.status === "cancelled") return "cancelled";
        if (prepared.status !== "ready") return "failed";
        if (!commitAllowed(prepared, content)) return "cancelled";
        const metadata = preparedRecovery.get(prepared.session);
        if (!metadata) return "cancelled";
        const session = prepared.session;
        const previous = active && active.canvasId === session.canvasId && sameCanvasScope(active.scope, session.scope) ? active : null;
        if (active && !previous) return "cancelled";
        installSession(session, content, "forced");
        void clearConflictDrafts(metadata.scopeId, session.draftId, session);
        return "committed";
    }

    /** Accepting the server version is coordination only: it must never create a deletion tombstone. */
    async function clearConflictDrafts(scopeId: RecoveryScopeId, keepDraftId: string, session: CanvasSyncSession) {
        for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
            const opened = await deps.recovery.readOpenSnapshot(scopeId);
            if (opened.status === "tombstoned") {
                session.reportRecoveryState({ status: "tombstoned" });
                return;
            }
            if (opened.status === "unavailable") {
                session.reportRecoveryState({ status: "degraded" });
                return;
            }
            const deleteDraftIds = opened.snapshot.drafts.map((draft) => draft.draftId).filter((draftId) => draftId !== keepDraftId);
            if (!deleteDraftIds.length && !opened.snapshot.marker) return;
            const outcome = await deps.recovery.commitCoordination({
                scopeId,
                expectedCoordinationRevision: opened.snapshot.epoch.coordinationRevision,
                expectedDeletionGeneration: opened.snapshot.epoch.deletionGeneration,
                marker: null,
                deleteDraftIds,
            });
            if (outcome.status === "committed") return;
            if (outcome.status === "tombstoned") {
                session.reportRecoveryState({ status: "tombstoned" });
                return;
            }
            if (outcome.status === "unavailable") {
                session.reportRecoveryState({ status: "degraded" });
                return;
            }
        }
        session.reportRecoveryState({ status: "degraded" });
    }

    /** Unknown epoch or marker ownership means GC is skipped, never treated as an empty scope. */
    async function collectDraftGarbage(session: CanvasSyncSession, scopeId: RecoveryScopeId) {
        const opened = await deps.recovery.readOpenSnapshot(scopeId);
        if (opened.status !== "ok") return;
        await deps.recovery.collectGarbage({
            scopeId,
            expectedCoordinationRevision: opened.snapshot.epoch.coordinationRevision,
            expectedDeletionGeneration: opened.snapshot.epoch.deletionGeneration,
            keepDraftIds: [session.draftId, ...(opened.snapshot.marker?.entries.map((entry) => entry.draftId) ?? [])],
            now: deps.now(),
            minAgeMs: DRAFT_GC_MIN_AGE_MS,
        });
    }

    const scopeChanged = (token: number, captured: CanvasScope) => token !== scopeToken || !sameCanvasScope(captured, scope);

    async function listCanvases(): Promise<CanvasListResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const summaries = await deps.repository.list(current.workspaceId);
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "ready", summaries };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.listFailed") };
        }
    }

    async function createCanvas(title: string): Promise<CanvasCreateResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const { project, revision } = await deps.repository.create(current.workspaceId, clampCanvasTitle(title));
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "created", canvasId: project.id, summary: projectToSummary(project, revision) };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.createFailed") };
        }
    }

    async function importCanvas(source: Partial<CanvasProject>, fallbackTitle: string): Promise<CanvasCreateResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const { project, revision } = await deps.repository.importProject(current.workspaceId, projectToImportBody(source, fallbackTitle));
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "created", canvasId: project.id, summary: projectToSummary(project, revision) };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.importFailed") };
        }
    }

    async function renameCanvas(canvasId: string, title: string): Promise<CanvasRenameResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const trimmed = clampCanvasTitle(title);
        if (!trimmed) return { status: "failed", messageKey: "canvas.renameFailed" };
        if (active && active.canvasId === canvasId && sameCanvasScope(active.scope, current)) {
            return active.rename(trimmed) === "scheduled" ? { status: "scheduled" } : { status: "local-only" };
        }
        const token = scopeToken;
        try {
            const loaded = await deps.repository.load(current.workspaceId, canvasId);
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            const saved = await deps.repository.save(current.workspaceId, canvasId, { baseRevision: loaded.revision, title: trimmed, snapshot: projectToSnapshot(loaded.project) });
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "saved", summary: projectToSummary({ ...saved.project, title: trimmed }, saved.revision) };
        } catch (error) {
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return classifyCanvasSaveError(error).kind === "conflict" ? { status: "conflict" } : { status: "failed", messageKey: "canvas.renameFailed" };
        }
    }

    async function deleteCanvases(canvasIds: string[]): Promise<CanvasDeleteResult> {
        const current = scope;
        if (!current || !canvasIds.length) return { deleted: [], failed: [], localCleanupPending: [] };
        const target = active && canvasIds.includes(active.canvasId) ? active : null;
        if (target) await target.holdForDelete();

        const outcomes = await Promise.allSettled(canvasIds.map((canvasId) => deps.repository.remove(current.workspaceId, canvasId)));
        const proofIds = canvasIds.filter((canvasId, index) => {
            const outcome = outcomes[index];
            return outcome.status === "fulfilled" && outcome.value.status === "deleted" && outcome.value.receipt.canvasId === canvasId;
        });
        /**
         * The server receipt already decided the canvas is gone. A failed local tombstone cannot
         * un-delete it, so it is reported as deleted with cleanup still pending — never as a failure
         * that claims the canvas was preserved.
         */
        const localCleanupPending: string[] = [];
        for (const canvasId of proofIds) {
            const scopeResult = scopeIdFor(current, canvasId);
            if (scopeResult.status !== "ready") {
                localCleanupPending.push(canvasId);
                continue;
            }
            const outcome = await deps.recovery.confirmDeletion(scopeResult.scopeId, 0, deps.now());
            if (outcome.status !== "tombstoned" && outcome.status !== "already-tombstoned") localCleanupPending.push(canvasId);
        }

        if (target) {
            if (proofIds.includes(target.canvasId)) {
                if (active === target) {
                    activeUnsubscribe?.();
                    activeUnsubscribe = null;
                    active = null;
                }
                await target.dispose("deleted");
                notify();
            } else {
                target.releaseHold();
                notify();
            }
        }
        return { deleted: proofIds, failed: canvasIds.filter((canvasId) => !proofIds.includes(canvasId)), localCleanupPending };
    }

    async function loadForExport(canvasIds: string[]): Promise<CanvasProject[]> {
        const current = scope;
        if (!current || !canvasIds.length) return [];
        const projects: CanvasProject[] = [];
        for (let index = 0; index < canvasIds.length; index += EXPORT_BATCH_SIZE) {
            const batch = await Promise.all(
                canvasIds.slice(index, index + EXPORT_BATCH_SIZE).map(async (canvasId) => {
                    if (active && active.canvasId === canvasId && sameCanvasScope(active.scope, current)) return active.content;
                    return (await deps.repository.load(current.workspaceId, canvasId)).project;
                }),
            );
            projects.push(...batch);
        }
        return projects;
    }

    return {
        getScope: () => scope,
        setScope,
        getActiveSession: () => active,
        prepareOpen: (canvasId) => prepare(canvasId, true),
        commitPrepared,
        prepareServerCopy: (canvasId) => prepare(canvasId, false),
        commitServerCopy,
        listCanvases,
        createCanvas,
        importCanvas,
        renameCanvas,
        deleteCanvases,
        loadForExport,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export const canvasSyncManager = createCanvasSyncManager({
    repository: canvasRepository,
    recovery: browserCanvasRecoveryStore,
    now: () => Date.now(),
    createDraftId: () => nanoid(),
    isDev: import.meta.env.DEV,
});
