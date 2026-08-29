import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { users } from "../identity/schema.js";
import { workspaces } from "../workspaces/schema.js";

export const assets = pgTable(
    "assets",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        kind: text("kind").notNull(),
        status: text("status").notNull().default("staging"),
        fileName: text("file_name").notNull(),
        contentType: text("content_type").notNull(),
        byteSize: bigint("byte_size", { mode: "number" }),
        stagingObjectKey: text("staging_object_key"),
        finalObjectKey: text("final_object_key").notNull(),
        etag: text("etag"),
        createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("assets_workspace_status_idx").on(table.workspaceId, table.status),
        unique("assets_staging_object_key_unique").on(table.stagingObjectKey),
        unique("assets_final_object_key_unique").on(table.finalObjectKey),
        check("assets_kind_check", sql.raw("kind IN ('image', 'video', 'audio')")),
        check("assets_status_check", sql.raw("status IN ('staging', 'ready', 'failed', 'deleted')")),
        check("assets_file_name_nonempty", sql.raw("length(file_name) > 0")),
        check("assets_content_type_nonempty", sql.raw("length(content_type) > 0")),
        check(
            "assets_byte_size_safe",
            sql.raw("byte_size IS NULL OR (byte_size >= 0 AND byte_size <= 9007199254740991)"),
        ),
        check(
            "assets_object_keys_distinct",
            sql.raw("staging_object_key IS NULL OR staging_object_key <> final_object_key"),
        ),
        check(
            "assets_state_coherent",
            sql.raw(`(
                status = 'staging' AND staging_object_key IS NOT NULL AND byte_size IS NULL
            ) OR (
                status = 'ready' AND staging_object_key IS NULL AND byte_size IS NOT NULL
            ) OR status IN ('failed', 'deleted')`),
        ),
    ],
);
