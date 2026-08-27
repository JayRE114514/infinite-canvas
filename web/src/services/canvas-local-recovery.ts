import localforage from "localforage";

import {
    DRAFT_GC_MIN_AGE_MS,
    LOCAL_FLUSH_TIMEOUT_MS,
    LOCAL_READ_TIMEOUT_MS,
    MAX_CONFLICT_MARKER_ENTRIES,
    settleWithin,
    CanvasLocalRecoveryError,
    type CanvasConflictMarker,
    type CanvasConflictMarkerEntry,
    type CanvasDraftRecord,
    type CanvasDraftScope,
    type CanvasLocalRecovery,
    type CanvasLocalWrite,
} from "@/services/canvas-sync/types";

const recoveryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_recovery" });
const DRAFT_PREFIX = "canvas-draft";
const CONFLICT_PREFIX = "canvas-conflict";

/**
 * 项目尚未上线，不保留旧键兼容层：模块首次加载时丢弃一次旧 store，失败忽略。
 * 必须由隔离实例发起：默认实例已被 app_state 配置占用，在它上面调用会与既有配置竞争。
 */
void recoveryStore.dropInstance({ name: "infinite-canvas", storeName: "canvas_drafts" }).catch(() => undefined);

export function canvasDraftKeyPrefix(scope: CanvasDraftScope) {
    return [DRAFT_PREFIX, encodeURIComponent(scope.userId), encodeURIComponent(scope.workspaceId), encodeURIComponent(scope.canvasId), ""].join(":");
}

export function canvasDraftKey(scope: CanvasDraftScope, draftId: string) {
    return canvasDraftKeyPrefix(scope) + encodeURIComponent(draftId);
}

export function canvasConflictMarkerKey(scope: CanvasDraftScope) {
    return [CONFLICT_PREFIX, encodeURIComponent(scope.userId), encodeURIComponent(scope.workspaceId), encodeURIComponent(scope.canvasId)].join(":");
}

/** 超时或抛错一律抛 CanvasLocalRecoveryError；「读不出来」绝不能降级成「没有草稿」。 */
async function bounded<T>(operation: string, work: Promise<T>, timeoutMs: number): Promise<T> {
    const result = await settleWithin(work, timeoutMs);
    if (result.status !== "ok") throw new CanvasLocalRecoveryError(operation);
    return result.value;
}

/** result 与 settled 共享同一条原始 setItem；settled 吞掉原始拒绝，供后台观察链安全等待。 */
function localWrite(operation: string, raw: Promise<unknown>): CanvasLocalWrite {
    const settled = raw.then(
        () => undefined,
        () => undefined,
    );
    const result = bounded(operation, raw, LOCAL_FLUSH_TIMEOUT_MS).then(() => undefined);
    return { result, settled };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asDraftRecord(value: unknown, key: string): CanvasDraftRecord | null {
    if (!isRecord(value)) return null;
    const { userId, workspaceId, canvasId, draftId, baseRevision, state, title, snapshot, savedAt } = value;
    if (typeof userId !== "string" || typeof workspaceId !== "string" || typeof canvasId !== "string" || typeof draftId !== "string") return null;
    if (!isRevision(baseRevision) || (state !== "pending" && state !== "synced") || typeof title !== "string" || typeof savedAt !== "string" || !isRecord(snapshot)) return null;
    /** 键里已经带完整作用域，键与记录不一致即视为无效，等价于逐字段比对请求作用域。 */
    if (canvasDraftKey({ userId, workspaceId, canvasId }, draftId) !== key) return null;
    return value as CanvasDraftRecord;
}

function asMarkerEntry(value: unknown): CanvasConflictMarkerEntry | null {
    if (!isRecord(value)) return null;
    const { draftKey, draftId, baseRevision, savedAt } = value;
    if (typeof draftKey !== "string" || typeof draftId !== "string" || !isRevision(baseRevision) || typeof savedAt !== "string") return null;
    return { draftKey, draftId, baseRevision, savedAt };
}

function asMarker(value: unknown, scope: CanvasDraftScope): CanvasConflictMarker | null {
    if (!isRecord(value)) return null;
    const { userId, workspaceId, canvasId, entries } = value;
    if (userId !== scope.userId || workspaceId !== scope.workspaceId || canvasId !== scope.canvasId) return null;
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_CONFLICT_MARKER_ENTRIES) return null;
    const parsed = entries.map(asMarkerEntry);
    if (parsed.some((entry) => entry === null)) return null;
    return { userId, workspaceId, canvasId, entries: parsed as CanvasConflictMarkerEntry[] };
}

