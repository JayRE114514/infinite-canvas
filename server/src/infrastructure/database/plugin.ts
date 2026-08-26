import type { FastifyInstance } from "fastify";

import type { DatabaseHandle } from "./types.js";

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
