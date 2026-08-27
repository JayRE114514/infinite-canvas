import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type BuildAppOptions } from "../../src/app.js";
import type { DatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/infrastructure/database/client.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

const UNREACHABLE_URL = "postgres://app_api:test@127.0.0.1:1/test";
/** 留出高于连接池 5 秒连接超时的余量，避免不可达用例先被测试框架判超时。 */
const UNREACHABLE_TIMEOUT_MS = 20_000;

let postgres: StartedRoleDatabase | undefined;
const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
const openHandles: DatabaseHandle[] = [];

/** 先登记再返回，保证断言失败时 afterEach 仍能释放连接池。 */
function openDatabase(config: DatabaseConfig): DatabaseHandle {
    const handle = createDatabase(config);
    openHandles.push(handle);
    return handle;
}

async function openApp(options: BuildAppOptions) {
    const app = await buildApp(options);
    openApps.push(app);
    return app;
}

function roles(): StartedRoleDatabase {
    if (!postgres) throw new Error("PostgreSQL container is not started");
    return postgres;
}

/** 运行期进程使用的真实 app_api 凭据。 */
function apiConfig(poolMax: number): DatabaseConfig {
    return { url: roles().api, poolMax, expectedRole: "app_api" };
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
}, 180_000);

/** 断言成功或失败都要释放 app 与连接池，残留句柄会让整个套件挂起。 */
afterEach(async () => {
    for (const app of openApps.splice(0)) await app.close().catch(() => {});
    for (const handle of openHandles.splice(0)) {
        if (handle.pool.ending || handle.pool.ended) continue;
        await handle.pool.end().catch(() => {});
    }
}, 30_000);

afterAll(async () => {
    await postgres?.stop();
    postgres = undefined;
}, 60_000);

describe("createDatabase", () => {
    it("executes a readiness query against PostgreSQL", async () => {
        const { pool } = openDatabase(apiConfig(2));

        await expect(pool.query("select 1 as ready")).resolves.toMatchObject({ rows: [{ ready: 1 }] });
    });

    it("applies the configured pool bounds", () => {
        const { pool } = openDatabase(apiConfig(3));

        expect(pool.options.max).toBe(3);
        expect(pool.options.connectionTimeoutMillis).toBe(5_000);
        expect(pool.options.idleTimeoutMillis).toBe(30_000);
    });

    it("carries the expected login role into the handle", () => {
        const handle = openDatabase(apiConfig(1));

        expect((handle as DatabaseHandle & { role?: string }).role).toBe("app_api");
    });

    it("shares one pool between Drizzle and the raw client", async () => {
        const { db, pool } = openDatabase(apiConfig(1));

        expect(pool.totalCount).toBe(0);

        await db.execute("select 1");

        expect(pool.totalCount).toBe(1);

        await pool.query("select 1");

        expect(pool.totalCount).toBe(1);
    });
});

describe("GET /api/v1/health/ready", () => {
    it("reports ready while PostgreSQL answers", async () => {
        const database = openDatabase(apiConfig(2));
        const app = await openApp({ logger: false, database });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "ok" });
    });

    it("returns 503 for a superuser connection marked as app_api", async () => {
        const database = openDatabase({ url: roles().admin, poolMax: 1, expectedRole: "app_api" });
        const app = await openApp({ logger: false, database });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ status: "unavailable" });
    });

    it("leaves an injected pool usable after the app closes", async () => {
        const database = openDatabase(apiConfig(2));
        const app = await openApp({ logger: false, database });

        await app.close();

        await expect(database.pool.query("select 1")).resolves.toBeTruthy();
    });

    it("returns a stable 503 once PostgreSQL is unavailable", async () => {
        const database = openDatabase(apiConfig(2));
        const app = await openApp({ logger: false, database });

        await database.pool.end();

        const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ status: "unavailable" });
    });

    it(
        "returns 503 instead of throwing when the database is unreachable",
        async () => {
            const database = openDatabase({ url: UNREACHABLE_URL, poolMax: 1, expectedRole: "app_api" });
            const app = await openApp({ logger: false, database });

            const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ status: "unavailable" });
        },
        UNREACHABLE_TIMEOUT_MS,
    );

    it("decorates the shared db and pool", async () => {
        const database = openDatabase(apiConfig(2));
        const app = await openApp({ logger: false, database });

        expect(app.pgPool).toBe(database.pool);
        expect(app.db).toBe(database.db);
    });
});
