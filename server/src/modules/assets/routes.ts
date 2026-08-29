import {
    AppErrorResponseSchema,
    AssetPathSchema,
    CompleteAssetResponseSchema,
    CreateAssetBodySchema,
    CreateAssetResponseSchema,
    ReadAssetResponseSchema,
    WorkspacePathSchema,
    type AssetPath,
    type CreateAssetBody,
    type WorkspacePath,
} from "@infinite-canvas/contracts";
import type { FastifyInstance } from "fastify";

import { AppError } from "../../errors.js";
import { requireDatabase } from "../../infrastructure/database/plugin.js";
import type { ObjectStorage } from "../../infrastructure/object-storage/types.js";
import { requireSession } from "../identity/session.js";
import { completeAssetUpload, createAssetUpload, readAsset } from "./service.js";

const errorResponses = {
    400: AppErrorResponseSchema,
    401: AppErrorResponseSchema,
    403: AppErrorResponseSchema,
    404: AppErrorResponseSchema,
    409: AppErrorResponseSchema,
    422: AppErrorResponseSchema,
    503: AppErrorResponseSchema,
    500: AppErrorResponseSchema,
};

function requireStorage(storage: ObjectStorage | undefined, ttl: number | undefined): { storage: ObjectStorage; ttl: number } {
    if (!storage || ttl === undefined) {
        throw new AppError("asset_storage_configuration_error", 503, "素材存储未配置");
    }
    return { storage, ttl };
}

export function registerAssetRoutes(app: FastifyInstance, storage?: ObjectStorage): void {
    app.post<{ Params: WorkspacePath; Body: CreateAssetBody }>(
        "/api/v1/workspaces/:workspaceId/assets",
        {
            schema: {
                params: WorkspacePathSchema,
                body: CreateAssetBodySchema,
                response: { 201: CreateAssetResponseSchema, ...errorResponses },
            },
        },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            const configured = requireStorage(storage, request.server.appConfig?.cos?.signedUrlTtlSeconds);
            const { db } = requireDatabase(request.server);
            const response = await createAssetUpload(
                db,
                { userId, workspaceId: request.params.workspaceId },
                request.body,
                configured.storage,
                configured.ttl,
            );
            return reply.status(201).send(response);
        },
    );

    app.post<{ Params: AssetPath }>(
        "/api/v1/workspaces/:workspaceId/assets/:assetId/complete",
        {
            schema: {
                params: AssetPathSchema,
                response: { 200: CompleteAssetResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const configured = requireStorage(storage, request.server.appConfig?.cos?.signedUrlTtlSeconds);
            const { db } = requireDatabase(request.server);
            return {
                asset: await completeAssetUpload(
                    db,
                    { userId, workspaceId: request.params.workspaceId },
                    request.params.assetId,
                    configured.storage,
                ),
            };
        },
    );

    app.get<{ Params: AssetPath }>(
        "/api/v1/workspaces/:workspaceId/assets/:assetId",
        {
            schema: {
                params: AssetPathSchema,
                response: { 200: ReadAssetResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const configured = requireStorage(storage, request.server.appConfig?.cos?.signedUrlTtlSeconds);
            const { db } = requireDatabase(request.server);
            return readAsset(
                db,
                { userId, workspaceId: request.params.workspaceId },
                request.params.assetId,
                configured.storage,
                configured.ttl,
            );
        },
    );
}
