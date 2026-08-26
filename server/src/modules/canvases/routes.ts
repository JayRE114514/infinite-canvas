import {
    AppErrorResponseSchema,
    CanvasListResponseSchema,
    CanvasPathSchema,
    CanvasResponseSchema,
    CreateCanvasBodySchema,
    SaveCanvasRequestSchema,
    SuccessResponseSchema,
    WorkspacePathSchema,
    type CanvasPath,
    type CreateCanvasBody,
    type SaveCanvasRequest,
    type WorkspacePath,
} from "@infinite-canvas/contracts";
import type { FastifyInstance } from "fastify";

import { requireDatabase } from "../../infrastructure/database/plugin.js";
import { requireWorkspaceMember } from "../workspaces/authorization.js";
import { createCanvas, getCanvas, listCanvases, saveCanvas, softDeleteCanvas } from "./service.js";

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
            const access = await requireWorkspaceMember(request, request.params.workspaceId);
            const { db } = requireDatabase(request.server);
            const canvas = await createCanvas(db, access, request.body);
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
            const access = await requireWorkspaceMember(request, request.params.workspaceId);
            const { db } = requireDatabase(request.server);
            return { canvases: await listCanvases(db, access) };
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
            const access = await requireWorkspaceMember(request, request.params.workspaceId);
            const { db } = requireDatabase(request.server);
            return { canvas: await getCanvas(db, access, request.params.canvasId) };
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
            const access = await requireWorkspaceMember(request, request.params.workspaceId);
            const { db } = requireDatabase(request.server);
            return { canvas: await saveCanvas(db, access, request.params.canvasId, request.body) };
        },
    );

    app.delete<{ Params: CanvasPath }>(
        "/api/v1/workspaces/:workspaceId/canvases/:canvasId",
        {
            schema: {
                params: CanvasPathSchema,
                response: { 200: SuccessResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const access = await requireWorkspaceMember(request, request.params.workspaceId);
            const { db } = requireDatabase(request.server);
            await softDeleteCanvas(db, access, request.params.canvasId);
            return { success: true } as const;
        },
    );
}
