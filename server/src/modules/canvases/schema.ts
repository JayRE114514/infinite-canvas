import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "../identity/schema.js";
import { workspaces } from "../workspaces/schema.js";

// 画布 ID 由数据库生成 UUID；workspace_id 沿用 Better Auth 的不透明 text ID。
// 快照整体存 JSONB，revision 由条件更新递增，用于拒绝过期写入。

/** revision 以 JSON 数字返回，上界与 Number.MAX_SAFE_INTEGER 对齐，避免超出后精度丢失。 */
const MAX_SAFE_REVISION = 9007199254740991;

export const canvases = pgTable(
    "canvases",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        // 空间删除走软下线流程，这里用 restrict 阻止物理删除绕过生命周期直接抹掉画布。
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        title: text("title").notNull(),
        snapshotJson: jsonb("snapshot_json").notNull(),
        revision: bigint("revision", { mode: "number" }).notNull().default(0),
        // 画布归空间共享，成员账号注销只清空署名，不能连带删除共享内容。
        createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
        updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (table) => [
        // 列表按空间取最近更新的画布，软删除过滤放在查询条件里。
        index("canvases_workspace_updated_at_idx").on(table.workspaceId, table.updatedAt.desc()),
        // 数据库兜底 revision 区间，越界写入直接失败而不是静默存成不精确数字。
        // 用 sql.raw 拼成字面量，避免绑定参数让约束表达式变成 $1。
        check("canvases_revision_non_negative", sql.raw("revision >= 0")),
        check("canvases_revision_max_safe", sql.raw(`revision <= ${MAX_SAFE_REVISION}`)),
    ],
);
