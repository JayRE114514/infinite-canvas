import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { users } from "../identity/schema.js";

// Workspaces 模块自有这三张表，是跨模块唯一的 Workspace 数据库入口。
// 空间删除走软下线（status + deleted_at），owner 归属由 owner_user_id 与唯一活跃 owner 成员共同约束。

export const workspaces = pgTable(
    "workspaces",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        slug: text("slug").notNull(),
        type: text("type").$type<"personal" | "team">().notNull(),
        ownerUserId: text("owner_user_id")
            .notNull()
            .references(() => users.id, { onDelete: "restrict" }),
        status: text("status").$type<"active" | "suspended" | "deactivated">().notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (table) => [
        uniqueIndex("workspaces_slug_uidx").on(table.slug),
        // 每个用户最多一个个人空间；谓词写裸列，避免生成器输出限定引用。
        uniqueIndex("workspaces_owner_personal_unique").on(table.ownerUserId).where(sql`type = 'personal'`),
        index("workspaces_owner_user_id_idx").on(table.ownerUserId),
        check("workspaces_type_allowed", sql.raw("type in ('personal', 'team')")),
        check("workspaces_status_allowed", sql.raw("status in ('active', 'suspended', 'deactivated')")),
        // 只有 deactivated 带删除时间；active / suspended 都必须为空。
        check(
            "workspaces_deleted_at_status_coherent",
            sql.raw("(status = 'deactivated') = (deleted_at is not null)"),
        ),
    ],
);

export const workspaceMembers = pgTable(
    "workspace_members",
    {
        id: text("id").primaryKey(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "restrict" }),
        role: text("role").$type<"owner" | "admin" | "member">().notNull(),
        status: text("status").$type<"active" | "removed">().notNull().default("active"),
        joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("workspace_members_workspace_user_unique").on(table.workspaceId, table.userId),
        // 每个空间只允许一个活跃 owner 成员。
        uniqueIndex("workspace_members_one_active_owner_unique")
            .on(table.workspaceId)
            .where(sql`role = 'owner' and status = 'active'`),
        index("workspace_members_workspace_id_idx").on(table.workspaceId),
        index("workspace_members_user_id_idx").on(table.userId),
        check("workspace_members_role_allowed", sql.raw("role in ('owner', 'admin', 'member')")),
        check("workspace_members_status_allowed", sql.raw("status in ('active', 'removed')")),
    ],
);

export const workspaceInvitations = pgTable(
    "workspace_invitations",
    {
        id: text("id").primaryKey(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        email: text("email").notNull(),
        role: text("role").$type<"admin" | "member">().notNull(),
        status: text("status").$type<"pending" | "accepted" | "rejected" | "canceled">().notNull().default("pending"),
        // 只存原始令牌的 SHA-256 摘要，原文永不落库。
        tokenDigest: text("token_digest").notNull(),
        inviterId: text("inviter_id")
            .notNull()
            .references(() => users.id, { onDelete: "restrict" }),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("workspace_invitations_token_digest_unique").on(table.tokenDigest),
        uniqueIndex("workspace_invitations_pending_email_unique")
            .on(table.workspaceId, table.email)
            .where(sql`status = 'pending'`),
        index("workspace_invitations_workspace_id_idx").on(table.workspaceId),
        index("workspace_invitations_email_idx").on(table.email),
        check("workspace_invitations_role_allowed", sql.raw("role in ('admin', 'member')")),
        check(
            "workspace_invitations_status_allowed",
            sql.raw("status in ('pending', 'accepted', 'rejected', 'canceled')"),
        ),
        // 邮箱入库前必须已归一化，避免大小写/空白造成重复邀请。
        check("workspace_invitations_email_normalized", sql.raw("email = lower(btrim(email))")),
        check("workspace_invitations_token_digest_length", sql.raw("char_length(token_digest) = 64")),
    ],
);
