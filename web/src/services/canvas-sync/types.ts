import type { CanvasDeletionReceipt, CanvasSnapshot } from "@infinite-canvas/contracts";

import type { CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import type { CanvasDraftUpsertInput } from "@/services/canvas-recovery/store";
import type { CanvasConflictMarkerEntry, CanvasDraftWriteOutcome } from "@/services/canvas-recovery/types";
import type { RecoveryScopeId } from "@/services/canvas-recovery/scope";
import type { CanvasProject, CanvasScope, ViewportTransform } from "@/types/canvas";

export const LOCAL_COALESCE_MS = 120;
export const NETWORK_DEBOUNCE_MS = 400;
export const NETWORK_MAX_WAIT_MS = 5_000;
export const SAVE_REQUEST_TIMEOUT_MS = 20_000;
export const LOAD_REQUEST_TIMEOUT_MS = 20_000;
export const LOCAL_FLUSH_TIMEOUT_MS = 2_000;
export const DETACHED_LOCAL_MS = 2_000;
export const DETACHED_NETWORK_MS = 10_000;
export const MAX_DETACHED_SESSIONS = 2;
export const EXPORT_BATCH_SIZE = 3;
export const DRAFT_GC_MIN_AGE_MS = 6 * 60 * 60 * 1_000;
export const MAX_COORDINATION_ATTEMPTS = 2;
export { MAX_CONFLICT_MARKER_ENTRIES } from "@/services/canvas-recovery/types";

export type CanvasSyncPhase = "loading" | "clean" | "dirty" | "saving" | "save-error" | "conflict" | "recovery-blocked" | "tombstoned" | "disposing" | "disposed";
export type CanvasSaveErrorKind = "network" | "timeout" | "server" | "invariant";
export type CanvasLocalPersistState = "ok" | "degraded" | "tombstoned";
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
    unavailableKey: string | null;
};

