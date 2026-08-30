import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { workspaces } from "../workspaces/schema.js";

export type PriceSnapshotJson = {
    capabilityId: string;
    routeId: string;
    exactModelId: string;
    priceVersion: string;
    rule: { kind: "fixed_per_image"; amount: string };
};

export const billingOrders = pgTable(
    "billing_orders",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        taskId: uuid("task_id").notNull(),
        capabilityId: text("capability_id").notNull(),
        priceVersion: text("price_version").notNull(),
        priceSnapshot: jsonb("price_snapshot").$type<PriceSnapshotJson>().notNull(),
        estimatedAmount: bigint("estimated_amount", { mode: "bigint" }).notNull(),
        actualAmount: bigint("actual_amount", { mode: "bigint" }),
        status: text("status").$type<"reserved" | "settled" | "released" | "review">().notNull().default("reserved"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        reviewAfter: timestamp("review_after", { withTimezone: true }).notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        unique("billing_orders_workspace_task_unique").on(table.workspaceId, table.taskId),
        unique("billing_orders_workspace_id_id_unique").on(table.workspaceId, table.id),
        index("billing_orders_workspace_review_idx").on(table.workspaceId, table.status, table.reviewAfter),
        check("billing_orders_estimated_positive", sql.raw("estimated_amount > 0")),
        check(
            "billing_orders_actual_range",
            sql.raw("actual_amount is null or (actual_amount >= 0 and actual_amount <= estimated_amount)"),
        ),
        check(
            "billing_orders_status_allowed",
            sql.raw("status in ('reserved', 'settled', 'released', 'review')"),
        ),
        check(
            "billing_orders_status_amount_coherent",
            sql.raw(
                "(status in ('reserved', 'review') and actual_amount is null) or (status = 'settled' and actual_amount is not null) or (status = 'released' and actual_amount = 0)",
            ),
        ),
        check("billing_orders_review_after_fixed", sql.raw("review_after = created_at + interval '24 hours'")),
    ],
);
