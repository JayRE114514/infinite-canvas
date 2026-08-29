import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { assets } from "../assets/schema.js";
import { users } from "../identity/schema.js";
import { workspaces } from "../workspaces/schema.js";

export const artboxVideoGenerations = pgTable(
    "artbox_video_generations",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        idempotencyKey: text("idempotency_key").notNull(),
        requestHash: text("request_hash").notNull(),
        normalizedInput: jsonb("normalized_input").notNull(),
        status: text("status").notNull().default("submitting"),
        remoteTaskId: text("remote_task_id"),
        resultAssetId: uuid("result_asset_id").references(() => assets.id, { onDelete: "restrict" }),
        publicError: jsonb("public_error"),
        pollLeaseEpoch: bigint("poll_lease_epoch", { mode: "number" }).notNull().default(0),
        pollLeaseUntil: timestamp("poll_lease_until", { withTimezone: true }),
        createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        unique("artbox_video_generations_workspace_idempotency_unique").on(
            table.workspaceId,
            table.idempotencyKey,
        ),
        index("artbox_video_generations_workspace_status_idx").on(table.workspaceId, table.status),
        check("artbox_video_generations_idempotency_key_nonempty", sql.raw("length(idempotency_key) > 0")),
        check(
            "artbox_video_generations_request_hash_check",
            sql.raw("request_hash ~ '^[0-9a-f]{64}$'"),
        ),
        check(
            "artbox_video_generations_status_check",
            sql.raw("status IN ('submitting', 'queued', 'processing', 'succeeded', 'failed', 'reconciling')"),
        ),
        check(
            "artbox_video_generations_remote_state_check",
            sql.raw("status NOT IN ('queued', 'processing', 'succeeded') OR remote_task_id IS NOT NULL"),
        ),
        check(
            "artbox_video_generations_result_state_check",
            sql.raw("(status = 'succeeded') = (result_asset_id IS NOT NULL)"),
        ),
        check(
            "artbox_video_generations_lease_epoch_safe",
            sql.raw("poll_lease_epoch >= 0 AND poll_lease_epoch <= 9007199254740991"),
        ),
    ],
);
