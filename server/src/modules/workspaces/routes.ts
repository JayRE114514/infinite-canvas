import {
    AppErrorResponseSchema,
    CreateWorkspaceBodySchema,
    CreateWorkspaceInvitationBodySchema,
    SuccessResponseSchema,
    UpdateWorkspaceBodySchema,
    WorkspaceInvitationPathSchema,
    WorkspaceInvitationResponseSchema,
    WorkspaceListResponseSchema,
    WorkspaceMemberPathSchema,
    WorkspaceMembersResponseSchema,
    WorkspacePathSchema,
    WorkspaceResponseSchema,
    type CreateWorkspaceBody,
    type CreateWorkspaceInvitationBody,
    type UpdateWorkspaceBody,
    type WorkspaceInvitation,
    type WorkspaceInvitationPath,
    type WorkspaceMember,
    type WorkspaceMemberPath,
    type WorkspacePath,
} from "@infinite-canvas/contracts";
import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { AppError } from "../../errors.js";
import { requireDatabase } from "../../infrastructure/database/plugin.js";
import type { AppDatabase } from "../../infrastructure/database/types.js";
import { users, workspaceInvitations, workspaceMembers, workspaces } from "../identity/auth-schema.js";
import type { Auth } from "../identity/auth.js";
import { requireSession } from "../identity/session.js";
import {
    parseWorkspaceRole,
    requireWorkspaceManager,
    requireWorkspaceMember,
    type WorkspaceAccess,
} from "./authorization.js";
import {
    ensurePersonalWorkspace,
    isPostgresUniqueViolation,
    toWorkspaceSummary,
    WORKSPACE_SLUG_UNIQUE_INDEX,
    type WorkspaceRow,
} from "./service.js";

const errorResponses = {
    400: AppErrorResponseSchema,
    401: AppErrorResponseSchema,
    403: AppErrorResponseSchema,
    409: AppErrorResponseSchema,
    500: AppErrorResponseSchema,
};

type BetterAuthMember = {
    id: string;
    userId: string;
    role: string;
    createdAt: Date;
    user: { id: string; name: string; email: string; image?: string | null };
};

type BetterAuthInvitation = {
    id: string;
    organizationId: string;
    email: string;
    role: string;
    status: string;
    inviterId: string;
    expiresAt: Date;
    createdAt: Date;
};

function toWorkspaceMember(member: BetterAuthMember): WorkspaceMember {
    return {
        id: member.id,
        userId: member.userId,
        role: parseWorkspaceRole(member.role),
        createdAt: member.createdAt.toISOString(),
        user: {
            id: member.user.id,
            name: member.user.name,
            email: member.user.email,
            image: member.user.image ?? null,
        },
    };
}

function toWorkspaceInvitation(invitation: BetterAuthInvitation): WorkspaceInvitation {
    if (!["pending", "accepted", "rejected", "canceled"].includes(invitation.status)) {
        throw new Error(`Unsupported invitation status: ${invitation.status}`);
    }

    return {
        id: invitation.id,
        workspaceId: invitation.organizationId,
        email: invitation.email,
        role: parseWorkspaceRole(invitation.role),
        status: invitation.status as WorkspaceInvitation["status"],
        inviterId: invitation.inviterId,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
    };
}

function betterAuthCode(error: APIError): string | undefined {
    return typeof error.body?.code === "string" ? error.body.code : undefined;
}

function rethrowWorkspaceOperation(error: unknown): never {
    if (error instanceof AppError) throw error;
    if (isPostgresUniqueViolation(error, WORKSPACE_SLUG_UNIQUE_INDEX)) {
        throw new AppError("workspace_slug_taken", 409, "空间标识已被使用");
    }
    if (!(error instanceof APIError)) throw error;

    const code = betterAuthCode(error);
    if (code === "ORGANIZATION_ALREADY_EXISTS" || code === "ORGANIZATION_SLUG_ALREADY_TAKEN") {
        throw new AppError("workspace_slug_taken", 409, "空间标识已被使用");
    }
    if (code === "PERSONAL_WORKSPACE_SINGLE_MEMBER") {
        throw new AppError("personal_workspace_single_member", 409, "个人空间只能包含所有者");
    }
    if (code === "WORKSPACE_OWNER_CANNOT_BE_REMOVED") {
        throw new AppError("workspace_owner_cannot_be_removed", 409, "不能移除空间所有者");
    }
    if (
        code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" ||
        code === "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION"
    ) {
        throw new AppError("workspace_invitation_conflict", 409, "该用户已加入或已收到邀请");
    }
    if (
        code === "MEMBER_NOT_FOUND" ||
        code === "INVITATION_NOT_FOUND" ||
        code === "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION" ||
        code === "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION"
    ) {
        throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
    }
    if (error.statusCode === 403) {
        throw new AppError("workspace_admin_required", 403, "需要空间所有者或管理员权限");
    }
    throw error;
}

async function requireVerifiedUser(request: FastifyRequest) {
    const { userId } = await requireSession(request);
    const { db } = requireDatabase(request.server);
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

    if (!user?.emailVerified) throw new AppError("email_verification_required", 403, "请先验证邮箱");
    return { id: user.id, name: user.name };
}

async function loadWorkspace(db: AppDatabase, workspaceId: string): Promise<WorkspaceRow> {
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    if (!workspace) throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
    return workspace;
}

async function requireWorkspace(
    request: FastifyRequest,
    workspaceId: string,
): Promise<{ access: WorkspaceAccess; workspace: WorkspaceRow; db: AppDatabase }> {
    const access = await requireWorkspaceMember(request, workspaceId);
    const { db } = requireDatabase(request.server);
    return { access, workspace: await loadWorkspace(db, workspaceId), db };
}

