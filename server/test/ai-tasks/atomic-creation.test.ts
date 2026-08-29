import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDatabase } from "../../src/infrastructure/database/client.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { AI_TASK_QUEUE, createRuntimeBoss, initializePgBossSchema } from "../../src/infrastructure/jobs/pg-boss.js";
import { createFixedImagePriceSnapshot } from "../../src/modules/billing/service.js";
import { PgBossAiTaskQueue, type AiTaskJobPayload, type AiTaskQueue } from "../../src/modules/ai-tasks/queue.js";
import { AiTaskModule } from "../../src/modules/ai-tasks/service.js";
import { MemoryMailer, registerVerifiedUser, type AuthApp } from "../helpers/auth.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

let postgres: StartedRoleDatabase | undefined;
let database: DatabaseHandle | undefined;
let admin: Pool | undefined;
let boss: PgBoss | undefined;
let app: AuthApp | undefined;
let mailer: MemoryMailer;
let tasks: AiTaskModule;

const descriptor = {
    adapterId: "openai-images",
    adapterVersion: "1",
    capabilityId: "image.generate" as const,
    exactModelId: "owner-image-model",
    supportsPolling: false,
    supportsCancellation: false,
};
const snapshot = createFixedImagePriceSnapshot({
    capabilityId: descriptor.capabilityId,
    routeId: "openai-images",
    exactModelId: descriptor.exactModelId,
    priceVersion: "fixed-v1",
    estimatedAmount: 25n,
    fixedAmount: 25n,
});

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
    await initializePgBossSchema({ schemaOwnerUrl: postgres.schemaOwner, queueName: AI_TASK_QUEUE, jobRetryCount: 0 });
    database = createDatabase({ url: postgres.api, poolMax: 4, expectedRole: "app_api" });
    admin = new Pool({ connectionString: postgres.admin, max: 2 });
    boss = createRuntimeBoss(postgres.api);
    await boss.start();
    tasks = new AiTaskModule(database.db, new PgBossAiTaskQueue(boss), descriptor, snapshot);
    mailer = new MemoryMailer();
    app = await buildApp({
        logger: false,
        database,
        mailer,
        aiTaskModule: tasks,
        config: loadConfig({
            NODE_ENV: "test",
            DATABASE_URL_API: postgres.api,
            BETTER_AUTH_SECRET: "t".repeat(32),
            APP_ORIGIN: "http://localhost:3000",
            SMTP_HOST: "localhost",
            SMTP_FROM: "no-reply@example.com",
        }),
    });
}, 180_000);

afterAll(async () => {
    await app?.close().catch(() => {});
    await boss?.stop().catch(() => {});
    if (database && !database.pool.ending && !database.pool.ended) await database.pool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await postgres?.stop().catch(() => {});
}, 60_000);

