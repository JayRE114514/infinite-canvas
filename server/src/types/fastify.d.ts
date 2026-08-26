import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../infrastructure/database/types.js";
import type { Pool } from "pg";

declare module "fastify" {
    interface FastifyInstance {
        /** buildApp 按传入选项条件注册，纯应用构造下不存在；读取前用 requireAppConfig 收窄。 */
        appConfig?: AppConfig;
        /** 仅在注入 database 或传入 config 时存在；读取前用 requireDatabase 收窄。 */
        db?: AppDatabase;
        pgPool?: Pool;
    }
}
