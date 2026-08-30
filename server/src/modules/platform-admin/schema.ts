import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { creditTransactions } from "../credits/schema.js";
import { users } from "../identity/schema.js";
import { workspaces } from "../workspaces/schema.js";

// 平台管理与审计表：全部只追加，不存在 UPDATE / DELETE 路径。
// 只有 0003 里的窄口 SECURITY DEFINER 函数或 0004 的策略可以写入。

/** 事务 ID 用 PostgreSQL 的 xid8，保证审计行与真实事务绑定。 */
const xid8 = customType<{ data: string; driverData: string }>({
    dataType() {
        return "xid8";
    },
});

export const platformAdmins = pgTable(
    "platform_admins",
    {
        userId: text("user_id")
            .primaryKey()
            .references(() => users.id, { onDelete: "restrict" }),
        status: text("status").$type<"active" | "revoked">().notNull().default("active"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [check("platform_admins_status_allowed", sql.raw("status in ('active', 'revoked')"))],
);

export const adminOperations = pgTable(
    "admin_operations",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        adminUserId: text("admin_user_id")
            .notNull()
            .references(() => users.id, { onDelete: "restrict" }),
        targetKind: text("target_kind").$type<"platform" | "workspace">().notNull(),
        targetWorkspaceId: text("target_workspace_id"),
        purpose: text("purpose").notNull(),
        requestId: text("request_id").notNull(),
        transactionXid: xid8("transaction_xid").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("admin_operations_admin_user_id_idx").on(table.adminUserId),
        check("admin_operations_target_kind_allowed", sql.raw("target_kind in ('platform', 'workspace')")),
        check(
            "admin_operations_target_coherent",
            sql.raw(
                "(target_kind = 'platform' and target_workspace_id is null) or (target_kind = 'workspace' and target_workspace_id is not null)",
            ),
        ),
    ],
);

export const globalAuditLogs = pgTable("global_audit_logs", {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: uuid("operation_id")
        .notNull()
        .references(() => adminOperations.id, { onDelete: "restrict" }),
    actorUserId: text("actor_user_id")
        .notNull()
        .references(() => users.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    transactionXid: xid8("transaction_xid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 空间内审计：只追加，由 owner 生命周期路径或已绑定的管理员操作写入。 */
export const workspaceAuditLogs = pgTable(
    "workspace_audit_logs",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        actorUserId: text("actor_user_id")
            .notNull()
            .references(() => users.id, { onDelete: "restrict" }),
        action: text("action")
            .$type<"workspace_read" | "workspace_suspend" | "workspace_deactivate" | "workspace_restore" | "wallet_adjust">()
            .notNull(),
        fromStatus: text("from_status").$type<"active" | "suspended" | "deactivated">(),
        toStatus: text("to_status").$type<"active" | "suspended" | "deactivated">(),
        operationId: uuid("operation_id").references(() => adminOperations.id, { onDelete: "restrict" }),
        creditAmount: bigint("credit_amount", { mode: "bigint" }),
        creditReason: text("credit_reason"),
        creditTransactionId: uuid("credit_transaction_id"),
        replayed: boolean("replayed").notNull().default(false),
        transactionXid: xid8("transaction_xid").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("workspace_audit_logs_workspace_id_idx").on(table.workspaceId),
        index("workspace_audit_logs_credit_transaction_idx").on(table.workspaceId, table.creditTransactionId),
        uniqueIndex("workspace_audit_logs_operation_unique").on(table.operationId),
        foreignKey({
            name: "workspace_audit_logs_workspace_credit_transaction_fk",
            columns: [table.workspaceId, table.creditTransactionId],
            foreignColumns: [creditTransactions.workspaceId, creditTransactions.id],
        }).onDelete("restrict"),
        check(
            "workspace_audit_logs_action_allowed",
            sql.raw("action in ('workspace_read', 'workspace_suspend', 'workspace_deactivate', 'workspace_restore', 'wallet_adjust')"),
        ),
        check(
            "workspace_audit_logs_status_allowed",
            sql.raw(
                "(from_status is null or from_status in ('active', 'suspended', 'deactivated')) and (to_status is null or to_status in ('active', 'suspended', 'deactivated'))",
            ),
        ),
        check(
            "workspace_audit_logs_credit_fields_coherent",
            sql.raw(
                "(action = 'wallet_adjust' and from_status is null and to_status is null and credit_amount > 0 and btrim(credit_reason) <> '' and credit_transaction_id is not null) or (action <> 'wallet_adjust' and credit_amount is null and credit_reason is null and credit_transaction_id is null)",
            ),
        ),
    ],
);

/**
 * 个人空间开通审计：按 (user_id, source) 全局唯一，只能由
 * record_workspace_provisioning 追加，重放时返回既有审计 ID。
 */
export const workspaceProvisioningAudits = pgTable(
    "workspace_provisioning_audits",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: text("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "restrict" }),
        source: text("source").$type<"email_verification" | "explicit_repair">().notNull(),
        eventId: text("event_id").notNull(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        transactionXid: xid8("transaction_xid").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("workspace_provisioning_audits_user_source_unique").on(table.userId, table.source),
        check(
            "workspace_provisioning_audits_source_allowed",
            sql.raw("source in ('email_verification', 'explicit_repair')"),
        ),
    ],
);