describe("AI Task atomic creation", () => {
    it("returns 202 only after Task, price snapshot, Hold, Attempt, Event and pg-boss Job commit together", async () => {
        const user = await registerVerifiedUser(app!, mailer, {
            name: "AI task owner",
            email: `ai-task-${randomUUID()}@example.com`,
        });
        const workspace = await app!.inject({ method: "GET", url: "/api/v1/workspaces", headers: { cookie: user.cookie } });
        const workspaceId = workspace.json().workspaces[0].id as string;
        const wallet = await admin!.query<{ id: string }>("select id from public.credit_wallets where workspace_id = $1", [
            workspaceId,
        ]);
        await admin!.query("begin");
        try {
            const transaction = await admin!.query<{ id: string }>(
                "insert into public.credit_transactions (workspace_id, operation_key, request_hash, kind) values ($1, 'fixture:ai-task', $2, 'adjustment') returning id",
                [workspaceId, "f".repeat(64)],
            );
            await admin!.query(
                "insert into public.ledger_entries (workspace_id, transaction_id, wallet_id, bucket, amount) values ($1, $2, $3, 'available', 100), ($1, $2, null, 'platform_clearing', -100)",
                [workspaceId, transaction.rows[0]!.id, wallet.rows[0]!.id],
            );
            await admin!.query("update public.credit_wallets set available_amount = 100 where id = $1", [wallet.rows[0]!.id]);
            await admin!.query("commit");
        } catch (error) {
            await admin!.query("rollback").catch(() => {});
            throw error;
        }

        const headers = { cookie: user.cookie, "idempotency-key": "create-image-1" };
        const payload = { workspaceId, prompt: "画一只猫" };
        const created = await app!.inject({ method: "POST", url: "/api/v1/ai/tasks", headers, payload });
        const replayed = await app!.inject({ method: "POST", url: "/api/v1/ai/tasks", headers, payload });
        const conflict = await app!.inject({
            method: "POST",
            url: "/api/v1/ai/tasks",
            headers,
            payload: { ...payload, prompt: "不同请求" },
        });

        expect(created.statusCode, created.body).toBe(202);
        expect(created.json()).toMatchObject({ status: "queued", estimatedCredits: "25", replayed: false });
        expect(replayed.statusCode, replayed.body).toBe(202);
        expect(replayed.json()).toEqual({ ...created.json(), replayed: true });
        expect(conflict.statusCode, conflict.body).toBe(409);
        expect(conflict.json().error.code).toBe("idempotency_conflict");

        const taskId = created.json().taskId as string;
        const committed = await admin!.query(
            `select
                (select count(*)::int from public.ai_tasks where id = $1) as tasks,
                (select count(*)::int from public.billing_orders where task_id = $1) as orders,
                (select count(*)::int from public.credit_holds h join public.billing_orders o on o.id = h.billing_order_id where o.task_id = $1) as holds,
                (select count(*)::int from public.provider_attempts where task_id = $1) as attempts,
                (select count(*)::int from public.task_events where task_id = $1) as events,
                (select count(*)::int from pgboss.job where name = $2 and data->>'taskId' = $1::text) as jobs`,
            [taskId, AI_TASK_QUEUE],
        );
        const job = await admin!.query<{ data: AiTaskJobPayload }>(
            "select data from pgboss.job where name = $1 and data->>'taskId' = $2",
            [AI_TASK_QUEUE, taskId],
        );
        expect(committed.rows).toEqual([{ tasks: 1, orders: 1, holds: 1, attempts: 1, events: 1, jobs: 1 }]);
        expect(job.rows[0]!.data).toEqual({ protocolVersion: 1, taskId, workspaceId });
        expect(JSON.stringify(job.rows[0]!.data)).not.toContain(payload.prompt);

        class FailAfterEnqueue implements AiTaskQueue {
            constructor(private readonly delegate: AiTaskQueue) {}
            async enqueue(tx: Parameters<AiTaskQueue["enqueue"]>[0], jobPayload: AiTaskJobPayload): Promise<string> {
                await this.delegate.enqueue(tx, jobPayload);
                throw new Error("injected after enqueue");
            }
        }
        const failing = new AiTaskModule(
            database!.db,
            new FailAfterEnqueue(new PgBossAiTaskQueue(boss!)),
            descriptor,
            snapshot,
        );
        await expect(
            failing.createTask({ userId: user.userId, workspaceId, idempotencyKey: "rollback-after-job", prompt: "回滚" }),
        ).rejects.toThrow("injected after enqueue");
        const rolledBack = await admin!.query(
            `select
                (select count(*)::int from public.ai_tasks where workspace_id = $1 and idempotency_key = 'rollback-after-job') as tasks,
                (select count(*)::int from pgboss.job where name = $2 and data->>'workspaceId' = $1) as workspace_jobs`,
            [workspaceId, AI_TASK_QUEUE],
        );
        expect(rolledBack.rows).toEqual([{ tasks: 0, workspace_jobs: 1 }]);
    }, 90_000);
});
