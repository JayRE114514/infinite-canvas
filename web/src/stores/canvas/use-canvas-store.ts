import { create } from "zustand";

import type { CanvasSnapshot } from "@infinite-canvas/contracts";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { clampCanvasTitle, draftToProject, projectToImportBody, projectToSnapshot, projectToSummary, snapshotToProjectContent, type CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import { platformErrorTranslationKey } from "@/services/api/platform-client";
import {
    createCanvasProject,
    deleteCanvasProject,
    importCanvasProject,
    isRevisionConflictError,
    listCanvasSummaries,
    loadCanvasProject,
    saveCanvasProject,
} from "@/services/canvas-repository";
import {
    canvasDraftKey,
    readCanvasConflictMarker,
    readCanvasDraft,
    readCanvasDraftByKey,
    removeCanvasConflictMarker,
    removeCanvasDraftByKey,
    removeCanvasDraftsOfCanvas,
    writeCanvasConflictMarker,
    writeCanvasDraft,
    type CanvasConflictMarker,
    type CanvasDraftRecord,
} from "@/services/canvas-drafts";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

export type CanvasScope = { userId: string; workspaceId: string };
export type CanvasSaveState = "idle" | "saving" | "saved" | "conflict" | "error";

/** 内存冲突只描述当前 active；跨画布、跨刷新事实由 localforage 中每画布独立的 marker 表达。 */
export type CanvasConflictInfo = { canvasId: string; draftKey: string; baseRevision: number };
export type CanvasDeleteResult = { deleted: string[]; failed: string[] };

type SavePayload = { title: string; snapshot: CanvasSnapshot };
type SaveRevision = { current: number; blocked: boolean; latest: SavePayload | null };

type ActiveCanvas = {
    project: CanvasProject;
    revision: number;
    scope: CanvasScope;
    generation: number;
    saveRevision: SaveRevision;
};

/** 候选在编辑发生时固定内容与 lineage，不能在防抖结束后再读取可变 active。 */
type SaveCandidate = {
    canvasId: string;
    scope: CanvasScope;
    scopeToken: number;
    saveRevision: SaveRevision;
    payload: SavePayload;
};

type CanvasStore = {
    scope: CanvasScope | null;
    scopeToken: number;
    listStatus: "idle" | "loading" | "ready" | "error";
    listError: string | null;
    summaries: CanvasProjectSummary[];
    active: ActiveCanvas | null;
    saveState: CanvasSaveState;
    conflict: CanvasConflictInfo | null;
    setScope: (scope: CanvasScope | null) => void;
    refreshList: () => Promise<void>;
    createProject: (title: string) => Promise<string>;
    importProject: (project: Partial<CanvasProject>, fallbackTitle: string) => Promise<string>;
    openProject: (id: string) => Promise<CanvasProject | null>;
    renameProject: (id: string, title: string) => Promise<void>;
    deleteProjects: (ids: string[]) => Promise<CanvasDeleteResult>;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
    flushProject: (id: string) => Promise<void>;
    loadProjectsForExport: (ids: string[]) => Promise<CanvasProject[]>;
    readConflictDraft: () => Promise<CanvasProject | null>;
    resolveConflictWithServer: (id: string) => Promise<CanvasProject | null>;
    clearActive: () => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: SaveCandidate | null = null;
let saveChain: Promise<void> = Promise.resolve();
let activeGeneration = 0;

/** 每画布本地操作严格串行，避免较早的异步写在较新的写之后完成并覆盖新草稿。 */
const draftChains = new Map<string, Promise<void>>();
const AUTOSAVE_DEBOUNCE_MS = 400;
const LOCAL_READ_TIMEOUT_MS = 2_000;
const LOCAL_SAVE_HANDOFF_MS = 2_000;
const EXPORT_BATCH_SIZE = 3;

export const CANVAS_SCOPE_CHANGED_ERROR = "canvas_scope_changed";

export function isScopeChangedError(error: unknown) {
    return error instanceof Error && error.message === CANVAS_SCOPE_CHANGED_ERROR;
}

function clearSaveTimer() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingSave = null;
}

function enqueueSave(run: () => Promise<void>) {
    saveChain = saveChain.then(run, run).catch(() => undefined);
    return saveChain;
}

function sameScope(a: CanvasScope | null, b: CanvasScope | null) {
    return a?.userId === b?.userId && a?.workspaceId === b?.workspaceId;
}

function localCanvasKey(scope: CanvasScope, canvasId: string) {
    return [encodeURIComponent(scope.userId), encodeURIComponent(scope.workspaceId), encodeURIComponent(canvasId)].join(":");
}

function enqueueLocalOperation(scope: CanvasScope, canvasId: string, operation: () => Promise<void>) {
    const key = localCanvasKey(scope, canvasId);
    const previous = draftChains.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation).catch(() => undefined);
    draftChains.set(key, next);
    void next.then(() => {
        if (draftChains.get(key) === next) draftChains.delete(key);
    });
    return next;
}

