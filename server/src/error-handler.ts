import type { FastifyInstance } from "fastify";

import { AppError } from "./errors.js";

const INVALID_JSON_CODES = new Set(["FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_INVALID_JSON_BODY"]);

function errorDetails(error: unknown): { code?: string; statusCode?: number; validation?: unknown } {
    if (!error || typeof error !== "object") return {};
    const candidate = error as { code?: unknown; statusCode?: unknown; validation?: unknown };
    return {
        code: typeof candidate.code === "string" ? candidate.code : undefined,
        statusCode: typeof candidate.statusCode === "number" ? candidate.statusCode : undefined,
        validation: candidate.validation,
    };
}

function envelope(code: string, message: string, retryable: boolean, requestId: string) {
    return { error: { code, message, retryable, requestId } };
}

export function registerErrorHandler(app: FastifyInstance): void {
    app.setNotFoundHandler((request, reply) => {
        reply.status(404).send(envelope("not_found", "请求的资源不存在", false, request.id));
    });

    app.setErrorHandler((error, request, reply) => {
        if (error instanceof AppError) {
            reply.status(error.statusCode).send(envelope(error.code, error.message, error.retryable, request.id));
            return;
        }

        const details = errorDetails(error);

        if (details.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
            const isCanvasSnapshot = (request.routeOptions.config as { canvasSnapshotBody?: boolean }).canvasSnapshotBody;
            const code = isCanvasSnapshot ? "canvas_snapshot_too_large" : "request_body_too_large";
            const message = isCanvasSnapshot ? "画布快照超过 10 MiB 限制" : "请求体过大";
            reply.status(413).send(envelope(code, message, false, request.id));
            return;
        }

        if (details.validation || (details.code !== undefined && INVALID_JSON_CODES.has(details.code))) {
            reply.status(400).send(envelope("invalid_request", "请求参数不合法", false, request.id));
            return;
        }

        if (details.statusCode !== undefined && details.statusCode >= 400 && details.statusCode < 500) {
            reply.status(details.statusCode).send(envelope("invalid_request", "请求参数不合法", false, request.id));
            return;
        }

        request.log.error({ requestId: request.id, kind: "unhandled_error" }, "unhandled request error");
        reply.status(500).send(envelope("internal_error", "服务内部错误，请稍后重试", true, request.id));
    });
}
