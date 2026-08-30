import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/infrastructure/database/client.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { createFixedImagePriceSnapshot } from "../../src/modules/billing/service.js";
import { MemoryObjectStoreAdapter } from "../../src/modules/assets/object-store.js";
import { AssetModule } from "../../src/modules/assets/service.js";
import type { ProviderAdapter, ProviderResult } from "../../src/modules/providers/adapter.js";
import { TestImageProviderAdapter } from "../../src/modules/providers/test-adapter.js";
import type { AiTaskJobPayload, AiTaskQueue } from "../../src/modules/ai-tasks/queue.js";
import { AiTaskModule } from "../../src/modules/ai-tasks/service.js";
import { AiTaskWorker } from "../../src/modules/ai-tasks/worker.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

const PNG = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
));

class MemoryQueue implements AiTaskQueue {
    readonly jobs: AiTaskJobPayload[] = [];
    async enqueue(_tx: Parameters<AiTaskQueue["enqueue"]>[0], payload: AiTaskJobPayload): Promise<string> {
        this.jobs.push(payload);
        return randomUUID();
    }
}

let postgres: StartedRoleDatabase | undefined;
let api: DatabaseHandle | undefined;
let workerDb: DatabaseHandle | undefined;
let admin: Pool | undefined;
let workspaceId = "";
let userId = "";
let tasks: AiTaskModule;
let queue: MemoryQueue;
let assets: AssetModule;

const descriptor = {
    adapterId: "test-image",
    adapterVersion: "1",
    capabilityId: "image.generate" as const,
    exactModelId: "test-image-model",
    supportsPolling: false,
    supportsCancellation: false,
};
const price = createFixedImagePriceSnapshot({
    capabilityId: descriptor.capabilityId,
    routeId: descriptor.adapterId,
    exactModelId: descriptor.exactModelId,
    priceVersion: "fixed-v1",
    estimatedAmount: 25n,
    fixedAmount: 25n,
});
const workerConfig = {
    workerId: "worker-test",
    leaseDurationMs: 5_000,
    heartbeatIntervalMs: 100,
    providerTimeoutMs: 1_000,
    safeRetryBudget: 0,
};

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
    api = createDatabase({ url: postgres.api, poolMax: 3, expectedRole: "app_api" });
    workerDb = createDatabase({ url: postgres.worker, poolMax: 4, expectedRole: "app_worker" });
    admin = new Pool({ connectionString: postgres.admin, max: 3 });
    userId = randomUUID();
    workspaceId = randomUUID();
    await admin.query("begin");
    try {
        await admin.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            userId,
            "worker owner",
            `worker-${userId}@example.com`,
        ]);
        await admin.query(
            "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, 'Worker', $2, 'team', $3, 'active')",
            [workspaceId, `worker-${workspaceId}`, userId],
        );
        await admin.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
            [randomUUID(), workspaceId, userId],
        );
        const wallet = await admin.query<{ id: string }>("select id from public.credit_wallets where workspace_id = $1", [workspaceId]);
        const transaction = await admin.query<{ id: string }>(
            "insert into public.credit_transactions (workspace_id, operation_key, request_hash, kind) values ($1, 'fixture:worker', $2, 'adjustment') returning id",
            [workspaceId, "f".repeat(64)],
        );
        await admin.query(
            "insert into public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount) values ($1, $2, $3, 'available', 100), ($1, $2, null, 'platform_clearing', -100)",
            [workspaceId, transaction.rows[0]!.id, wallet.rows[0]!.id],
        );
        await admin.query("update public.credit_wallets set available_amount = 100 where id = $1", [wallet.rows[0]!.id]);
        await admin.query("commit");
    } catch (error) {
        await admin.query("rollback").catch(() => {});
        throw error;
    }
    queue = new MemoryQueue();
    tasks = new AiTaskModule(api.db, queue, descriptor, price);
    assets = new AssetModule(workerDb.db, new MemoryObjectStoreAdapter());
}, 180_000);

