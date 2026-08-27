import localforage from "localforage";

import type { CanvasSnapshot } from "@infinite-canvas/contracts";

/**
 * 草稿是「未成功保存到服务端的本地快照」，key 必须完整包含 userId、workspaceId、canvasId 和 baseRevision，
 * 这样切换账号、切换 Workspace 或服务端 revision 前进后，旧草稿都不会被误当成当前画布的待保存内容。
 */
const draftStore = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_drafts" });
const DRAFT_PREFIX = "canvas-draft";
const CONFLICT_PREFIX = "canvas-conflict";

export type CanvasDraftScope = {
    userId: string;
    workspaceId: string;
    canvasId: string;
    baseRevision: number;
};

export type CanvasDraftRecord = CanvasDraftScope & {
    title: string;
    snapshot: CanvasSnapshot;
    savedAt: string;
};

export type CanvasConflictMarker = Omit<CanvasDraftScope, "baseRevision"> & {
    draftKey: string;
    baseRevision: number;
};

export type CanvasConflictMarkerRead = { marker: CanvasConflictMarker | null; invalid: boolean };

function encodePart(value: string) {
    return encodeURIComponent(value);
}

export function canvasDraftKey({ userId, workspaceId, canvasId, baseRevision }: CanvasDraftScope) {
    return [DRAFT_PREFIX, encodePart(userId), encodePart(workspaceId), encodePart(canvasId), String(baseRevision)].join(":");
}

export function canvasConflictMarkerKey({ userId, workspaceId, canvasId }: Omit<CanvasDraftScope, "baseRevision">) {
    return [CONFLICT_PREFIX, encodePart(userId), encodePart(workspaceId), encodePart(canvasId)].join(":");
}

export function isCanvasDraftKeyOfCanvas(key: string, scope: Omit<CanvasDraftScope, "baseRevision">) {
    const prefix = [DRAFT_PREFIX, encodePart(scope.userId), encodePart(scope.workspaceId), encodePart(scope.canvasId), ""].join(":");
    return key.startsWith(prefix);
}

export async function readCanvasDraft(scope: CanvasDraftScope) {
    const value = await draftStore.getItem<unknown>(canvasDraftKey(scope));
    return isCanvasDraftRecord(value) ? value : null;
}

export async function readCanvasDraftByKey(key: string) {
    const value = await draftStore.getItem<unknown>(key);
    return isCanvasDraftRecord(value) && canvasDraftKey(value) === key ? value : null;
}

export async function writeCanvasDraft(record: CanvasDraftRecord) {
    await draftStore.setItem(canvasDraftKey(record), record);
}

export async function removeCanvasDraftByKey(key: string) {
    await draftStore.removeItem(key);
}

export async function readCanvasConflictMarker(scope: Omit<CanvasDraftScope, "baseRevision">): Promise<CanvasConflictMarkerRead> {
    const value = await draftStore.getItem<unknown>(canvasConflictMarkerKey(scope));
    if (value === null) return { marker: null, invalid: false };
    if (!isCanvasConflictMarker(value) || value.userId !== scope.userId || value.workspaceId !== scope.workspaceId || value.canvasId !== scope.canvasId) {
        return { marker: null, invalid: true };
    }
    return { marker: value, invalid: false };
}

export async function writeCanvasConflictMarker(marker: CanvasConflictMarker) {
    await draftStore.setItem(canvasConflictMarkerKey(marker), marker);
}

export async function removeCanvasConflictMarker(scope: Omit<CanvasDraftScope, "baseRevision">) {
    await draftStore.removeItem(canvasConflictMarkerKey(scope));
}

/** 保存成功后清掉该画布所有历史 baseRevision 的草稿，只保留 keepKey 指向的那一条（冲突时用于保留本地草稿）。 */
export async function removeCanvasDraftsOfCanvas(scope: Omit<CanvasDraftScope, "baseRevision">, keepKey?: string) {
    const staleKeys: string[] = [];
    await draftStore.iterate((_value, key) => {
        if (isCanvasDraftKeyOfCanvas(key, scope) && key !== keepKey) staleKeys.push(key);
    });
    await Promise.all(staleKeys.map((key) => draftStore.removeItem(key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanvasDraftRecord(value: unknown): value is CanvasDraftRecord {
    if (!isRecord(value)) return false;
    return (
        typeof value.userId === "string" &&
        typeof value.workspaceId === "string" &&
        typeof value.canvasId === "string" &&
        typeof value.baseRevision === "number" &&
        Number.isSafeInteger(value.baseRevision) &&
        value.baseRevision >= 0 &&
        typeof value.title === "string" &&
        isRecord(value.snapshot) &&
        typeof value.savedAt === "string"
    );
}

function isCanvasConflictMarker(value: unknown): value is CanvasConflictMarker {
    if (!isRecord(value)) return false;
    if (
        typeof value.userId !== "string" ||
        typeof value.workspaceId !== "string" ||
        typeof value.canvasId !== "string" ||
        typeof value.baseRevision !== "number" ||
        !Number.isSafeInteger(value.baseRevision) ||
        value.baseRevision < 0 ||
        typeof value.draftKey !== "string"
    )
        return false;
    return canvasDraftKey({ userId: value.userId, workspaceId: value.workspaceId, canvasId: value.canvasId, baseRevision: value.baseRevision }) === value.draftKey;
}
