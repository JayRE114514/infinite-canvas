import {
    AppErrorResponseSchema,
    ArtBoxCreateHeadersSchema,
    ArtBoxVideoGenerationPathSchema,
    ArtBoxVideoGenerationResponseSchema,
    CreateArtBoxVideoGenerationBodySchema,
    WorkspacePathSchema,
    type ArtBoxCreateHeaders,
    type ArtBoxVideoGenerationPath,
    type CreateArtBoxVideoGenerationBody,
    type WorkspacePath,
} from "@infinite-canvas/contracts";
import type { FastifyInstance } from "fastify";

import { AppError } from "../../errors.js";
import { requireAppConfig, requireDatabase } from "../../infrastructure/database/plugin.js";
import type { ObjectStorage } from "../../infrastructure/object-storage/types.js";
import { requireSession } from "../identity/session.js";
import type { ArtBoxAdapter } from "./adapter.js";
import { createArtBoxVideoGeneration, pollArtBoxVideoGeneration, type ArtBoxServiceDependencies } from "./service.js";

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

function requireDependencies(
    app: FastifyInstance,
    storage: ObjectStorage | undefined,
    adapter: ArtBoxAdapter | undefined,
    fetchImpl: typeof fetch,
): ArtBoxServiceDependencies {
    const config = requireAppConfig(app);
    if (!config.artbox || !adapter) {
        throw new AppError("provider_configuration_error", 503, "视频生成服务未配置");
    }
    if (!config.cos || !storage) {
        throw new AppError("asset_storage_configuration_error", 503, "素材存储未配置");
    }
    return {
        adapter,
        storage,
        signedUrlTtlSeconds: config.cos.signedUrlTtlSeconds,
        requestTimeoutMs: config.artbox.requestTimeoutMs,
        resultMaxBytes: config.artbox.resultMaxBytes,
        resultAllowedHosts: config.artbox.resultAllowedHosts,
        pollLeaseSeconds: config.artbox.pollLeaseSeconds,
        fetchImpl,
    };
}

export function registerArtBoxRoutes(
    app: FastifyInstance,
    storage?: ObjectStorage,
    adapter?: ArtBoxAdapter,
    fetchImpl: typeof fetch = fetch,
): void {
    app.post<{ Params: WorkspacePath; Headers: ArtBoxCreateHeaders; Body: CreateArtBoxVideoGenerationBody }>(
        "/api/v1/workspaces/:workspaceId/integrations/artbox/video-generations",
        {
            schema: {
                params: WorkspacePathSchema,
                headers: ArtBoxCreateHeadersSchema,
                body: CreateArtBoxVideoGenerationBodySchema,
                response: { 201: ArtBoxVideoGenerationResponseSchema, ...errorResponses },
            },
        },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            const generation = await createArtBoxVideoGeneration(
                db,
                { userId, workspaceId: request.params.workspaceId },
                request.body,
                request.headers["idempotency-key"],
                requireDependencies(request.server, storage, adapter, fetchImpl),
            );
            return reply.status(201).send({ generation });
        },
    );

    app.post<{ Params: ArtBoxVideoGenerationPath }>(
        "/api/v1/workspaces/:workspaceId/integrations/artbox/video-generations/:generationId/poll",
        {
            schema: {
                params: ArtBoxVideoGenerationPathSchema,
                response: { 200: ArtBoxVideoGenerationResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return {
                generation: await pollArtBoxVideoGeneration(
                    db,
                    { userId, workspaceId: request.params.workspaceId },
                    request.params.generationId,
                    requireDependencies(request.server, storage, adapter, fetchImpl),
                ),
            };
        },
    );
}
