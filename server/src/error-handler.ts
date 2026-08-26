import type { FastifyInstance } from "fastify";

import { AppError } from "./errors.js";

const INVALID_JSON_CODES = new Set(["FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_INVALID_JSON_BODY"]);

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

        if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
            const isCanvasSnapshot = (request.routeOptions.config as { canvasSnapshotBody?: boolean }).canvasSnapshotBody;
            const code = isCanvasSnapshot ? "canvas_snapshot_too_large" : "request_body_too_large";
            const message = isCanvasSnapshot ? "画布快照超过 10 MiB 限制" : "请求体过大";
            reply.status(413).send(envelope(code, message, false, request.id));
            return;
        }

        if (error.validation || INVALID_JSON_CODES.has(error.code)) {
            reply.status(400).send(envelope("invalid_request", "请求参数不合法", false, request.id));
            return;
        }

        request.log.error({ requestId: request.id, kind: "unhandled_error" }, "unhandled request error");
        reply.status(500).send(envelope("internal_error", "服务内部错误，请稍后重试", true, request.id));
    });
}
