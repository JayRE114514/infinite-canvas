import { readFile } from "node:fs/promises";

import { expect } from "vitest";

import { buildApp, type BuildAppOptions } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { createDatabase } from "../../src/infrastructure/database/client.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import type { Mailer } from "../../src/infrastructure/email/mailer.js";
import { startPostgres, type StartedPostgres } from "./postgres.js";

export const APP_ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct-horse-battery-staple";

const MIGRATION_URL = new URL("../../migrations/0000_auth_and_workspaces.sql", import.meta.url);

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

export function cookieHeader(setCookie: string | string[] | undefined): string {
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

/** 注册、验证并登录真实 Better Auth 用户。 */
export async function registerVerifiedUser(
    app: AuthApp,
    mailer: MemoryMailer,
    user: { name: string; email: string },
): Promise<VerifiedUser> {
    const before = mailer.messages.length;
    const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { origin: APP_ORIGIN },
        payload: { name: user.name, email: user.email, password: PASSWORD },
    });

    expect(signUp.statusCode).toBe(200);
    expect(mailer.messages).toHaveLength(before + 1);

    const verificationUrl = new URL(mailer.messages[before]!.verificationUrl);
    await app.inject({ method: "GET", url: verificationUrl.pathname + verificationUrl.search });

    const signIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: APP_ORIGIN },
        payload: { email: user.email, password: PASSWORD },
    });

    expect(signIn.statusCode).toBe(200);
    const cookie = cookieHeader(signIn.headers["set-cookie"]);
    expect(cookie).not.toBe("");

    return { cookie, userId: signIn.json().user.id as string };
}

/** 每个测试文件独享容器，且无论断言或构造在哪一步失败都回收 app、连接池和容器。 */
export function createAuthTestHarness() {
    let postgres: StartedPostgres | undefined;
    let migrationSql = "";
    const openApps: AuthApp[] = [];
    const openHandles: DatabaseHandle[] = [];

    function postgresUrl(): string {
        if (!postgres) throw new Error("PostgreSQL container is not started");
        return postgres.url;
    }

    function config(overrides: { nodeEnv?: AppConfig["nodeEnv"]; appOrigin?: string } = {}): AppConfig {
        return loadConfig({
            NODE_ENV: overrides.nodeEnv ?? "test",
            DATABASE_URL: postgresUrl(),
            BETTER_AUTH_SECRET: "t".repeat(32),
            APP_ORIGIN: overrides.appOrigin ?? APP_ORIGIN,
            SMTP_HOST: "localhost",
            SMTP_FROM: "no-reply@example.com",
        });
    }

    async function openApp(options: BuildAppOptions): Promise<AuthApp> {
        const app = await buildApp(options);
        openApps.push(app);
        return app;
    }

    return {
        async start(): Promise<void> {
            postgres = await startPostgres();
            migrationSql = await readFile(MIGRATION_URL, "utf8");
        },

        openApp,

        async openAuthApp(configOverrides: { nodeEnv?: AppConfig["nodeEnv"]; appOrigin?: string } = {}) {
            const mailer = new MemoryMailer();
            const database = createDatabase({ url: postgresUrl(), poolMax: 8 });
            openHandles.push(database);
            await database.pool.query("drop schema public cascade; create schema public");
            await database.pool.query(migrationSql);
            const app = await openApp({ logger: false, config: config(configOverrides), database, mailer });
            return { app, mailer, database };
        },

        async cleanup(): Promise<void> {
            for (const app of openApps.splice(0)) await app.close().catch(() => {});
            for (const handle of openHandles.splice(0)) {
                if (handle.pool.ending || handle.pool.ended) continue;
                await handle.pool.end().catch(() => {});
            }
        },

        async stop(): Promise<void> {
            await this.cleanup();
            await postgres?.stop().catch(() => {});
            postgres = undefined;
        },
    };
}
