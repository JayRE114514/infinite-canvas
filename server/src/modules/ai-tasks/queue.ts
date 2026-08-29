import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";

import { AI_TASK_QUEUE } from "../../infrastructure/jobs/pg-boss.js";
import type { AppTransaction } from "../../infrastructure/database/types.js";

export type AiTaskJobPayload = { protocolVersion: 1; taskId: string; workspaceId: string };

export interface AiTaskQueue {
    enqueue(tx: AppTransaction, payload: AiTaskJobPayload): Promise<string>;
}

export class PgBossAiTaskQueue implements AiTaskQueue {
    constructor(private readonly boss: PgBoss) {}

    async enqueue(tx: AppTransaction, payload: AiTaskJobPayload): Promise<string> {
        const jobId = await this.boss.send(AI_TASK_QUEUE, payload, {
            db: fromDrizzle(tx, sql),
        });
        if (!jobId) throw new Error("pg-boss did not create an AI Task Job");
        return jobId;
    }
}
