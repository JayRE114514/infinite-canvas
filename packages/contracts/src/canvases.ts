import { Type, type Static } from "typebox";

import { WorkspaceIdSchema } from "./workspaces.js";

/** 画布由服务端生成 UUID，与 Better Auth 的不透明 Workspace ID 不同。 */
export const CanvasIdSchema = Type.String({ format: "uuid" });
export type CanvasId = Static<typeof CanvasIdSchema>;

export const CanvasTitleSchema = Type.String({ minLength: 1, maxLength: 200 });
export type CanvasTitle = Static<typeof CanvasTitleSchema>;

/** 快照整体存为 JSON 对象，节点与连线语义由前端负责，服务端不做结构校验。 */
export const CanvasSnapshotSchema = Type.Record(Type.String(), Type.Unknown());
export type CanvasSnapshot = Static<typeof CanvasSnapshotSchema>;

export const CanvasRevisionSchema = Type.Integer({ minimum: 0 });
export type CanvasRevision = Static<typeof CanvasRevisionSchema>;

/** 列表只返回摘要，不含快照，避免一次请求传输全部画布内容。 */
export const CanvasSummarySchema = Type.Object({
    id: CanvasIdSchema,
    workspaceId: WorkspaceIdSchema,
    title: CanvasTitleSchema,
    revision: CanvasRevisionSchema,
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
});
export type CanvasSummary = Static<typeof CanvasSummarySchema>;

/** 单个画布响应写成扁平对象，避免 allOf 影响 Fastify 响应序列化。 */
export const CanvasSchema = Type.Object({
    id: CanvasIdSchema,
    workspaceId: WorkspaceIdSchema,
    title: CanvasTitleSchema,
    snapshot: CanvasSnapshotSchema,
    revision: CanvasRevisionSchema,
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
});
export type Canvas = Static<typeof CanvasSchema>;

export const CanvasResponseSchema = Type.Object({ canvas: CanvasSchema });
export type CanvasResponse = Static<typeof CanvasResponseSchema>;

export const CanvasListResponseSchema = Type.Object({ canvases: Type.Array(CanvasSummarySchema) });
export type CanvasListResponse = Static<typeof CanvasListResponseSchema>;

export const CreateCanvasBodySchema = Type.Object(
    {
        title: CanvasTitleSchema,
        snapshot: Type.Optional(CanvasSnapshotSchema),
    },
    { additionalProperties: false },
);
export type CreateCanvasBody = Static<typeof CreateCanvasBodySchema>;

/** 保存必须带 baseRevision，服务端据此条件更新，冲突返回 409 revision_conflict。 */
export const SaveCanvasRequestSchema = Type.Object(
    {
        baseRevision: CanvasRevisionSchema,
        snapshot: CanvasSnapshotSchema,
    },
    { additionalProperties: false },
);
export type SaveCanvasRequest = Static<typeof SaveCanvasRequestSchema>;

export const CanvasPathSchema = Type.Object(
    { workspaceId: WorkspaceIdSchema, canvasId: CanvasIdSchema },
    { additionalProperties: false },
);
export type CanvasPath = Static<typeof CanvasPathSchema>;
