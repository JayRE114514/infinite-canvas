import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

let postgres: StartedRoleDatabase | undefined;
let admin: Pool | undefined;
let workspaceId = "";
let walletId = "";

async function rollback(client: PoolClient): Promise<void> {
    await client.query("rollback").catch(() => {});
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
    admin = new Pool({ connectionString: postgres.admin, max: 4 });

    const userId = randomUUID();
    workspaceId = randomUUID();
    const client = await admin.connect();
    try {
        await client.query("begin");
        await client.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            userId,
            "ledger owner",
            `ledger-${userId}@example.com`,
        ]);
        await client.query(
            "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, 'Ledger', $2, 'team', $3, 'active')",
            [workspaceId, `ledger-${workspaceId}`, userId],
        );
        await client.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
            [randomUUID(), workspaceId, userId],
        );
        await client.query("commit");
    } catch (error) {
        await rollback(client);
        throw error;
    } finally {
        client.release();
    }

    const wallet = await admin.query<{ id: string }>(
        "select id from public.credit_wallets where workspace_id = $1",
        [workspaceId],
    );
    walletId = wallet.rows[0]!.id;
}, 180_000);

afterAll(async () => {
    await admin?.end().catch(() => {});
    await postgres?.stop().catch(() => {});
}, 60_000);

describe("credit ledger database core", () => {
    it("commits only balanced entries with the matching non-negative Wallet projection and keeps history immutable", async () => {
        const client = await admin!.connect();
        let transactionId = "";
        try {
            await client.query("begin");
            const transaction = await client.query<{ id: string }>(
                "insert into public.credit_transactions (workspace_id, operation_key, request_hash, kind) values ($1, $2, $3, 'adjustment') returning id",
                [workspaceId, "ledger-core:valid", "a".repeat(64)],
            );
            transactionId = transaction.rows[0]!.id;
            await client.query(
                "insert into public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount) values ($1, $2, $3, 'available', 10), ($1, $2, null, 'platform_clearing', -10)",
                [workspaceId, transactionId, walletId],
            );
            await client.query(
                "update public.credit_wallets set available_amount = available_amount + 10, updated_at = now() where workspace_id = $1 and id = $2",
                [workspaceId, walletId],
            );
            await client.query("commit");

            await expect(
                client.query("update public.ledger_entries set amount = amount where transaction_id = $1", [transactionId]),
            ).rejects.toMatchObject({ code: "42501" });
            await expect(
                client.query("update public.credit_wallets set available_amount = -1 where id = $1", [walletId]),
            ).rejects.toMatchObject({ code: "23514" });

            await client.query("begin");
            const invalid = await client.query<{ id: string }>(
                "insert into public.credit_transactions (workspace_id, operation_key, request_hash, kind) values ($1, $2, $3, 'adjustment') returning id",
                [workspaceId, "ledger-core:unbalanced", "b".repeat(64)],
            );
            await client.query(
                "insert into public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount) values ($1, $2, $3, 'available', 2), ($1, $2, null, 'platform_clearing', -1)",
                [workspaceId, invalid.rows[0]!.id, walletId],
            );
            await client.query("update public.credit_wallets set available_amount = available_amount + 2 where id = $1", [
                walletId,
            ]);
            await expect(client.query("commit")).rejects.toMatchObject({ code: "23514" });
            await rollback(client);

            const balance = await admin!.query<{ available_amount: string; held_amount: string }>(
                "select available_amount, held_amount from public.credit_wallets where id = $1",
                [walletId],
            );
            expect(balance.rows[0]).toEqual({ available_amount: "10", held_amount: "0" });
        } finally {
            await rollback(client);
            client.release();
        }
    });

    it("serializes concurrent Wallet mutation through a row lock", async () => {
        const first = await admin!.connect();
        const second = await admin!.connect();
        try {
            await first.query("begin");
            await second.query("begin");
            await first.query("select id from public.credit_wallets where id = $1 for update", [walletId]);
            await expect(
                second.query("select id from public.credit_wallets where id = $1 for update nowait", [walletId]),
            ).rejects.toMatchObject({ code: "55P03" });
        } finally {
            await rollback(first);
            await rollback(second);
            first.release();
            second.release();
        }
    });
});
