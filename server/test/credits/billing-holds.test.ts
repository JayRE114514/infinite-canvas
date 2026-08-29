import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/infrastructure/database/client.js";
import { withTenantTransaction } from "../../src/infrastructure/database/transactions.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { createBillingOrder, createFixedImagePriceSnapshot } from "../../src/modules/billing/service.js";
import { aiTasks } from "../../src/modules/ai-tasks/schema.js";
import { getWalletBalance, reserveCredits } from "../../src/modules/credits/service.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

let postgres: StartedRoleDatabase | undefined;
let api: DatabaseHandle | undefined;
let admin: Pool | undefined;
let worker: Pool | undefined;
let userId = "";
let workspaceId = "";

async function rollback(client: PoolClient): Promise<void> {
    await client.query("rollback").catch(() => {});
}

async function workerCommand<T>(query: string, values: unknown[]): Promise<T> {
    const client = await worker!.connect();
    try {
        await client.query("begin");
        await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
        const result = await client.query<T & Record<string, unknown>>(query, values);
        await client.query("commit");
        return result.rows[0] as T;
    } catch (error) {
        await rollback(client);
        throw error;
    } finally {
        client.release();
    }
}

async function createReservedOrder(estimated: bigint, fixed: bigint, key: string) {
    return withTenantTransaction(api!.db, { userId, workspaceId }, async (tx) => {
        const taskId = randomUUID();
        await tx.insert(aiTasks).values({
            id: taskId,
            workspaceId,
            createdBy: userId,
            capabilityId: "image.generate",
            adapterId: "openai-images",
            adapterVersion: "test-v1",
            exactModelId: "owner-model",
            input: { prompt: key },
            idempotencyKey: `billing-hold:${key}`,
            requestHash: key.repeat(64).slice(0, 64),
        });
        const snapshot = createFixedImagePriceSnapshot({
            capabilityId: "image.generate",
            routeId: "openai-images",
            exactModelId: "owner-model",
            priceVersion: "fixed-v1",
            estimatedAmount: estimated,
            fixedAmount: fixed,
        });
        const billingOrderId = await createBillingOrder(tx, { workspaceId, taskId, snapshot });
        const hold = await reserveCredits(tx, {
            workspaceId,
            billingOrderId,
            amount: estimated,
            operationKey: `reserve:${key}`,
            requestHash: key.repeat(64).slice(0, 64),
        });
        return { billingOrderId, ...hold };
    });
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
    api = createDatabase({ url: postgres.api, poolMax: 4, expectedRole: "app_api" });
    admin = new Pool({ connectionString: postgres.admin, max: 2 });
    worker = new Pool({ connectionString: postgres.worker, max: 2 });
    userId = randomUUID();
    workspaceId = randomUUID();

    const client = await admin.connect();
    try {
        await client.query("begin");
        await client.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            userId,
            "billing owner",
            `billing-${userId}@example.com`,
        ]);
        await client.query(
            "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, 'Billing', $2, 'team', $3, 'active')",
            [workspaceId, `billing-${workspaceId}`, userId],
        );
        await client.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
            [randomUUID(), workspaceId, userId],
        );
        const wallet = await client.query<{ id: string }>(
            "select id from public.credit_wallets where workspace_id = $1",
            [workspaceId],
        );
        const transaction = await client.query<{ id: string }>(
            "insert into public.credit_transactions (workspace_id, operation_key, request_hash, kind) values ($1, 'fixture:grant', $2, 'adjustment') returning id",
            [workspaceId, "f".repeat(64)],
        );
        await client.query(
            "insert into public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount) values ($1, $2, $3, 'available', 200), ($1, $2, null, 'platform_clearing', -200)",
            [workspaceId, transaction.rows[0]!.id, wallet.rows[0]!.id],
        );
        await client.query("update public.credit_wallets set available_amount = 200 where id = $1", [wallet.rows[0]!.id]);
        await client.query("commit");
    } catch (error) {
        await rollback(client);
        throw error;
    } finally {
        client.release();
    }
}, 180_000);

afterAll(async () => {
    await api?.pool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await worker?.end().catch(() => {});
    await postgres?.stop().catch(() => {});
}, 60_000);

