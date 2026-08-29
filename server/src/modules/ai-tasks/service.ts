import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import { hashCanonicalRequest } from "../../infrastructure/idempotency.js";
import { withTenantTransaction } from "../../infrastructure/database/transactions.js";
import type { AppDatabase } from "../../infrastructure/database/types.js";
import { createBillingOrder, type FixedImagePriceSnapshot } from "../billing/service.js";
import { billingOrders } from "../billing/schema.js";
import { reserveCredits } from "../credits/service.js";
import type { ProviderDescriptor } from "../providers/adapter.js";
import type { AiTaskQueue } from "./queue.js";
import { aiTasks, providerAttempts, taskEvents } from "./schema.js";

export type CreateAiTaskResult = { taskId: string; status: "queued"; estimatedCredits: bigint; replayed: boolean };

/**
 * Drizzle 的 node-postgres 会话把 timestamptz 的类型解析器改成原样返回，
 * 而 tx.execute 不做列映射，因此原始行的时间列必须如实声明两种运行时类型。
 */
type TaskEventRow = {
    sequence: string;
    type: string;
    payload: Record<string, string>;
    created_at: string | Date;
};

/** 模块对调用方的保证：created_at 一定是有效 Date，调用方不需要知道驱动返回什么。 */
export type TaskEventRecord = Omit<TaskEventRow, "created_at"> & { created_at: Date };

function normalizeEventCreatedAt(value: string | Date): Date {
    const createdAt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(createdAt.getTime())) {
        throw new AppError("task_event_timestamp_invalid", 500, "任务事件时间不可解析");
    }
    return createdAt;
}

export class AiTaskModule {
    constructor(
        private readonly db: AppDatabase,
        private readonly queue: AiTaskQueue,
        private readonly provider: ProviderDescriptor,
        private readonly priceSnapshot: FixedImagePriceSnapshot,
    ) {}

    async createTask(input: {
        userId: string;
        workspaceId: string;
        idempotencyKey: string;
        prompt: string;
    }): Promise<CreateAiTaskResult> {
        const requestHash = hashCanonicalRequest({
            workspaceId: input.workspaceId,
            capabilityId: this.provider.capabilityId,
            prompt: input.prompt,
        });
        return withTenantTransaction(this.db, { userId: input.userId, workspaceId: input.workspaceId }, async (tx) => {
            const taskId = randomUUID();
            const [created] = await tx
                .insert(aiTasks)
                .values({
                    id: taskId,
                    workspaceId: input.workspaceId,
                    createdBy: input.userId,
                    capabilityId: this.provider.capabilityId,
                    adapterId: this.provider.adapterId,
                    adapterVersion: this.provider.adapterVersion,
                    exactModelId: this.provider.exactModelId,
                    input: { prompt: input.prompt },
                    idempotencyKey: input.idempotencyKey,
                    requestHash,
                })
                .onConflictDoNothing({ target: [aiTasks.workspaceId, aiTasks.idempotencyKey] })
                .returning({ id: aiTasks.id, requestHash: aiTasks.requestHash, status: aiTasks.status });

            if (!created) {
                const [existing] = await tx
                    .select({ id: aiTasks.id, requestHash: aiTasks.requestHash, status: aiTasks.status })
                    .from(aiTasks)
                    .where(and(eq(aiTasks.workspaceId, input.workspaceId), eq(aiTasks.idempotencyKey, input.idempotencyKey)))
                    .limit(1);
                if (!existing || existing.requestHash !== requestHash) {
                    throw new AppError("idempotency_conflict", 409, "幂等键已用于不同请求");
                }
                const [order] = await tx.select({ estimatedAmount: billingOrders.estimatedAmount })
                    .from(billingOrders)
                    .where(and(eq(billingOrders.workspaceId, input.workspaceId), eq(billingOrders.taskId, existing.id)))
                    .limit(1);
                if (!order) throw new Error("Idempotent AI Task is missing its Billing Order");
                return { taskId: existing.id, status: "queued", estimatedCredits: order.estimatedAmount, replayed: true };
            }

            const billingOrderId = await createBillingOrder(tx, {
                workspaceId: input.workspaceId,
                taskId,
                snapshot: this.priceSnapshot,
            });
            await reserveCredits(tx, {
                workspaceId: input.workspaceId,
                billingOrderId,
                amount: this.priceSnapshot.estimatedAmount,
                operationKey: `ai-task:${taskId}:reserve`,
                requestHash,
            });
            await tx.insert(providerAttempts).values({
                workspaceId: input.workspaceId,
                taskId,
                sequence: 1,
                adapterId: this.provider.adapterId,
                adapterVersion: this.provider.adapterVersion,
                exactModelId: this.provider.exactModelId,
                providerIdempotencyKey: `ai-task:${taskId}:attempt:1`,
            });
            await tx.insert(taskEvents).values({
                workspaceId: input.workspaceId,
                taskId,
                sequence: 1n,
                type: "queued",
                payload: {},
            });
            await this.queue.enqueue(tx, { protocolVersion: 1, taskId, workspaceId: input.workspaceId });
            return { taskId, status: "queued", estimatedCredits: this.priceSnapshot.estimatedAmount, replayed: false };
        });
    }

    async getTask(input: { userId: string; workspaceId: string; taskId: string }) {
        return withTenantTransaction(this.db, input, async (tx) => {
            const result = await tx.execute<{
                id: string;
                workspace_id: string;
                status: "queued" | "submitting" | "processing" | "storing" | "succeeded" | "failed" | "reconciling";
                result_asset_id: string | null;
                public_error_code: string | null;
                latest_sequence: string;
                estimated_amount: string;
                actual_amount: string | null;
            }>(sql`
                select task.id, task.workspace_id, task.status, task.result_asset_id, task.public_error_code,
                       COALESCE(max(event.sequence), 0) as latest_sequence,
                       orders.estimated_amount, orders.actual_amount
                from public.ai_tasks task
                join public.billing_orders orders on orders.workspace_id = task.workspace_id and orders.task_id = task.id
                left join public.task_events event on event.workspace_id = task.workspace_id and event.task_id = task.id
                where task.workspace_id = ${input.workspaceId} and task.id = ${input.taskId}::uuid
                group by task.id, orders.estimated_amount, orders.actual_amount
            `);
            const row = result.rows[0];
            if (!row) throw new AppError("ai_task_not_found", 404, "AI 任务不存在");
            return row;
        });
    }

    async listEventsAfter(input: {
        userId: string;
        workspaceId: string;
        taskId: string;
        sequence: bigint;
    }): Promise<TaskEventRecord[]> {
        return withTenantTransaction(this.db, input, async (tx) => {
            const rows = await tx.execute<TaskEventRow>(sql`
                select sequence, type, payload, created_at from public.task_events
                where workspace_id = ${input.workspaceId} and task_id = ${input.taskId}::uuid
                  and sequence > ${input.sequence}
                order by sequence
            `);
            return rows.rows.map((row) => ({ ...row, created_at: normalizeEventCreatedAt(row.created_at) }));
        });
    }
}
