import {
    AppErrorResponseSchema,
    CreateAiTaskBodySchema,
    CreateAiTaskResponseSchema,
    AiTaskResponseSchema,
    IdempotencyHeadersSchema,
    type CreateAiTaskBody,
    type IdempotencyHeaders,
} from "@infinite-canvas/contracts";
import type { FastifyInstance } from "fastify";
import { Type, type Static } from "typebox";

import { AppError } from "../../errors.js";
import { requireSession } from "../identity/session.js";
import { formatCreditAmount } from "../credits/amount.js";
import type { AiTaskModule } from "./service.js";
import type { TaskEventNotifier } from "./events.js";

const errorResponses = {
    400: AppErrorResponseSchema,
    401: AppErrorResponseSchema,
    403: AppErrorResponseSchema,
    409: AppErrorResponseSchema,
    402: AppErrorResponseSchema,
    500: AppErrorResponseSchema,
};

const TaskParamsSchema = Type.Object({ taskId: Type.String({ format: "uuid" }) }, { additionalProperties: false });
const TaskQuerySchema = Type.Object({ workspaceId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
type TaskParams = Static<typeof TaskParamsSchema>;
type TaskQuery = Static<typeof TaskQuerySchema>;

function hasPostgresCode(error: unknown, code: string): boolean {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const value = current as Record<string, unknown>;
        if (value.code === code) return true;
        current = value.cause;
    }
    return false;
}

export function registerAiTaskRoutes(app: FastifyInstance, tasks: AiTaskModule, notifier?: TaskEventNotifier): void {
    app.post<{ Headers: IdempotencyHeaders; Body: CreateAiTaskBody }>(
        "/api/v1/ai/tasks",
        {
            schema: {
                headers: IdempotencyHeadersSchema,
                body: CreateAiTaskBodySchema,
                response: { 202: CreateAiTaskResponseSchema, ...errorResponses },
            },
        },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            try {
                const task = await tasks.createTask({
                    userId,
                    workspaceId: request.body.workspaceId,
                    idempotencyKey: request.headers["idempotency-key"],
                    prompt: request.body.prompt,
                });
                return reply.status(202).send({ ...task, estimatedCredits: formatCreditAmount(task.estimatedCredits) });
            } catch (error) {
                if (error instanceof AppError) throw error;
                if (hasPostgresCode(error, "P4020")) {
                    throw new AppError("insufficient_credits", 402, "可用积分不足");
                }
                throw error;
            }
        },
    );

    app.get<{ Params: TaskParams; Querystring: TaskQuery }>(
        "/api/v1/ai/tasks/:taskId",
        { schema: { params: TaskParamsSchema, querystring: TaskQuerySchema, response: { 200: AiTaskResponseSchema, ...errorResponses } } },
        async (request) => {
            const { userId } = await requireSession(request);
            const row = await tasks.getTask({ userId, workspaceId: request.query.workspaceId, taskId: request.params.taskId });
            return { task: {
                id: row.id, workspaceId: row.workspace_id, status: row.status,
                resultAssetId: row.result_asset_id, publicErrorCode: row.public_error_code,
                latestSequence: row.latest_sequence, estimatedCredits: row.estimated_amount, actualCredits: row.actual_amount,
            } };
        },
    );

    app.get<{ Params: TaskParams; Querystring: TaskQuery }>(
        "/api/v1/ai/tasks/:taskId/events",
        { schema: { params: TaskParamsSchema, querystring: TaskQuerySchema } },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            if (!notifier) throw new AppError("task_events_unavailable", 503, "任务事件服务暂时不可用", true);
            const workspaceId = request.query.workspaceId;
            await tasks.getTask({ userId, workspaceId, taskId: request.params.taskId });
            const rawLastId = request.headers["last-event-id"];
            if (rawLastId !== undefined && (typeof rawLastId !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(rawLastId))) {
                throw new AppError("invalid_last_event_id", 400, "Last-Event-ID 不合法");
            }
            const lastId = typeof rawLastId === "string" ? BigInt(rawLastId) : 0n;

            reply.hijack();
            reply.raw.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
            });
            let cursor = lastId;
            let writing = Promise.resolve();
            const writePersisted = () => {
                writing = writing.then(async () => {
                    const events = await tasks.listEventsAfter({ userId, workspaceId, taskId: request.params.taskId, sequence: cursor });
                    for (const event of events) {
                        cursor = BigInt(event.sequence);
                        reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({
                            sequence: event.sequence,
                            type: event.type,
                            payload: event.payload,
                            createdAt: event.created_at.toISOString(),
                        })}\n\n`);
                    }
                }).catch(() => {
                    reply.raw.end();
                });
            };
            const unsubscribe = notifier.subscribe(request.params.taskId, writePersisted);
            request.raw.on("close", () => {
                unsubscribe();
            });
            writePersisted();
        },
    );
}
