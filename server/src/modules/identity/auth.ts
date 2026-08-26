import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";

import { authSchema } from "./auth-schema.js";
import type { AuthDependencies } from "./types.js";

/** 组装 Better Auth 实例：邮箱密码需验证邮箱，Organization 映射到应用工作区表。 */
export function createAuth({ db, config, mailer }: AuthDependencies) {
    return betterAuth({
        basePath: "/api/auth",
        secret: config.betterAuthSecret,
        baseURL: config.appOrigin,
        trustedOrigins: [config.appOrigin],
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
                requireEmailVerificationOnInvitation: true,
                sendInvitationEmail: async (data) => {
                    await mailer.sendWorkspaceInvitation(data.email, data.invitation.id);
                },
                schema: {
                    organization: {
                        modelName: "workspaces",
                        additionalFields: {
                            workspaceType: {
                                type: "string",
                                fieldName: "workspace_type",
                                input: false,
                                required: true,
                                defaultValue: "team",
                            },
                            status: {
                                type: "string",
                                fieldName: "status",
                                input: false,
                                required: true,
                                defaultValue: "active",
                            },
                            ownerUserId: {
                                type: "string",
                                fieldName: "owner_user_id",
                                input: false,
                                required: true,
                            },
                        },
                    },
                    member: { modelName: "workspace_members" },
                    invitation: { modelName: "workspace_invitations" },
                },
                organizationHooks: {
                    // 应用自有列不接受客户端输入，统一在创建前落库。
                    beforeCreateOrganization: async ({ organization: input, user }) => ({
                        data: { ...input, workspaceType: "team", status: "active", ownerUserId: user.id },
                    }),
                },
            }),
        ],
    });
}

export type Auth = ReturnType<typeof createAuth>;
