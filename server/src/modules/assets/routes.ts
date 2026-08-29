import { Readable } from "node:stream";

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
import { completeAssetUpload, createAssetReadUrl, createAssetUpload, readAssetMetadata } from "./service.js";

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

const CONTENT_RESPONSE_HEADERS = [
    "accept-ranges",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
] as const;

const PRIVATE_CONTENT_HEADERS = {
    "cache-control": "private, no-store",
    "content-security-policy": "sandbox; default-src 'none'",
    "x-content-type-options": "nosniff",
} as const;

type AssetContent = {
    status: 200 | 206 | 416;
    headers: Record<string, string>;
    body: Response["body"];
};

export async function loadAssetContent(
    displayUrl: string,
    range: string | undefined,
    fetchImpl: typeof fetch,
): Promise<AssetContent> {
    let response: Response;
    try {
        response = await fetchImpl(displayUrl, {
            headers: range === undefined ? undefined : { range },
            redirect: "error",
        });
    } catch {
        throw new AppError("asset_content_unavailable", 503, "素材内容暂时不可用", true);
    }

    const successfulBody = (response.status === 200 || response.status === 206) && response.body !== null;
    if (!successfulBody && response.status !== 416) {
        await response.body?.cancel().catch(() => {});
        throw new AppError("asset_content_unavailable", 503, "素材内容暂时不可用", true);
    }

    const headers: Record<string, string> = { ...PRIVATE_CONTENT_HEADERS };
    for (const name of CONTENT_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
    }
    const status: AssetContent["status"] = response.status === 200 ? 200 : response.status === 206 ? 206 : 416;
    return { status, headers, body: response.body };
}

function assetContentPath(workspaceId: string, assetId: string): string {
    return `/api/v1/workspaces/${workspaceId}/assets/${assetId}/content`;
}

export function registerAssetRoutes(
    app: FastifyInstance,
    storage?: ObjectStorage,
    fetchImpl: typeof fetch = fetch,
): void {
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
            const { db } = requireDatabase(request.server);
            const asset = await readAssetMetadata(
                db,
                { userId, workspaceId: request.params.workspaceId },
                request.params.assetId,
            );
            return {
                asset,
                displayUrl: assetContentPath(request.params.workspaceId, request.params.assetId),
            };
        },
    );

    app.get<{ Params: AssetPath }>(
        "/api/v1/workspaces/:workspaceId/assets/:assetId/content",
        { exposeHeadRoute: false, schema: { params: AssetPathSchema, response: { ...errorResponses } } },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            const configured = requireStorage(storage, request.server.appConfig?.cos?.signedUrlTtlSeconds);
            const { db } = requireDatabase(request.server);
            const displayUrl = await createAssetReadUrl(
                db,
                { userId, workspaceId: request.params.workspaceId },
                request.params.assetId,
                configured.storage,
                configured.ttl,
            );
            const content = await loadAssetContent(displayUrl, request.headers.range, fetchImpl);
            for (const [name, value] of Object.entries(content.headers)) reply.header(name, value);
            if (content.body === null) return reply.status(content.status).send();
            return reply.status(content.status).send(Readable.fromWeb(content.body));
        },
    );
}
