import type {
    Canvas,
    CanvasListResponse,
    CanvasResponse,
    CanvasSummary,
    CreateCanvasBody,
    SaveCanvasRequest,
    SuccessResponse,
} from "@infinite-canvas/contracts";

import { platformRequest } from "@/services/api/platform-client";

function canvasCollectionPath(workspaceId: string) {
    return `/workspaces/${encodeURIComponent(workspaceId)}/canvases`;
}

function canvasPath(workspaceId: string, canvasId: string) {
    return `${canvasCollectionPath(workspaceId)}/${encodeURIComponent(canvasId)}`;
}

export async function fetchCanvasList(workspaceId: string): Promise<CanvasSummary[]> {
    const response = await platformRequest<CanvasListResponse>(canvasCollectionPath(workspaceId));
    return response.canvases;
}

export async function fetchCanvas(workspaceId: string, canvasId: string): Promise<Canvas> {
    const response = await platformRequest<CanvasResponse>(canvasPath(workspaceId, canvasId));
    return response.canvas;
}

export async function createCanvas(workspaceId: string, body: CreateCanvasBody): Promise<Canvas> {
    const response = await platformRequest<CanvasResponse>(canvasCollectionPath(workspaceId), { method: "POST", body: JSON.stringify(body) });
    return response.canvas;
}

export async function saveCanvas(workspaceId: string, canvasId: string, body: SaveCanvasRequest, signal?: AbortSignal): Promise<Canvas> {
    const response = await platformRequest<CanvasResponse>(canvasPath(workspaceId, canvasId), { method: "PUT", body: JSON.stringify(body), signal });
    return response.canvas;
}

export async function deleteCanvas(workspaceId: string, canvasId: string): Promise<void> {
    await platformRequest<SuccessResponse>(canvasPath(workspaceId, canvasId), { method: "DELETE" });
}
