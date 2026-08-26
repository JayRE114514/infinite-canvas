import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import type * as schema from "./schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;

export type DatabaseHandle = { db: AppDatabase; pool: Pool };
