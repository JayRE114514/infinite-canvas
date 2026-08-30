import { resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import { loadPgBossBootstrapConfig } from "../src/config.js";
import { AI_TASK_QUEUE, initializePgBossSchema } from "../src/infrastructure/jobs/pg-boss.js";

export async function bootstrapPgBoss(
    env: NodeJS.ProcessEnv,
    initialize: typeof initializePgBossSchema = initializePgBossSchema,
): Promise<void> {
    const config = loadPgBossBootstrapConfig(env);
    await initialize({ ...config, queueName: AI_TASK_QUEUE });
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
    await bootstrapPgBoss(process.env);
    process.stdout.write(`pg-boss schema and queue ${AI_TASK_QUEUE} initialized\n`);
}
