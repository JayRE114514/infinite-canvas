import { expect } from "vitest";
import { Pool } from "pg";

import { buildApp, type BuildAppOptions } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { createDatabase } from "../../src/infrastructure/database/client.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import type { Mailer } from "../../src/infrastructure/email/mailer.js";
import { runMigrations } from "./database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "./postgres.js";

export const APP_ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct-horse-battery-staple";

/** 测试注入的内存邮件发送器，不产生真实 SMTP 请求。 */
export class MemoryMailer implements Mailer {
    readonly messages: { email: string; verificationUrl: string }[] = [];
    readonly invitations: { email: string; invitationUrl: string }[] = [];

    async sendVerification(email: string, url: string): Promise<void> {
        this.messages.push({ email, verificationUrl: url });
    }

    async sendWorkspaceInvitation(email: string, url: string): Promise<void> {
        this.invitations.push({ email, invitationUrl: url });
    }
}

export type AuthApp = Awaited<ReturnType<typeof buildApp>>;
export type VerifiedUser = { cookie: string; userId: string };
export type UnverifiedUser = { userId: string; verificationUrl: string };

export function cookieHeader(setCookie: string | string[] | undefined): string {
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

/** 只完成注册并返回最新验证链接，供验证回调与失败恢复用例控制提交时点。 */
export async function registerUserWithoutVerification(
    app: AuthApp,
    mailer: MemoryMailer,
    user: { name: string; email: string },
): Promise<UnverifiedUser> {
    const before = mailer.messages.length;
    const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { origin: APP_ORIGIN },
        payload: { ...user, password: PASSWORD },
    });

    expect(signUp.statusCode).toBe(200);
    expect(mailer.messages).toHaveLength(before + 1);
    return {
        userId: signUp.json().user.id as string,
        verificationUrl: mailer.messages[before]!.verificationUrl,
    };
}

/** 通过真实 Better Auth GET 端点消费指定验证链接，并把响应交给故障用例断言。 */
export function verifyLatestEmail(app: AuthApp, user: UnverifiedUser) {
    const verificationUrl = new URL(user.verificationUrl);
    return app.inject({ method: "GET", url: verificationUrl.pathname + verificationUrl.search });
}

/** 注册、验证并登录真实 Better Auth 用户。 */
export async function registerVerifiedUser(
    app: AuthApp,
    mailer: MemoryMailer,
    user: { name: string; email: string },
): Promise<VerifiedUser> {
    const registered = await registerUserWithoutVerification(app, mailer, user);
    const verified = await verifyLatestEmail(app, registered);
    expect(verified.statusCode).toBe(302);

    const signIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: APP_ORIGIN },
        payload: { email: user.email, password: PASSWORD },
    });

    expect(signIn.statusCode).toBe(200);
    const cookie = cookieHeader(signIn.headers["set-cookie"]);
    expect(cookie).not.toBe("");

    return { cookie, userId: registered.userId };
}

/** 每个测试文件独享容器，且无论断言或构造在哪一步失败都回收 app、连接池和容器。 */
export function createAuthTestHarness() {
    let postgres: StartedRoleDatabase | undefined;
    const openApps: AuthApp[] = [];
    const openHandles: DatabaseHandle[] = [];
    const openPools: Pool[] = [];

    function roles(): StartedRoleDatabase {
        if (!postgres) throw new Error("PostgreSQL container is not started");
        return postgres;
    }

    function config(overrides: { nodeEnv?: AppConfig["nodeEnv"]; appOrigin?: string } = {}, includeCos = false): AppConfig {
        return loadConfig({
            NODE_ENV: overrides.nodeEnv ?? "test",
            DATABASE_URL_API: roles().api,
            BETTER_AUTH_SECRET: "t".repeat(32),
            APP_ORIGIN: overrides.appOrigin ?? APP_ORIGIN,
            SMTP_HOST: "localhost",
            SMTP_FROM: "no-reply@example.com",
            ...(includeCos
                ? {
                      COS_SECRET_ID: "test-secret-id",
                      COS_SECRET_KEY: "test-secret-key",
                      COS_BUCKET: "test-assets-1250000000",
                      COS_REGION: "ap-guangzhou",
                      COS_SIGNED_URL_TTL_SECONDS: "300",
                  }
                : {}),
        });
    }

    async function openApp(options: BuildAppOptions): Promise<AuthApp> {
        const app = await buildApp(options);
        openApps.push(app);
        return app;
    }

    return {
        async start(): Promise<void> {
            postgres = await startRoleDatabase();
        },

        openApp,

        async openAuthApp(
            configOverrides: { nodeEnv?: AppConfig["nodeEnv"]; appOrigin?: string } = {},
            appOverrides: Pick<BuildAppOptions, "logger" | "objectStorage"> = {},
        ) {
            const mailer = new MemoryMailer();
            const current = roles();

            // 每个 app 实例拿到干净 schema：容器管理员重置后仍由 schema_owner 持有。
            const setupPool = new Pool({ connectionString: current.admin, max: 1 });
            try {
                await setupPool.query("drop schema if exists drizzle cascade");
                await setupPool.query("drop schema public cascade; create schema public");
                await setupPool.query("alter schema public owner to schema_owner");
                await setupPool.query("revoke create on schema public from public");
                await setupPool.query("grant create, usage on schema public to schema_owner");
            } finally {
                await setupPool.end().catch(() => {});
            }

            // 迁移只以 schema_owner 身份按 _journal.json 顺序执行。
            await runMigrations(current.schemaOwner);

            // HTTP 与业务行为只通过生产等价的 app_api 登录执行。
            const database = createDatabase({ url: current.api, poolMax: 8, expectedRole: "app_api" });
            openHandles.push(database);
            // 测试夹具的播种与提交后断言使用一次性容器管理员，绝不计作 RLS 证据。
            const adminPool = new Pool({ connectionString: current.admin, max: 4 });
            openPools.push(adminPool);
            const app = await openApp({
                logger: appOverrides.logger ?? false,
                config: config(configOverrides, Boolean(appOverrides.objectStorage)),
                database,
                mailer,
                objectStorage: appOverrides.objectStorage,
            });
            return { app, mailer, database, adminPool };
        },

        async cleanup(): Promise<void> {
            for (const app of openApps.splice(0)) await app.close().catch(() => {});
            for (const handle of openHandles.splice(0)) {
                if (handle.pool.ending || handle.pool.ended) continue;
                await handle.pool.end().catch(() => {});
            }
            for (const pool of openPools.splice(0)) {
                if (pool.ending || pool.ended) continue;
                await pool.end().catch(() => {});
            }
        },

        async stop(): Promise<void> {
            await this.cleanup();
            await postgres?.stop().catch(() => {});
            postgres = undefined;
        },
    };
}
