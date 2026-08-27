import { create } from "zustand";

import type { CanvasSnapshot } from "@infinite-canvas/contracts";

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
import type { CanvasProject, CanvasScope } from "@/types/canvas";

export type CanvasSaveState = "idle" | "saving" | "saved" | "conflict" | "error" | "recoveryError";

/** 内存冲突只描述当前 active；跨画布、跨刷新事实由 localforage 中每画布独立的 marker 表达。 */
export type CanvasConflictInfo = { canvasId: string; draftKey: string; baseRevision: number };
/** 本地 marker/草稿读不出来时的状态：服务端内容照常可编辑，但必须禁止网络保存，直到确认没有未知冲突。 */
export type CanvasRecoveryError = { canvasId: string };
export type CanvasDeleteResult = { deleted: string[]; failed: string[] };
/** 冲突重载分两段：先取服务端快照，等画布补水完成再提交，避免旧内容在补水窗口里被当成新 lineage 保存回服务端。 */
export type CanvasReloadHandle = { canvasId: string; project: CanvasProject; revision: number; scope: CanvasScope; scopeToken: number; generation: number };

type SavePayload = { title: string; snapshot: CanvasSnapshot };
/** none 可正常保存；conflict 等待用户显式解决；recovery 表示本地冲突状态未知，一律不发网络保存。 */
type SaveBlock = "none" | "conflict" | "recovery";
type SaveRevision = { current: number; block: SaveBlock; dirty: boolean; latest: SavePayload | null };

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

/**
 * 编辑发生时只捕获不可变的 project 引用，全量快照序列化推迟到本地合并窗口结束。
 * 拖动节点每帧都会触发一次编辑，逐帧序列化整份快照并写 IndexedDB 会直接拖垮主线程。
 */
type PendingEdit = {
    canvasId: string;
    scope: CanvasScope;
    scopeToken: number;
    saveRevision: SaveRevision;
    project: CanvasProject;
    conflictBaseRevision: number | null;
};

/** 本地恢复读数：draft 是要叠加的内容，conflict 非空表示确认存在冲突，cleanupMarker 表示 marker 已确认失效。 */
type LocalRecovery = { draft: CanvasDraftRecord | null; conflict: CanvasConflictInfo | null; cleanupMarker: boolean };

type CanvasStore = {
    scope: CanvasScope | null;
    scopeToken: number;
    listStatus: "idle" | "loading" | "ready" | "error";
    listError: string | null;
    summaries: CanvasProjectSummary[];
    active: ActiveCanvas | null;
    saveState: CanvasSaveState;
    conflict: CanvasConflictInfo | null;
    recoveryError: CanvasRecoveryError | null;
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
    fetchServerCopy: (id: string) => Promise<CanvasReloadHandle | null>;
    commitServerCopy: (handle: CanvasReloadHandle) => boolean;
    retryCanvasRecovery: (id: string) => Promise<boolean>;
    retrySave: (id: string) => Promise<void>;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: SaveCandidate | null = null;
let localTimer: ReturnType<typeof setTimeout> | null = null;
let pendingEdit: PendingEdit | null = null;
let saveChain: Promise<void> = Promise.resolve();
let activeGeneration = 0;

/** 每画布本地操作严格串行，避免较早的异步写在较新的写之后完成并覆盖新草稿。 */
const draftChains = new Map<string, Promise<void>>();
/** 每画布只保留最后一条待写草稿，慢速 IndexedDB 下也不会堆积多份完整快照。 */
const pendingDraftRecords = new Map<string, CanvasDraftRecord>();
const AUTOSAVE_DEBOUNCE_MS = 400;
const LOCAL_COALESCE_MS = 120;
const LOCAL_READ_TIMEOUT_MS = 2_000;
const LOCAL_SAVE_HANDOFF_MS = 2_000;
const EXPORT_BATCH_SIZE = 3;

export const CANVAS_SCOPE_CHANGED_ERROR = "canvas_scope_changed";

export function isScopeChangedError(error: unknown) {
    return error instanceof Error && error.message === CANVAS_SCOPE_CHANGED_ERROR;
}

function clearNetworkTimer() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingSave = null;
}

function clearLocalTimer() {
    if (localTimer) clearTimeout(localTimer);
    localTimer = null;
}

