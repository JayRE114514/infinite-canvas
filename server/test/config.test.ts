import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const baseEnv: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost/test",
    BETTER_AUTH_SECRET: "x".repeat(32),
    APP_ORIGIN: "http://localhost:3000",
    SMTP_HOST: "localhost",
    SMTP_FROM: "no-reply@example.com",
};

describe("loadConfig", () => {
    it("rejects a missing database URL", () => {
        const { DATABASE_URL: _omitted, ...env } = baseEnv;

        expect(() => loadConfig(env)).toThrow("DATABASE_URL");
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
            database: { url: "postgres://test:test@localhost/test", poolMax: 10 },
            smtp: { host: "localhost", port: 587, user: "", password: "", from: "no-reply@example.com" },
        });
    });

    it.each(["DATABASE_URL", "APP_ORIGIN", "BETTER_AUTH_SECRET", "SMTP_HOST", "SMTP_FROM"])("rejects a missing %s", (name) => {
        expect(() => loadConfig({ ...baseEnv, [name]: undefined })).toThrow(name);
    });

    it.each(["DATABASE_URL", "APP_ORIGIN", "SMTP_HOST", "SMTP_FROM"])("treats a whitespace-only %s as missing", (name) => {
        expect(() => loadConfig({ ...baseEnv, [name]: "   " })).toThrow(name);
    });

    it("trims surrounding whitespace from required values", () => {
        const config = loadConfig({ ...baseEnv, DATABASE_URL: "  postgres://test:test@localhost/test  " });

        expect(config.database.url).toBe("postgres://test:test@localhost/test");
    });

    describe("NODE_ENV", () => {
        it("defaults to development when unset", () => {
            const { NODE_ENV: _omitted, ...env } = baseEnv;

            expect(loadConfig(env).nodeEnv).toBe("development");
        });

        it.each(["development", "test", "production"] as const)("accepts %s", (nodeEnv) => {
            expect(loadConfig({ ...baseEnv, NODE_ENV: nodeEnv }).nodeEnv).toBe(nodeEnv);
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

    it("keeps optional SMTP credentials as provided", () => {
        const config = loadConfig({ ...baseEnv, SMTP_USER: "mailer", SMTP_PASSWORD: "secret" });

        expect(config.smtp).toMatchObject({ user: "mailer", password: "secret" });
    });
});
