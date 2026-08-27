import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { DatabaseConfig } from "../../config.js";
import * as schema from "./schema.js";
import type { DatabaseHandle } from "./types.js";

const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;

/** 创建唯一的 PostgreSQL 连接池，Drizzle 复用同一个 Pool，不额外开第二个池。 */
export function createDatabase(config: DatabaseConfig): DatabaseHandle {
    const pool = new Pool({
        connectionString: config.url,
        max: config.poolMax,
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
        idleTimeoutMillis: IDLE_TIMEOUT_MS,
    });

    return { db: drizzle(pool, { schema }), pool, role: config.expectedRole };
}