/** 画布被删除或被服务端版本替换后，仍在合并窗口里的编辑必须丢弃，否则它会在清理之后重新写回草稿与 marker。 */
function dropPendingEdit(canvasId: string) {
    if (pendingEdit?.canvasId !== canvasId) return;
    pendingEdit = null;
    clearLocalTimer();
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

function activeCanvas(project: CanvasProject, revision: number, scope: CanvasScope, generation: number, block: SaveBlock = "none"): ActiveCanvas {
    return { project, revision, scope, generation, saveRevision: { current: revision, block, dirty: false, latest: null } };
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

    /** 草稿写入按画布取最后一条：排队期间的中间态直接被覆盖，内存里最多只压着一份完整快照。 */
    const queueDraftWrite = (candidate: SaveCandidate, baseRevision: number, payload: SavePayload) => {
        const key = localCanvasKey(candidate.scope, candidate.canvasId);
        pendingDraftRecords.set(key, toDraftRecord(candidate, baseRevision, payload));
        return enqueueLocalOperation(candidate.scope, candidate.canvasId, async () => {
            const record = pendingDraftRecords.get(key);
            if (!record) return;
            pendingDraftRecords.delete(key);
            await writeCanvasDraft(record);
        });
    };

    const queueConflictWrite = (candidate: SaveCandidate, baseRevision: number, payload: SavePayload, prune = false) => {
        const marker = toConflictMarker(candidate, baseRevision);
        /** 冲突草稿是权威的本地内容，丢掉仍在排队的普通草稿，避免它随后覆盖掉冲突记录。 */
        pendingDraftRecords.delete(localCanvasKey(candidate.scope, candidate.canvasId));
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
            pendingDraftRecords.delete(localCanvasKey(scope, canvasId));
            await Promise.allSettled([removeCanvasDraftsOfCanvas({ ...scope, canvasId }), removeCanvasConflictMarker({ ...scope, canvasId })]);
        });

    const queueMarkerCleanup = (scope: CanvasScope, canvasId: string) => enqueueLocalOperation(scope, canvasId, () => removeCanvasConflictMarker({ ...scope, canvasId }));

    /**
     * 读取本地恢复状态。返回 null 表示「读不出来」，不能当成「没有冲突」：
     * marker 读失败后照常开自动保存，会让一份仍然有效的冲突草稿变成休眠态，日后突然复活并覆盖画布内容。
     */
    const readLocalRecovery = async (scope: CanvasScope, canvasId: string, serverRevision: number): Promise<LocalRecovery | null> => {
        const markerRead = await settleWithin(readCanvasConflictMarker({ ...scope, canvasId }), LOCAL_READ_TIMEOUT_MS);
        if (markerRead.status !== "ok") return null;
        if (markerRead.value.invalid) return { draft: null, conflict: null, cleanupMarker: true };
        const marker = markerRead.value.marker;
        if (!marker) {
            const draftRead = await settleWithin(readCanvasDraft({ ...scope, canvasId, baseRevision: serverRevision }), LOCAL_READ_TIMEOUT_MS);
            if (draftRead.status !== "ok") return null;
            return { draft: draftRead.value, conflict: null, cleanupMarker: false };
        }
        const draftRead = await settleWithin(readCanvasDraftByKey(marker.draftKey), LOCAL_READ_TIMEOUT_MS);
        if (draftRead.status !== "ok") return null;
        const draft = draftRead.value;
        if (draft && draft.userId === scope.userId && draft.workspaceId === scope.workspaceId && draft.canvasId === canvasId && draft.baseRevision === marker.baseRevision) {
            return { draft, conflict: { canvasId, draftKey: marker.draftKey, baseRevision: marker.baseRevision }, cleanupMarker: false };
        }
        /** marker 指向的草稿已经不存在或对不上，这条 marker 才算确认失效，可以 best-effort 清掉。 */
        return { draft: null, conflict: null, cleanupMarker: true };
    };

    /** 本地存储偶发超时很常见，先自动重试一次，真正读不出来才进入 recovery 状态。 */
    const readLocalRecoveryWithRetry = async (scope: CanvasScope, canvasId: string, serverRevision: number) =>
        (await readLocalRecovery(scope, canvasId, serverRevision)) ?? (await readLocalRecovery(scope, canvasId, serverRevision));

    /**
     * 把仍在合并窗口里的编辑真正序列化并交给草稿/网络队列。
     * 序列化的是编辑当时捕获的 project 引用，不会读到已经被换掉的 active。
     */
    const materializePendingEdit = (canvasId?: string) => {
        const edit = pendingEdit;
        if (!edit || (canvasId && edit.canvasId !== canvasId)) return;
        pendingEdit = null;
        clearLocalTimer();
        const payload: SavePayload = { title: edit.project.title, snapshot: projectToSnapshot(edit.project) };
        const candidate: SaveCandidate = { canvasId: edit.canvasId, scope: edit.scope, scopeToken: edit.scopeToken, saveRevision: edit.saveRevision, payload };
        edit.saveRevision.latest = payload;
        if (edit.conflictBaseRevision !== null) {
            void queueConflictWrite(candidate, edit.conflictBaseRevision, payload);
            return;
        }
        void queueDraftWrite(candidate, edit.saveRevision.current, payload);
        if (edit.saveRevision.block === "none") pendingSave = candidate;
    };

    /** 保存网络不等待普通草稿写；成功后的 revision handoff 只短暂等待，localforage 永不返回也不会冻结全局保存链。 */
    const runSave = async (candidate: SaveCandidate) => {
        const { canvasId, scope, scopeToken: token, saveRevision, payload } = candidate;
        if (saveRevision.block !== "none") return;
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
                saveRevision.block = "conflict";
                saveRevision.latest = conflictPayload;
                if (pendingSave?.saveRevision === saveRevision) clearNetworkTimer();
                /** 仍在合并窗口里的同 lineage 编辑改写同一条冲突草稿，不再发起任何网络保存。 */
                if (pendingEdit?.saveRevision === saveRevision) pendingEdit.conflictBaseRevision = baseRevision;
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
        /** flush 必须先强制物化，否则最后一次编辑还停在合并窗口里，导航或 pagehide 就会漏掉它。 */
        materializePendingEdit(canvasId);
        const candidate = pendingSave;
        if (!candidate || (canvasId && candidate.canvasId !== canvasId)) return saveChain;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        pendingSave = null;
        return enqueueSave(() => runSave(candidate));
    };

    /**
     * 编辑只捕获 project 引用：本地草稿在 120ms 合并窗口内落盘，网络请求仍严格从最后一次编辑起 400ms。
     * 拖动节点每帧触发一次编辑，这里保证每 120ms 最多序列化并写一次草稿。
     */
    const scheduleSave = (canvasId: string) => {
        const scope = get().scope;
        const active = get().active;
        if (!scope || !active || active.project.id !== canvasId || !sameScope(active.scope, scope)) return;
        const saveRevision = active.saveRevision;
        saveRevision.dirty = true;
        let conflictBaseRevision: number | null = null;
        if (saveRevision.block === "conflict") {
            const conflict = get().conflict;
            /** 定位不到冲突草稿就不写，绝不凭空造一个 draftKey。 */
            if (conflict?.canvasId !== canvasId) return;
            conflictBaseRevision = conflict.baseRevision;
        }
        /** 换画布或换 lineage 时先把上一条落地，避免它被这次编辑顶掉。 */
        if (pendingEdit && (pendingEdit.canvasId !== canvasId || pendingEdit.saveRevision !== saveRevision)) materializePendingEdit();
        if (pendingSave && pendingSave.canvasId !== canvasId) flushPendingSave(pendingSave.canvasId);
        pendingEdit = { canvasId, scope, scopeToken: get().scopeToken, saveRevision, project: active.project, conflictBaseRevision };
        if (!localTimer) localTimer = setTimeout(() => materializePendingEdit(), LOCAL_COALESCE_MS);
        if (saveRevision.block !== "none") return;
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
        recoveryError: null,

        setScope: (scope) => {
            if (sameScope(get().scope, scope) && get().scopeToken > 0) return;
            activeGeneration += 1;
            flushPendingSave();
            set({ scope, scopeToken: get().scopeToken + 1, summaries: [], active: null, conflict: null, recoveryError: null, saveState: "idle", listStatus: "idle", listError: null });
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
            set({ active: activeCanvas(project, revision, scope, generation), conflict: null, recoveryError: null, saveState: "idle", summaries: [projectToSummary(project, revision), ...get().summaries] });
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

            const recovery = await readLocalRecoveryWithRetry(scope, id, result.revision);
            if (!isCurrentOperation(token, scope, generation)) return null;
            if (recovery?.cleanupMarker) void queueMarkerCleanup(scope, id);
            const draft = recovery?.draft ?? null;
            const conflict = recovery?.conflict ?? null;
            /** 读不出本地状态时以服务端内容打开，但锁住网络保存，直到用户重试并确认没有未知冲突。 */
            const block: SaveBlock = !recovery ? "recovery" : conflict ? "conflict" : "none";
            const restored = draft ? { ...result.project, ...snapshotToProjectContent(draft.snapshot), title: draft.title || result.project.title } : result.project;
            if (!isCurrentOperation(token, scope, generation) || restored.id !== id) return null;
            set({
                active: activeCanvas(restored, result.revision, scope, generation, block),
                conflict,
                recoveryError: block === "recovery" ? { canvasId: id } : null,
                saveState: block === "recovery" ? "recoveryError" : conflict ? "conflict" : "idle",
            });
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
            deleted.forEach((id) => {
                /** 先丢掉仍在合并窗口里的编辑，否则它会在清理之后重新写回已删画布的草稿。 */
                dropPendingEdit(id);
                void queueCanvasCleanup(scope, id);
            });
            if (isStaleScope(token, scope)) return { deleted: [], failed: [] };
            if (deleted.length) {
                const active = get().active;
                const conflict = get().conflict;
                const recoveryError = get().recoveryError;
                const deletesActive = Boolean(active && deleted.includes(active.project.id));
                if (deletesActive) activeGeneration += 1;
                set({
                    summaries: get().summaries.filter((item) => !deleted.includes(item.id)),
                    active: deletesActive ? null : active,
                    conflict: conflict && deleted.includes(conflict.canvasId) ? null : conflict,
                    recoveryError: recoveryError && deleted.includes(recoveryError.canvasId) ? null : recoveryError,
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
            if (!scope || !conflict) return null;
            /** 先把仍在合并窗口里的编辑写进这条冲突草稿，导出的就是磁盘上那份权威草稿，而不是内存里的另一个版本。 */
            materializePendingEdit(conflict.canvasId);
            await settleWithin(draftChains.get(localCanvasKey(scope, conflict.canvasId)) ?? Promise.resolve(), LOCAL_SAVE_HANDOFF_MS);
            const draftRead = await settleWithin(readCanvasDraftByKey(conflict.draftKey), LOCAL_READ_TIMEOUT_MS);
            if (isStaleScope(token, scope) || get().conflict?.draftKey !== conflict.draftKey || draftRead.status !== "ok") return null;
            return draftRead.value ? draftToProject(draftRead.value) : null;
        },

        /**
         * 冲突重载第一段：只取服务端快照，不动 store。
         * 提交推迟到画布补水完成，期间 active 仍是旧的 blocked lineage，任何迟到的编辑都发不出网络保存。
         */
        fetchServerCopy: async (id) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return null;
            const generation = ++activeGeneration;
            const result = await loadCanvasProject(scope.workspaceId, id);
            if (!isCurrentOperation(token, scope, generation) || result.project.id !== id) return null;
            return { canvasId: id, project: result.project, revision: result.revision, scope, scopeToken: token, generation };
        },

        /** 冲突重载第二段：与画布内容在同一次提交里换成服务端版本，之后才允许重新自动保存。 */
        commitServerCopy: (handle) => {
            if (!isCurrentOperation(handle.scopeToken, handle.scope, handle.generation)) return false;
            dropPendingEdit(handle.canvasId);
            if (pendingSave?.canvasId === handle.canvasId) clearNetworkTimer();
            set({
                active: activeCanvas(handle.project, handle.revision, handle.scope, handle.generation),
                conflict: null,
                recoveryError: null,
                saveState: "idle",
            });
            void queueCanvasCleanup(handle.scope, handle.canvasId);
            return true;
        },

        /**
         * 重新读取本地 marker/草稿。读成功才解除 recovery：没有 marker 就解锁，
         * 有 marker 且草稿完好就转成正常冲突状态，只有确认失效的 marker 才 best-effort 清理。
         */
        retryCanvasRecovery: async (id) => {
            const token = get().scopeToken;
            const scope = get().scope;
            const active = get().active;
            if (!scope || !active || active.project.id !== id || !sameScope(active.scope, scope) || active.saveRevision.block !== "recovery") return false;
            const saveRevision = active.saveRevision;
            const recovery = await readLocalRecoveryWithRetry(scope, id, saveRevision.current);
            if (isStaleScope(token, scope) || get().active?.saveRevision !== saveRevision) return false;
            if (!recovery) return false;
            if (recovery.cleanupMarker) void queueMarkerCleanup(scope, id);
            if (recovery.conflict) {
                saveRevision.block = "conflict";
                set({ conflict: recovery.conflict, recoveryError: null, saveState: "conflict" });
                return true;
            }
            saveRevision.block = "none";
            set({ recoveryError: null, saveState: "idle" });
            /** recovery 期间的编辑只落了本地草稿，解锁后要主动补一次云端保存。 */
            if (saveRevision.dirty) scheduleSave(id);
            return true;
        },

        /** 保存失败后的显式重试：重新从当前 active 捕获最新内容并立即提交，不是重放上一条已失败的候选。 */
        retrySave: async (id) => {
            const scope = get().scope;
            const active = get().active;
            if (!scope || !active || active.project.id !== id || !sameScope(active.scope, scope) || active.saveRevision.block !== "none") return;
            scheduleSave(id);
            await flushPendingSave(id);
        },
    };
});
