import { create } from "zustand";

import type { CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import { clampCanvasTitle } from "@/lib/canvas/canvas-snapshot";
import { canvasSyncManager } from "@/services/canvas-sync/canvas-sync-manager";
import { sameCanvasScope, type CanvasCreateResult, type CanvasDeleteResult, type CanvasProjectPatch, type CanvasRenameResult, type CanvasRetryRecoveryResult, type CanvasSyncView } from "@/services/canvas-sync/types";
import type { CanvasProject, CanvasScope } from "@/types/canvas";

/** 视图适配器：只保存可渲染状态并把动作转发给 manager，不持有计时器、修订号或本地存储逻辑。 */
type CanvasStore = {
    scope: CanvasScope | null;
    listStatus: "idle" | "loading" | "ready" | "error";
    listError: string | null;
    summaries: CanvasProjectSummary[];
    activeCanvasId: string | null;
    /** 由活动会话推送；无活动会话为 null。 */
    sync: CanvasSyncView | null;
    setScope: (scope: CanvasScope | null) => void;
    refreshList: () => Promise<void>;
    createProject: (title: string) => Promise<CanvasCreateResult>;
    importProject: (source: Partial<CanvasProject>, fallbackTitle: string) => Promise<CanvasCreateResult>;
    renameProject: (canvasId: string, title: string) => Promise<CanvasRenameResult>;
    deleteProjects: (canvasIds: string[]) => Promise<CanvasDeleteResult>;
    loadProjectsForExport: (canvasIds: string[]) => Promise<CanvasProject[]>;
    updateProject: (canvasId: string, patch: CanvasProjectPatch) => void;
    flushProject: (canvasId: string) => Promise<void>;
    retrySave: (canvasId: string) => Promise<void>;
    retryRecovery: (canvasId: string) => Promise<CanvasRetryRecoveryResult>;
    exportConflictDrafts: (canvasId: string) => Promise<CanvasProject[]>;
    /** 非响应式读取活动画布内容，供素材回收与导出使用；不进入 React 订阅。 */
    getActiveProject: () => CanvasProject | null;
};

export const useCanvasStore = create<CanvasStore>()((set, get) => {
    /** 动作一律带 canvasId：切画布瞬间组件发出的调用不会打到别的画布上。 */
    const sessionFor = (canvasId: string) => {
        const session = canvasSyncManager.getActiveSession();
        return session && session.canvasId === canvasId && get().activeCanvasId === canvasId ? session : null;
    };

    return {
        scope: null,
        listStatus: "idle",
        listError: null,
        summaries: [],
        activeCanvasId: null,
        sync: null,

        setScope: (scope) => {
            /** 幂等判断交给 manager：它持有作用域令牌，首次的 null 也必须让它完成初始化，适配器不得替它拦下。 */
            canvasSyncManager.setScope(scope);
            const current = get().scope;
            /** 视图状态没变就不写 store，避免多余的重渲染；令牌失效已经由上面的 manager 调用完成。 */
            if ((current === null && scope === null) || sameCanvasScope(current, scope)) return;
            set({ scope, summaries: [], listStatus: "idle", listError: null });
        },

        refreshList: async () => {
            if (!get().scope) return;
            set({ listStatus: "loading", listError: null });
            const result = await canvasSyncManager.listCanvases();
            /** 迟到结果按作用域丢弃：新的作用域已经把 listStatus 重置为 idle 并会自己拉一次。 */
            if (result.status === "scope-changed") return;
            if (result.status === "failed") {
                set({ listStatus: "error", listError: result.messageKey, summaries: [] });
                return;
            }
            set({ summaries: result.summaries, listStatus: "ready" });
        },

        createProject: async (title) => {
            const result = await canvasSyncManager.createCanvas(title);
            if (result.status === "created") set({ summaries: [result.summary, ...get().summaries] });
            return result;
        },

        importProject: async (source, fallbackTitle) => {
            const result = await canvasSyncManager.importCanvas(source, fallbackTitle);
            if (result.status === "created") set({ summaries: [result.summary, ...get().summaries] });
            return result;
        },

        renameProject: async (canvasId, title) => {
            const result = await canvasSyncManager.renameCanvas(canvasId, title);
            if (result.status === "saved") set({ summaries: get().summaries.map((item) => (item.id === canvasId ? result.summary : item)) });
            /** 活动画布改名尚未落库，列表标题先按截断后的输入乐观更新，revision 与时间戳等下一次列表刷新。 */
            if (result.status === "scheduled" || result.status === "local-only") {
                const trimmed = clampCanvasTitle(title);
                set({ summaries: get().summaries.map((item) => (item.id === canvasId ? { ...item, title: trimmed } : item)) });
            }
            return result;
        },

        deleteProjects: async (canvasIds) => {
            const scopeAtCall = get().scope;
            const result = await canvasSyncManager.deleteCanvases(canvasIds);
            /** 作用域已变时仍返回真实结果，只是不写 store。 */
            if (!sameCanvasScope(scopeAtCall, get().scope)) return result;
            if (result.deleted.length) set({ summaries: get().summaries.filter((item) => !result.deleted.includes(item.id)) });
            return result;
        },

        loadProjectsForExport: (canvasIds) => canvasSyncManager.loadForExport(canvasIds),
        updateProject: (canvasId, patch) => {
            sessionFor(canvasId)?.update(patch);
        },
        flushProject: async (canvasId) => {
            await sessionFor(canvasId)?.flush();
        },
        retrySave: async (canvasId) => {
            await sessionFor(canvasId)?.retrySave();
        },
        retryRecovery: async (canvasId) => (await sessionFor(canvasId)?.retryRecovery()) ?? "failed",
        exportConflictDrafts: async (canvasId) => (await sessionFor(canvasId)?.exportConflictDrafts()) ?? [],
        getActiveProject: () => canvasSyncManager.getActiveSession()?.content ?? null,
    };
});

/** 会话视图是唯一真相：manager 在会话安装、替换与视图变化时通知，这里只做一次浅比较后写入。 */
canvasSyncManager.subscribe(() => {
    const session = canvasSyncManager.getActiveSession();
    const activeCanvasId = session?.canvasId ?? null;
    const sync: CanvasSyncView | null = session?.view ?? null;
    const state = useCanvasStore.getState();
    if (state.activeCanvasId === activeCanvasId && state.sync === sync) return;
    useCanvasStore.setState({ activeCanvasId, sync });
});
