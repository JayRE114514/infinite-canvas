import type { Canvas, CanvasSnapshot } from "@infinite-canvas/contracts";

import { canvasToProject, summaryToProjectSummary, type CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import { createCanvas, deleteCanvas, fetchCanvas, fetchCanvasList, saveCanvas } from "@/services/api/canvases";
import { PlatformApiError } from "@/services/api/platform-client";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

/**
 * 仓储层只负责「服务端契约 <-> 前端 CanvasProject」的转换与请求编排，不引用任何 Zustand store，
 * 便于在没有 React 环境时单独调用，也避免 store 与网络层互相依赖。
 */
export const REVISION_CONFLICT_CODE = "revision_conflict";

export function isRevisionConflictError(error: unknown) {
    return error instanceof PlatformApiError && (error.code === REVISION_CONFLICT_CODE || error.status === 409);
}

export type CanvasLoadResult = { project: CanvasProject; revision: number };

export async function listCanvasSummaries(workspaceId: string): Promise<CanvasProjectSummary[]> {
    const canvases = await fetchCanvasList(workspaceId);
    return canvases.map(summaryToProjectSummary);
}

export async function loadCanvasProject(workspaceId: string, canvasId: string): Promise<CanvasLoadResult> {
    return toResult(await fetchCanvas(workspaceId, canvasId));
}

export async function createCanvasProject(workspaceId: string, title: string): Promise<CanvasLoadResult> {
    return toResult(await createCanvas(workspaceId, { title }));
}

export async function importCanvasProject(workspaceId: string, body: { title: string; snapshot: CanvasSnapshot }): Promise<CanvasLoadResult> {
    return toResult(await createCanvas(workspaceId, body));
}

export async function saveCanvasProject(
    workspaceId: string,
    canvasId: string,
    input: { baseRevision: number; title?: string; snapshot: CanvasSnapshot },
): Promise<CanvasLoadResult> {
    return toResult(await saveCanvas(workspaceId, canvasId, input));
}

export async function deleteCanvasProject(workspaceId: string, canvasId: string) {
    await deleteCanvas(workspaceId, canvasId);
}

function toResult(canvas: Canvas) {
    return { project: canvasToProject(canvas), revision: canvas.revision };
}
