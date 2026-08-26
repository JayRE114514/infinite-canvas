import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../infrastructure/database/types.js";
import type { Pool } from "pg";

declare module "fastify" {
    interface FastifyInstance {
        appConfig: AppConfig;
        db: AppDatabase;
        pgPool: Pool;
    }
}
