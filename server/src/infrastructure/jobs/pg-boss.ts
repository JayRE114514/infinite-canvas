import { Pool } from "pg";
import { PgBoss } from "pg-boss";

export const AI_TASK_QUEUE = "ai-task-v1";

/** 部署/迁移边界专用；普通 API 请求与 Worker 启动不得调用。 */
export async function initializePgBossSchema(input: {
    schemaOwnerUrl: string;
    queueName: string;
    jobRetryCount: number;
}): Promise<void> {
    if (!Number.isSafeInteger(input.jobRetryCount) || input.jobRetryCount < 0) {
        throw new Error("Invalid configuration: PG_BOSS_JOB_RETRY_COUNT");
    }
    const rolePool = new Pool({ connectionString: input.schemaOwnerUrl, max: 1 });
    try {
        const role = await rolePool.query<{ current_user: string }>("select current_user");
        if (role.rows[0]?.current_user !== "schema_owner") {
            throw new Error("Invalid configuration: DATABASE_URL_SCHEMA_OWNER");
        }
    } finally {
        await rolePool.end().catch(() => {});
    }

    const boss = new PgBoss({
        connectionString: input.schemaOwnerUrl,
        schema: "pgboss",
        createSchema: true,
        migrate: true,
        supervise: false,
        schedule: false,
    });
    await boss.start();
    try {
        const existing = await boss.getQueue(input.queueName);
        if (existing) await boss.updateQueue(input.queueName, { retryLimit: input.jobRetryCount });
        else await boss.createQueue(input.queueName, { retryLimit: input.jobRetryCount });

        const pool = new Pool({ connectionString: input.schemaOwnerUrl, max: 1 });
        try {
            await pool.query("grant usage on schema pgboss to app_api, app_worker");
            await pool.query("grant select on pgboss.version, pgboss.queue to app_api");
            await pool.query("grant select, insert on pgboss.job, pgboss.job_common to app_api");
            await pool.query("grant select, insert, update, delete on all tables in schema pgboss to app_worker");
            await pool.query("grant usage, select on all sequences in schema pgboss to app_worker");
            await pool.query("grant execute on all functions in schema pgboss to app_worker");
        } finally {
            await pool.end().catch(() => {});
        }

        const queue = await boss.getQueue(input.queueName);
        if (!queue || queue.retryLimit !== input.jobRetryCount) {
            throw new Error("Invalid configuration: PG_BOSS_JOB_RETRY_COUNT");
        }
    } finally {
        await boss.stop();
    }
}

export function createRuntimeBoss(connectionString: string): PgBoss {
    return new PgBoss({
        connectionString,
        schema: "pgboss",
        createSchema: false,
        migrate: false,
        supervise: false,
        schedule: false,
    });
}