describe("Billing Order and Credit Hold", () => {
    it("conserves reserve/capture/release/compensation and escalates overdue ambiguity without changing the active Hold", async () => {
        const captured = await createReservedOrder(100n, 70n, "a");
        expect(captured.balance).toEqual({ available: 100n, held: 100n });

        const capture = await workerCommand<{
            transaction_id: string;
            replayed: boolean;
            available_amount: string;
            held_amount: string;
        }>("select * from public.capture_credit_hold($1, $2, $3, $4, $5)", [
            workspaceId,
            captured.holdId,
            "70",
            "capture:a",
            "1".repeat(64),
        ]);
        expect(capture).toMatchObject({ replayed: false, available_amount: "130", held_amount: "0" });
        const captureReplay = await workerCommand<typeof capture>(
            "select * from public.capture_credit_hold($1, $2, $3, $4, $5)",
            [workspaceId, captured.holdId, "70", "capture:a", "1".repeat(64)],
        );
        expect(captureReplay).toEqual({ ...capture, replayed: true });

        const compensation = await workerCommand<{
            transaction_id: string;
            replayed: boolean;
            available_amount: string;
            held_amount: string;
        }>("select * from public.compensate_credit_capture($1, $2, $3, $4, $5)", [
            workspaceId,
            capture.transaction_id,
            "20",
            "compensate:a",
            "2".repeat(64),
        ]);
        expect(compensation).toMatchObject({ replayed: false, available_amount: "150", held_amount: "0" });

        const released = await createReservedOrder(20n, 20n, "b");
        const release = await workerCommand<{ replayed: boolean; available_amount: string; held_amount: string }>(
            "select * from public.release_credit_hold($1, $2, $3, $4)",
            [workspaceId, released.holdId, "release:b", "3".repeat(64)],
        );
        expect(release).toMatchObject({ replayed: false, available_amount: "150", held_amount: "0" });

        const review = await createReservedOrder(10n, 10n, "c");
        await admin!.query(
            "update public.billing_orders set created_at = now() - interval '25 hours', review_after = now() - interval '1 hour' where id = $1",
            [review.billingOrderId],
        );
        expect(
            await workerCommand<{ changed: boolean }>(
                "select public.mark_billing_order_review($1, $2) as changed",
                [workspaceId, review.billingOrderId],
            ),
        ).toEqual({ changed: true });

        const state = await admin!.query(
            `select o.status as order_status, h.status as hold_status,
                    h.original_amount::text, h.captured_amount::text, h.released_amount::text
             from public.billing_orders o join public.credit_holds h
               on h.workspace_id = o.workspace_id and h.billing_order_id = o.id
             where o.id = $1`,
            [review.billingOrderId],
        );
        const balance = await withTenantTransaction(api!.db, { userId, workspaceId }, (tx) =>
            getWalletBalance(tx, workspaceId),
        );
        const transactionSums = await admin!.query(
            "select transaction_id, sum(amount)::text as total from public.ledger_entries where workspace_id = $1 group by transaction_id order by transaction_id",
            [workspaceId],
        );

        expect(state.rows).toEqual([
            { order_status: "review", hold_status: "active", original_amount: "10", captured_amount: "0", released_amount: "0" },
        ]);
        expect(balance).toEqual({ available: 140n, held: 10n });
        expect(transactionSums.rows.every((row) => row.total === "0")).toBe(true);
    }, 90_000);

    it("keeps credit history and the admin narrow window closed outside authorized Workspace context", async () => {
        await expect(api!.pool.query("select id from public.credit_wallets")).resolves.toMatchObject({ rows: [] });
        await expect(api!.pool.query("select id from public.credit_transactions")).rejects.toMatchObject({ code: "42501" });

        const client = await api!.pool.connect();
        try {
            await client.query("begin");
            await client.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [
                randomUUID(),
                workspaceId,
            ]);
            await expect(client.query("select id from public.credit_wallets")).resolves.toMatchObject({ rows: [] });
            await expect(
                client.query("select * from public.execute_wallet_adjustment(1, 'forged', 'forged', $1)", [
                    "9".repeat(64),
                ]),
            ).rejects.toMatchObject({ code: "42501" });
        } finally {
            await rollback(client);
            client.release();
        }
    });
});
