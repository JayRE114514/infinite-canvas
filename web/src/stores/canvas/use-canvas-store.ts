import { create } from "zustand";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { clampCanvasTitle, draftToProject, projectToImportBody, projectToSnapshot, projectToSummary, snapshotToProjectContent, type CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
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
import { platformErrorTranslationKey } from "@/services/api/platform-client";
import type { CanvasSnapshot } from "@infinite-canvas/contracts";
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

/** 批量删除是部分成功语义：成功的已从列表移除，失败的仍在列表里，调用方据此决定提示与选中态。 */
export type CanvasDeleteResult = { deleted: string[]; failed: string[] };

type ActiveCanvas = {
    project: CanvasProject;
    revision: number;
    scope: CanvasScope;
    saveRevision: SaveRevision;
};

type SavePayload = { title: string; snapshot: CanvasSnapshot };

/**
 * 同一次画布打开期间的候选共享这条 revision 链。
 * 前一个候选成功后只推进自己的链，后续编辑便以新 revision 保存；重新打开或切换 scope 会创建新链，
 * 因而旧请求既不能给新画布 rebase，也不能把冲突状态串进新的编辑会话。
 */
type SaveRevision = { current: number; blocked: boolean; latest: SavePayload | null };

/**
 * 保存候选在「安排保存」的那一刻就把要写出去的内容全部固定下来。
 * 如果等到防抖计时器真正触发时才去读 active，用户在这期间新建或切换画布，
 * 就会把上一个画布的最后一次编辑丢掉，或者错写进另一个画布。
 */
type SaveCandidate = {
    canvasId: string;
    scope: CanvasScope;
    scopeToken: number;
    saveRevision: SaveRevision;
    payload: SavePayload;
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
    /** 逐个删除：分别返回成功与失败的 id，成功的立即从列表移除，失败的保留，调用方据此提示。 */
    deleteProjects: (ids: string[]) => Promise<CanvasDeleteResult>;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>) => void;
    flushProject: (id: string) => Promise<void>;
    /** 导出需要完整快照，列表只有摘要，因此按需从服务端小批量拉取。 */
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
let pendingSave: SaveCandidate | null = null;
let saveChain: Promise<void> = Promise.resolve();

function clearSaveTimer() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingSave = null;
}

/**
 * 保存必须串行，但任何一次失败都不能污染后续链路，否则队列会永久停摆。
 * 失败结果也在这里收口：链上永远保存一个已 resolve 的 Promise，
 * 既保证下一次保存照常执行，也避免调用方 void 调用时冒出未处理的 rejection。
 */
function enqueueSave(run: () => Promise<void>) {
    saveChain = saveChain.then(run, run).catch(() => undefined);
    return saveChain;
}

function sameScope(a: CanvasScope | null, b: CanvasScope | null) {
    return a?.userId === b?.userId && a?.workspaceId === b?.workspaceId;
}

function activeCanvas(project: CanvasProject, revision: number, scope: CanvasScope): ActiveCanvas {
    return { project, revision, scope, saveRevision: { current: revision, blocked: false, latest: null } };
}

const AUTOSAVE_DEBOUNCE_MS = 400;
/** 导出逐个拉取服务端快照，限制并发避免一次选中很多画布时打满连接。 */
const EXPORT_BATCH_SIZE = 3;
/** scope 已切换时新建/导入的结果属于旧账号或旧 Workspace，调用方据此跳过导航与报错提示。 */
export const CANVAS_SCOPE_CHANGED_ERROR = "canvas_scope_changed";

export function isScopeChangedError(error: unknown) {
    return error instanceof Error && error.message === CANVAS_SCOPE_CHANGED_ERROR;
}

