import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { assets } from "../assets/schema.js";
import { users } from "../identity/schema.js";
import { workspaces } from "../workspaces/schema.js";

export const aiTasks = pgTable(
    "ai_tasks",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "restrict" }),
        createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
        capabilityId: text("capability_id").notNull(),
        adapterId: text("adapter_id").notNull(),
        adapterVersion: text("adapter_version").notNull(),
        exactModelId: text("exact_model_id").notNull(),
        input: jsonb("input").$type<{ prompt: string }>().notNull(),
        idempotencyKey: text("idempotency_key").notNull(),
        requestHash: text("request_hash").notNull(),
        status: text("status")
            .$type<"queued" | "submitting" | "processing" | "storing" | "succeeded" | "failed" | "reconciling">()
            .notNull()
            .default("queued"),
        resultAssetId: uuid("result_asset_id"),
        publicErrorCode: text("public_error_code"),
        leaseEpoch: bigint("lease_epoch", { mode: "bigint" }).notNull().default(sql`0`),
        leaseWorkerId: text("lease_worker_id"),
        leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        unique("ai_tasks_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
        unique("ai_tasks_workspace_id_id_unique").on(table.workspaceId, table.id),
        foreignKey({
            name: "ai_tasks_workspace_result_asset_fk",
            columns: [table.workspaceId, table.resultAssetId],
            foreignColumns: [assets.workspaceId, assets.id],
        }).onDelete("restrict"),
        index("ai_tasks_workspace_created_idx").on(table.workspaceId, table.createdAt),
        check("ai_tasks_idempotency_nonempty", sql.raw("idempotency_key <> ''")),
        check("ai_tasks_request_hash_format", sql.raw("request_hash ~ '^[0-9a-f]{64}$'")),
        check(
            "ai_tasks_status_allowed",
            sql.raw("status in ('queued', 'submitting', 'processing', 'storing', 'succeeded', 'failed', 'reconciling')"),
        ),
        check("ai_tasks_lease_epoch_nonnegative", sql.raw("lease_epoch >= 0")),
    ],
);

export const providerAttempts = pgTable(
    "provider_attempts",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "restrict" }),
        taskId: uuid("task_id").notNull(),
        sequence: integer("sequence").notNull(),
        adapterId: text("adapter_id").notNull(),
        adapterVersion: text("adapter_version").notNull(),
        exactModelId: text("exact_model_id").notNull(),
        providerIdempotencyKey: text("provider_idempotency_key").notNull(),
        remoteTaskId: text("remote_task_id"),
        status: text("status").$type<"pending" | "submitting" | "processing" | "succeeded" | "failed" | "ambiguous">().notNull().default("pending"),
        failureClassification: text("failure_classification"),
        redactedError: jsonb("redacted_error").$type<{ code: string; message: string }>(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        unique("provider_attempts_workspace_task_sequence_unique").on(table.workspaceId, table.taskId, table.sequence),
        unique("provider_attempts_workspace_id_id_unique").on(table.workspaceId, table.id),
        foreignKey({
            name: "provider_attempts_workspace_task_fk",
            columns: [table.workspaceId, table.taskId],
            foreignColumns: [aiTasks.workspaceId, aiTasks.id],
        }).onDelete("restrict"),
        check("provider_attempts_sequence_positive", sql.raw("sequence > 0")),
        check(
            "provider_attempts_status_allowed",
            sql.raw("status in ('pending', 'submitting', 'processing', 'succeeded', 'failed', 'ambiguous')"),
        ),
    ],
);

export const taskEvents = pgTable(
    "task_events",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "restrict" }),
        taskId: uuid("task_id").notNull(),
        sequence: bigint("sequence", { mode: "bigint" }).notNull(),
        type: text("type").notNull(),
        payload: jsonb("payload").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        unique("task_events_workspace_task_sequence_unique").on(table.workspaceId, table.taskId, table.sequence),
        foreignKey({
            name: "task_events_workspace_task_fk",
            columns: [table.workspaceId, table.taskId],
            foreignColumns: [aiTasks.workspaceId, aiTasks.id],
        }).onDelete("restrict"),
        index("task_events_workspace_task_idx").on(table.workspaceId, table.taskId, table.sequence),
        check("task_events_sequence_positive", sql.raw("sequence > 0")),
    ],
);
