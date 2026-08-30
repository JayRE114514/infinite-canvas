import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./infrastructure/database/client.js";
import { createRuntimeBoss } from "./infrastructure/jobs/pg-boss.js";
import { AssetModule } from "./modules/assets/service.js";
import { S3ObjectStoreAdapter } from "./modules/assets/object-store.js";
import { createFixedImagePriceSnapshot } from "./modules/billing/service.js";
import { PgBossAiTaskQueue } from "./modules/ai-tasks/queue.js";
import { AiTaskModule } from "./modules/ai-tasks/service.js";
import { TaskEventNotifier } from "./modules/ai-tasks/events.js";

const config = loadConfig(process.env);
const database = createDatabase(config.database);
let boss: ReturnType<typeof createRuntimeBoss> | undefined;
let taskEventNotifier: TaskEventNotifier | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
    let assetModule: AssetModule | undefined;
    let aiTaskModule: AiTaskModule | undefined;
    if (config.platformImage) {
        const image = config.platformImage;
        assetModule = new AssetModule(database.db, new S3ObjectStoreAdapter({ ...image.s3 }));
        boss = createRuntimeBoss(config.database.url);
        await boss.start();
        const descriptor = {
            adapterId: image.adapterId,
            adapterVersion: image.adapterVersion,
            capabilityId: image.capabilityId,
            exactModelId: image.exactModelId,
            supportsPolling: false,
            supportsCancellation: false,
        } as const;
        const price = createFixedImagePriceSnapshot({
            capabilityId: image.capabilityId,
            routeId: image.routeId,
            exactModelId: image.exactModelId,
            priceVersion: image.priceVersion,
            estimatedAmount: image.estimatedAmount,
            fixedAmount: image.fixedAmount,
        });
        aiTaskModule = new AiTaskModule(database.db, new PgBossAiTaskQueue(boss), descriptor, price);
        taskEventNotifier = new TaskEventNotifier(config.database.url);
        await taskEventNotifier.start();
    }
    app = await buildApp({ config, database, assetModule, aiTaskModule, taskEventNotifier });
    app.addHook("onClose", async () => {
        await taskEventNotifier?.close().catch(() => {});
        await boss?.stop().catch(() => {});
        await database.pool.end().catch(() => {});
    });
} catch (error) {
    await taskEventNotifier?.close().catch(() => {});
    await boss?.stop().catch(() => {});
    await database.pool.end().catch(() => {});
    throw error;
}

// 监听失败也要走 close，否则 buildApp 自建的连接池不会被释放。
try {
    await app.listen({ port: config.port, host: process.env.HOST ?? "127.0.0.1" });
} catch (error) {
    await app.close().catch(() => {});
    throw error;
}
