import { sql } from "drizzle-orm";
import {
    bigint,
    check,
    foreignKey,
    index,
    pgTable,
    text,
    timestamp,
    unique,
    uuid,
} from "drizzle-orm/pg-core";

import { billingOrders } from "../billing/schema.js";
import { workspaces } from "../workspaces/schema.js";

export const creditAccounts = pgTable(
    "credit_accounts",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        status: text("status").$type<"active">().notNull().default("active"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        unique("credit_accounts_workspace_unique").on(table.workspaceId),
        unique("credit_accounts_workspace_id_id_unique").on(table.workspaceId, table.id),
        check("credit_accounts_status_allowed", sql.raw("status = 'active'")),
    ],
);

export const creditWallets = pgTable(
    "credit_wallets",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        creditAccountId: uuid("credit_account_id").notNull(),
        availableAmount: bigint("available_amount", { mode: "bigint" }).notNull().default(sql`0`),
        heldAmount: bigint("held_amount", { mode: "bigint" }).notNull().default(sql`0`),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        unique("credit_wallets_workspace_unique").on(table.workspaceId),
        unique("credit_wallets_account_unique").on(table.creditAccountId),
        unique("credit_wallets_workspace_id_id_unique").on(table.workspaceId, table.id),
        foreignKey({
            name: "credit_wallets_workspace_account_fk",
            columns: [table.workspaceId, table.creditAccountId],
            foreignColumns: [creditAccounts.workspaceId, creditAccounts.id],
        }).onDelete("restrict"),
        check("credit_wallets_available_nonnegative", sql.raw("available_amount >= 0")),
        check("credit_wallets_held_nonnegative", sql.raw("held_amount >= 0")),
    ],
);

export const creditTransactions = pgTable(
    "credit_transactions",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        operationKey: text("operation_key").notNull(),
        requestHash: text("request_hash").notNull(),
        kind: text("kind")
            .$type<"adjustment" | "reserve" | "capture" | "release" | "compensation">()
            .notNull(),
        compensatesTransactionId: uuid("compensates_transaction_id"),
        billingOrderId: uuid("billing_order_id"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        unique("credit_transactions_workspace_operation_unique").on(table.workspaceId, table.operationKey),
        unique("credit_transactions_workspace_id_id_unique").on(table.workspaceId, table.id),
        foreignKey({
            name: "credit_transactions_workspace_compensation_fk",
            columns: [table.workspaceId, table.compensatesTransactionId],
            foreignColumns: [table.workspaceId, table.id],
        }).onDelete("restrict"),
        foreignKey({
            name: "credit_transactions_workspace_billing_order_fk",
            columns: [table.workspaceId, table.billingOrderId],
            foreignColumns: [billingOrders.workspaceId, billingOrders.id],
        }).onDelete("restrict"),
        index("credit_transactions_workspace_created_idx").on(table.workspaceId, table.createdAt),
        check("credit_transactions_operation_key_nonempty", sql.raw("operation_key <> ''")),
        check("credit_transactions_request_hash_format", sql.raw("request_hash ~ '^[0-9a-f]{64}$'")),
        check(
            "credit_transactions_kind_allowed",
            sql.raw("kind in ('adjustment', 'reserve', 'capture', 'release', 'compensation')"),
        ),
        check(
            "credit_transactions_compensation_coherent",
            sql.raw("(kind = 'compensation') = (compensates_transaction_id is not null)"),
        ),
    ],
);

export const creditHolds = pgTable(
    "credit_holds",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        billingOrderId: uuid("billing_order_id").notNull(),
        originalAmount: bigint("original_amount", { mode: "bigint" }).notNull(),
        capturedAmount: bigint("captured_amount", { mode: "bigint" }).notNull().default(sql`0`),
        releasedAmount: bigint("released_amount", { mode: "bigint" }).notNull().default(sql`0`),
        status: text("status").$type<"active" | "closed">().notNull().default("active"),
        reserveTransactionId: uuid("reserve_transaction_id").notNull(),
        closeTransactionId: uuid("close_transaction_id"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        closedAt: timestamp("closed_at", { withTimezone: true }),
    },
    (table) => [
        unique("credit_holds_workspace_order_unique").on(table.workspaceId, table.billingOrderId),
        unique("credit_holds_workspace_id_id_unique").on(table.workspaceId, table.id),
        unique("credit_holds_workspace_reserve_transaction_unique").on(table.workspaceId, table.reserveTransactionId),
        foreignKey({
            name: "credit_holds_workspace_billing_order_fk",
            columns: [table.workspaceId, table.billingOrderId],
            foreignColumns: [billingOrders.workspaceId, billingOrders.id],
        }).onDelete("restrict"),
        foreignKey({
            name: "credit_holds_workspace_reserve_transaction_fk",
            columns: [table.workspaceId, table.reserveTransactionId],
            foreignColumns: [creditTransactions.workspaceId, creditTransactions.id],
        }).onDelete("restrict"),
        foreignKey({
            name: "credit_holds_workspace_close_transaction_fk",
            columns: [table.workspaceId, table.closeTransactionId],
            foreignColumns: [creditTransactions.workspaceId, creditTransactions.id],
        }).onDelete("restrict"),
        index("credit_holds_workspace_status_idx").on(table.workspaceId, table.status),
        check("credit_holds_original_positive", sql.raw("original_amount > 0")),
        check(
            "credit_holds_amounts_conserved",
            sql.raw(
                "captured_amount >= 0 and released_amount >= 0 and captured_amount + released_amount <= original_amount",
            ),
        ),
        check("credit_holds_status_allowed", sql.raw("status in ('active', 'closed')")),
        check(
            "credit_holds_status_coherent",
            sql.raw(
                "(status = 'active' and captured_amount + released_amount < original_amount and close_transaction_id is null and closed_at is null) or (status = 'closed' and captured_amount + released_amount = original_amount and close_transaction_id is not null and closed_at is not null)",
            ),
        ),
    ],
);

export const ledgerEntries = pgTable(
    "ledger_entries",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        workspaceId: text("workspace_id")
            .notNull()
            .references(() => workspaces.id, { onDelete: "restrict" }),
        transactionId: uuid("transaction_id").notNull(),
        walletId: uuid("wallet_id"),
        bucket: text("bucket").$type<"available" | "held" | "platform_clearing">().notNull(),
        amount: bigint("amount", { mode: "bigint" }).notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        foreignKey({
            name: "ledger_entries_workspace_transaction_fk",
            columns: [table.workspaceId, table.transactionId],
            foreignColumns: [creditTransactions.workspaceId, creditTransactions.id],
        }).onDelete("restrict"),
        foreignKey({
            name: "ledger_entries_workspace_wallet_fk",
            columns: [table.workspaceId, table.walletId],
            foreignColumns: [creditWallets.workspaceId, creditWallets.id],
        }).onDelete("restrict"),
        index("ledger_entries_workspace_transaction_idx").on(table.workspaceId, table.transactionId),
        index("ledger_entries_workspace_wallet_idx").on(table.workspaceId, table.walletId),
        check(
            "ledger_entries_bucket_allowed",
            sql.raw("bucket in ('available', 'held', 'platform_clearing')"),
        ),
        check(
            "ledger_entries_wallet_coherent",
            sql.raw(
                "(bucket = 'platform_clearing' and wallet_id is null) or (bucket in ('available', 'held') and wallet_id is not null)",
            ),
        ),
    ],
);
