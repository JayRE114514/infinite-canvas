import {
    AcceptWorkspaceInvitationBodySchema,
    AcceptWorkspaceInvitationResponseSchema,
    AppErrorResponseSchema,
    CreateWorkspaceBodySchema,
    CreateWorkspaceInvitationBodySchema,
    SuccessResponseSchema,
    UpdateWorkspaceBodySchema,
    WorkspaceInvitationPathSchema,
    WorkspaceInvitationResponseSchema,
    WorkspaceInvitationsResponseSchema,
    WorkspaceListResponseSchema,
    WorkspaceMemberPathSchema,
    WorkspaceMembersResponseSchema,
    WorkspacePathSchema,
    WorkspaceResponseSchema,
    type AcceptWorkspaceInvitationBody,
    type CreateWorkspaceBody,
    type CreateWorkspaceInvitationBody,
    type UpdateWorkspaceBody,
    type WorkspaceInvitationPath,
    type WorkspaceMemberPath,
    type WorkspacePath,
} from "@infinite-canvas/contracts";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { AppError } from "../../errors.js";
import { requireAppConfig, requireDatabase } from "../../infrastructure/database/plugin.js";
import { withTenantTransaction, withUserTransaction } from "../../infrastructure/database/transactions.js";
import type { AppTransaction } from "../../infrastructure/database/types.js";
import type { Mailer } from "../../infrastructure/email/mailer.js";
import { users } from "../identity/schema.js";
import { requireSession } from "../identity/session.js";
import { requireActiveWorkspace } from "./authorization.js";
import { adoptOwnedWorkspaceContext } from "./context.js";
import {
    acceptWorkspaceInvitation,
    cancelWorkspaceInvitation,
    createTeamWorkspace,
    createWorkspaceInvitation,
    deactivateOwnedTeamWorkspace,
    getWorkspace,
    isPostgresUniqueViolation,
    listWorkspaceInvitations,
    listWorkspaceMembers,
    listWorkspaces,
    removeWorkspaceMember,
    resolvePersonalWorkspace,
    updateWorkspace,
    WORKSPACE_INVITATION_PENDING_UNIQUE_INDEX,
    WORKSPACE_SLUG_UNIQUE_INDEX,
} from "./service.js";

const errorResponses = {
    400: AppErrorResponseSchema,
    401: AppErrorResponseSchema,
    403: AppErrorResponseSchema,
    409: AppErrorResponseSchema,
    500: AppErrorResponseSchema,
};

async function requireVerifiedUser(tx: AppTransaction, userId: string) {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.emailVerified) throw new AppError("email_verification_required", 403, "请先验证邮箱");
    return { id: user.id, name: user.name, email: user.email };
}

function rethrowWorkspaceOperation(error: unknown): never {
    if (error instanceof AppError) throw error;
    if (isPostgresUniqueViolation(error, WORKSPACE_SLUG_UNIQUE_INDEX)) {
        throw new AppError("workspace_slug_taken", 409, "空间标识已被使用");
    }
    if (isPostgresUniqueViolation(error, WORKSPACE_INVITATION_PENDING_UNIQUE_INDEX)) {
        throw new AppError("workspace_invitation_conflict", 409, "该用户已加入或已收到邀请");
    }
    throw error;
}

