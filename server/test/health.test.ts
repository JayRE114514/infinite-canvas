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