afterAll(async () => {
    await api?.pool.end().catch(() => {});
    await workerDb?.pool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await postgres?.stop().catch(() => {});
}, 60_000);

async function createTask(key: string) {
    const result = await tasks.createTask({ userId, workspaceId, idempotencyKey: key, prompt: key });
    return { result, payload: queue.jobs.at(-1)! };
}

function runWorker(provider: ProviderAdapter, payload: AiTaskJobPayload) {
    return new AiTaskWorker(workerDb!.db, assets, provider, workerConfig).handle(payload);
}

describe("AI Task Worker state machine", () => {
    it("settles only after a ready Asset, keeps ambiguous Holds active, and rejects an old lease epoch", async () => {
        const success = await createTask("success");
        await runWorker(
            new TestImageProviderAdapter({ kind: "success", output: { bytes: PNG, mediaType: "image/png" }, billing: {} }),
            success.payload,
        );
        const successState = await admin!.query(
            "select status, result_asset_id from public.ai_tasks where id = $1",
            [success.result.taskId],
        );
        expect(successState.rows).toEqual([{ status: "succeeded", result_asset_id: expect.any(String) }]);
        expect((await admin!.query("select status from public.assets where id = $1", [successState.rows[0]!.result_asset_id])).rows)
            .toEqual([{ status: "ready" }]);
        const replayedEvents = await tasks.listEventsAfter({ userId, workspaceId, taskId: success.result.taskId, sequence: 1n });
        expect(replayedEvents.map((event) => event.type)).toEqual(["submitting", "storing", "succeeded"]);
        expect(replayedEvents.map((event) => BigInt(event.sequence))).toEqual([2n, 3n, 4n]);
        expect((await tasks.getTask({ userId, workspaceId, taskId: success.result.taskId })).status).toBe("succeeded");

        const ambiguous = await createTask("ambiguous");
        await runWorker(
            new TestImageProviderAdapter({ kind: "ambiguous", error: { code: "provider_unconfirmed", message: "unconfirmed" } }),
            ambiguous.payload,
        );
        const ambiguousState = await admin!.query(
            `select task.status, orders.status as order_status, hold.status as hold_status
             from public.ai_tasks task
             join public.billing_orders orders on orders.task_id = task.id
             join public.credit_holds hold on hold.billing_order_id = orders.id
             where task.id = $1`,
            [ambiguous.result.taskId],
        );
        expect(ambiguousState.rows).toEqual([{ status: "reconciling", order_status: "reserved", hold_status: "active" }]);

        let resolveProvider!: (value: ProviderResult) => void;
        const deferred: ProviderAdapter = {
            descriptor,
            submit: () => new Promise((resolve) => { resolveProvider = resolve; }),
        };
        const stale = await createTask("stale");
        const handling = runWorker(deferred, stale.payload);
        for (;;) {
            const state = await admin!.query<{ status: string }>("select status from public.ai_tasks where id = $1", [stale.result.taskId]);
            if (state.rows[0]?.status === "submitting") break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await admin!.query(
            "update public.ai_tasks set lease_epoch = lease_epoch + 1, lease_worker_id = 'replacement', lease_expires_at = now() + interval '1 hour' where id = $1",
            [stale.result.taskId],
        );
        resolveProvider({ kind: "success", output: { bytes: PNG, mediaType: "image/png" }, billing: {} });
        await expect(handling).rejects.toMatchObject({ code: "ai_task_lease_lost" });

        const staleState = await admin!.query(
            `select task.status, task.result_asset_id, hold.status as hold_status
             from public.ai_tasks task
             join public.billing_orders orders on orders.task_id = task.id
             join public.credit_holds hold on hold.billing_order_id = orders.id
             where task.id = $1`,
            [stale.result.taskId],
        );
        expect(staleState.rows).toEqual([{ status: "submitting", result_asset_id: null, hold_status: "active" }]);
    }, 90_000);
});
