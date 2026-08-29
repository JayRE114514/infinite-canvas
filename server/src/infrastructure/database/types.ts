import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import type { DatabaseLoginRole } from "../../config.js";
import type * as schema from "./schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;

/** 事务回调拿到的句柄类型，业务服务只接受它，不接受 AppDatabase。 */
export type AppTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

/** 句柄携带自己的登录角色，就绪检查据此校验真实身份。 */
export type DatabaseHandle = { db: AppDatabase; pool: Pool; role: DatabaseLoginRole };
