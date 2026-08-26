import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("health routes", () => {
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;

    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    it("returns a stable liveness response", async () => {
        app = await buildApp({ logger: false });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/live" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "ok" });
    });

    it("does not open a network listener when injecting", async () => {
        app = await buildApp({ logger: false });

        await app.inject({ method: "GET", url: "/api/v1/health/live" });

        expect(app.server.listening).toBe(false);
    });
});

describe("cors policy", () => {
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(async () => {
        await app?.close();
        app = undefined;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
    });

    it("allows the Vite dev origin in development", async () => {
        process.env.NODE_ENV = "development";
        app = await buildApp({ logger: false });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/live", headers: { origin: "http://localhost:3000" } });

        expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    });

    it("rejects an unknown origin in development", async () => {
        process.env.NODE_ENV = "development";
        app = await buildApp({ logger: false });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/live", headers: { origin: "https://evil.example" } });

        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("disables cross-origin access in production", async () => {
        process.env.NODE_ENV = "production";
        app = await buildApp({ logger: false });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/live", headers: { origin: "http://localhost:3000" } });

        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it.each(["test", "staging", "Development", "production "])(
        "disables cross-origin access when NODE_ENV is %s",
        async (nodeEnv) => {
            process.env.NODE_ENV = nodeEnv;
            app = await buildApp({ logger: false });

            const response = await app.inject({ method: "GET", url: "/api/v1/health/live", headers: { origin: "http://localhost:3000" } });

            expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        },
    );

    it("disables cross-origin access when NODE_ENV is unset", async () => {
        delete process.env.NODE_ENV;
        app = await buildApp({ logger: false });

        const response = await app.inject({ method: "GET", url: "/api/v1/health/live", headers: { origin: "http://localhost:3000" } });

        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });
});
