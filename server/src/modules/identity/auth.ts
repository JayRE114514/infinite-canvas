import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { authSchema } from "./auth-schema.js";
import type { AuthDependencies } from "./types.js";

/**
 * 组装 Better Auth 实例：只负责身份（用户、会话、账号、验证）。
 * Workspace 的创建、成员与邀请全部由 Workspaces 模块在应用事务中自有，
 * 这里不再挂载 Organization 插件，也没有任何组织业务钩子。
 */
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
    });
}

export type Auth = ReturnType<typeof createAuth>;
