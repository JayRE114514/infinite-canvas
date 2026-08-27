import {
    AdminWorkspaceResponseSchema,
    AppErrorResponseSchema,
    WorkspacePathSchema,
    type WorkspacePath,
} from "@infinite-canvas/contracts";
import type { FastifyInstance } from "fastify";

import { AppError } from "../../errors.js";
import { requireDatabase } from "../../infrastructure/database/plugin.js";
import {
    withPlatformAdminTransaction,
    type WorkspaceAdminPurpose,
} from "../../infrastructure/database/transactions.js";
import { requireSession } from "../identity/session.js";
import {
    executeWorkspaceAdminOperation,
    type WorkspaceLifecycleAction,
} from "./service.js";

const errorResponses = {
    400: AppErrorResponseSchema,
    401: AppErrorResponseSchema,
    403: AppErrorResponseSchema,
    404: AppErrorResponseSchema,
    409: AppErrorResponseSchema,
    500: AppErrorResponseSchema,
};

const purposes: Record<WorkspaceLifecycleAction, WorkspaceAdminPurpose> = {
    suspend: "workspace_suspend",
    deactivate: "workspace_deactivate",
    restore: "workspace_restore",
};

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

function rethrowAdminOperation(error: unknown): never {
    if (error instanceof AppError) throw error;
    if (hasPostgresCode(error, "P4040")) {
        throw new AppError("workspace_not_found", 404, "空间不存在");
    }
    if (hasPostgresCode(error, "P4091")) {
        throw new AppError("workspace_status_transition_invalid", 409, "当前空间状态不允许此操作");
    }
    if (hasPostgresCode(error, "P4092")) {
        throw new AppError("workspace_status_transition_conflict", 409, "空间状态已发生变化");
    }
    if (hasPostgresCode(error, "42501")) {
        throw new AppError("platform_admin_forbidden", 403, "需要活跃的平台管理员权限");
    }
    throw error;
}

export function registerPlatformAdminRoutes(app: FastifyInstance): void {
    app.get<{ Params: WorkspacePath }>(
        "/api/v1/admin/workspaces/:workspaceId",
        {
            schema: {
                params: WorkspacePathSchema,
                response: { 200: AdminWorkspaceResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            try {
                return await withPlatformAdminTransaction(
                    db,
                    {
                        userId,
                        requestId: request.id,
                        target: { kind: "workspace", workspaceId: request.params.workspaceId },
                        purpose: "workspace_read",
                    },
                    async (tx) => ({ workspace: await executeWorkspaceAdminOperation(tx) }),
                );
            } catch (error) {
                rethrowAdminOperation(error);
            }
        },
    );

    for (const action of Object.keys(purposes) as WorkspaceLifecycleAction[]) {
        app.post<{ Params: WorkspacePath }>(
            `/api/v1/admin/workspaces/:workspaceId/${action}`,
            {
                schema: {
                    params: WorkspacePathSchema,
                    response: { 200: AdminWorkspaceResponseSchema, ...errorResponses },
                },
            },
            async (request) => {
                const { userId } = await requireSession(request);
                const { db } = requireDatabase(request.server);
                try {
                    return await withPlatformAdminTransaction(
                        db,
                        {
                            userId,
                            requestId: request.id,
                            target: { kind: "workspace", workspaceId: request.params.workspaceId },
                            purpose: purposes[action],
                        },
                        async (tx) => ({ workspace: await executeWorkspaceAdminOperation(tx) }),
                    );
                } catch (error) {
                    rethrowAdminOperation(error);
                }
            },
        );
    }
}
