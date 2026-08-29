import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { AppError } from "../src/errors.js";

describe("error envelope", () => {
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;

    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    it("maps AppError to its public code, message and retryable flag", async () => {
        app = await buildApp({ logger: false });
        app.get("/api/v1/test/app-error", async () => {
            throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
        });

        const response = await app.inject({ method: "GET", url: "/api/v1/test/app-error" });

        expect(response.statusCode).toBe(403);
        expect(response.json().error).toMatchObject({ code: "workspace_forbidden", message: "无权访问当前空间", retryable: false });
        expect(response.json().error.requestId).toEqual(expect.any(String));
    });

    it("keeps the retryable flag when an AppError is retryable", async () => {
        app = await buildApp({ logger: false });
        app.get("/api/v1/test/retryable", async () => {
            throw new AppError("provider_unavailable", 503, "服务暂时不可用", true);
        });

        const response = await app.inject({ method: "GET", url: "/api/v1/test/retryable" });

        expect(response.statusCode).toBe(503);
        expect(response.json().error.retryable).toBe(true);
    });

    it("maps schema validation failures to 400 invalid_request", async () => {
        app = await buildApp({ logger: false });
        app.post("/api/v1/test/validated", { schema: { body: { type: "object", required: ["name"], properties: { name: { type: "string" } } } } }, async () => ({ status: "ok" }));

        const response = await app.inject({ method: "POST", url: "/api/v1/test/validated", payload: {} });

        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe("invalid_request");
    });

    it("rejects additional request properties instead of silently stripping them", async () => {
        app = await buildApp({ logger: false });
        app.post(
            "/api/v1/test/strict",
            {
                schema: {
                    body: {
                        type: "object",
                        additionalProperties: false,
                        required: ["name"],
                        properties: { name: { type: "string" } },
                    },
                },
            },
            async (request) => ({ body: request.body }),
        );

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/test/strict",
            payload: { name: "画布", unexpected: true },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe("invalid_request");
    });

    it("maps malformed JSON to 400 without exposing parser details", async () => {
        app = await buildApp({ logger: false });
        app.post("/api/v1/test/json", { schema: { body: { type: "object" } } }, async () => ({ status: "ok" }));

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/test/json",
            headers: { "content-type": "application/json" },
            payload: '{"value":undefined}',
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe("invalid_request");
        expect(response.body).not.toContain("FST_ERR_CTP_INVALID_JSON_BODY");
        expect(response.body).not.toContain("JSON body is invalid");
    });

    it("maps unsupported content types to a non-retryable 4xx envelope", async () => {
        app = await buildApp({ logger: false });
        app.post("/api/v1/test/content-type", async () => ({ status: "ok" }));

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/test/content-type",
            headers: { "content-type": "application/x-unsupported" },
            payload: "content",
        });

        expect(response.statusCode).toBe(415);
        expect(response.json().error).toMatchObject({ code: "invalid_request", retryable: false });
        expect(response.body).not.toContain("FST_ERR_CTP_INVALID_MEDIA_TYPE");
    });

    it("keeps the default body limit behind a stable 413 envelope", async () => {
        app = await buildApp({ logger: false });
        app.post("/api/v1/test/default-body-limit", async () => ({ status: "ok" }));

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/test/default-body-limit",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify({ content: "x".repeat(1024 * 1024) }),
        });

        expect(response.statusCode).toBe(413);
        expect(response.json().error.code).toBe("request_body_too_large");
        expect(response.body).not.toContain("FST_ERR_CTP_BODY_TOO_LARGE");
        expect(response.body).not.toContain("Request body is too large");
    });

    it("hides unknown error details behind 500 internal_error", async () => {
        app = await buildApp({ logger: false });
        app.get("/api/v1/test/unknown", async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:5432 password=secret");
        });

        const response = await app.inject({ method: "GET", url: "/api/v1/test/unknown" });

        expect(response.statusCode).toBe(500);
        expect(response.json().error.code).toBe("internal_error");
        expect(response.payload).not.toContain("ECONNREFUSED");
        expect(response.payload).not.toContain("password=secret");
    });

    it("answers unknown routes with the same envelope", async () => {
        app = await buildApp({ logger: false });

        const response = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });

        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("not_found");
    });
});

describe("unknown error logging", () => {
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;

    afterEach(async () => {
        await app?.close();
        app = undefined;
    });

    it("logs only the request id and safe metadata", async () => {
        const lines: string[] = [];
        app = await buildApp({
            logger: {
                level: "error",
                stream: {
                    write(line: string) {
                        lines.push(line);
                    },
                },
            },
        });
        app.get("/api/v1/test/logged", async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:5432 password=secret");
        });

        await app.inject({
            method: "GET",
            url: "/api/v1/test/logged?token=leaked",
            headers: { authorization: "Bearer leaked-token", cookie: "session=leaked" },
        });

        const logged = lines.join("\n");

        expect(logged).toContain("unhandled request error");
        expect(logged).not.toContain("password=secret");
        expect(logged).not.toContain("ECONNREFUSED");
        expect(logged).not.toContain("leaked-token");
        expect(logged).not.toContain("session=leaked");
        expect(logged).not.toContain("token=leaked");
        expect(logged).not.toContain("at Object");
        expect(logged).not.toContain("stack");
    });
});
