import type { CanvasSnapshot } from "@infinite-canvas/contracts";

import type { CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import type { CanvasProject, CanvasScope } from "@/types/canvas";

export const LOCAL_COALESCE_MS = 120;
export const NETWORK_DEBOUNCE_MS = 400;
export const NETWORK_MAX_WAIT_MS = 5_000;
export const SAVE_REQUEST_TIMEOUT_MS = 20_000;
export const LOAD_REQUEST_TIMEOUT_MS = 20_000;
export const LOCAL_READ_TIMEOUT_MS = 2_000;
export const LOCAL_FLUSH_TIMEOUT_MS = 2_000;
export const DETACHED_LOCAL_MS = 2_000;
export const DETACHED_NETWORK_MS = 10_000;
export const MAX_DETACHED_SESSIONS = 2;
export const EXPORT_BATCH_SIZE = 3;
export const DRAFT_GC_MIN_AGE_MS = 6 * 60 * 60 * 1_000;
export const MAX_CONFLICT_MARKER_ENTRIES = 2;

export type CanvasSyncPhase = "loading" | "clean" | "dirty" | "saving" | "save-error" | "conflict" | "recovery-blocked" | "disposing" | "disposed";
export type CanvasSaveErrorKind = "network" | "timeout" | "server" | "invariant";
export type CanvasLocalPersistState = "ok" | "degraded";
export type CanvasSyncSaveError = { kind: CanvasSaveErrorKind; messageKey: string };
export type CanvasSyncConflictView = { baseRevision: number; source: "save" | "restored"; extraDraftCount: number };

/** 会话对外导出的唯一可渲染事实；字段变化时整体替换。 */
export type CanvasSyncView = {
    canvasId: string;
    scope: CanvasScope;
    title: string;
    revision: number;
    phase: CanvasSyncPhase;
    hasUnsavedEdits: boolean;
    /** 本会话至少成功保存过一次，用于区分「已保存」与「打开后从未保存」。 */
    savedOnce: boolean;
    saveError: CanvasSyncSaveError | null;
    localPersist: CanvasLocalPersistState;
    conflict: CanvasSyncConflictView | null;
};

export type CanvasProjectPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>;
export const CANVAS_PATCH_FIELDS = ["nodes", "connections", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo", "viewport"] as const;

export type CanvasDisposeReason = "replaced" | "scope-changed" | "deleted" | "forced";
export type CanvasRetryRecoveryResult = "unlocked" | "conflict" | "failed";
export type CanvasRenameOutcome = "scheduled" | "local-only";

export type CanvasDraftScope = { userId: string; workspaceId: string; canvasId: string };
export type CanvasDraftState = "pending" | "synced";

export type CanvasDraftRecord = {
    userId: string;
    workspaceId: string;
    canvasId: string;
    draftId: string;
    /** 该内容所基于的服务端 revision。 */
    baseRevision: number;
    /** pending：尚未确认保存到服务端；synced：内容已被服务端在 baseRevision 确认。 */
    state: CanvasDraftState;
    title: string;
    snapshot: CanvasSnapshot;
    savedAt: string;
};

export type CanvasConflictMarkerEntry = { draftKey: string; draftId: string; baseRevision: number; savedAt: string };

export type CanvasConflictMarker = {
    userId: string;
    workspaceId: string;
    canvasId: string;
    /** 最新在前，最多 MAX_CONFLICT_MARKER_ENTRIES 条。 */
    entries: CanvasConflictMarkerEntry[];
};

/** 本地读取超时或抛错时抛出；与「记录无效」（返回 null）是两种不同结果。 */
export class CanvasLocalRecoveryError extends Error {
    constructor(readonly operation: string) {
        super("canvas_local_recovery_failed:" + operation);
        this.name = "CanvasLocalRecoveryError";
    }
}

export type CanvasLocalWrite = {
    /** 最多等待 LOCAL_FLUSH_TIMEOUT_MS；失败或超时统一抛 CanvasLocalRecoveryError。 */
    result: Promise<void>;
    /** 观察同一次原始 setItem 直到成功或失败；永不拒绝、没有超时，也不会取消底层写。 */
    settled: Promise<void>;
};

/** 只做存取与校验，不做调度，不判断冲突语义；读取/删除有界，写入同时暴露有界结果与原始落定信号。 */
export interface CanvasLocalRecovery {
    readMarker(scope: CanvasDraftScope): Promise<CanvasConflictMarker | null>;
    writeMarker(marker: CanvasConflictMarker): CanvasLocalWrite;
    deleteMarker(scope: CanvasDraftScope): Promise<void>;
    readDraftByKey(key: string): Promise<CanvasDraftRecord | null>;
    writeDraft(record: CanvasDraftRecord): CanvasLocalWrite;
    deleteDraftByKey(key: string): Promise<void>;
    /** 前缀枚举该画布全部草稿，savedAt 新的在前。 */
    listCanvasDrafts(scope: CanvasDraftScope): Promise<CanvasDraftRecord[]>;
    /** 删除该画布下不在 keepKeys 中且超过 DRAFT_GC_MIN_AGE_MS 的草稿；失败忽略。 */
    collectGarbage(scope: CanvasDraftScope, keepKeys: string[]): Promise<void>;
}

export type CanvasLoadResult = { project: CanvasProject; revision: number };
export type CanvasSaveInput = { baseRevision: number; title: string; snapshot: CanvasSnapshot };

/** 纯 HTTP 映射，不引用 store/manager；session 与 manager 通过它注入网络依赖。 */
export interface CanvasSyncRepository {
    list(workspaceId: string): Promise<CanvasProjectSummary[]>;
    load(workspaceId: string, canvasId: string): Promise<CanvasLoadResult>;
    create(workspaceId: string, title: string): Promise<CanvasLoadResult>;
    importProject(workspaceId: string, body: { title: string; snapshot: CanvasSnapshot }): Promise<CanvasLoadResult>;
    save(workspaceId: string, canvasId: string, input: CanvasSaveInput, signal?: AbortSignal): Promise<CanvasLoadResult>;
    remove(workspaceId: string, canvasId: string): Promise<void>;
}

export type CanvasSaveFailure = { kind: "conflict" } | { kind: "network" | "timeout" | "server"; messageKey: string };
export type CanvasOpenFailure = { kind: "missing" } | { kind: "failed"; messageKey: string };

export type CanvasSyncInvariantContext = { sessionId: number; canvasId: string; phase: CanvasSyncPhase; event: string; editSeq: number; savedSeq: number; inflightSeq: number; revision: number };

export class CanvasSyncInvariantError extends Error {
    constructor(readonly context: CanvasSyncInvariantContext) {
        super("canvas_sync_invariant_violation");
        this.name = "CanvasSyncInvariantError";
    }
}

export interface CanvasSyncSession {
    readonly sessionId: number;
    readonly canvasId: string;
    readonly scope: CanvasScope;
    readonly scopeToken: number;
    readonly openToken: number;
    /** 本会话唯一的草稿键，供 manager 在回收与清理时保留或删除。 */
    readonly draftKey: string;
    readonly view: CanvasSyncView;
    /** 当前权威前端内容，引用稳定，供导出与素材引用判定使用。 */
    readonly content: CanvasProject;
    /** 由 manager 在 commit 时调用，携带补水后的内容；重复调用视为不变量事故。 */
    install(content: CanvasProject): void;
    /** 返回是否记为一次真实编辑；字段引用全同或阶段不接受编辑时返回 false。 */
    update(patch: CanvasProjectPatch): boolean;
    /** 标题在调用前已由 clampCanvasTitle 截断到 CANVAS_TITLE_MAX_LENGTH。 */
    rename(title: string): CanvasRenameOutcome;
    /** 强制物化本地并在允许时提交一次；对外等待全部有界，超时后的原始本地写由 settled 继续观察。 */
    flush(): Promise<void>;
    retrySave(): Promise<void>;
    retryRecovery(): Promise<CanvasRetryRecoveryResult>;
    exportConflictDrafts(): Promise<CanvasProject[]>;
    dispose(reason: CanvasDisposeReason): Promise<void>;
    /**
     * 会话所有的本地落定信号：等到该会话的草稿队列、可产生写入的尾巴和原始 setItem 都结束，故意不设上界。
     * 同一会话的重复调用共享一个观察器；等待期间新登记的操作会在下一轮被重新检查。
     * 它只观察，不取消或重试：有界 result/dispose 返回不代表原始写已结束，永久挂起也会令本观察器永久挂起。
     * 只允许在已 dispose 或正在 dispose 的会话上调用，且只用于清理路径补一次幂等清理，绝不出现在打开画布的等待路径上。
     */
    whenLocalSettled(): Promise<void>;
    subscribe(listener: (view: CanvasSyncView) => void): () => void;
}

export type PreparedCanvasOpen =
    | { status: "ready"; canvasId: string; project: CanvasProject; session: CanvasSyncSession }
    | { status: "cancelled" }
    | { status: "missing" }
    | { status: "failed"; messageKey: string };

export type CanvasCreateResult =
    | { status: "created"; canvasId: string; summary: CanvasProjectSummary }
    | { status: "scope-changed" }
    | { status: "failed"; messageKey: string };

export type CanvasListResult =
    | { status: "ready"; summaries: CanvasProjectSummary[] }
    | { status: "scope-changed" }
    | { status: "failed"; messageKey: string };

/** saved 携带服务端返回的新摘要，列表不必为一次重命名再刷新一次。 */
export type CanvasRenameResult =
    | { status: "scheduled" }
    | { status: "saved"; summary: CanvasProjectSummary }
    | { status: "local-only" }
    | { status: "conflict" }
    | { status: "scope-changed" }
    | { status: "failed"; messageKey: string };
export type CanvasDeleteResult = { deleted: string[]; failed: string[] };
export type CanvasCommitServerCopyResult = "committed" | "cancelled" | "failed";

export interface CanvasSyncManager {
    getScope(): CanvasScope | null;
    setScope(scope: CanvasScope | null): void;
    getActiveSession(): CanvasSyncSession | null;
    prepareOpen(canvasId: string): Promise<PreparedCanvasOpen>;
    /** content 必须是补水后的对象，与页面写入 React 的引用完全相同。 */
    commitPrepared(prepared: PreparedCanvasOpen, content: CanvasProject): boolean;
    prepareServerCopy(canvasId: string): Promise<PreparedCanvasOpen>;
    commitServerCopy(prepared: PreparedCanvasOpen, content: CanvasProject): CanvasCommitServerCopyResult;
    listCanvases(): Promise<CanvasListResult>;
    createCanvas(title: string): Promise<CanvasCreateResult>;
    importCanvas(source: Partial<CanvasProject>, fallbackTitle: string): Promise<CanvasCreateResult>;
    renameCanvas(canvasId: string, title: string): Promise<CanvasRenameResult>;
    deleteCanvases(canvasIds: string[]): Promise<CanvasDeleteResult>;
    loadForExport(canvasIds: string[]): Promise<CanvasProject[]>;
    subscribe(listener: () => void): () => void;
}

export function sameCanvasScope(a: CanvasScope | null | undefined, b: CanvasScope | null | undefined) {
    return Boolean(a && b && a.userId === b.userId && a.workspaceId === b.workspaceId);
}

export type BoundedResult<T> = { status: "ok"; value: T } | { status: "failed" };

/** 所有等待点都必须有上界：慢速或永不返回的本地存储不得冻结云端保存与打开画布。 */
export function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ status: "failed" });
        }, timeoutMs);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ status: "ok", value });
            },
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ status: "failed" });
            },
        );
    });
}
