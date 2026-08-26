import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createDatabase } from "../../src/infrastructure/database/client.js";
import { startPostgres, type StartedPostgres } from "../helpers/postgres.js";

describe("createDatabase", () => {
    let postgres: StartedPostgres;

    beforeAll(async () => {
        postgres = await startPostgres();
    }, 180_000);

    afterAll(async () => {
        await postgres?.stop();
    }, 60_000);

    it("executes a readiness query against PostgreSQL", async () => {
        const { pool } = createDatabase({ url: postgres.url, poolMax: 2 });

        await expect(pool.query("select 1 as ready")).resolves.toMatchObject({ rows: [{ ready: 1 }] });

        await pool.end();
    });

    it("applies the configured pool bounds", () => {
        const { pool } = createDatabase({ url: postgres.url, poolMax: 3 });

        expect(pool.options.max).toBe(3);
        expect(pool.options.connectionTimeoutMillis).toBe(5_000);
        expect(pool.options.idleTimeoutMillis).toBe(30_000);

        return pool.end();
    });

    it("shares one pool between Drizzle and the raw client", async () => {
        const { db, pool } = createDatabase({ url: postgres.url, poolMax: 1 });

        expect(pool.totalCount).toBe(0);

        await db.execute("select 1");

        expect(pool.totalCount).toBe(1);

        await pool.query("select 1");

        expect(pool.totalCount).toBe(1);

        await pool.end();
    });
});

describe("GET /api/v1/health/ready", () => {
    let postgres: StartedPostgres;
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;

    beforeAll(async () => {
        postgres = await startPostgres();
    }, 180_000);

    afterAll(async () => {
        await postgres?.stop();
    }, 60_000);

    it("reports ready while PostgreSQL answers", async () => {
        const database = createDatabase({ url: postgres.url, poolMax: 2 });
        app = await buildApp({ logger: false, database });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "ok" });

        await app.close();
        app = undefined;
        await expect(database.pool.query("select 1")).resolves.toBeTruthy();
        await database.pool.end();
    });

    it("returns a stable 503 once PostgreSQL is unavailable", async () => {
        const database = createDatabase({ url: postgres.url, poolMax: 2 });
        app = await buildApp({ logger: false, database });

        await database.pool.end();

        const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ status: "unavailable" });

        await app.close();
        app = undefined;
    });

    it("returns 503 instead of throwing when the database is unreachable", async () => {
        const database = createDatabase({ url: "postgres://test:test@127.0.0.1:1/test", poolMax: 1 });
        app = await buildApp({ logger: false, database });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ status: "unavailable" });

        await app.close();
        app = undefined;
        await database.pool.end();
    });

    it("decorates the shared config, db and pool", async () => {
        const database = createDatabase({ url: postgres.url, poolMax: 2 });
        app = await buildApp({ logger: false, database });

        expect(app.pgPool).toBe(database.pool);
        expect(app.db).toBe(database.db);

        await app.close();
        app = undefined;
        await database.pool.end();
    });
});
