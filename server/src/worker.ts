import { loadDatabaseConfig, loadWorkerAiConfig } from "./config.js";
import { createDatabase } from "./infrastructure/database/client.js";
import { assertDatabaseRole } from "./infrastructure/database/role-assertions.js";
import { AI_TASK_QUEUE, createRuntimeBoss } from "./infrastructure/jobs/pg-boss.js";
import { S3ObjectStoreAdapter } from "./modules/assets/object-store.js";
import { AssetModule } from "./modules/assets/service.js";
import { createOwnerProviderAdapter } from "./modules/providers/registry.js";
import { AiTaskWorker } from "./modules/ai-tasks/worker.js";
import type { AiTaskJobPayload } from "./modules/ai-tasks/queue.js";

const imageConfig = loadWorkerAiConfig(process.env);
const workerDatabaseConfig = loadDatabaseConfig(process.env, "DATABASE_URL_WORKER", "app_worker");
const database = createDatabase(workerDatabaseConfig);

// 身份不符立即退出，绝不带着错误凭据继续运行。
try {
    await assertDatabaseRole(database.pool, database.role);
} catch (error) {
    await database.pool.end().catch(() => {});
    throw error;
}

if (!imageConfig) {
    process.stdout.write("worker process started without platform image capability\n");
} else {
    const objectStore = new S3ObjectStoreAdapter({ ...imageConfig.s3 });
    const assets = new AssetModule(database.db, objectStore);
    const adapter = createOwnerProviderAdapter({
        baseUrl: imageConfig.providerBaseUrl,
        apiKey: imageConfig.providerApiKey,
        adapterId: imageConfig.adapterId,
        adapterVersion: imageConfig.adapterVersion,
        capabilityId: imageConfig.capabilityId,
        exactModelId: imageConfig.exactModelId,
        fetch,
    });
    const taskWorker = new AiTaskWorker(
        database.db,
        assets,
        adapter,
        {
            workerId: `worker-${process.pid}`,
            leaseDurationMs: imageConfig.leaseDurationMs,
            heartbeatIntervalMs: imageConfig.heartbeatIntervalMs,
            providerTimeoutMs: imageConfig.providerTimeoutMs,
            safeRetryBudget: imageConfig.safeRetryBudget,
        },
    );
    const boss = createRuntimeBoss(workerDatabaseConfig.url);
    await boss.start();
    const queue = await boss.getQueue(AI_TASK_QUEUE);
    if (!queue || queue.retryLimit !== imageConfig.jobRetryCount) {
        await boss.stop().catch(() => {});
        await database.pool.end().catch(() => {});
        throw new Error("Invalid configuration: PG_BOSS_JOB_RETRY_COUNT");
    }
    await boss.work<AiTaskJobPayload>(
        AI_TASK_QUEUE,
        { localConcurrency: imageConfig.queueConcurrency },
        async ([job]) => {
            if (job) await taskWorker.handle(job.data);
        },
    );
    const shutdown = async () => {
        await boss.stop().catch(() => {});
        await database.pool.end().catch(() => {});
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    process.stdout.write("platform image worker started\n");
}