export const useCanvasStore = create<CanvasStore>()((set, get) => {
    /** 统一的 scope 守卫：token 变化或 scope 已切换时，异步结果一律丢弃。 */
    const isStale = (token: number, scope: CanvasScope | null) => get().scopeToken !== token || !sameScope(get().scope, scope);

    /** 草稿是尽力而为的本地兜底：写失败不能阻断网络保存，也不能让保存状态卡住。 */
    const persistDraft = async (candidate: SaveCandidate, baseRevision: number, payload = candidate.payload) => {
        try {
            await writeCanvasDraft({
                userId: candidate.scope.userId,
                workspaceId: candidate.scope.workspaceId,
                canvasId: candidate.canvasId,
                baseRevision,
                title: payload.title,
                snapshot: payload.snapshot,
                savedAt: new Date().toISOString(),
            });
        } catch {
            /** 本地存储可能满或被禁用，此时只丢失离线兜底能力，服务端保存照常进行。 */
        }
    };

    const dropDrafts = async (scope: CanvasScope, canvasId: string, keepKey?: string) => {
        try {
            await removeCanvasDraftsOfCanvas({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId }, keepKey);
        } catch {
            /** 清理草稿失败只会留下一条孤儿草稿，不影响服务端权威内容。 */
        }
    };

    /** 只按候选内容保存：期间 active 可能已经切到别的画布，但这份内容必须原样落到它自己的画布上。 */
    const runSave = async (candidate: SaveCandidate) => {
        const { canvasId, scope, scopeToken: token, saveRevision, payload } = candidate;
        if (saveRevision.blocked) return;
        const baseRevision = saveRevision.current;
        const draftKey = canvasDraftKey({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId, baseRevision });
        const isCurrent = () => {
            const active = get().active;
            return !isStale(token, scope) && active?.project.id === canvasId && sameScope(active.scope, scope) && active.saveRevision === saveRevision;
        };
        if (isCurrent()) set({ saveState: "saving" });
        await persistDraft(candidate, baseRevision);

        try {
            const result = await saveCanvasProject(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot });
            /** 先推进候选自己的链；即使期间已切 scope，排在它后面的旧 scope 编辑也必须使用这次服务端返回的 revision。 */
            saveRevision.current = result.revision;
            if (saveRevision.latest === payload) saveRevision.latest = null;
            await dropDrafts(scope, canvasId);
            if (isStale(token, scope)) return;
            const current = get().active;
            /** revision 只从服务端响应推进；本地内容保持不变，避免服务端回包覆盖用户在保存期间的新编辑。 */
            set({
                ...(current && isCurrent() ? { active: { ...current, revision: result.revision }, saveState: "saved" as CanvasSaveState } : {}),
                summaries: get().summaries.map((item) => (item.id === canvasId ? { ...item, title: payload.title, revision: result.revision, updatedAt: result.project.updatedAt } : item)),
            });
        } catch (error) {
            if (isRevisionConflictError(error)) {
                /** 冲突时以该 lineage 最新捕获的内容重写草稿，再阻断所有后续候选，绝不丢掉请求期间的新编辑。 */
                const conflictPayload = saveRevision.latest ?? payload;
                saveRevision.blocked = true;
                if (pendingSave?.saveRevision === saveRevision) clearSaveTimer();
                await persistDraft(candidate, baseRevision, conflictPayload);
                await dropDrafts(scope, canvasId, draftKey);
                if (isStale(token, scope)) return;
                set({ conflict: { canvasId, draftKey, baseRevision }, ...(isCurrent() ? { saveState: "conflict" as CanvasSaveState } : {}) });
                return;
            }
            if (isStale(token, scope)) return;
            if (isCurrent()) set({ saveState: "error" });
        }
    };

    /** 把已捕获的待保存内容立刻推进保存队列，返回值用于卸载/pagehide 时等待完成。 */
    const flushPendingSave = (canvasId?: string) => {
        const candidate = pendingSave;
        if (!candidate || (canvasId && candidate.canvasId !== canvasId)) return saveChain;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        pendingSave = null;
        return enqueueSave(() => runSave(candidate));
    };

    /** 安排保存时就地捕获快照与 revision，之后无论用户怎么切换画布，这份内容都不会跑到别的画布上。 */
    const scheduleSave = (canvasId: string) => {
        const scope = get().scope;
        const active = get().active;
        if (!scope || !active || active.project.id !== canvasId || active.saveRevision.blocked || get().conflict?.canvasId === canvasId) return;
        const payload = { title: active.project.title, snapshot: projectToSnapshot(active.project) };
        const candidate: SaveCandidate = {
            canvasId,
            scope,
            scopeToken: get().scopeToken,
            saveRevision: active.saveRevision,
            payload,
        };
        active.saveRevision.latest = payload;
        /** 同一画布的待保存内容直接替换成最新的；换成别的画布时先把上一份提交出去，避免丢编辑。 */
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
            /** 切 scope 前先把已捕获的编辑提交出去，它带着旧 scope，不会写进新 scope。 */
            flushPendingSave();
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
                /** 只保留稳定的本地化 key：服务端原文可能包含实现细节，不适合写入界面或 Agent 状态。 */
                set({ listStatus: "error", listError: platformErrorTranslationKey(error, "canvas.listFailed"), summaries: [] });
            }
        },

        createProject: async (title) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) throw new Error("canvas_scope_missing");
            /** 新建前先把上一个画布已捕获的编辑提交出去，否则「改完 A 立刻新建 B」会丢掉 A 的最后一次改动。 */
            await flushPendingSave();
            if (isStale(token, scope)) throw new Error(CANVAS_SCOPE_CHANGED_ERROR);
            const { project, revision } = await createCanvasProject(scope.workspaceId, clampCanvasTitle(title));
            /** scope 已经切换时这条结果属于旧账号/旧 Workspace，既不能进列表也不能让调用方拿去导航。 */
            if (isStale(token, scope)) throw new Error(CANVAS_SCOPE_CHANGED_ERROR);
            set({ active: activeCanvas(project, revision, scope), saveState: "idle", summaries: [projectToSummary(project, revision), ...get().summaries] });
            return project.id;
        },

        importProject: async (source, fallbackTitle) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) throw new Error("canvas_scope_missing");
            const body = projectToImportBody(source, fallbackTitle);
            const { project, revision } = await importCanvasProject(scope.workspaceId, body);
            if (isStale(token, scope)) throw new Error(CANVAS_SCOPE_CHANGED_ERROR);
            set({ summaries: [projectToSummary(project, revision), ...get().summaries] });
            return project.id;
        },

        openProject: async (id) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope) return null;
            /** 打开新画布前先提交上一个画布已捕获的编辑，再清空计时器。 */
            await flushPendingSave();
            if (isStale(token, scope)) return null;
            const { project, revision } = await loadCanvasProject(scope.workspaceId, id);
            if (isStale(token, scope)) return null;
            const conflict = get().conflict?.canvasId === id ? get().conflict : null;
            /** 冲突草稿必须按记录下来的旧 revision 精确读取；普通恢复只接受当前服务端 revision 的草稿。 */
            const draft = conflict
                ? await readCanvasDraftByKey(conflict.draftKey)
                : await readCanvasDraft({ userId: scope.userId, workspaceId: scope.workspaceId, canvasId: id, baseRevision: revision });
            if (isStale(token, scope)) return null;
            /** 草稿只覆盖画布语义字段，id、时间戳与 revision 仍以服务端为准。 */
            const restored = draft ? { ...project, ...snapshotToProjectContent(draft.snapshot), title: draft.title || project.title } : project;
            const active = activeCanvas(restored, revision, scope);
            if (conflict) active.saveRevision.blocked = true;
            set({ active, saveState: conflict ? "conflict" : "idle" });
            return restored;
        },

        renameProject: async (id, title) => {
            const trimmed = clampCanvasTitle(title);
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
            if (!scope || !ids.length) return { deleted: [], failed: [] };
            /** 先完成已捕获的编辑；删除若失败，画布仍保留且最后一次编辑也不能被提前丢弃。 */
            await flushPendingSave();
            if (isStale(token, scope)) return { deleted: [], failed: [] };
            /** 逐个判定成败：一个失败不能让已经删掉的画布继续留在列表里。 */
            const outcomes = await Promise.allSettled(ids.map((id) => deleteCanvasProject(scope.workspaceId, id)));
            const deleted = ids.filter((_id, index) => outcomes[index].status === "fulfilled");
            const failed = ids.filter((id) => !deleted.includes(id));
            for (const id of deleted) await dropDrafts(scope, id);
            if (isStale(token, scope)) return { deleted: [], failed: [] };
            if (deleted.length) {
                const active = get().active;
                const conflict = get().conflict;
                set({
                    summaries: get().summaries.filter((item) => !deleted.includes(item.id)),
                    active: active && deleted.includes(active.project.id) ? null : active,
                    conflict: conflict && deleted.includes(conflict.canvasId) ? null : conflict,
                });
            }
            return { deleted, failed };
        },

        updateProject: (id, patch) => {
            const active = get().active;
            if (!active || active.project.id !== id) return;
            set({ active: { ...active, project: { ...active.project, ...patch } } });
            scheduleSave(id);
        },

        flushProject: async (id) => {
            /**
             * 只提交已捕获的内容：待保存内容属于哪个画布，就保存到那个画布。
             * id 只用于表达调用方关心的画布，此时 active 可能已经是别的画布，绝不能拿它的内容顶替。
             */
            await flushPendingSave(id);
        },

        loadProjectsForExport: async (ids) => {
            const token = get().scopeToken;
            const scope = get().scope;
            if (!scope || !ids.length) return [];
            const active = get().active;
            const results: CanvasProject[] = [];
            /** 小批次串行拉取：任一失败直接抛给调用方提示，不返回空数组假装「没有可导出内容」。 */
            for (let index = 0; index < ids.length; index += EXPORT_BATCH_SIZE) {
                const batch = await Promise.all(
                    ids.slice(index, index + EXPORT_BATCH_SIZE).map(async (id) => {
                        /** 当前画布的内存内容比服务端更新（可能还在防抖窗口内），导出用内存版本更符合用户看到的画面。 */
                        if (active && active.project.id === id) return active.project;
                        const { project } = await loadCanvasProject(scope.workspaceId, id);
                        return project;
                    }),
                );
                if (isStale(token, scope)) return [];
                results.push(...batch);
            }
            return results;
        },

        readConflictDraft: async () => {
            const token = get().scopeToken;
            const scope = get().scope;
            const conflict = get().conflict;
            if (!scope || !conflict) return null;
            const draft = await readCanvasDraftByKey(conflict.draftKey);
            /** await 期间可能已切换账号/Workspace 或换了冲突画布，此时不能把旧 scope 的草稿导出去。 */
            if (isStale(token, scope) || get().conflict?.draftKey !== conflict.draftKey) return null;
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
            set({ active: activeCanvas(project, revision, scope), conflict: null, saveState: "idle" });
            return project;
        },

        clearActive: () => {
            /** 先把已捕获的编辑提交出去，它带着自己的画布 id 与 scope，不会写错目标。 */
            flushPendingSave();
            set({ active: null, saveState: "idle" });
        },
    };
});
