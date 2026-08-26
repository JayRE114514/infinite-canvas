import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { AppConfig } from "../../config.js";
import type { AppDatabase, DatabaseHandle } from "./types.js";

export type DatabasePluginOptions = { database: DatabaseHandle; ownsPool: boolean };

/** 挂载共享的 db / pgPool 装饰器；只有自己创建的连接池才在关闭时释放。 */
export function registerDatabase(app: FastifyInstance, { database, ownsPool }: DatabasePluginOptions): void {
    app.decorate("db", database.db);
    app.decorate("pgPool", database.pool);

    if (!ownsPool) return;

    app.addHook("onClose", async () => {
        await database.pool.end();
    });
}

/** 执行一次最小连通性查询，失败时不抛错，交由调用方决定响应。 */
export async function checkDatabaseReady(database: DatabaseHandle): Promise<boolean> {
    try {
        await database.pool.query("select 1");
        return true;
    } catch {
        return false;
    }
}

/** 结构化入参，兼容 withTypeProvider 之后的实例类型。 */
type RuntimeDecorations = { appConfig?: AppConfig; db?: AppDatabase; pgPool?: Pool };

/** 把可选装饰器收窄成必选，缺失时立即报错，避免调用方拿到 undefined。 */
export function requireDatabase(app: RuntimeDecorations): DatabaseHandle {
    const { db, pgPool } = app;
    if (!db || !pgPool) throw new Error("This app was built without a database; pass config or database to buildApp");
    return { db, pool: pgPool };
}

export function requireAppConfig(app: RuntimeDecorations): AppConfig {
    const { appConfig } = app;
    if (!appConfig) throw new Error("This app was built without appConfig; pass config to buildApp");
    return appConfig;
}
