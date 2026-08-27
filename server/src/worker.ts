// Worker 进程入口：只建立 app_worker 连接池并校验真实身份，队列消费在后续 Gate 接入。
import { loadDatabaseConfig } from "./config.js";
import { createDatabase } from "./infrastructure/database/client.js";
import { assertDatabaseRole } from "./infrastructure/database/role-assertions.js";

const database = createDatabase(loadDatabaseConfig(process.env, "DATABASE_URL_WORKER", "app_worker"));

// 身份不符立即退出，绝不带着错误凭据继续运行。
try {
    await assertDatabaseRole(database.pool, database.role);
} catch (error) {
    await database.pool.end().catch(() => {});
    throw error;
}

process.stdout.write("worker process started\n");
