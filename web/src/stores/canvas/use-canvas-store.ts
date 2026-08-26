import { create } from "zustand";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { draftToProject, projectToImportBody, projectToSnapshot, projectToSummary, snapshotToProjectContent, type CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import {
    createCanvasProject,
    deleteCanvasProject,
    importCanvasProject,
    isRevisionConflictError,
    listCanvasSummaries,
    loadCanvasProject,
    saveCanvasProject,
} from "@/services/canvas-repository";
import { canvasDraftKey, readCanvasDraft, readCanvasDraftByKey, removeCanvasDraftsOfCanvas, writeCanvasDraft } from "@/services/canvas-drafts";
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

/** baseRevision 是本地草稿所基于的版本；服务端已经前进到别的版本，因此必须由用户显式选择处理方式。 */
export type CanvasConflictInfo = { canvasId: string; draftKey: string; baseRevision: number };

type ActiveCanvas = {
    project: CanvasProject;
    revision: number;
    scope: CanvasScope;
};

type CanvasStore = {
    /** scope 为 null 表示尚未登录或尚未选定 Workspace，此时不允许持有任何服务端数据。 */
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
    deleteProjects: (ids: string[]) => Promise<void>;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
    flushProject: (id: string) => Promise<void>;
    /** 导出需要完整快照，列表只有摘要，因此按需从服务端逐个拉取。 */
    loadProjectsForExport: (ids: string[]) => Promise<CanvasProject[]>;
    /** 冲突时导出本地草稿用：只读取冲突那一条草稿，不改动任何状态。 */
    readConflictDraft: () => Promise<CanvasProject | null>;
    resolveConflictWithServer: (id: string) => Promise<CanvasProject | null>;
    clearActive: () => void;
};

/**
 * 自动保存计时器与在途请求都放在模块作用域：它们是副作用句柄，不属于渲染状态。
 * scopeToken 在每次 setScope 时自增，任何异步回调写回 state 前都必须比对 token，
 * 保证上一个账号或上一个 Workspace 的迟到响应无法把数据写进当前 scope。
 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSaveCanvasId: string | null = null;
let inFlightSave: Promise<void> | null = null;

function clearSaveTimer() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingSaveCanvasId = null;
}

function sameScope(a: CanvasScope | null, b: CanvasScope | null) {
    return a?.userId === b?.userId && a?.workspaceId === b?.workspaceId;
}

const AUTOSAVE_DEBOUNCE_MS = 400;

export const useCanvasStore = create<CanvasStore>()((set, get) => {
    /** 统一的 scope 守卫：token 变化或 scope 已切换时，异步结果一律丢弃。 */
    const isStale = (token: number, scope: CanvasScope | null) => get().scopeToken !== token || !sameScope(get().scope, scope);

    const persistDraft = async (canvas: ActiveCanvas) => {
        await writeCanvasDraft({
            userId: canvas.scope.userId,
            workspaceId: canvas.scope.workspaceId,
            canvasId: canvas.project.id,
            baseRevision: canvas.revision,
            title: canvas.project.title,
            snapshot: projectToSnapshot(canvas.project),
            savedAt: new Date().toISOString(),
        });
    };

    const runSave = async (canvasId: string) => {
        const token = get().scopeToken;
        const scope = get().scope;
        const active = get().active;
        if (!scope || !active || active.project.id !== canvasId || get().conflict?.canvasId === canvasId) return;

        const baseRevision = active.revision;
        const snapshot = projectToSnapshot(active.project);
        const title = active.project.title;
        const draftKey = canvasDraftKey({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId, baseRevision });
        set({ saveState: "saving" });
        await persistDraft(active);

        try {
            const result = await saveCanvasProject(scope.workspaceId, canvasId, { baseRevision, title, snapshot });
            if (isStale(token, scope)) return;
            const current = get().active;
            if (!current || current.project.id !== canvasId) return;
            /** revision 只从服务端响应推进；本地内容保持不变，避免服务端回包覆盖用户在保存期间的新编辑。 */
            set({
                active: { ...current, revision: result.revision },
                saveState: "saved",
                summaries: get().summaries.map((item) => (item.id === canvasId ? { ...item, title, revision: result.revision, updatedAt: result.project.updatedAt } : item)),
            });
            await removeCanvasDraftsOfCanvas({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId });
        } catch (error) {
            if (isStale(token, scope)) return;
            if (isRevisionConflictError(error)) {
                /** 冲突时停掉该画布的自动保存，并精确保留本次 baseRevision 的草稿，绝不静默合并或覆盖。 */
                clearSaveTimer();
                set({ saveState: "conflict", conflict: { canvasId, draftKey, baseRevision } });
                await removeCanvasDraftsOfCanvas({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId }, draftKey);
                return;
            }
            set({ saveState: "error" });
        }
    };

    const scheduleSave = (canvasId: string) => {
        if (get().conflict?.canvasId === canvasId) return;
        pendingSaveCanvasId = canvasId;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            pendingSaveCanvasId = null;
            inFlightSave = (inFlightSave ?? Promise.resolve()).then(() => runSave(canvasId));
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
            clearSaveTimer();
            inFlightSave = null;
            set({
                scope,
                scopeToken: get().scopeToken + 1,
                summaries: [],
                active: null,
                conflict: null,
                saveState: "idle",
                listStatus: "idle",
                listError: null,
            });
        },

        refreshList: async () => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return;
            set({ listStatus: "loading", listError: null });
            try {
                const summaries = await listCanvasSummaries(scope.workspaceId);
                if (isStale(token, scope)) return;
                set({ summaries, listStatus: "ready" });
            } catch (error) {
                if (isStale(token, scope)) return;
                set({ listStatus: "error", listError: error instanceof Error ? error.message : "unknown_error", summaries: [] });
            }
        },

        createProject: async (title) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) throw new Error("canvas_scope_missing");
            const { project, revision } = await createCanvasProject(scope.workspaceId, title);
            if (isStale(token, scope)) return project.id;
            set({ active: { project, revision, scope }, saveState: "idle", conflict: null, summaries: [projectToSummary(project, revision), ...get().summaries] });
            return project.id;
        },

        importProject: async (source, fallbackTitle) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) throw new Error("canvas_scope_missing");
            const body = projectToImportBody(source, fallbackTitle);
            const { project, revision } = await importCanvasProject(scope.workspaceId, body);
            if (isStale(token, scope)) return project.id;
            set({ summaries: [projectToSummary(project, revision), ...get().summaries] });
            return project.id;
        },

        openProject: async (id) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return null;
            clearSaveTimer();
            const { project, revision } = await loadCanvasProject(scope.workspaceId, id);
            if (isStale(token, scope)) return null;
            /** 若本地存在与该 revision 完全对应的草稿，说明上次编辑未成功保存，优先恢复草稿内容。 */
            const draft = await readCanvasDraft({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId: id, baseRevision: revision });
            if (isStale(token, scope)) return null;
            /** 草稿只覆盖画布语义字段，id、时间戳与 revision 仍以服务端为准。 */
            const restored = draft ? { ...project, ...snapshotToProjectContent(draft.snapshot), title: draft.title || project.title } : project;
            set({ active: { project: restored, revision, scope }, saveState: "idle", conflict: null });
            return restored;
        },

        renameProject: async (id, title) => {
            const trimmed = title.trim();
            if (!trimmed) return;
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return;
            const active = get().active;
            /** 当前画布本地已有权威快照，改名走同一条防抖保存链路，避免与正在编辑的内容互相覆盖。 */
            if (active && active.project.id === id) {
                if (get().conflict?.canvasId === id) return;
                set({ active: { ...active, project: { ...active.project, title: trimmed } } });
                scheduleSave(id);
                return;
            }
            /** 列表页改名时本地没有快照，先按服务端 revision 读取，再用同一 revision 条件写回，冲突直接抛给调用方提示。 */
            const { project, revision } = await loadCanvasProject(scope.workspaceId, id);
            if (isStale(token, scope)) return;
            const result = await saveCanvasProject(scope.workspaceId, id, { baseRevision: revision, title: trimmed, snapshot: projectToSnapshot(project) });
            if (isStale(token, scope)) return;
            set({
                summaries: get().summaries.map((item) => (item.id === id ? { ...item, title: trimmed, revision: result.revision, updatedAt: result.project.updatedAt } : item)),
            });
        },

        deleteProjects: async (ids) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope || !ids.length) return;
            clearSaveTimer();
            await Promise.all(ids.map((id) => deleteCanvasProject(scope.workspaceId, id)));
            await Promise.all(ids.map((id) => removeCanvasDraftsOfCanvas({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId: id })));
            if (isStale(token, scope)) return;
            const active = get().active;
            set({
                summaries: get().summaries.filter((item) => !ids.includes(item.id)),
                active: active && ids.includes(active.project.id) ? null : active,
                conflict: get().conflict && ids.includes(get().conflict!.canvasId) ? null : get().conflict,
            });
        },

        updateProject: (id, patch) => {
            const active = get().active;
            if (!active || active.project.id !== id) return;
            set({ active: { ...active, project: { ...active.project, ...patch } } });
            scheduleSave(id);
        },

        flushProject: async (id) => {
            if (pendingSaveCanvasId === id) clearSaveTimer();
            inFlightSave = (inFlightSave ?? Promise.resolve()).then(() => runSave(id));
            await inFlightSave;
        },

        loadProjectsForExport: async (ids) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope || !ids.length) return [];
            const active = get().active;
            const results = await Promise.all(
                ids.map(async (id) => {
                    /** 当前画布的内存内容比服务端更新（可能还在防抖窗口内），导出用内存版本更符合用户看到的画面。 */
                    if (active && active.project.id === id) return active.project;
                    const { project } = await loadCanvasProject(scope.workspaceId, id);
                    return project;
                }),
            );
            if (isStale(token, scope)) return [];
            return results;
        },

        readConflictDraft: async () => {
            const conflict = get().conflict;
            if (!conflict) return null;
            const draft = await readCanvasDraftByKey(conflict.draftKey);
            return draft ? draftToProject(draft) : null;
        },

        resolveConflictWithServer: async (id) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return null;
            const { project, revision } = await loadCanvasProject(scope.workspaceId, id);
            if (isStale(token, scope)) return null;
            await removeCanvasDraftsOfCanvas({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId: id });
            if (isStale(token, scope)) return null;
            set({ active: { project, revision, scope }, conflict: null, saveState: "idle" });
            return project;
        },

        clearActive: () => {
            clearSaveTimer();
            set({ active: null, saveState: "idle", conflict: null });
        },
    };
});