export const canvasLocalRecovery: CanvasLocalRecovery = {
    readMarker: async (scope) => {
        const key = canvasConflictMarkerKey(scope);
        const value = await bounded("readMarker", recoveryStore.getItem<unknown>(key), LOCAL_READ_TIMEOUT_MS);
        if (value === null || value === undefined) return null;
        const marker = asMarker(value, scope);
        /** 结构性损坏的 marker 由存储层自行清理；「条目全部指向无效草稿」是语义判断，交给会话解析器。 */
        if (!marker) {
            await settleWithin(recoveryStore.removeItem(key), LOCAL_FLUSH_TIMEOUT_MS);
            return null;
        }
        return marker;
    },
    writeMarker: (marker) => localWrite("writeMarker", recoveryStore.setItem(canvasConflictMarkerKey(marker), marker)),
    deleteMarker: async (scope) => {
        await bounded("deleteMarker", recoveryStore.removeItem(canvasConflictMarkerKey(scope)), LOCAL_FLUSH_TIMEOUT_MS);
    },
    readDraftByKey: async (key) => {
        const value = await bounded("readDraftByKey", recoveryStore.getItem<unknown>(key), LOCAL_READ_TIMEOUT_MS);
        return asDraftRecord(value, key);
    },
    writeDraft: (record) => localWrite("writeDraft", recoveryStore.setItem(canvasDraftKey(record, record.draftId), record)),
    deleteDraftByKey: async (key) => {
        await bounded("deleteDraftByKey", recoveryStore.removeItem(key), LOCAL_FLUSH_TIMEOUT_MS);
    },
    listCanvasDrafts: async (scope) => {
        const prefix = canvasDraftKeyPrefix(scope);
        const records: CanvasDraftRecord[] = [];
        await bounded(
            "listCanvasDrafts",
            recoveryStore.iterate<unknown, void>((value, key) => {
                if (!key.startsWith(prefix)) return;
                const record = asDraftRecord(value, key);
                /** 校验失败只跳过，不删除；删除只发生在 collectGarbage。 */
                if (record) records.push(record);
            }),
            LOCAL_READ_TIMEOUT_MS,
        );
        return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    collectGarbage: async (scope, keepKeys) => {
        const prefix = canvasDraftKeyPrefix(scope);
        const keep = new Set(keepKeys);
        const now = Date.now();
        const stale: string[] = [];
        const scan = await settleWithin(
            recoveryStore.iterate<unknown, void>((value, key) => {
                if (!key.startsWith(prefix) || keep.has(key)) return;
                const record = asDraftRecord(value, key);
                const savedAt = record ? Date.parse(record.savedAt) : Number.NaN;
                /** 6 小时年龄阈值给同源其他标签页留出活草稿的安全边界。 */
                if (Number.isFinite(savedAt) && now - savedAt > DRAFT_GC_MIN_AGE_MS) stale.push(key);
            }),
            LOCAL_READ_TIMEOUT_MS,
        );
        if (scan.status !== "ok" || !stale.length) return;
        await settleWithin(Promise.allSettled(stale.map((key) => recoveryStore.removeItem(key))), LOCAL_FLUSH_TIMEOUT_MS);
    },
};
