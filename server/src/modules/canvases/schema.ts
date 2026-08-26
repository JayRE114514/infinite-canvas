import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users, workspaces } from "../identity/auth-schema.js";

// 画布 ID 由数据库生成 UUID；workspace_id 沿用 Better Auth 的不透明 text ID。
// 快照整体存 JSONB，revision 由条件更新递增，用于拒绝过期写入。

export const canvases = pgTable(
    "canvases",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "cascade" }),
        title: text("title").notNull(),
        snapshotJson: jsonb("snapshot_json").notNull(),
        revision: bigint("revision", { mode: "number" }).notNull().default(0),
        createdBy: text("created_by")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        updatedBy: text("updated_by")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (table) => [
        // 列表按空间取最近更新的画布，软删除过滤放在查询条件里。
        index("canvases_workspace_updated_at_idx").on(table.workspaceId, table.updatedAt.desc()),
    ],
);
