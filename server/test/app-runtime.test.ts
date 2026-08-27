import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { requireAppConfig, requireDatabase } from "../src/infrastructure/database/plugin.js";

const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL_API: "postgres://app_api:test@127.0.0.1:1/test",
    BETTER_AUTH_SECRET: "x".repeat(32),
    APP_ORIGIN: "http://localhost:3000",
    SMTP_HOST: "localhost",
    SMTP_FROM: "no-reply@example.com",
});

describe("pure app construction", () => {
    it("stays free of runtime decorations", async () => {
        const app = await buildApp({ logger: false });

        try {
            expect(app.hasDecorator("appConfig")).toBe(false);
            expect(app.hasDecorator("db")).toBe(false);
            expect(app.hasDecorator("pgPool")).toBe(false);
        } finally {
            await app.close();
        }
    });

    it("has no readiness route without a database", async () => {
        const app = await buildApp({ logger: false });

        try {
            const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

            expect(response.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it("rejects narrowing helpers instead of handing back undefined", async () => {
        const app = await buildApp({ logger: false });

        try {
            expect(() => requireDatabase(app)).toThrow("database");
            expect(() => requireAppConfig(app)).toThrow("appConfig");
        } finally {
            await app.close();
        }
    });

    it("keeps Fastify's default one MiB body limit globally", async () => {
        const app = await buildApp({ logger: false });
        app.post("/api/v1/test/body-limit", async (request) => ({ bodyLimit: request.routeOptions.bodyLimit }));

        try {
            const response = await app.inject({ method: "POST", url: "/api/v1/test/body-limit", payload: {} });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ bodyLimit: 1_048_576 });
        } finally {
            await app.close();
        }
    });
});

describe("config-driven app construction", () => {
    it("owns the pool it created and closes it on shutdown", async () => {
        const app = await buildApp({ logger: false, config });
        const { pool } = requireDatabase(app);

        expect(pool.ended).toBe(false);
        expect(requireAppConfig(app)).toBe(config);
        expect(pool.options.max).toBe(config.database.poolMax);

        await app.close();

        expect(pool.ended).toBe(true);
    });

    it("narrows to the same decorations it registered", async () => {
        const app = await buildApp({ logger: false, config });

        try {
            const { db, pool, role } = requireDatabase(app);

            expect(db).toBe(app.db);
            expect(pool).toBe(app.pgPool);
            expect(role).toBe("app_api");
        } finally {
            await app.close();
        }
    });
});