type BoundedResult<T> = { status: "ok"; value: T } | { status: "failed" };

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
    return new Promise((resolve) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ status: "failed" });
        }, timeoutMs);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ status: "ok", value });
            },
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ status: "failed" });
            },
        );
    });
}

function activeCanvas(project: CanvasProject, revision: number, scope: CanvasScope, generation: number, blocked = false): ActiveCanvas {
    return { project, revision, scope, generation, saveRevision: { current: revision, blocked, latest: null } };
}

function toDraftRecord(candidate: SaveCandidate, baseRevision: number, payload: SavePayload): CanvasDraftRecord {
    return {
        userId: candidate.scope.userId,
        workspaceId: candidate.scope.workspaceId,
        canvasId: candidate.canvasId,
        baseRevision,
        title: payload.title,
        snapshot: payload.snapshot,
        savedAt: new Date().toISOString(),
    };
}

function toConflictMarker(candidate: SaveCandidate, baseRevision: number): CanvasConflictMarker {
    return {
        userId: candidate.scope.userId,
        workspaceId: candidate.scope.workspaceId,
        canvasId: candidate.canvasId,
        baseRevision,
        draftKey: canvasDraftKey({ ...candidate.scope, canvasId: candidate.canvasId, baseRevision }),
    };
}

export const useCanvasStore = create<CanvasStore>()((set, get) => {
    const isStaleScope = (token: number, scope: CanvasScope | null) => get().scopeToken !== token || !sameScope(get().scope, scope);
    const isCurrentOperation = (token: number, scope: CanvasScope, generation: number) => !isStaleScope(token, scope) && activeGeneration === generation;

    const queueDraftWrite = (candidate: SaveCandidate, baseRevision: number, payload: SavePayload) =>
        enqueueLocalOperation(candidate.scope, candidate.canvasId, () => writeCanvasDraft(toDraftRecord(candidate, baseRevision, payload)));

    const queueConflictWrite = (candidate: SaveCandidate, baseRevision: number, payload: SavePayload, prune = false) => {
        const marker = toConflictMarker(candidate, baseRevision);
        return enqueueLocalOperation(candidate.scope, candidate.canvasId, async () => {
            await writeCanvasDraft(toDraftRecord(candidate, baseRevision, payload));
            await writeCanvasConflictMarker(marker);
            if (prune) await removeCanvasDraftsOfCanvas({ ...candidate.scope, canvasId: candidate.canvasId }, marker.draftKey);
        });
    };

    const queueDraftHandoff = (candidate: SaveCandidate, oldDraftKey: string, newRevision: number, latest: SavePayload | null) =>
        enqueueLocalOperation(candidate.scope, candidate.canvasId, async () => {
            const nextDraft = latest ? toDraftRecord(candidate, newRevision, latest) : null;
            if (nextDraft) await writeCanvasDraft(nextDraft);
            if (!nextDraft || canvasDraftKey(nextDraft) !== oldDraftKey) await removeCanvasDraftByKey(oldDraftKey);
        });

    const queueCanvasCleanup = (scope: CanvasScope, canvasId: string) =>
        enqueueLocalOperation(scope, canvasId, async () => {
            await Promise.allSettled([removeCanvasDraftsOfCanvas({ ...scope, canvasId }), removeCanvasConflictMarker({ ...scope, canvasId })]);
        });

    const queueMarkerCleanup = (scope: CanvasScope, canvasId: string) => enqueueLocalOperation(scope, canvasId, () => removeCanvasConflictMarker({ ...scope, canvasId }));

    /** 保存网络不等待普通草稿写；成功后的 revision handoff 只短暂等待，localforage 永不返回也不会冻结全局保存链。 */
    const runSave = async (candidate: SaveCandidate) => {
        const { canvasId, scope, scopeToken: token, saveRevision, payload } = candidate;
        if (saveRevision.blocked) return;
        const baseRevision = saveRevision.current;
        const oldDraftKey = canvasDraftKey({ ...scope, canvasId, baseRevision });
        const isCurrent = () => {
            const active = get().active;
            return !isStaleScope(token, scope) && active?.project.id === canvasId && sameScope(active.scope, scope) && active.saveRevision === saveRevision;
        };
        if (isCurrent()) set({ saveState: "saving" });

        try {
            const result = await saveCanvasProject(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot });
            saveRevision.current = result.revision;
            const latest = saveRevision.latest === payload ? null : saveRevision.latest;
            if (saveRevision.latest === payload) saveRevision.latest = null;
            const handoff = queueDraftHandoff(candidate, oldDraftKey, result.revision, latest);
            await settleWithin(handoff, LOCAL_SAVE_HANDOFF_MS);
            if (isStaleScope(token, scope)) return;
            const current = get().active;
            set({
                ...(current && isCurrent() ? { active: { ...current, revision: result.revision }, saveState: "saved" as CanvasSaveState } : {}),
                summaries: get().summaries.map((item) => (item.id === canvasId ? { ...item, title: payload.title, revision: result.revision, updatedAt: result.project.updatedAt } : item)),
            });
        } catch (error) {
            if (isRevisionConflictError(error)) {
                const conflictPayload = saveRevision.latest ?? payload;
                saveRevision.blocked = true;
                saveRevision.latest = conflictPayload;
                if (pendingSave?.saveRevision === saveRevision) clearSaveTimer();
                const marker = toConflictMarker(candidate, baseRevision);
                await settleWithin(queueConflictWrite(candidate, baseRevision, conflictPayload, true), LOCAL_SAVE_HANDOFF_MS);
                if (!isCurrent()) return;
                set({ conflict: { canvasId, draftKey: marker.draftKey, baseRevision }, saveState: "conflict" });
                return;
            }
            if (isCurrent()) set({ saveState: "error" });
        }
    };

    const flushPendingSave = (canvasId?: string) => {
        const candidate = pendingSave;
        if (!candidate || (canvasId && candidate.canvasId !== canvasId)) return saveChain;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        pendingSave = null;
        return enqueueSave(() => runSave(candidate));
    };

    /** 编辑发生时立即把固定 payload 排进本地串行写队列；400ms 只用于合并服务端请求。 */
    const scheduleSave = (canvasId: string) => {
        const scope = get().scope;
        const active = get().active;
        if (!scope || !active || active.project.id !== canvasId || !sameScope(active.scope, scope)) return;
        const payload = { title: active.project.title, snapshot: projectToSnapshot(active.project) };
        const candidate: SaveCandidate = { canvasId, scope, scopeToken: get().scopeToken, saveRevision: active.saveRevision, payload };
        active.saveRevision.latest = payload;
        if (active.saveRevision.blocked) {
            const conflict = get().conflict;
            if (conflict?.canvasId === canvasId) void queueConflictWrite(candidate, conflict.baseRevision, payload);
            return;
        }
        void queueDraftWrite(candidate, active.saveRevision.current, payload);
        if (pendingSave && pendingSave.canvasId !== canvasId) flushPendingSave();
        pendingSave = candidate;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            flushPendingSave();
        }, AUTOSAVE_DEBOUNCE_MS);
    };

    return {
        scope: null,
        scopeToken: 0,
        listStatus: "idle",
        listError: null,
        summaries: [],
        active: null,
        saveState: "idle",
        conflict: null,

        setScope: (scope) => {
            if (sameScope(get().scope, scope) && get().scopeToken > 0) return;
            activeGeneration += 1;
            flushPendingSave();
            set({ scope, scopeToken: get().scopeToken + 1, summaries: [], active: null, conflict: null, saveState: "idle", listStatus: "idle", listError: null });
        },

        refreshList: async () => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return;
            set({ listStatus: "loading", listError: null });
            try {
                const summaries = await listCanvasSummaries(scope.workspaceId);
                if (isStaleScope(token, scope)) return;
                set({ summaries, listStatus: "ready" });
            } catch (error) {
                if (isStaleScope(token, scope)) return;
                set({ listStatus: "error", listError: platformErrorTranslationKey(error, "canvas.listFailed"), summaries: [] });
            }
        },

        createProject: async (title) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) throw new Error("canvas_scope_missing");
            const generation = ++activeGeneration;
            await flushPendingSave();
            if (!isCurrentOperation(token, scope, generation)) throw new Error(CANVAS_SCOPE_CHANGED_ERROR);
            const { project, revision } = await createCanvasProject(scope.workspaceId, clampCanvasTitle(title));
            if (!isCurrentOperation(token, scope, generation)) throw new Error(CANVAS_SCOPE_CHANGED_ERROR);
            set({ active: activeCanvas(project, revision, scope, generation), conflict: null, saveState: "idle", summaries: [projectToSummary(project, revision), ...get().summaries] });
            return project.id;
        },

        importProject: async (source, fallbackTitle) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) throw new Error("canvas_scope_missing");
            const { project, revision } = await importCanvasProject(scope.workspaceId, projectToImportBody(source, fallbackTitle));
            if (isStaleScope(token, scope)) throw new Error(CANVAS_SCOPE_CHANGED_ERROR);
            set({ summaries: [projectToSummary(project, revision), ...get().summaries] });
            return project.id;
        },

        openProject: async (id) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return null;
            const generation = ++activeGeneration;
            await flushPendingSave();
            if (!isCurrentOperation(token, scope, generation)) return null;
            const result = await loadCanvasProject(scope.workspaceId, id);
            if (!isCurrentOperation(token, scope, generation) || result.project.id !== id) return null;

            const localScope = { ...scope, canvasId: id };
            const markerRead = await settleWithin(readCanvasConflictMarker(localScope), LOCAL_READ_TIMEOUT_MS);
            if (!isCurrentOperation(token, scope, generation)) return null;
            let draft: CanvasDraftRecord | null = null;
            let conflict: CanvasConflictInfo | null = null;

            if (markerRead.status === "ok") {
                const marker = markerRead.value.marker;
                if (markerRead.value.invalid) {
                    void queueMarkerCleanup(scope, id);
                } else if (marker) {
                    const draftRead = await settleWithin(readCanvasDraftByKey(marker.draftKey), LOCAL_READ_TIMEOUT_MS);
                    if (!isCurrentOperation(token, scope, generation)) return null;
                    if (
                        draftRead.status === "ok" &&
                        draftRead.value &&
                        draftRead.value.userId === scope.userId &&
                        draftRead.value.workspaceId === scope.workspaceId &&
                        draftRead.value.canvasId === id &&
                        draftRead.value.baseRevision === marker.baseRevision
                    ) {
                        draft = draftRead.value;
                        conflict = { canvasId: id, draftKey: marker.draftKey, baseRevision: marker.baseRevision };
                    } else if (draftRead.status === "ok") {
                        void queueMarkerCleanup(scope, id);
                    }
                } else {
                    const draftRead = await settleWithin(readCanvasDraft({ ...localScope, baseRevision: result.revision }), LOCAL_READ_TIMEOUT_MS);
                    if (!isCurrentOperation(token, scope, generation)) return null;
                    if (draftRead.status === "ok") draft = draftRead.value;
                }
            }

            const restored = draft ? { ...result.project, ...snapshotToProjectContent(draft.snapshot), title: draft.title || result.project.title } : result.project;
            if (!isCurrentOperation(token, scope, generation) || restored.id !== id) return null;
            set({ active: activeCanvas(restored, result.revision, scope, generation, Boolean(conflict)), conflict, saveState: conflict ? "conflict" : "idle" });
            return restored;
        },

        renameProject: async (id, title) => {
            const trimmed = clampCanvasTitle(title);
            if (!trimmed) return;
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return;
            const active = get().active;
            if (active && active.project.id === id && sameScope(active.scope, scope)) {
                set({ active: { ...active, project: { ...active.project, title: trimmed } } });
                scheduleSave(id);
                return;
            }
            const { project, revision } = await loadCanvasProject(scope.workspaceId, id);
            if (isStaleScope(token, scope) || project.id !== id) return;
            const result = await saveCanvasProject(scope.workspaceId, id, { baseRevision: revision, title: trimmed, snapshot: projectToSnapshot(project) });
            if (isStaleScope(token, scope) || result.project.id !== id) return;
            set({ summaries: get().summaries.map((item) => (item.id === id ? { ...item, title: trimmed, revision: result.revision, updatedAt: result.project.updatedAt } : item)) });
        },

        deleteProjects: async (ids) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope || !ids.length) return { deleted: [], failed: [] };
            await flushPendingSave();
            if (isStaleScope(token, scope)) return { deleted: [], failed: [] };
            const outcomes = await Promise.allSettled(ids.map((id) => deleteCanvasProject(scope.workspaceId, id)));
            const deleted = ids.filter((_id, index) => outcomes[index].status === "fulfilled");
            const failed = ids.filter((id) => !deleted.includes(id));
            deleted.forEach((id) => void queueCanvasCleanup(scope, id));
            if (isStaleScope(token, scope)) return { deleted: [], failed: [] };
            if (deleted.length) {
                const active = get().active;
                const conflict = get().conflict;
                const deletesActive = Boolean(active && deleted.includes(active.project.id));
                if (deletesActive) activeGeneration += 1;
                set({
                    summaries: get().summaries.filter((item) => !deleted.includes(item.id)),
                    active: deletesActive ? null : active,
                    conflict: conflict && deleted.includes(conflict.canvasId) ? null : conflict,
                    ...(deletesActive ? { saveState: "idle" as CanvasSaveState } : {}),
                });
            }
            return { deleted, failed };
        },

        updateProject: (id, patch) => {
            const active = get().active;
            if (!active || active.project.id !== id || !sameScope(active.scope, get().scope)) return;
            set({ active: { ...active, project: { ...active.project, ...patch } } });
            scheduleSave(id);
        },

        flushProject: async (id) => {
            await flushPendingSave(id);
        },

        loadProjectsForExport: async (ids) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope || !ids.length) return [];
            const active = get().active;
            const results: CanvasProject[] = [];
            for (let index = 0; index < ids.length; index += EXPORT_BATCH_SIZE) {
                const batch = await Promise.all(
                    ids.slice(index, index + EXPORT_BATCH_SIZE).map(async (id) => {
                        if (active && active.project.id === id && sameScope(active.scope, scope)) return active.project;
                        const { project } = await loadCanvasProject(scope.workspaceId, id);
                        return project;
                    }),
                );
                if (isStaleScope(token, scope)) return [];
                results.push(...batch);
            }
            return results;
        },

        readConflictDraft: async () => {
            const token = get().scopeToken;
            const scope = get().scope;
            const conflict = get().conflict;
            const active = get().active;
            if (!scope || !conflict) return null;
            if (active?.project.id === conflict.canvasId && active.saveRevision.blocked && sameScope(active.scope, scope)) return active.project;
            const draftRead = await settleWithin(readCanvasDraftByKey(conflict.draftKey), LOCAL_READ_TIMEOUT_MS);
            if (isStaleScope(token, scope) || get().conflict?.draftKey !== conflict.draftKey || draftRead.status !== "ok") return null;
            return draftRead.value ? draftToProject(draftRead.value) : null;
        },

        resolveConflictWithServer: async (id) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return null;
            const generation = ++activeGeneration;
            const result = await loadCanvasProject(scope.workspaceId, id);
            if (!isCurrentOperation(token, scope, generation) || result.project.id !== id) return null;
            set({ active: activeCanvas(result.project, result.revision, scope, generation), conflict: null, saveState: "idle" });
            void queueCanvasCleanup(scope, id);
            return result.project;
        },

        clearActive: () => {
            activeGeneration += 1;
            flushPendingSave();
            set({ active: null, conflict: null, saveState: "idle" });
        },
    };
});
