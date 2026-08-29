import type { Canvas, CanvasDeletionReceipt } from "@infinite-canvas/contracts";

import { canvasToProject, summaryToProjectSummary } from "@/lib/canvas/canvas-snapshot";
import { createCanvas, deleteCanvas, fetchCanvas, fetchCanvasList, saveCanvas } from "@/services/api/canvases";
import { PlatformApiError, platformErrorTranslationKey } from "@/services/api/platform-client";
import { LOAD_REQUEST_TIMEOUT_MS, SAVE_REQUEST_TIMEOUT_MS, type CanvasDeleteOutcome, type CanvasLoadResult, type CanvasOpenFailure, type CanvasSaveFailure, type CanvasSaveInput, type CanvasSyncRepository } from "@/services/canvas-sync/types";

export const REVISION_CONFLICT_CODE = "revision_conflict";
const CANVAS_NOT_FOUND_CODE = "canvas_not_found";
const SNAPSHOT_TOO_LARGE_CODE = "canvas_snapshot_too_large";
const NETWORK_ERROR_CODE = "platform_network_error";
const INVALID_RESPONSE_CODE = "platform_invalid_response";
const DELETE_UNAVAILABLE_KEY = "canvas.delete.unavailable";
const DELETE_UNCONFIRMED_KEY = "canvas.delete.unconfirmed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CanvasRequestTimeoutError extends Error {
    constructor() {
        super("canvas_request_timeout");
        this.name = "CanvasRequestTimeoutError";
    }
}

export function isRevisionConflictError(error: unknown) {
    return error instanceof PlatformApiError && error.code === REVISION_CONFLICT_CODE;
}

/** 读取只解除等待，不中止请求；真实拒绝原样抛出，404 与超时因此不会互相污染。 */
function withReadTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new CanvasRequestTimeoutError()), LOAD_REQUEST_TIMEOUT_MS);
        operation.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

async function saveWithTimeout(workspaceId: string, canvasId: string, input: CanvasSaveInput, external?: AbortSignal): Promise<CanvasLoadResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, SAVE_REQUEST_TIMEOUT_MS);
    const abortFromExternal = () => controller.abort();
    if (external?.aborted) controller.abort();
    else external?.addEventListener("abort", abortFromExternal, { once: true });
    try {
        return toResult(await saveCanvas(workspaceId, canvasId, input, controller.signal));
    } catch (error) {
        throw timedOut ? new CanvasRequestTimeoutError() : error;
    } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", abortFromExternal);
    }
}

/** revision_conflict 是唯一的冲突来源；canvas_revision_limit_reached 等 409 落在最后一条分支，按 server 处理。 */
export function classifyCanvasSaveError(error: unknown): CanvasSaveFailure {
    if (isRevisionConflictError(error)) return { kind: "conflict" };
    if (error instanceof CanvasRequestTimeoutError) return { kind: "timeout", messageKey: "canvas.save.failed" };
    if (error instanceof PlatformApiError && error.code === SNAPSHOT_TOO_LARGE_CODE) return { kind: "server", messageKey: "canvas.save.tooLarge" };
    if (error instanceof PlatformApiError && error.code === NETWORK_ERROR_CODE) return { kind: "network", messageKey: "canvas.save.failed" };
    return { kind: "server", messageKey: "canvas.save.failed" };
}

export function classifyCanvasOpenError(error: unknown): CanvasOpenFailure {
    if (error instanceof PlatformApiError && (error.code === CANVAS_NOT_FOUND_CODE || error.status === 404)) return { kind: "missing" };
    return { kind: "failed", messageKey: platformErrorTranslationKey(error, "canvas.openFailed") };
}

function isDeletionReceipt(value: unknown, canvasId: string): value is CanvasDeletionReceipt {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    if (keys.length !== 3 || !keys.every((key) => key === "canvasId" || key === "deletionReceipt" || key === "deletedAt")) return false;
    const receipt = value as Record<string, unknown>;
    if (receipt.canvasId !== canvasId || typeof receipt.canvasId !== "string" || !UUID.test(receipt.canvasId)) return false;
    if (typeof receipt.deletionReceipt !== "string" || !UUID.test(receipt.deletionReceipt)) return false;
    if (typeof receipt.deletedAt !== "string") return false;
    const deletedAt = Date.parse(receipt.deletedAt);
    return Number.isFinite(deletedAt) && new Date(deletedAt).toISOString() === receipt.deletedAt;
}

/** A refusal or an unknown result can preserve data, but neither can prove deletion. */
export function classifyCanvasDeleteError(error: unknown): Extract<CanvasDeleteOutcome, { status: "denied" | "indeterminate" }> {
    if (error instanceof CanvasRequestTimeoutError) return { status: "indeterminate", reason: "timeout", messageKey: DELETE_UNCONFIRMED_KEY };
    if (error instanceof PlatformApiError) {
        if (error.code === NETWORK_ERROR_CODE) return { status: "indeterminate", reason: "network", messageKey: DELETE_UNCONFIRMED_KEY };
        if (error.code === INVALID_RESPONSE_CODE) return { status: "indeterminate", reason: "invalid-response", messageKey: DELETE_UNCONFIRMED_KEY };
        if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409) {
            return { status: "denied", code: error.code, messageKey: DELETE_UNAVAILABLE_KEY };
        }
    }
    return { status: "indeterminate", reason: "unknown", messageKey: DELETE_UNCONFIRMED_KEY };
}

export const canvasRepository: CanvasSyncRepository = {
    list: async (workspaceId) => (await withReadTimeout(fetchCanvasList(workspaceId))).map(summaryToProjectSummary),
    load: async (workspaceId, canvasId) => toResult(await withReadTimeout(fetchCanvas(workspaceId, canvasId))),
    create: async (workspaceId, title) => toResult(await withReadTimeout(createCanvas(workspaceId, { title }))),
    importProject: async (workspaceId, body) => toResult(await withReadTimeout(createCanvas(workspaceId, body))),
    save: (workspaceId, canvasId, input, signal) => saveWithTimeout(workspaceId, canvasId, input, signal),
    remove: async (workspaceId, canvasId) => {
        try {
            /**
             * 传输层声明的类型不是证据：回执必须在运行时逐字段验证通过后才可信，
             * 所以这里显式按 unknown 接收，让不匹配/畸形分支仍然是可达的真实分支。
             */
            const receipt: unknown = await withReadTimeout(deleteCanvas(workspaceId, canvasId));
            if (!isDeletionReceipt(receipt, canvasId)) {
                const reason = receipt && typeof receipt === "object" && "canvasId" in receipt && receipt.canvasId !== canvasId ? "mismatched-receipt" : "invalid-response";
                return { status: "indeterminate", reason, messageKey: DELETE_UNCONFIRMED_KEY };
            }
            return { status: "deleted", receipt };
        } catch (error) {
            return classifyCanvasDeleteError(error);
        }
    },
};

function toResult(canvas: Canvas): CanvasLoadResult {
    return { project: canvasToProject(canvas), revision: canvas.revision };
}
