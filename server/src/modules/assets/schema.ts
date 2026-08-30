import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { workspaces } from "../workspaces/schema.js";

export const assets = pgTable(
    "assets",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        status: text("status").$type<"staging" | "ready" | "failed" | "deleted">().notNull().default("staging"),
        displayName: text("display_name").notNull(),
        objectKey: text("object_key").notNull(),
        mediaType: text("media_type"),
        byteSize: bigint("byte_size", { mode: "bigint" }),
        sha256: text("sha256"),
        failureReason: text("failure_reason"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (table) => [
        unique("assets_object_key_unique").on(table.objectKey),
        unique("assets_workspace_id_id_unique").on(table.workspaceId, table.id),
        index("assets_workspace_status_idx").on(table.workspaceId, table.status),
        check("assets_status_allowed", sql.raw("status in ('staging', 'ready', 'failed', 'deleted')")),
        check("assets_byte_size_nonnegative", sql.raw("byte_size is null or byte_size >= 0")),
        check("assets_sha256_format", sql.raw("sha256 is null or sha256 ~ '^[0-9a-f]{64}$'")),
        check(
            "assets_state_coherent",
            sql.raw(
                "(status = 'staging' and media_type is null and byte_size is null and sha256 is null and failure_reason is null and deleted_at is null) or (status = 'ready' and media_type is not null and byte_size is not null and sha256 is not null and failure_reason is null and deleted_at is null) or (status = 'failed' and failure_reason is not null and deleted_at is null) or (status = 'deleted' and deleted_at is not null)",
            ),
        ),
    ],
);
