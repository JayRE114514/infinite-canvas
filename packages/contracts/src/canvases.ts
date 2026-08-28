import { Type, type Static } from "typebox";

import { WorkspaceIdSchema } from "./workspaces.js";

/** 画布由服务端生成 UUID，与 Better Auth 的不透明 Workspace ID 不同。 */
export const CanvasIdSchema = Type.String({ format: "uuid" });
export type CanvasId = Static<typeof CanvasIdSchema>;

export const CanvasTitleSchema = Type.String({ minLength: 1, maxLength: 200 });
export type CanvasTitle = Static<typeof CanvasTitleSchema>;

/** JSON 值递归定义：只允许 null、布尔、有限数字、字符串、数组和 JSON 对象，拒绝 bigint、undefined、函数、Symbol 和 NaN/Infinity。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON 对象即快照顶层结构，键为字符串，值递归复用 JsonValue。 */
export type JsonObject = { [key: string]: JsonValue };

/**
 * TypeBox 的 Type.Record(Type.String(), ...) 默认键模式是 `^.*$`，校验时只用 `u` 标志编译正则，
 * 因此 `.` 匹配不到 \n、\r、U+2028、U+2029；而 patternProperties 校验遇到不匹配的键会直接跳过值校验，
 * 使换行等键名下的 bigint、undefined 等非法值被放过。这里显式传入覆盖全部字符的 pattern，
 * 让根层与嵌套层的任意 JS/JSON 字符串键都进入值校验。
 * FromStringKey 对带 pattern 的字符串键有专门覆盖分支，会把该 pattern 原样作为 patternProperties 键，
 * 静态推导仍固定为 Record<string, JsonValue>，所以对外类型不变。
 */
const JsonKeySchema = Type.String({ pattern: "^[\\s\\S]*$" });

/**
 * 快照整体存为 JSON 对象，节点与连线语义由前端负责，服务端只校验值是合法 JSON。
 * 用 Type.Cyclic 定义递归引用，避免 Type.Unknown 放过 bigint、undefined 等无法序列化的值。
 */
export const CanvasSnapshotSchema = Type.Cyclic(
    {
        JsonValue: Type.Union([
            Type.Null(),
            // 数字必须先于布尔，避免 AJV union coercion 把 1/0 改写成 true/false。
            Type.Number({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }),
            Type.Boolean(),
            Type.String(),
            Type.Array(Type.Ref("JsonValue")),
            Type.Record(JsonKeySchema, Type.Ref("JsonValue")),
        ]),
        JsonObject: Type.Record(JsonKeySchema, Type.Ref("JsonValue")),
    },
    "JsonObject",
);
export type CanvasSnapshot = JsonObject;

/**
 * revision 用 JSON 数字表示，因此上界收敛到 Number.MAX_SAFE_INTEGER，数据库 CHECK 用同一上界兜底。
 * Task 2 需要在 revision 已达上界时按确定规则拒绝自增，不能静默回绕或溢出成不精确浮点。
 */
export const CanvasRevisionSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export type CanvasRevision = Static<typeof CanvasRevisionSchema>;

export const CanvasDocumentModeSchema = Type.Union([Type.Literal("snapshot"), Type.Literal("collaborative")]);
export type CanvasDocumentMode = Static<typeof CanvasDocumentModeSchema>;

/** 列表只返回摘要，不含快照，避免一次请求传输全部画布内容；strict 保证摘要里混入 snapshot 会被判定为非法。 */
export const CanvasSummarySchema = Type.Object(
    {
        id: CanvasIdSchema,
        workspaceId: WorkspaceIdSchema,
        title: CanvasTitleSchema,
        documentMode: CanvasDocumentModeSchema,
        revision: CanvasRevisionSchema,
        createdAt: Type.String({ format: "date-time" }),
        updatedAt: Type.String({ format: "date-time" }),
    },
    { additionalProperties: false },
);
export type CanvasSummary = Static<typeof CanvasSummarySchema>;

/** 画布完整结构不用 allOf 组合摘要，避免 allOf 影响 Fastify 响应序列化；strict 保证多余字段被判定为非法。 */
export const CanvasSchema = Type.Object(
    {
        id: CanvasIdSchema,
        workspaceId: WorkspaceIdSchema,
        title: CanvasTitleSchema,
        snapshot: CanvasSnapshotSchema,
        documentMode: CanvasDocumentModeSchema,
        revision: CanvasRevisionSchema,
        createdAt: Type.String({ format: "date-time" }),
        updatedAt: Type.String({ format: "date-time" }),
    },
    { additionalProperties: false },
);
export type Canvas = Static<typeof CanvasSchema>;

/**
 * DELETE 响应：包含持久化的删除回执，允许调用方幂等地确认删除已完成。
 * 首次删除和授权重放均返回同一字段值。
 */
export const CanvasDeletionReceiptSchema = Type.Object(
    {
        canvasId: CanvasIdSchema,
        deletionReceipt: Type.String({ format: "uuid" }),
        deletedAt: Type.String({ format: "date-time" }),
    },
    { additionalProperties: false },
);
export type CanvasDeletionReceipt = Static<typeof CanvasDeletionReceiptSchema>;

/** 响应统一用 { canvas } / { canvases } 信封，后续 Task 2、Task 3 按该结构收发。 */
export const CanvasResponseSchema = Type.Object({ canvas: CanvasSchema }, { additionalProperties: false });
export type CanvasResponse = Static<typeof CanvasResponseSchema>;

export const CanvasListResponseSchema = Type.Object(
    { canvases: Type.Array(CanvasSummarySchema) },
    { additionalProperties: false },
);
export type CanvasListResponse = Static<typeof CanvasListResponseSchema>;

export const CreateCanvasBodySchema = Type.Object(
    {
        title: CanvasTitleSchema,
        snapshot: Type.Optional(CanvasSnapshotSchema),
    },
    { additionalProperties: false },
);
export type CreateCanvasBody = Static<typeof CreateCanvasBodySchema>;

/**
 * 保存必须带 baseRevision，服务端据此条件更新，冲突返回 409 revision_conflict。
 * title 可选用于保留重命名能力，Task 2 在同一次 baseRevision 条件更新里原子写入标题和快照。
 */
export const SaveCanvasRequestSchema = Type.Object(
    {
        baseRevision: CanvasRevisionSchema,
        title: Type.Optional(CanvasTitleSchema),
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
