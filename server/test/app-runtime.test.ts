import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { requireAppConfig, requireDatabase } from "../src/infrastructure/database/plugin.js";

const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL_API: "postgres://app_api:test@127.0.0.1:1/test",
    BETTER_AUTH_SECRET: "x".repeat(32),
    APP_ORIGIN: "http://localhost:3000",
    SMTP_HOST: "localhost",
    SMTP_FROM: "no-reply@example.com",
};
const config = loadConfig(baseEnv);

const integrationEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    COS_SECRET_ID: "test-cos-secret-id",
    COS_SECRET_KEY: "test-cos-secret-key",
    COS_BUCKET: "test-assets-1250000000",
    COS_REGION: "ap-guangzhou",
    COS_SIGNED_URL_TTL_SECONDS: "300",
    ARTBOX_BASE_URL: "https://artbox.test",
    ARTBOX_API_KEY: "test-artbox-key",
    ARTBOX_VIDEO_MODELS: "Artdance 2 Mini-480p",
    ARTBOX_REQUEST_TIMEOUT_MS: "2500",
    ARTBOX_RESULT_MAX_BYTES: "50000000",
    ARTBOX_RESULT_ALLOWED_HOSTS: "results.artbox.test",
    ARTBOX_POLL_LEASE_SECONDS: "20",
};

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

    it("registers the configured Asset and ArtBox routes", async () => {
        const app = await buildApp({ logger: false, config: loadConfig(integrationEnv) });

        try {
            const routes = [
                ["POST", "/api/v1/workspaces/:workspaceId/assets"],
                ["POST", "/api/v1/workspaces/:workspaceId/assets/:assetId/complete"],
                ["GET", "/api/v1/workspaces/:workspaceId/assets/:assetId"],
                ["POST", "/api/v1/workspaces/:workspaceId/integrations/artbox/video-generations"],
                ["POST", "/api/v1/workspaces/:workspaceId/integrations/artbox/video-generations/:generationId/poll"],
            ] as const;
            expect(routes.map(([method, url]) => app.hasRoute({ method, url }))).toEqual([true, true, true, true, true]);
        } finally {
            await app.close();
        }
    });

    it("keeps unrelated routes healthy when optional integrations are omitted", async () => {
        const app = await buildApp({ logger: false, config });

        try {
            const response = await app.inject({ method: "GET", url: "/api/v1/health/live" });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "ok" });
        } finally {
            await app.close();
        }
    });

    it.each([
        ["COS", { COS_SECRET_KEY: "must-not-leak-cos-secret" }],
        ["ARTBOX", { ARTBOX_API_KEY: "must-not-leak-artbox-secret" }],
    ])("rejects a partial %s block before app construction without leaking its secret", (_name, partial) => {
        const env = { ...baseEnv, ...partial };
        let thrown: unknown;

        try {
            loadConfig(env);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect(String(thrown)).not.toContain(Object.values(partial)[0]);
    });
});
