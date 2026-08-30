import { and, eq, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import { withWorkerTransaction } from "../../infrastructure/database/transactions.js";
import type { AppDatabase, AppTransaction } from "../../infrastructure/database/types.js";
import type { AssetModule } from "../assets/service.js";
import { calculateStoredActualCreditAmount } from "../billing/service.js";
import type { PriceSnapshotJson } from "../billing/schema.js";
import { captureHold, releaseHold } from "../credits/service.js";
import type { ProviderAdapter, ProviderBillingFact, ProviderResult } from "../providers/adapter.js";
import type { AiTaskJobPayload } from "./queue.js";
import { aiTasks, providerAttempts, taskEvents } from "./schema.js";

export type AiTaskWorkerConfig = {
    workerId: string;
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
    providerTimeoutMs: number;
    safeRetryBudget: number;
};

type ClaimedTask = { taskId: string; workspaceId: string; prompt: string; leaseEpoch: bigint; providerIdempotencyKey: string };

export class AiTaskWorker {
    constructor(
        private readonly db: AppDatabase,
        private readonly assets: AssetModule,
        private readonly provider: ProviderAdapter,
        private readonly config: AiTaskWorkerConfig,
    ) {
        if (
            config.leaseDurationMs <= 0 || config.heartbeatIntervalMs <= 0 ||
            config.heartbeatIntervalMs >= config.leaseDurationMs || config.providerTimeoutMs <= 0 ||
            config.safeRetryBudget < 0
        ) {
            throw new Error("AI Task Worker timing and retry configuration is invalid");
        }
    }

    async handle(payload: AiTaskJobPayload): Promise<void> {
        if (payload.protocolVersion !== 1) throw new Error("Unsupported AI Task Job protocol version");
        const task = await this.claim(payload);
        if (!task) return;

        const leaseAbort = new AbortController();
        let leaseLost = false;
        let heartbeatRunning = false;
        let pendingHeartbeat: Promise<void> = Promise.resolve();
        const heartbeat = setInterval(() => {
            if (heartbeatRunning || leaseLost) return;
            heartbeatRunning = true;
            pendingHeartbeat = this.renew(task)
                .then((renewed) => {
                    if (!renewed) {
                        leaseLost = true;
                        leaseAbort.abort();
                    }
                })
                .finally(() => {
                    heartbeatRunning = false;
                });
        }, this.config.heartbeatIntervalMs);

        try {
            let result: ProviderResult | undefined;
            for (let attempt = 0; attempt <= this.config.safeRetryBudget; attempt += 1) {
                const signal = AbortSignal.any([leaseAbort.signal, AbortSignal.timeout(this.config.providerTimeoutMs)]);
                result = await this.provider.submit(
                    { prompt: task.prompt },
                    { providerIdempotencyKey: task.providerIdempotencyKey, signal },
                );
                if (result.kind !== "safe_retry" || attempt === this.config.safeRetryBudget) break;
            }
            if (leaseLost) throw new AppError("ai_task_lease_lost", 409, "任务租约已失效");
            if (!result) throw new Error("Provider returned no result");

            if (result.kind === "success") await this.succeed(task, result.output, result.billing);
            else if (result.kind === "terminal") await this.fail(task, result.error.code, "terminal");
            else if (result.kind === "safe_retry") await this.fail(task, result.error.code, "safe_retry_exhausted");
            else await this.reconcile(task, result.kind === "provider_processing" ? "provider_processing" : result.error.code);
        } finally {
            clearInterval(heartbeat);
            await pendingHeartbeat;
        }
    }

    private async claim(payload: AiTaskJobPayload): Promise<ClaimedTask | null> {
        return withWorkerTransaction(
            this.db,
            { workspaceId: payload.workspaceId, verify: (tx) => this.findTask(tx, payload.workspaceId, payload.taskId) },
            async (tx, task) => {
                const locked = await tx.execute<{
                    status: string;
                    lease_epoch: string;
                    lease_expires_at: Date | null;
                    prompt: string;
                    provider_idempotency_key: string;
                }>(sql`
                    select task.status, task.lease_epoch, task.lease_expires_at,
                           task.input->>'prompt' as prompt, attempt.provider_idempotency_key
                    from public.ai_tasks task
                    join public.provider_attempts attempt
                      on attempt.workspace_id = task.workspace_id and attempt.task_id = task.id and attempt.sequence = 1
                    where task.workspace_id = ${payload.workspaceId} and task.id = ${payload.taskId}::uuid
                    for update of task, attempt
                `);
                const row = locked.rows[0];
                if (!row) return null;
                if (row.status !== "queued") {
                    if (row.lease_expires_at && row.lease_expires_at <= new Date() && !["succeeded", "failed"].includes(row.status)) {
                        const epoch = BigInt(row.lease_epoch) + 1n;
                        await tx.update(aiTasks).set({ status: "reconciling", leaseEpoch: epoch, leaseWorkerId: this.config.workerId })
                            .where(and(eq(aiTasks.workspaceId, payload.workspaceId), eq(aiTasks.id, payload.taskId)));
                        await this.appendEvent(tx, payload.workspaceId, payload.taskId, "reconciling", { reason: "expired_lease" });
                    }
                    return null;
                }
                const leaseEpoch = BigInt(row.lease_epoch) + 1n;
                await tx.execute(sql`
                    update public.ai_tasks set status = 'submitting', lease_epoch = ${leaseEpoch},
                        lease_worker_id = ${this.config.workerId},
                        lease_expires_at = now() + (${this.config.leaseDurationMs} * interval '1 millisecond'), updated_at = now()
                    where workspace_id = ${payload.workspaceId} and id = ${payload.taskId}::uuid
                `);
                await tx.update(providerAttempts).set({ status: "submitting" })
                    .where(and(eq(providerAttempts.workspaceId, payload.workspaceId), eq(providerAttempts.taskId, payload.taskId)));
                await this.appendEvent(tx, payload.workspaceId, payload.taskId, "submitting", {});
                return {
                    taskId: payload.taskId,
                    workspaceId: payload.workspaceId,
                    prompt: row.prompt,
                    leaseEpoch,
                    providerIdempotencyKey: row.provider_idempotency_key,
                };
            },
        );
    }

    private async renew(task: ClaimedTask): Promise<boolean> {
        return withWorkerTransaction(
            this.db,
            { workspaceId: task.workspaceId, verify: (tx) => this.findTask(tx, task.workspaceId, task.taskId) },
            async (tx) => {
                const result = await tx.execute(sql`
                    update public.ai_tasks
                    set lease_expires_at = now() + (${this.config.leaseDurationMs} * interval '1 millisecond'), updated_at = now()
                    where workspace_id = ${task.workspaceId} and id = ${task.taskId}::uuid
                      and lease_epoch = ${task.leaseEpoch} and lease_worker_id = ${this.config.workerId}
                      and lease_expires_at > now()
                    returning id
                `);
                return result.rows.length === 1;
            },
        );
    }

    private async succeed(
        task: ClaimedTask,
        output: { bytes: Uint8Array; mediaType: string },
        billing: ProviderBillingFact,
    ): Promise<void> {
        const { assetId } = await withWorkerTransaction(
            this.db,
            { workspaceId: task.workspaceId, verify: (tx) => this.findTask(tx, task.workspaceId, task.taskId) },
            async (tx) => {
                await this.assertLease(tx, task, "submitting");
                const asset = await this.assets.createStagingAsset(tx, { workspaceId: task.workspaceId, displayName: "ai-output" });
                await tx.update(aiTasks).set({ status: "storing" }).where(this.leaseWhere(task));
                await this.appendEvent(tx, task.workspaceId, task.taskId, "storing", { assetId: asset.assetId });
                return asset;
            },
        );
        try {
            await this.assets.storeAndVerifyOutput({ workspaceId: task.workspaceId, assetId, output });
        } catch {
            await this.reconcile(task, "asset_storage_unconfirmed");
            return;
        }

        await withWorkerTransaction(
            this.db,
            { workspaceId: task.workspaceId, verify: (tx) => this.findTask(tx, task.workspaceId, task.taskId) },
            async (tx) => {
                await this.assertLease(tx, task, "storing");
                await this.assets.getReadyAsset(tx, { workspaceId: task.workspaceId, assetId });
                const context = await this.billingContext(tx, task);
                const actual = calculateStoredActualCreditAmount(context.priceSnapshot, context.estimatedAmount, billing);
                await captureHold(tx, {
                    workspaceId: task.workspaceId,
                    holdId: context.holdId,
                    amount: actual,
                    operationKey: `ai-task:${task.taskId}:settle`,
                    requestHash: context.requestHash,
                });
                const [updated] = await tx.update(aiTasks)
                    .set({ status: "succeeded", resultAssetId: assetId, leaseExpiresAt: null, updatedAt: new Date() })
                    .where(this.leaseWhere(task)).returning({ id: aiTasks.id });
                if (!updated) throw new AppError("ai_task_lease_lost", 409, "任务租约已失效");
                await tx.update(providerAttempts).set({ status: "succeeded" })
                    .where(and(eq(providerAttempts.workspaceId, task.workspaceId), eq(providerAttempts.taskId, task.taskId)));
                await this.appendEvent(tx, task.workspaceId, task.taskId, "succeeded", { assetId });
            },
        );
    }

    private async fail(task: ClaimedTask, errorCode: string, classification: string): Promise<void> {
        await withWorkerTransaction(
            this.db,
            { workspaceId: task.workspaceId, verify: (tx) => this.findTask(tx, task.workspaceId, task.taskId) },
            async (tx) => {
                await this.assertLease(tx, task, "submitting");
                const context = await this.billingContext(tx, task);
                await releaseHold(tx, {
                    workspaceId: task.workspaceId,
                    holdId: context.holdId,
                    operationKey: `ai-task:${task.taskId}:release`,
                    requestHash: context.requestHash,
                });
                await tx.update(aiTasks).set({ status: "failed", publicErrorCode: errorCode, leaseExpiresAt: null })
                    .where(this.leaseWhere(task));
                await tx.update(providerAttempts).set({ status: "failed", failureClassification: classification })
                    .where(and(eq(providerAttempts.workspaceId, task.workspaceId), eq(providerAttempts.taskId, task.taskId)));
                await this.appendEvent(tx, task.workspaceId, task.taskId, "failed", { errorCode });
            },
        );
    }

    private async reconcile(task: ClaimedTask, reason: string): Promise<void> {
        await withWorkerTransaction(
            this.db,
            { workspaceId: task.workspaceId, verify: (tx) => this.findTask(tx, task.workspaceId, task.taskId) },
            async (tx) => {
                await this.assertLease(tx, task);
                await tx.update(aiTasks).set({ status: "reconciling", publicErrorCode: reason, leaseExpiresAt: null })
                    .where(this.leaseWhere(task));
                await tx.update(providerAttempts).set({ status: "ambiguous", failureClassification: "ambiguous" })
                    .where(and(eq(providerAttempts.workspaceId, task.workspaceId), eq(providerAttempts.taskId, task.taskId)));
                await this.appendEvent(tx, task.workspaceId, task.taskId, "reconciling", { reason });
            },
        );
    }

    private leaseWhere(task: ClaimedTask) {
        return and(
            eq(aiTasks.workspaceId, task.workspaceId), eq(aiTasks.id, task.taskId),
            eq(aiTasks.leaseEpoch, task.leaseEpoch), eq(aiTasks.leaseWorkerId, this.config.workerId),
        );
    }

    private async assertLease(tx: AppTransaction, task: ClaimedTask, status?: string): Promise<void> {
        const result = await tx.execute(sql`
            select id from public.ai_tasks
            where workspace_id = ${task.workspaceId} and id = ${task.taskId}::uuid
              and lease_epoch = ${task.leaseEpoch} and lease_worker_id = ${this.config.workerId}
              and lease_expires_at > now() ${status ? sql`and status = ${status}` : sql``}
            for update
        `);
        if (result.rows.length !== 1) throw new AppError("ai_task_lease_lost", 409, "任务租约已失效");
    }

    private async billingContext(tx: AppTransaction, task: ClaimedTask): Promise<{
        holdId: string;
        requestHash: string;
        priceSnapshot: PriceSnapshotJson;
        estimatedAmount: bigint;
    }> {
        const result = await tx.execute<{
            hold_id: string;
            request_hash: string;
            price_snapshot: PriceSnapshotJson;
            estimated_amount: string;
        }>(sql`
            select hold.id as hold_id, task.request_hash, orders.price_snapshot, orders.estimated_amount
            from public.ai_tasks task
            join public.billing_orders orders on orders.workspace_id = task.workspace_id and orders.task_id = task.id
            join public.credit_holds hold on hold.workspace_id = orders.workspace_id and hold.billing_order_id = orders.id
            where task.workspace_id = ${task.workspaceId} and task.id = ${task.taskId}::uuid
        `);
        const row = result.rows[0];
        if (!row) throw new Error("AI Task billing context is missing");
        return {
            holdId: row.hold_id,
            requestHash: row.request_hash,
            priceSnapshot: row.price_snapshot,
            estimatedAmount: BigInt(row.estimated_amount),
        };
    }

    private async appendEvent(
        tx: AppTransaction,
        workspaceId: string,
        taskId: string,
        type: string,
        payload: Record<string, string>,
    ): Promise<void> {
        const result = await tx.execute<{ sequence: string }>(sql`
            select COALESCE(max(sequence), 0) + 1 as sequence
            from public.task_events where workspace_id = ${workspaceId} and task_id = ${taskId}::uuid
        `);
        await tx.insert(taskEvents).values({
            workspaceId,
            taskId,
            sequence: BigInt(result.rows[0]!.sequence),
            type,
            payload,
        });
    }

    private async findTask(tx: AppTransaction, workspaceId: string, taskId: string) {
        const [task] = await tx.select({ id: aiTasks.id }).from(aiTasks)
            .where(and(eq(aiTasks.workspaceId, workspaceId), eq(aiTasks.id, taskId))).limit(1);
        return task ?? null;
    }
}
