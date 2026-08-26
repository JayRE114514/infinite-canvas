import type { Canvas, CanvasSnapshot, CanvasSummary } from "@infinite-canvas/contracts";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

/** 服务端只保证快照是合法 JSON，节点与连线语义仍由前端维护，这里集中做一次结构归一。 */
export const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };

export type CanvasProjectSummary = Pick<CanvasProject, "id" | "title" | "createdAt" | "updatedAt"> & {
    revision: number;
    /** 服务端列表接口只返回摘要，没有快照，此时数量未知用 null 表示，界面据此不显示统计值。 */
    nodeCount: number | null;
    connectionCount: number | null;
};

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

function asViewport(value: unknown): ViewportTransform {
    const source = asRecord(value);
    const x = Number(source.x);
    const y = Number(source.y);
    const k = Number(source.k);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(k) || k <= 0) return initialViewport;
    return { x, y, k };
}

function asBackgroundMode(value: unknown): CanvasBackgroundMode {
    return value === "lines" || value === "dots" || value === "blank" ? value : "lines";
}

/** 快照只保存画布语义字段，id/时间戳/revision 一律以服务端返回为准，避免本地值覆盖权威数据。 */
export function projectToSnapshot(project: CanvasProject): CanvasSnapshot {
    return {
        nodes: project.nodes,
        connections: project.connections,
        chatSessions: project.chatSessions,
        activeChatId: project.activeChatId,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
    } as unknown as CanvasSnapshot;
}

export function canvasToProject(canvas: Canvas): CanvasProject {
    return {
        id: canvas.id,
        title: canvas.title,
        createdAt: canvas.createdAt,
        updatedAt: canvas.updatedAt,
        ...snapshotToProjectContent(canvas.snapshot),
    };
}

/** 草稿只是「尚未成功保存的快照」，导出时需要还原成完整 CanvasProject，时间戳用草稿保存时间。 */
export function draftToProject(draft: { canvasId: string; title: string; snapshot: CanvasSnapshot; savedAt: string }): CanvasProject {
    return {
        id: draft.canvasId,
        title: draft.title,
        createdAt: draft.savedAt,
        updatedAt: draft.savedAt,
        ...snapshotToProjectContent(draft.snapshot),
    };
}

/** 快照里的画布语义字段统一归一，节点、连线、会话、外观和视口都按当前前端类型收敛。 */
export function snapshotToProjectContent(value: unknown): Omit<CanvasProject, "id" | "title" | "createdAt" | "updatedAt"> {
    const snapshot = asRecord(value);
    const activeChatId = snapshot.activeChatId;
    return {
        nodes: asArray<CanvasNodeData>(snapshot.nodes),
        connections: asArray<CanvasConnection>(snapshot.connections),
        chatSessions: asArray<CanvasAssistantSession>(snapshot.chatSessions),
        activeChatId: typeof activeChatId === "string" ? activeChatId : null,
        backgroundMode: asBackgroundMode(snapshot.backgroundMode),
        showImageInfo: snapshot.showImageInfo === true,
        viewport: asViewport(snapshot.viewport),
    };
}

/** 列表摘要来自本地已知的完整画布时，节点与连线数量可以直接算出来。 */
export function projectToSummary(project: CanvasProject, revision: number): CanvasProjectSummary {
    return {
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        revision,
        nodeCount: project.nodes.length,
        connectionCount: project.connections.length,
    };
}

/** 列表只有摘要，没有快照，节点与连线数量未知，用 null 表示，避免假造统计值。 */
export function summaryToProjectSummary(summary: CanvasSummary): CanvasProjectSummary {
    return {
        id: summary.id,
        title: summary.title,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        revision: summary.revision,
        nodeCount: null,
        connectionCount: null,
    };
}

export function projectToImportBody(source: Partial<CanvasProject>, fallbackTitle: string) {
    const project: CanvasProject = {
        id: "",
        title: source.title?.trim() || fallbackTitle,
        createdAt: source.createdAt || "",
        updatedAt: source.updatedAt || "",
        nodes: source.nodes || [],
        connections: source.connections || [],
        chatSessions: source.chatSessions || [],
        activeChatId: source.activeChatId || null,
        backgroundMode: source.backgroundMode || "lines",
        showImageInfo: source.showImageInfo || false,
        viewport: source.viewport || initialViewport,
    };
    return { title: project.title, snapshot: projectToSnapshot(project) };
}