function requireTeamWorkspace(workspace: WorkspaceRow): void {
    if (workspace.workspaceType === "team") return;
    throw new AppError("personal_workspace_single_member", 409, "个人空间只能包含所有者");
}

export function registerWorkspaceRoutes(app: FastifyInstance, auth: Auth): void {
    app.get(
        "/api/v1/workspaces",
        { schema: { response: { 200: WorkspaceListResponseSchema, ...errorResponses } } },
        async (request) => {
            const user = await requireVerifiedUser(request);
            const { db } = requireDatabase(request.server);
            await ensurePersonalWorkspace(db, user);

            const rows = await db
                .select({ workspace: workspaces, role: workspaceMembers.role })
                .from(workspaceMembers)
                .innerJoin(workspaces, eq(workspaceMembers.organizationId, workspaces.id))
                .where(eq(workspaceMembers.userId, user.id))
                .orderBy(asc(workspaces.createdAt), asc(workspaces.id));

            return {
                workspaces: rows.map(({ workspace, role }) => toWorkspaceSummary(workspace, parseWorkspaceRole(role))),
            };
        },
    );

    app.post<{ Body: CreateWorkspaceBody }>(
        "/api/v1/workspaces",
        {
            schema: {
                body: CreateWorkspaceBodySchema,
                response: { 201: WorkspaceResponseSchema, ...errorResponses },
            },
        },
        async (request, reply) => {
            await requireVerifiedUser(request);
            const { db } = requireDatabase(request.server);

            try {
                const created = await auth.api.createOrganization({
                    headers: fromNodeHeaders(request.headers),
                    body: request.body,
                });
                const workspace = await loadWorkspace(db, created.id);
                return reply.status(201).send({ workspace: toWorkspaceSummary(workspace, "owner") });
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
        },
    );

    app.get<{ Params: WorkspacePath }>(
        "/api/v1/workspaces/:workspaceId",
        {
            schema: {
                params: WorkspacePathSchema,
                response: { 200: WorkspaceResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { access, workspace } = await requireWorkspace(request, request.params.workspaceId);
            return { workspace: toWorkspaceSummary(workspace, access.role) };
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
            const { access, db } = await requireWorkspace(request, request.params.workspaceId);
            requireWorkspaceManager(access);

            try {
                await auth.api.updateOrganization({
                    headers: fromNodeHeaders(request.headers),
                    body: { organizationId: request.params.workspaceId, data: request.body },
                });
                const workspace = await loadWorkspace(db, request.params.workspaceId);
                return { workspace: toWorkspaceSummary(workspace, access.role) };
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
        },
    );

    app.get<{ Params: WorkspacePath }>(
        "/api/v1/workspaces/:workspaceId/members",
        {
            schema: {
                params: WorkspacePathSchema,
                response: { 200: WorkspaceMembersResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            await requireWorkspaceMember(request, request.params.workspaceId);

            try {
                const result = await auth.api.listMembers({
                    headers: fromNodeHeaders(request.headers),
                    query: { organizationId: request.params.workspaceId },
                });
                return {
                    members: result.members.map((member) => toWorkspaceMember(member)),
                    total: result.total,
                };
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
        },
    );

    app.delete<{ Params: WorkspaceMemberPath }>(
        "/api/v1/workspaces/:workspaceId/members/:memberId",
        {
            schema: {
                params: WorkspaceMemberPathSchema,
                response: { 200: SuccessResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { access, workspace, db } = await requireWorkspace(request, request.params.workspaceId);
            requireTeamWorkspace(workspace);
            requireWorkspaceManager(access);

            const target = await db.query.workspaceMembers.findFirst({
                where: and(
                    eq(workspaceMembers.id, request.params.memberId),
                    eq(workspaceMembers.organizationId, request.params.workspaceId),
                ),
            });
            if (!target) throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
            if (parseWorkspaceRole(target.role) === "owner") {
                throw new AppError("workspace_owner_cannot_be_removed", 409, "不能移除空间所有者");
            }

            try {
                await auth.api.removeMember({
                    headers: fromNodeHeaders(request.headers),
                    body: { memberIdOrEmail: target.id, organizationId: request.params.workspaceId },
                });
                return { success: true } as const;
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
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
            const { access, workspace } = await requireWorkspace(request, request.params.workspaceId);
            requireTeamWorkspace(workspace);
            requireWorkspaceManager(access);

            try {
                const invitation = await auth.api.createInvitation({
                    headers: fromNodeHeaders(request.headers),
                    body: { ...request.body, organizationId: request.params.workspaceId },
                });
                return reply.status(201).send({ invitation: toWorkspaceInvitation(invitation) });
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
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
            const { access, workspace, db } = await requireWorkspace(request, request.params.workspaceId);
            requireTeamWorkspace(workspace);
            requireWorkspaceManager(access);

            const invitation = await db.query.workspaceInvitations.findFirst({
                where: and(
                    eq(workspaceInvitations.id, request.params.invitationId),
                    eq(workspaceInvitations.organizationId, request.params.workspaceId),
                ),
            });
            if (!invitation) throw new AppError("workspace_forbidden", 403, "无权访问当前空间");

            try {
                await auth.api.cancelInvitation({
                    headers: fromNodeHeaders(request.headers),
                    body: { invitationId: invitation.id },
                });
                return { success: true } as const;
            } catch (error) {
                rethrowWorkspaceOperation(error);
            }
        },
    );
}
