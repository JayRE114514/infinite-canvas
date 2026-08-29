import {
    AppErrorResponseSchema,
    CanvasDeletionReceiptSchema,
    CanvasListResponseSchema,
    CanvasPathSchema,
    CanvasResponseSchema,
    CreateCanvasBodySchema,
    SaveCanvasRequestSchema,
    WorkspacePathSchema,
    type CanvasPath,
    type CreateCanvasBody,
    type SaveCanvasRequest,
    type WorkspacePath,
} from "@infinite-canvas/contracts";
import type { FastifyInstance } from "fastify";

import { AppError } from "../../errors.js";
import { requireDatabase } from "../../infrastructure/database/plugin.js";
import { withTenantTransaction } from "../../infrastructure/database/transactions.js";
import { requireSession } from "../identity/session.js";
import { requireActiveWorkspace } from "../workspaces/authorization.js";
import {
    CanvasDeleteInvariantError,
    CanvasSaveInvariantError,
    createCanvas,
    deleteCanvas,
    getCanvas,
    listCanvases,
    saveCanvas,
} from "./service.js";

export const CANVAS_SNAPSHOT_BODY_LIMIT = 10 * 1024 * 1024;

const errorResponses = {
    400: AppErrorResponseSchema,
    401: AppErrorResponseSchema,
    403: AppErrorResponseSchema,
    404: AppErrorResponseSchema,
    409: AppErrorResponseSchema,
    413: AppErrorResponseSchema,
    500: AppErrorResponseSchema,
};

const snapshotBodyRoute = {
    bodyLimit: CANVAS_SNAPSHOT_BODY_LIMIT,
    config: { canvasSnapshotBody: true },
} as const;

export function registerCanvasRoutes(app: FastifyInstance): void {
    app.post<{ Params: WorkspacePath; Body: CreateCanvasBody }>(
        "/api/v1/workspaces/:workspaceId/canvases",
        {
            ...snapshotBodyRoute,
            schema: {
                params: WorkspacePathSchema,
                body: CreateCanvasBodySchema,
                response: { 201: CanvasResponseSchema, ...errorResponses },
            },
        },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            const canvas = await withTenantTransaction(
                db,
                { userId, workspaceId: request.params.workspaceId },
                (tx, access) => {
                    requireActiveWorkspace(access);
                    return createCanvas(tx, access, request.body);
                },
            );
            return reply.status(201).send({ canvas });
        },
    );

    app.get<{ Params: WorkspacePath }>(
        "/api/v1/workspaces/:workspaceId/canvases",
        {
            schema: {
                params: WorkspacePathSchema,
                response: { 200: CanvasListResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withTenantTransaction(db, { userId, workspaceId: request.params.workspaceId }, async (tx, access) => {
                requireActiveWorkspace(access);
                return { canvases: await listCanvases(tx, access) };
            });
        },
    );

    app.get<{ Params: CanvasPath }>(
        "/api/v1/workspaces/:workspaceId/canvases/:canvasId",
        {
            schema: {
                params: CanvasPathSchema,
                response: { 200: CanvasResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withTenantTransaction(db, { userId, workspaceId: request.params.workspaceId }, async (tx, access) => {
                requireActiveWorkspace(access);
                return { canvas: await getCanvas(tx, access, request.params.canvasId) };
            });
        },
    );

    app.put<{ Params: CanvasPath; Body: SaveCanvasRequest }>(
        "/api/v1/workspaces/:workspaceId/canvases/:canvasId",
        {
            ...snapshotBodyRoute,
            schema: {
                params: CanvasPathSchema,
                body: SaveCanvasRequestSchema,
                response: { 200: CanvasResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            try {
                return await withTenantTransaction(db, { userId, workspaceId: request.params.workspaceId }, async (tx, access) => {
                    requireActiveWorkspace(access);
                    return { canvas: await saveCanvas(tx, access, request.params.canvasId, request.body) };
                });
            } catch (err) {
                if (err instanceof CanvasSaveInvariantError) {
                    request.log.error(
                        {
                            requestId: request.id,
                            canvasId: err.canvasId,
                            workspaceId: err.workspaceId,
                            expectedRevision: err.expectedRevision,
                            err,
                        },
                        "canvas save invariant failed",
                    );
                    throw new AppError("canvas_save_invariant_failed", 500, "内部错误：画布保存不变量失败");
                }
                throw err;
            }
        },
    );

    app.delete<{ Params: CanvasPath }>(
        "/api/v1/workspaces/:workspaceId/canvases/:canvasId",
        {
            schema: {
                params: CanvasPathSchema,
                response: { 200: CanvasDeletionReceiptSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            try {
                return await withTenantTransaction(
                    db,
                    { userId, workspaceId: request.params.workspaceId },
                    async (tx, access) => {
                        requireActiveWorkspace(access);
                        return deleteCanvas(tx, access, request.params.canvasId);
                    },
                );
            } catch (err) {
                // 事务已整体回滚；这里只做结构化诊断与稳定脱敏响应，绝不猜测用户级结果。
                if (err instanceof CanvasDeleteInvariantError) {
                    request.log.error(
                        {
                            requestId: request.id,
                            canvasId: err.canvasId,
                            workspaceId: err.workspaceId,
                            reason: err.reason,
                            err,
                        },
                        "canvas delete invariant failed",
                    );
                    throw new AppError("canvas_delete_invariant_failed", 500, "内部错误：画布删除不变量失败");
                }
                throw err;
            }
        },
    );
}
