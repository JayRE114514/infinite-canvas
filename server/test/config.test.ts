import { describe, expect, it } from "vitest";

import { loadConfig, loadWorkerAiConfig } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL_API: "postgres://app_api:test@localhost/test",
    BETTER_AUTH_SECRET: "x".repeat(32),
    APP_ORIGIN: "http://localhost:3000",
    SMTP_HOST: "localhost",
    SMTP_FROM: "no-reply@example.com",
};

const platformImageEnv: NodeJS.ProcessEnv = {
    PLATFORM_IMAGE_ENABLED: "true",
    PLATFORM_IMAGE_CAPABILITY_ID: "image.generate",
    PLATFORM_IMAGE_ROUTE_ID: "owner-openai-images",
    PLATFORM_IMAGE_ADAPTER_ID: "owner-openai-images",
    PLATFORM_IMAGE_ADAPTER_VERSION: "test-v1",
    PLATFORM_IMAGE_EXACT_MODEL_ID: "owner-image-model",
    PLATFORM_IMAGE_PRICE_VERSION: "test-price-v1",
    PLATFORM_IMAGE_ESTIMATED_CREDITS: "25",
    PLATFORM_IMAGE_FIXED_CREDITS: "25",
    PLATFORM_IMAGE_PROVIDER_BASE_URL: "https://provider.example/v1",
    PLATFORM_IMAGE_PROVIDER_API_KEY: "test-provider-key",
    S3_ENDPOINT: "https://objects.example",
    S3_REGION: "test-region",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_REQUEST_TIMEOUT_MS: "1000",
    S3_MAX_ATTEMPTS: "1",
};

