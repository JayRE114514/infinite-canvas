import type { Canvas, CanvasSnapshot, CanvasSummary } from "@infinite-canvas/contracts";

import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type CanvasProject, type ViewportTransform } from "@/types/canvas";

/** 服务端只保证快照是合法 JSON，节点与连线语义仍由前端维护，这里集中做一次结构归一。 */
export const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };

/** 与服务端 CanvasTitleSchema 的 maxLength 对齐：本地就截断，避免把服务端永远拒绝的标题留在内存或草稿里。 */
export const CANVAS_TITLE_MAX_LENGTH = 200;

export function clampCanvasTitle(title: string, fallback = "") {
    return title.trim().slice(0, CANVAS_TITLE_MAX_LENGTH).trimEnd() || fallback;
}

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

/**
 * 补水时 resolveImageUrl / resolveMediaUrl 会生成 blob: 临时地址，它只在当前页面会话内有效。
 * 快照里必须换成稳定的 storageKey：补水逻辑本来就以 storageKey 为准，且 storageKey 也是一个非空字符串，
 * 能让「有内容」的判断继续成立；完全没有稳定键的临时地址只能丢弃，它在别的会话里无法还原。
 */
function isTransientUrl(value?: string) {
    return Boolean(value?.startsWith("blob:"));
}

/**
 * JSON 丢弃值为 undefined 的自有属性，structuredClone 会原样保留它。
 * 上层给可选字段赋 undefined 很常见（例如文本节点没有 texts 时仍会写 texts: undefined），
 * 于是云端 JSON 保存成功、本地恢复却因为不是合法 JSON 被拒绝。这里在唯一的快照边界统一成
 * 云端会存下的那个值，让两条持久化路径看到同一份数据。
 * 只归一普通对象和数组：Date、Map、类实例、访问器、symbol 键、稀疏数组和非有限数字一律原样保留，
 * 继续由恢复校验器 fail-closed 拒绝，不在这里静默改写成别的值。
 */
function canonicalJson<T>(value: T, active: Set<object> = new Set()): T {
    if (!value || typeof value !== "object") return value;
    /** 出现环时原样返回，交给恢复校验器 fail-closed 拒绝，而不是在这里递归爆栈。 */
    if (active.has(value as object)) return value;
    const prototype = Object.getPrototypeOf(value);
    const isPlainArray = Array.isArray(value) && prototype === Array.prototype;
    const isPlainObject = !Array.isArray(value) && (prototype === Object.prototype || prototype === null);
    /** Date、Map、类实例、子类化数组等一律原样保留，由校验器判定，不在这里改写成别的值。 */
    if (!isPlainArray && !isPlainObject) return value;

    active.add(value as object);
    try {
        /** map 会保留空洞，稀疏数组因此仍然会被校验器拒绝。 */
        if (isPlainArray) return (value as unknown[]).map((item) => canonicalJson(item, active)) as unknown as T;
        const next: Record<PropertyKey, unknown> = {};
        for (const key of Reflect.ownKeys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            /** 访问器与 symbol 键都原样搬过去，保持不合法即被拒绝的语义。 */
            if (!("value" in descriptor)) Object.defineProperty(next, key, descriptor);
            else if (descriptor.value !== undefined) next[key] = canonicalJson(descriptor.value, active);
        }
        return next as T;
    } finally {
        active.delete(value as object);
    }
}

function sanitizeNode(node: CanvasNodeData): CanvasNodeData {
    const metadata = node.metadata;
    if (!metadata) return node;
    const next: CanvasNodeMetadata = { ...metadata };
    const hasMediaContent = node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio;
    if (hasMediaContent && isTransientUrl(next.content)) {
        if (next.storageKey) next.content = next.storageKey;
        else delete next.content;
    }
    if (next.images) next.images = next.images.map((image) => (isTransientUrl(image.content) ? { ...image, content: image.storageKey } : image));
    /** 生成参数里的参考项已经是「storageKey 或稳定外链」，临时地址换会话就失效，只能丢弃。 */
    if (next.references?.some(isTransientUrl)) next.references = next.references.filter((url) => !isTransientUrl(url));
    return { ...node, metadata: next };
}

function sanitizeSession(session: CanvasAssistantSession): CanvasAssistantSession {
    return {
        ...session,
        messages: session.messages.map((message) => {
            if (!message.references?.length) return message;
            return {
                ...message,
                references: message.references.map((item) => {
                    if (!isTransientUrl(item.dataUrl)) return item;
                    const next = { ...item };
                    /** storageKey 已保留稳定语义；没有稳定键时也不能把本会话的 object URL 写入草稿或服务端。 */
                    delete next.dataUrl;
                    return next;
                }),
            };
        }),
    };
}

/**
 * 快照只保存画布语义字段，id/时间戳/revision 一律以服务端返回为准，避免本地值覆盖权威数据。
 * 同时剥掉补水产生的 blob: 临时地址：有 storageKey 的只留键，没有稳定键的临时地址直接丢弃，
 * 否则下次在别的会话打开画布会拿到一个已经失效的地址。
 */
export function projectToSnapshot(project: CanvasProject): CanvasSnapshot {
    return canonicalJson({
        nodes: project.nodes.map(sanitizeNode),
        connections: project.connections,
        chatSessions: project.chatSessions.map(sanitizeSession),
        activeChatId: project.activeChatId,
        backgroundMode: project.backgroundMode,
        showImageInfo: project.showImageInfo,
        viewport: project.viewport,
    }) as unknown as CanvasSnapshot;
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
        title: clampCanvasTitle(source.title || "", clampCanvasTitle(fallbackTitle)),
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
