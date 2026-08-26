import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import { eq } from "drizzle-orm";

import { authSchema, workspaceMembers } from "./auth-schema.js";
import type { AuthDependencies } from "./types.js";

function rejectPersonalMemberMutation(organization: Record<string, unknown>): void {
    if (organization.workspaceType !== "personal") return;
    throw new APIError("CONFLICT", {
        code: "PERSONAL_WORKSPACE_SINGLE_MEMBER",
        message: "Personal workspace can only contain its owner",
    });
}

function rejectOwnerRoleMutation(role: string): void {
    if (!role.split(",").map((item) => item.trim()).includes("owner")) return;
    throw new APIError("CONFLICT", {
        code: "WORKSPACE_OWNER_CANNOT_BE_REMOVED",
        message: "Workspace owner role cannot be mutated",
    });
}

function parseSingleWorkspaceRole(role: string): "owner" | "admin" | "member" {
    const roles = role.split(",").map((item) => item.trim()).filter(Boolean);
    if (roles.length === 1 && (roles[0] === "owner" || roles[0] === "admin" || roles[0] === "member")) {
        return roles[0];
    }
    throw new APIError("BAD_REQUEST", {
        code: "WORKSPACE_ROLE_INVALID",
        message: "Workspace membership requires one owner, admin, or member role",
    });
}

/** 组装 Better Auth 实例：邮箱密码需验证邮箱，Organization 映射到应用工作区表。 */
export function createAuth({ db, config, mailer }: AuthDependencies) {
    return betterAuth({
        basePath: "/api/auth",
        secret: config.betterAuthSecret,
        baseURL: config.appOrigin,
        trustedOrigins: [config.appOrigin],
        advanced: { useSecureCookies: config.nodeEnv === "production" },
        // 表名已通过 modelName 显式指定，usePlural 会再次追加 s，必须保持关闭。
        database: drizzleAdapter(db, { provider: "pg", schema: authSchema, usePlural: false }),
        emailAndPassword: { enabled: true, requireEmailVerification: true },
        emailVerification: {
            sendOnSignUp: true,
            sendVerificationEmail: async ({ user, url }) => {
                await mailer.sendVerification(user.email, url);
            },
        },
        user: { modelName: "users" },
        session: { modelName: "sessions" },
        account: { modelName: "accounts" },
        verification: { modelName: "verifications" },
        plugins: [
            organization({
                allowUserToCreateOrganization: false,
                disableOrganizationDeletion: true,
                requireEmailVerificationOnInvitation: true,
                // Better Auth 不生成邀请链接，接受页地址由应用拼装（Task 5 负责该前端路由）。
                sendInvitationEmail: async (data) => {
                    const url = new URL(`/accept-invitation/${data.invitation.id}`, config.appOrigin);
                    await mailer.sendWorkspaceInvitation(data.email, url.toString());
                },
                schema: {
                    organization: {
                        modelName: "workspaces",
                        // 适配器按对象键取 Drizzle 列（drizzle-adapter getSchema/checkMissingFields），
                        // 这里不能写 fieldName，否则会去找 workspace_type 这类不存在的键。
                        additionalFields: {
                            workspaceType: {
                                type: "string",
                                input: false,
                                required: true,
                                defaultValue: "team",
                            },
                            status: {
                                type: "string",
                                input: false,
                                required: true,
                                defaultValue: "active",
                            },
                            ownerUserId: {
                                type: "string",
                                input: false,
                                required: true,
                            },
                        },
                    },
                    member: { modelName: "workspace_members" },
                    invitation: { modelName: "workspace_invitations" },
                },
                organizationHooks: {
                    // Workspace 创建必须走应用事务；即使服务端误调 Better Auth 也拒绝绕过。
                    beforeCreateOrganization: async () => {
                        throw new APIError("FORBIDDEN", {
                            code: "WORKSPACE_CREATION_REQUIRES_APPLICATION_ROUTE",
                            message: "Workspace creation requires the application route",
                        });
                    },
                    // 业务路由可安全复用其余内部 API；钩子继续保护成员不变量。
                    beforeAddMember: async ({ member, organization }) => {
                        rejectPersonalMemberMutation(organization);
                        const role = parseSingleWorkspaceRole(member.role);
                        const existing = await db.query.workspaceMembers.findFirst({
                            where: eq(workspaceMembers.organizationId, member.organizationId),
                        });
                        if (role === "owner" && existing) rejectOwnerRoleMutation(role);
                    },
                    beforeCreateInvitation: async ({ invitation, organization }) => {
                        rejectPersonalMemberMutation(organization);
                        if (parseSingleWorkspaceRole(invitation.role) === "owner") {
                            throw new APIError("BAD_REQUEST", {
                                code: "WORKSPACE_ROLE_INVALID",
                                message: "Workspace invitations support admin or member roles",
                            });
                        }
                    },
                    beforeAcceptInvitation: async ({ organization }) => {
                        rejectPersonalMemberMutation(organization);
                    },
                    beforeRemoveMember: async ({ member, organization }) => {
                        rejectPersonalMemberMutation(organization);
                        rejectOwnerRoleMutation(member.role);
                    },
                    beforeUpdateMemberRole: async ({ member, newRole, organization }) => {
                        rejectPersonalMemberMutation(organization);
                        const role = parseSingleWorkspaceRole(newRole);
                        rejectOwnerRoleMutation(member.role);
                        if (role === "owner") rejectOwnerRoleMutation(role);
                    },
                },
            }),
        ],
    });
}

export type Auth = ReturnType<typeof createAuth>;