describe("loadConfig", () => {
    it("rejects a missing database URL", () => {
        const { DATABASE_URL_API: _omitted, ...env } = baseEnv;

        expect(() => loadConfig(env)).toThrow("DATABASE_URL_API");
    });

    it("parses bounded pool and server settings", () => {
        const config = loadConfig({ ...baseEnv, PORT: "4100", DB_POOL_MAX: "8", SMTP_PORT: "1025" });

        expect(config.port).toBe(4100);
        expect(config.database.poolMax).toBe(8);
        expect(config.smtp.port).toBe(1025);
    });

    it("applies documented defaults when optional variables are unset", () => {
        expect(loadConfig(baseEnv)).toEqual({
            nodeEnv: "test",
            port: 4000,
            appOrigin: "http://localhost:3000",
            betterAuthSecret: "x".repeat(32),
            database: { url: "postgres://app_api:test@localhost/test", poolMax: 10, expectedRole: "app_api" },
            smtp: { host: "localhost", port: 587, user: "", password: "", from: "no-reply@example.com" },
        });
    });

    it.each(["DATABASE_URL_API", "APP_ORIGIN", "BETTER_AUTH_SECRET", "SMTP_HOST", "SMTP_FROM"])("rejects a missing %s", (name) => {
        expect(() => loadConfig({ ...baseEnv, [name]: undefined })).toThrow(name);
    });

    it.each(["DATABASE_URL_API", "APP_ORIGIN", "SMTP_HOST", "SMTP_FROM"])("treats a whitespace-only %s as missing", (name) => {
        expect(() => loadConfig({ ...baseEnv, [name]: "   " })).toThrow(name);
    });

    it("trims surrounding whitespace from required values", () => {
        const config = loadConfig({ ...baseEnv, DATABASE_URL_API: "  postgres://app_api:test@localhost/test  " });

        expect(config.database.url).toBe("postgres://app_api:test@localhost/test");
    });

    describe("NODE_ENV", () => {
        it("defaults to development when unset", () => {
            const { NODE_ENV: _omitted, ...env } = baseEnv;

            expect(loadConfig(env).nodeEnv).toBe("development");
        });

        it.each(["development", "test"] as const)("accepts %s", (nodeEnv) => {
            expect(loadConfig({ ...baseEnv, NODE_ENV: nodeEnv }).nodeEnv).toBe(nodeEnv);
        });

        // production 必须配 HTTPS origin，否则 loadConfig 会按设计直接拒绝。
        it("accepts production with an HTTPS origin", () => {
            const config = loadConfig({ ...baseEnv, NODE_ENV: "production", APP_ORIGIN: "https://canvas.example.com" });

            expect(config.nodeEnv).toBe("production");
        });

        it.each(["staging", "Development", "production ", "prod", ""])("rejects the unsupported value %j", (nodeEnv) => {
            expect(() => loadConfig({ ...baseEnv, NODE_ENV: nodeEnv })).toThrow("NODE_ENV");
        });
    });

    describe("numeric ranges", () => {
        it.each([
            ["PORT", "0"],
            ["PORT", "65536"],
            ["PORT", "-1"],
            ["PORT", "4100.5"],
            ["PORT", "abc"],
            ["PORT", "4100abc"],
            ["PORT", ""],
            ["DB_POOL_MAX", "0"],
            ["DB_POOL_MAX", "51"],
            ["DB_POOL_MAX", "2.5"],
            ["DB_POOL_MAX", "many"],
            ["SMTP_PORT", "0"],
            ["SMTP_PORT", "65536"],
            ["SMTP_PORT", "587.5"],
            ["SMTP_PORT", "smtp"],
        ])("rejects %s=%j", (name, value) => {
            expect(() => loadConfig({ ...baseEnv, [name]: value })).toThrow(name);
        });

        it.each([
            ["PORT", "1", 1],
            ["PORT", "65535", 65535],
            ["DB_POOL_MAX", "1", 1],
            ["DB_POOL_MAX", "50", 50],
        ])("accepts the %s boundary %s", (name, value, expected) => {
            const config = loadConfig({ ...baseEnv, [name]: value });

            expect(name === "PORT" ? config.port : config.database.poolMax).toBe(expected);
        });
    });

    it("rejects a signing secret shorter than 32 characters", () => {
        expect(() => loadConfig({ ...baseEnv, BETTER_AUTH_SECRET: "x".repeat(31) })).toThrow("BETTER_AUTH_SECRET");
    });

    it.each(["localhost:3000", "ftp://localhost:3000", "not a url"])("rejects the non-http APP_ORIGIN %j", (appOrigin) => {
        expect(() => loadConfig({ ...baseEnv, APP_ORIGIN: appOrigin })).toThrow("APP_ORIGIN");
    });

    it("normalizes APP_ORIGIN to its URL origin", () => {
        const config = loadConfig({ ...baseEnv, APP_ORIGIN: "https://canvas.example.com/path?source=test#fragment" });

        expect(config.appOrigin).toBe("https://canvas.example.com");
    });

    it("requires HTTPS APP_ORIGIN in production", () => {
        expect(() => loadConfig({ ...baseEnv, NODE_ENV: "production", APP_ORIGIN: "http://canvas.example.com" })).toThrow(
            "APP_ORIGIN must use HTTPS in production",
        );
    });

    it("keeps optional SMTP credentials as provided", () => {
        const config = loadConfig({ ...baseEnv, SMTP_USER: "mailer", SMTP_PASSWORD: "secret" });

        expect(config.smtp).toMatchObject({ user: "mailer", password: "secret" });
    });

    it("requires explicit shared S3 behavior before enabling API Asset content", () => {
        const config = loadConfig({ ...baseEnv, ...platformImageEnv });
        expect(config.platformImage?.s3).toMatchObject({ requestTimeoutMs: 1000, maxAttempts: 1 });
        expect(loadConfig({
            ...baseEnv,
            ...platformImageEnv,
            PLATFORM_IMAGE_PROVIDER_BASE_URL: undefined,
            PLATFORM_IMAGE_PROVIDER_API_KEY: undefined,
        }).platformImage).toBeDefined();
        expect(() => loadConfig({ ...baseEnv, ...platformImageEnv, S3_REQUEST_TIMEOUT_MS: undefined })).toThrow(
            "S3_REQUEST_TIMEOUT_MS",
        );
    });

    it("validates Worker-only values separately without leaking configured secrets", () => {
        const workerEnv = {
            ...platformImageEnv,
            AI_WORKER_LEASE_DURATION_MS: "5000",
            AI_WORKER_HEARTBEAT_INTERVAL_MS: "1000",
            AI_PROVIDER_HTTP_TIMEOUT_MS: "2000",
            AI_PROVIDER_SAFE_RETRY_BUDGET: "0",
            PG_BOSS_QUEUE_CONCURRENCY: "1",
            PG_BOSS_JOB_RETRY_COUNT: "0",
        };
        expect(loadWorkerAiConfig(workerEnv)).toMatchObject({
            leaseDurationMs: 5000,
            heartbeatIntervalMs: 1000,
            safeRetryBudget: 0,
            queueConcurrency: 1,
            jobRetryCount: 0,
        });
        expect(() => loadWorkerAiConfig({ ...workerEnv, AI_WORKER_HEARTBEAT_INTERVAL_MS: "5000" })).toThrow(
            "AI_WORKER_HEARTBEAT_INTERVAL_MS",
        );
        try {
            loadWorkerAiConfig({ ...workerEnv, S3_MAX_ATTEMPTS: undefined });
        } catch (error) {
            expect(String(error)).toBe("Error: Missing required environment variable: S3_MAX_ATTEMPTS");
            expect(String(error)).not.toContain("test-provider-key");
            expect(String(error)).not.toContain("objects.example");
        }
    });
});