/** Document edits advance editSeq and schedule a cloud save. */
export const CANVAS_DOCUMENT_PATCH_FIELDS = ["nodes", "connections", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo"] as const;
/** Local UI only: persisted in the draft envelope, never serialized as a document edit. */
export const CANVAS_LOCAL_PATCH_FIELDS = ["viewport"] as const;
export type CanvasProjectPatch = Partial<Pick<CanvasProject, (typeof CANVAS_DOCUMENT_PATCH_FIELDS)[number] | (typeof CANVAS_LOCAL_PATCH_FIELDS)[number]>>;

export type CanvasDisposeReason = "replaced" | "scope-changed" | "deleted" | "forced";
export type CanvasRetryRecoveryResult = "unlocked" | "conflict" | "failed";
export type CanvasRenameOutcome = "scheduled" | "local-only";

/**
 * 打开画布时按 4.4 判定得出的本地修复动作。
 * resolver 只描述要做什么，不自己执行：这些改写必须由 commit 之后的会话拥有，
 * 否则被取消的 prepare 会留下无人观察、可能在清理之后落盘的原始写。
 */
export type CanvasRecoveryRepair = { kind: "write-marker"; entries: CanvasConflictMarkerEntry[] } | { kind: "delete-marker" } | { kind: "delete-drafts"; draftIds: string[] };

export type CanvasLoadResult = { project: CanvasProject; revision: number };
export type CanvasSaveInput = { baseRevision: number; title: string; snapshot: CanvasSnapshot };

export type CanvasRecoveryResolution = {
    phase: "clean" | "dirty" | "conflict" | "recovery-blocked" | "tombstoned";
    content: CanvasProject;
    revision: number;
    draftId: string;
    conflict: CanvasSyncConflictView | null;
    repairs: CanvasRecoveryRepair[];
    expectedCoordinationRevision: number;
    expectedDeletionGeneration: number;
    /**
     * 本会话把内容复制进自己新行时，被它取代的旧草稿行及其当时的 writeSeq。
     * 等本会话自己的行确认落盘、且该行仍是当时那一行时才回收：内容此时已在新行里，
     * 不依赖网络也能安全回收。留着不回收会让已保存干净的画布下次打开被误判成冲突，
     * 而 GC 不允许回收未同步行。
     */
    supersededDrafts: { draftId: string; expectedWriteSeq: number }[];
    documentDefaultViewport: ViewportTransform;
};

export type CanvasConflictPublishOutcome = { status: "published"; extraDraftCount: number } | { status: "tombstoned" } | { status: "unavailable" };
export type CanvasCoordinatedRetryOutcome =
    | ({ status: "unlocked" } & CanvasRecoveryOwnership)
    | ({ status: "conflict"; conflict: CanvasSyncConflictView } & CanvasRecoveryOwnership)
    | { status: "tombstoned" }
    | { status: "failed" };

/**
 * 一次重试后重新确立的本地恢复所有权事实。重试必须把这些事实带回 Session：
 * 只返回 "unlocked" 会让 Session 继续用 prepare 期的 draftId 和删除代次写盘，
 * 那等于在存储已经换代之后假装自己仍然拥有旧行。
 */
export type CanvasRecoveryOwnership = {
    /** 本会话在新 epoch 下自己的草稿行；重试会重新铸一个，不接管别人的行。 */
    draftId: string;
    expectedCoordinationRevision: number;
    expectedDeletionGeneration: number;
    /** 已被本会话复制走、待本会话自己的行落盘后回收的旧行。 */
    supersededDrafts: { draftId: string; expectedWriteSeq: number }[];
};

/** Manager-owned coordination seam; Session never receives the full recovery store. */
export type CanvasSessionRecoveryCoordinator = {
    publishConflict(draftId: string, baseRevision: number, signal: AbortSignal): Promise<CanvasConflictPublishOutcome>;
    retryRecovery(load: CanvasLoadResult, ownDraftId: string, hasUnsavedEdits: boolean, signal: AbortSignal): Promise<CanvasCoordinatedRetryOutcome>;
    exportConflictDrafts(canvasId: string, ownDraftId: string, signal: AbortSignal): Promise<CanvasProject[] | null>;
    /** 回收已被本会话复制走的旧草稿行；只在本会话自己的行确认落盘后调用。 */
    retireSupersededDrafts(drafts: { draftId: string; expectedWriteSeq: number }[], signal: AbortSignal): Promise<void>;
};

export type CanvasDraftWriter = (input: CanvasDraftUpsertInput, signal?: AbortSignal) => Promise<CanvasDraftWriteOutcome>;

/** 纯 HTTP 映射，不引用 store/manager；session 与 manager 通过它注入网络依赖。 */
export interface CanvasSyncRepository {
    list(workspaceId: string): Promise<CanvasProjectSummary[]>;
    load(workspaceId: string, canvasId: string): Promise<CanvasLoadResult>;
    create(workspaceId: string, title: string): Promise<CanvasLoadResult>;
    importProject(workspaceId: string, body: { title: string; snapshot: CanvasSnapshot }): Promise<CanvasLoadResult>;
    save(workspaceId: string, canvasId: string, input: CanvasSaveInput, signal?: AbortSignal): Promise<CanvasLoadResult>;
    /** Denied and indeterminate results are values so callers cannot mistake them for deletion proof. */
    remove(workspaceId: string, canvasId: string): Promise<CanvasDeleteOutcome>;
}

export type CanvasSaveFailure = { kind: "conflict" } | { kind: "network" | "timeout" | "server"; messageKey: string };
export type CanvasOpenFailure = { kind: "missing" } | { kind: "failed"; messageKey: string };
export type CanvasDeleteIndeterminateReason = "network" | "timeout" | "invalid-response" | "mismatched-receipt" | "unknown";
/** Only a valid receipt for the requested canvas is positive deletion proof. */
export type CanvasDeleteOutcome =
    | { status: "deleted"; receipt: CanvasDeletionReceipt }
    | { status: "denied"; code: string; messageKey: string }
    | { status: "indeterminate"; reason: CanvasDeleteIndeterminateReason; messageKey: string };

export type CanvasSyncInvariantContext = {
    sessionId: number;
    canvasId: string;
    phase: CanvasSyncPhase;
    event: string;
    editSeq: number;
    savedSeq: number;
    inflightSeq: number;
    revision: number;
    localUiSeq: number;
    materializedLocalUiSeq: number;
    persistedLocalUiSeq: number;
};

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
    /** 本会话在 recovery scope 内唯一的草稿 id。 */
    readonly draftId: string;
    readonly view: CanvasSyncView;
    /** 当前权威前端内容，引用稳定，供导出与素材引用判定使用。 */
    readonly content: CanvasProject;
    /** 由 manager 在 commit 时调用，携带补水后的内容；重复调用视为不变量事故。 */
    install(content: CanvasProject): void;
    /** 返回是否记为一次真实编辑；字段引用全同或阶段不接受编辑时返回 false。 */
    update(patch: CanvasProjectPatch): boolean;
    /** 标题在调用前已由 clampCanvasTitle 截断到 CANVAS_TITLE_MAX_LENGTH。 */
    rename(title: string): CanvasRenameOutcome;
    /** 强制物化本地并在允许时提交一次；所有本地事务都由会话 owner signal 有界取消。 */
    flush(): Promise<void>;
    /**
     * 删除活动画布前的可逆冻结：停止接受编辑与网络保存，强制把最后一次编辑物化到本地，但保留会话所有权。
     * 删除成功由 manager 走 dispose("deleted") 终结；删除失败必须 releaseHold() 让同一个会话继续可用。
     */
    holdForDelete(): Promise<void>;
    /** 撤销 holdForDelete：恢复编辑与网络调度，并把冻结期间累积的编辑重新排程。 */
    releaseHold(): void;
    retrySave(): Promise<void>;
    retryRecovery(): Promise<CanvasRetryRecoveryResult>;
    exportConflictDrafts(): Promise<CanvasProject[]>;
    dispose(reason: CanvasDisposeReason): Promise<void>;
    /** Manager reports coordination outcomes without exposing its store to Session. */
    reportRecoveryState(state: { status: "degraded" } | { status: "tombstoned" } | { status: "conflict"; conflict: CanvasSyncConflictView }): void;
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
/**
 * `deleted` means the server proved the deletion. `localCleanupPending` is a subset of it whose
 * local tombstone could not be written yet, so the canvas is gone but local rows remain.
 * `failed` means no deletion proof was received and the canvas still exists.
 */
export type CanvasDeleteResult = { deleted: string[]; failed: string[]; localCleanupPending: string[] };
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
