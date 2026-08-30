import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { AI_TASK_QUEUE, createRuntimeBoss } from "../../src/infrastructure/jobs/pg-boss.js";
import { bootstrapPgBoss } from "../../scripts/init-pg-boss.js";
import { startRoleDatabase } from "../helpers/postgres.js";

async function pgBossFootprint(adminUrl: string) {
    const pool = new Pool({ connectionString: adminUrl, max: 1 });
    try {
        const result = await pool.query<{ schema_count: number; grant_count: number }>(`
            select
                (select count(*)::int from pg_namespace where nspname = 'pgboss') as schema_count,
                (select count(*)::int from information_schema.table_privileges where table_schema = 'pgboss') as grant_count
        `);
        return result.rows[0]!;
    } finally {
        await pool.end().catch(() => {});
    }
}

describe("pg-boss deployment bootstrap", () => {
    it("initializes idempotently as schema_owner and leaves the queue at the explicit retry limit", async () => {
        const postgres = await startRoleDatabase();
        try {
            await bootstrapPgBoss({
                DATABASE_URL_SCHEMA_OWNER: postgres.schemaOwner,
                PG_BOSS_JOB_RETRY_COUNT: "0",
            });
            await bootstrapPgBoss({
                DATABASE_URL_SCHEMA_OWNER: postgres.schemaOwner,
                PG_BOSS_JOB_RETRY_COUNT: "2",
            });

            const boss = createRuntimeBoss(postgres.schemaOwner);
            await boss.start();
            try {
                expect(await boss.getQueue(AI_TASK_QUEUE)).toMatchObject({ retryLimit: 2 });
            } finally {
                await boss.stop();
            }

            const admin = new Pool({ connectionString: postgres.admin, max: 1 });
            try {
                const privileges = await admin.query(`
                    select
                        has_schema_privilege('app_api', 'pgboss', 'USAGE') as api_schema,
                        has_table_privilege('app_api', 'pgboss.job_common', 'INSERT') as api_insert,
                        has_schema_privilege('app_worker', 'pgboss', 'USAGE') as worker_schema,
                        has_table_privilege('app_worker', 'pgboss.job_common', 'UPDATE') as worker_update
                `);
                expect(privileges.rows[0]).toEqual({
                    api_schema: true,
                    api_insert: true,
                    worker_schema: true,
                    worker_update: true,
                });
            } finally {
                await admin.end().catch(() => {});
            }
        } finally {
            await postgres.stop().catch(() => {});
        }
    }, 180_000);

    it("rejects a non-schema_owner login before creating the schema or changing grants", async () => {
        const postgres = await startRoleDatabase();
        try {
            const before = await pgBossFootprint(postgres.admin);

            await expect(bootstrapPgBoss({
                DATABASE_URL_SCHEMA_OWNER: postgres.api,
                PG_BOSS_JOB_RETRY_COUNT: "0",
            })).rejects.toThrow("Invalid configuration: DATABASE_URL_SCHEMA_OWNER");

            expect(await pgBossFootprint(postgres.admin)).toEqual(before);
            expect(before).toEqual({ schema_count: 0, grant_count: 0 });
        } finally {
            await postgres.stop().catch(() => {});
        }
    }, 180_000);

    it.each([
        ["DATABASE_URL_SCHEMA_OWNER", undefined],
        ["DATABASE_URL_SCHEMA_OWNER", "   "],
        ["PG_BOSS_JOB_RETRY_COUNT", undefined],
        ["PG_BOSS_JOB_RETRY_COUNT", ""],
        ["PG_BOSS_JOB_RETRY_COUNT", "-1"],
        ["PG_BOSS_JOB_RETRY_COUNT", "1.5"],
        ["PG_BOSS_JOB_RETRY_COUNT", "9007199254740992"],
    ])("rejects invalid %s without leaking its value", async (name, value) => {
        const initialize = vi.fn(async () => undefined);
        const secretUrl = "postgres://schema_owner:do-not-leak@internal.example/private";
        const env: NodeJS.ProcessEnv = {
            DATABASE_URL_SCHEMA_OWNER: secretUrl,
            PG_BOSS_JOB_RETRY_COUNT: "0",
            [name]: value,
        };

        let failure: unknown;
        try {
            await bootstrapPgBoss(env, initialize);
        } catch (error) {
            failure = error;
        }

        expect(String(failure)).toContain(name);
        expect(String(failure)).not.toContain(secretUrl);
        if (value?.trim()) expect(String(failure)).not.toContain(value);
        expect(initialize).not.toHaveBeenCalled();
    });
});
