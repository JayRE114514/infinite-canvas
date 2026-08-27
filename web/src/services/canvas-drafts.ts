import localforage from "localforage";

import type { CanvasSnapshot } from "@infinite-canvas/contracts";

/**
 * 草稿是「未成功保存到服务端的本地快照」，key 必须完整包含 userId、workspaceId、canvasId 和 baseRevision，
 * 这样切换账号、切换 Workspace 或服务端 revision 前进后，旧草稿都不会被误当成当前画布的待保存内容。
 */
const draftStore = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_drafts" });
const DRAFT_PREFIX = "canvas-draft";

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

function encodePart(value: string) {
    return encodeURIComponent(value);
}

export function canvasDraftKey({ userId, workspaceId, canvasId, baseRevision }: CanvasDraftScope) {
    return [DRAFT_PREFIX, encodePart(userId), encodePart(workspaceId), encodePart(canvasId), String(baseRevision)].join(":");
}

export function isCanvasDraftKeyOfCanvas(key: string, scope: Omit<CanvasDraftScope, "baseRevision">) {
    const prefix = [DRAFT_PREFIX, encodePart(scope.userId), encodePart(scope.workspaceId), encodePart(scope.canvasId), ""].join(":");
    return key.startsWith(prefix);
}

export async function readCanvasDraft(scope: CanvasDraftScope) {
    return (await draftStore.getItem<CanvasDraftRecord>(canvasDraftKey(scope))) ?? null;
}

export async function readCanvasDraftByKey(key: string) {
    return (await draftStore.getItem<CanvasDraftRecord>(key)) ?? null;
}

export async function writeCanvasDraft(record: CanvasDraftRecord) {
    await draftStore.setItem(canvasDraftKey(record), record);
}

/** 保存成功后清掉该画布所有历史 baseRevision 的草稿，只保留 keepKey 指向的那一条（冲突时用于保留本地草稿）。 */
export async function removeCanvasDraftsOfCanvas(scope: Omit<CanvasDraftScope, "baseRevision">, keepKey?: string) {
    const staleKeys: string[] = [];
    await draftStore.iterate((_value, key) => {
        if (isCanvasDraftKeyOfCanvas(key, scope) && key !== keepKey) staleKeys.push(key);
    });
    await Promise.all(staleKeys.map((key) => draftStore.removeItem(key)));
}