export function registerWorkspaceRoutes(app: FastifyInstance, mailer: Mailer): void {
    app.get(
        "/api/v1/workspaces",
        { schema: { response: { 200: WorkspaceListResponseSchema, ...errorResponses } } },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withUserTransaction(db, userId, async (tx) => {
                const user = await requireVerifiedUser(tx, userId);
                // Task 5 moves this provisioning side effect to verification/repair; Task 4 retains current behavior.
                await resolvePersonalWorkspace(tx, user);
                return { workspaces: await listWorkspaces(tx, userId) };
            });
        },
    );

    app.post<{ Body: CreateWorkspaceBody }>(
        "/api/v1/workspaces",
        { schema: { body: CreateWorkspaceBodySchema, response: { 201: WorkspaceResponseSchema, ...errorResponses } } },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            try {
                const workspace = await withUserTransaction(db, userId, async (tx) => {
                    const user = await requireVerifiedUser(tx, userId);
                    const created = await createTeamWorkspace(tx, user, request.body);
                    await adoptOwnedWorkspaceContext(tx, userId, created.resolvedWorkspaceId);
                    return created.summary;
                });
                return reply.status(201).send({ workspace });
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
        },
    );

    app.get<{ Params: WorkspacePath }>(
        "/api/v1/workspaces/:workspaceId",
        { schema: { params: WorkspacePathSchema, response: { 200: WorkspaceResponseSchema, ...errorResponses } } },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withTenantTransaction(db, { userId, workspaceId: request.params.workspaceId }, async (tx, access) => {
                return { workspace: await getWorkspace(tx, access) };
            });
        },
    );

    app.patch<{ Params: WorkspacePath; Body: UpdateWorkspaceBody }>(
        "/api/v1/workspaces/:workspaceId",
        {
            schema: {
                params: WorkspacePathSchema,
                body: UpdateWorkspaceBodySchema,
                response: { 200: WorkspaceResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            try {
                return await withTenantTransaction(
                    db,
                    { userId, workspaceId: request.params.workspaceId, minimumRole: "admin" },
                    async (tx, access) => {
                        requireActiveWorkspace(access);
                        return { workspace: await updateWorkspace(tx, access, request.body) };
                    },
                );
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
        },
    );

    app.post<{ Params: WorkspacePath }>(
        "/api/v1/workspaces/:workspaceId/deactivate",
        { schema: { params: WorkspacePathSchema, response: { 200: WorkspaceResponseSchema, ...errorResponses } } },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withTenantTransaction(
                db,
                { userId, workspaceId: request.params.workspaceId, minimumRole: "owner" },
                async (tx, access) => ({ workspace: await deactivateOwnedTeamWorkspace(tx, access) }),
            );
        },
    );

    app.get<{ Params: WorkspacePath }>(
        "/api/v1/workspaces/:workspaceId/members",
        { schema: { params: WorkspacePathSchema, response: { 200: WorkspaceMembersResponseSchema, ...errorResponses } } },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withTenantTransaction(db, { userId, workspaceId: request.params.workspaceId }, (tx, access) => {
                requireActiveWorkspace(access);
                return listWorkspaceMembers(tx, access);
            });
        },
    );

    app.delete<{ Params: WorkspaceMemberPath }>(
        "/api/v1/workspaces/:workspaceId/members/:memberId",
        { schema: { params: WorkspaceMemberPathSchema, response: { 200: SuccessResponseSchema, ...errorResponses } } },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withTenantTransaction(
                db,
                { userId, workspaceId: request.params.workspaceId, minimumRole: "admin" },
                async (tx, access) => {
                    requireActiveWorkspace(access);
                    await removeWorkspaceMember(tx, access, request.params.memberId);
                    return { success: true } as const;
                },
            );
        },
    );

    app.get<{ Params: WorkspacePath }>(
        "/api/v1/workspaces/:workspaceId/invitations",
        { schema: { params: WorkspacePathSchema, response: { 200: WorkspaceInvitationsResponseSchema, ...errorResponses } } },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withTenantTransaction(
                db,
                { userId, workspaceId: request.params.workspaceId, minimumRole: "admin" },
                async (tx, access) => {
                    requireActiveWorkspace(access);
                    return { invitations: await listWorkspaceInvitations(tx, access) };
                },
            );
        },
    );

    app.post<{ Params: WorkspacePath; Body: CreateWorkspaceInvitationBody }>(
        "/api/v1/workspaces/:workspaceId/invitations",
        {
            schema: {
                params: WorkspacePathSchema,
                body: CreateWorkspaceInvitationBodySchema,
                response: { 201: WorkspaceInvitationResponseSchema, ...errorResponses },
            },
        },
        async (request, reply) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            try {
                const created = await withTenantTransaction(
                    db,
                    { userId, workspaceId: request.params.workspaceId, minimumRole: "admin" },
                    async (tx, access) => {
                        requireActiveWorkspace(access);
                        return createWorkspaceInvitation(tx, access, request.body);
                    },
                );
                const invitationUrl = new URL(
                    `/accept-invitation/${encodeURIComponent(created.token)}`,
                    requireAppConfig(request.server).appOrigin,
                ).toString();
                await mailer.sendWorkspaceInvitation(created.invitation.email, invitationUrl);
                return reply.status(201).send({ invitation: created.invitation });
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
        },
    );

    app.post<{ Body: AcceptWorkspaceInvitationBody }>(
        "/api/v1/workspace-invitations/accept",
        {
            schema: {
                body: AcceptWorkspaceInvitationBodySchema,
                response: { 200: AcceptWorkspaceInvitationResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withUserTransaction(db, userId, async (tx) => {
                const user = await requireVerifiedUser(tx, userId);
                return acceptWorkspaceInvitation(tx, user, request.body.token);
            });
        },
    );

    app.delete<{ Params: WorkspaceInvitationPath }>(
        "/api/v1/workspaces/:workspaceId/invitations/:invitationId",
        {
            schema: {
                params: WorkspaceInvitationPathSchema,
                response: { 200: SuccessResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            return withTenantTransaction(
                db,
                { userId, workspaceId: request.params.workspaceId, minimumRole: "admin" },
                async (tx, access) => {
                    requireActiveWorkspace(access);
                    await cancelWorkspaceInvitation(tx, access, request.params.invitationId);
                    return { success: true } as const;
                },
            );
        },
    );
}
