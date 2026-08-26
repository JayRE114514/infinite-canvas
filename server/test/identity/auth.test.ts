import { readFile } from "node:fs/promises";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp, type BuildAppOptions } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { createDatabase } from "../../src/infrastructure/database/client.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import type { Mailer } from "../../src/infrastructure/email/mailer.js";
import { startPostgres, type StartedPostgres } from "../helpers/postgres.js";

const APP_ORIGIN = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-staple";
const MIGRATION_URL = new URL("../../migrations/0000_auth_and_workspaces.sql", import.meta.url);

/** 测试注入的内存邮件发送器，捕获验证链接与邀请链接，不产生真实 SMTP 请求。 */
class MemoryMailer implements Mailer {
    readonly messages: { email: string; verificationUrl: string }[] = [];
    readonly invitations: { email: string; invitationUrl: string }[] = [];

    async sendVerification(email: string, url: string): Promise<void> {
        this.messages.push({ email, verificationUrl: url });
    }

    async sendWorkspaceInvitation(email: string, url: string): Promise<void> {
        this.invitations.push({ email, invitationUrl: url });
    }
}

let postgres: StartedPostgres | undefined;
let migrationSql = "";
const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
const openHandles: DatabaseHandle[] = [];

function postgresUrl(): string {
    if (!postgres) throw new Error("PostgreSQL container is not started");
    return postgres.url;
}

function testConfig(): AppConfig {
    return loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: postgresUrl(),
        BETTER_AUTH_SECRET: "t".repeat(32),
        APP_ORIGIN: APP_ORIGIN,
        SMTP_HOST: "localhost",
        SMTP_FROM: "no-reply@example.com",
    });
}

/** 先登记再返回，保证断言失败时 afterEach 仍能释放连接池。 */
function openDatabase(): DatabaseHandle {
    const handle = createDatabase({ url: postgresUrl(), poolMax: 4 });
    openHandles.push(handle);
    return handle;
}

async function openApp(options: BuildAppOptions) {
    const app = await buildApp(options);
    openApps.push(app);
    return app;
}

/** 每个用例独立建库结构，避免用户与工作区数据跨用例串味。 */
async function openAuthApp() {
    const mailer = new MemoryMailer();
    const database = openDatabase();
    await database.pool.query("drop schema public cascade; create schema public");
    await database.pool.query(migrationSql);
    const app = await openApp({ logger: false, config: testConfig(), database, mailer });
    return { app, mailer, database };
}

function cookieHeader(setCookie: string | string[] | undefined): string {
    const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

type AuthApp = Awaited<ReturnType<typeof openApp>>;

/** 注册 → 跟随捕获的验证链接 → 登录，返回会话 Cookie 与用户 id。 */
async function registerVerifiedUser(
    app: AuthApp,
    mailer: MemoryMailer,
    user: { name: string; email: string },
): Promise<{ cookie: string; userId: string }> {
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

beforeAll(async () => {
    postgres = await startPostgres();
    // 迁移文件是唯一的建表来源，测试直接执行它，能同时验证迁移可用。
    migrationSql = await readFile(MIGRATION_URL, "utf8");
}, 180_000);

afterEach(async () => {
    for (const app of openApps.splice(0)) await app.close().catch(() => {});
    for (const handle of openHandles.splice(0)) {
        if (handle.pool.ending || handle.pool.ended) continue;
        await handle.pool.end().catch(() => {});
    }
}, 30_000);

afterAll(async () => {
    await postgres?.stop();
    postgres = undefined;
}, 60_000);

describe("session guard", () => {
    it("returns 401 from a protected probe without a session", async () => {
        const { app } = await openAuthApp();

        const response = await app.inject({ method: "GET", url: "/api/v1/session-probe" });

        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("unauthenticated");
    }, 60_000);

    it("keeps the probe absent from the pure app", async () => {
        const app = await openApp({ logger: false });

        const response = await app.inject({ method: "GET", url: "/api/v1/session-probe" });

        expect(response.statusCode).toBe(404);
        expect(app.hasDecorator("auth")).toBe(false);
    });
});

describe("email and password registration", () => {
    it("creates an email/password user through Better Auth", async () => {
        const { app, mailer } = await openAuthApp();

        const signUp = await app.inject({
            method: "POST",
            url: "/api/auth/sign-up/email",
            headers: { origin: APP_ORIGIN },
            payload: { name: "测试用户", email: "user@example.com", password: PASSWORD },
        });

        expect(signUp.statusCode).toBe(200);
        expect(mailer.messages).toHaveLength(1);
        expect(mailer.messages[0]?.email).toBe("user@example.com");

        const verificationUrl = new URL(mailer.messages[0]!.verificationUrl);
        await app.inject({ method: "GET", url: verificationUrl.pathname + verificationUrl.search });

        const signIn = await app.inject({
            method: "POST",
            url: "/api/auth/sign-in/email",
            headers: { origin: APP_ORIGIN },
            payload: { email: "user@example.com", password: PASSWORD },
        });

        expect(signIn.statusCode).toBe(200);
        expect(signIn.headers["set-cookie"]).toBeDefined();
    }, 60_000);

    it("refuses sign-in until the address is verified", async () => {
        const { app, mailer } = await openAuthApp();

        await app.inject({
            method: "POST",
            url: "/api/auth/sign-up/email",
            headers: { origin: APP_ORIGIN },
            payload: { name: "未验证用户", email: "pending@example.com", password: PASSWORD },
        });

        expect(mailer.messages).toHaveLength(1);

        const signIn = await app.inject({
            method: "POST",
            url: "/api/auth/sign-in/email",
            headers: { origin: APP_ORIGIN },
            payload: { email: "pending@example.com", password: PASSWORD },
        });

        expect(signIn.statusCode).toBe(403);
        expect(signIn.headers["set-cookie"]).toBeUndefined();
    }, 60_000);

    it("accepts the session cookie on the protected probe", async () => {
        const { app, mailer } = await openAuthApp();

        await app.inject({
            method: "POST",
            url: "/api/auth/sign-up/email",
            headers: { origin: APP_ORIGIN },
            payload: { name: "已验证用户", email: "member@example.com", password: PASSWORD },
        });
        const verificationUrl = new URL(mailer.messages[0]!.verificationUrl);
        await app.inject({ method: "GET", url: verificationUrl.pathname + verificationUrl.search });

        const signIn = await app.inject({
            method: "POST",
            url: "/api/auth/sign-in/email",
            headers: { origin: APP_ORIGIN },
            payload: { email: "member@example.com", password: PASSWORD },
        });
        const cookie = cookieHeader(signIn.headers["set-cookie"]);

        expect(cookie).not.toBe("");

        const probe = await app.inject({ method: "GET", url: "/api/v1/session-probe", headers: { cookie } });

        expect(probe.statusCode).toBe(200);
        expect(probe.json().userId).toEqual(expect.any(String));
        expect(probe.json().requestId).toEqual(expect.any(String));
    }, 60_000);
});

describe("auth route mounting", () => {
    it("exposes only GET and POST under /api/auth", async () => {
        const { app } = await openAuthApp();

        const deleted = await app.inject({ method: "DELETE", url: "/api/auth/sign-out", headers: { origin: APP_ORIGIN } });

        expect(deleted.statusCode).toBe(404);
        expect(deleted.json().error.code).toBe("not_found");
    }, 60_000);

    it("forwards Better Auth failures without leaking internals", async () => {
        const { app } = await openAuthApp();

        const response = await app.inject({
            method: "POST",
            url: "/api/auth/sign-in/email",
            headers: { origin: APP_ORIGIN },
            payload: { email: "missing@example.com", password: PASSWORD },
        });

        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain("stack");
    }, 60_000);
});

describe("workspace mapping", () => {
    it("stores an organization as a workspace row with application columns", async () => {
        const { app, mailer, database } = await openAuthApp();

        const owner = await registerVerifiedUser(app, mailer, { name: "工作区所有者", email: "owner@example.com" });

        const created = await app.inject({
            method: "POST",
            url: "/api/auth/organization/create",
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
            payload: { name: "团队工作区", slug: "team-workspace" },
        });

        expect(created.statusCode).toBe(200);

        const workspaces = await database.pool.query(
            'select "id", "workspace_type", "status", "owner_user_id", "slug" from "workspaces"',
        );

        expect(workspaces.rows).toHaveLength(1);
        expect(workspaces.rows[0]).toMatchObject({
            id: created.json().id,
            workspace_type: "team",
            status: "active",
            slug: "team-workspace",
            owner_user_id: owner.userId,
        });

        const members = await database.pool.query('select "userId", "role", "organizationId" from "workspace_members"');

        expect(members.rows).toHaveLength(1);
        expect(members.rows[0]).toMatchObject({
            userId: owner.userId,
            role: "owner",
            organizationId: created.json().id,
        });
    }, 60_000);

    it("allows only one personal workspace per owner", async () => {
        const { database } = await openAuthApp();

        await database.pool.query(
            'insert into "users" ("id", "name", "email", "emailVerified") values ($1, $2, $3, true)',
            ["user-personal", "个人用户", "personal@example.com"],
        );
        const insertWorkspace = (id: string, slug: string, type: string) =>
            database.pool.query(
                'insert into "workspaces" ("id", "name", "slug", "createdAt", "workspace_type", "status", "owner_user_id") values ($1, $2, $3, now(), $4, \'active\', $5)',
                [id, slug, slug, type, "user-personal"],
            );

        await insertWorkspace("ws-personal", "personal-one", "personal");

        await expect(insertWorkspace("ws-personal-2", "personal-two", "personal")).rejects.toThrow();

        await expect(insertWorkspace("ws-team", "team-one", "team")).resolves.toBeTruthy();
    }, 60_000);
});

describe("workspace invitations", () => {
    it("emails a same-origin acceptance URL carrying the invitation id", async () => {
        const { app, mailer, database } = await openAuthApp();

        const owner = await registerVerifiedUser(app, mailer, { name: "邀请人", email: "inviter@example.com" });
        const created = await app.inject({
            method: "POST",
            url: "/api/auth/organization/create",
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
            payload: { name: "受邀工作区", slug: "invited-workspace" },
        });

        expect(created.statusCode).toBe(200);

        const invited = await app.inject({
            method: "POST",
            url: "/api/auth/organization/invite-member",
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member", organizationId: created.json().id },
        });

        expect(invited.statusCode).toBe(200);

        const stored = await database.pool.query(
            'select "id", "email", "status", "expiresAt" from "workspace_invitations"',
        );

        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0]?.status).toBe("pending");
        expect(stored.rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());

        expect(mailer.invitations).toHaveLength(1);
        expect(mailer.invitations[0]?.email).toBe("invitee@example.com");

        // 邮件必须给出可直接打开的同源接受链接，而不是裸邀请 id。
        const acceptUrl = new URL(mailer.invitations[0]!.invitationUrl);

        expect(acceptUrl.origin).toBe(APP_ORIGIN);
        expect(acceptUrl.pathname).toBe(`/accept-invitation/${stored.rows[0]?.id}`);
    }, 60_000);

    it("accepts the invitation with the id carried by the emailed URL", async () => {
        const { app, mailer, database } = await openAuthApp();

        const owner = await registerVerifiedUser(app, mailer, { name: "邀请人", email: "inviter2@example.com" });
        const created = await app.inject({
            method: "POST",
            url: "/api/auth/organization/create",
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
            payload: { name: "接受邀请工作区", slug: "accepted-workspace" },
        });
        await app.inject({
            method: "POST",
            url: "/api/auth/organization/invite-member",
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
            payload: { email: "invitee2@example.com", role: "member", organizationId: created.json().id },
        });

        expect(mailer.invitations).toHaveLength(1);

        const invitationId = new URL(mailer.invitations[0]!.invitationUrl).pathname.split("/").pop();
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee2@example.com" });

        const accepted = await app.inject({
            method: "POST",
            url: "/api/auth/organization/accept-invitation",
            headers: { origin: APP_ORIGIN, cookie: invitee.cookie },
            payload: { invitationId },
        });

        expect(accepted.statusCode).toBe(200);

        const members = await database.pool.query(
            'select "userId", "role" from "workspace_members" where "organizationId" = $1',
            [created.json().id],
        );

        expect(members.rows).toHaveLength(2);
        expect(members.rows).toEqual(
            expect.arrayContaining([
                { userId: owner.userId, role: "owner" },
                { userId: invitee.userId, role: "member" },
            ]),
        );

        const invitations = await database.pool.query('select "status" from "workspace_invitations"');

        expect(invitations.rows[0]?.status).toBe("accepted");
    }, 90_000);
});

describe("auth schema constraints", () => {
    it("rejects a duplicate provider identity at the database level", async () => {
        const { database } = await openAuthApp();

        await database.pool.query(
            'insert into "users" ("id", "name", "email", "emailVerified") values ($1, $2, $3, true)',
            ["user-accounts", "凭据用户", "accounts@example.com"],
        );
        const insertAccount = (id: string) =>
            database.pool.query(
                'insert into "accounts" ("id", "issuer", "accountId", "providerId", "userId") values ($1, $2, $3, $4, $5)',
                [id, "https://accounts.google.com", "google-subject-1", "google", "user-accounts"],
            );

        await expect(insertAccount("account-1")).resolves.toBeTruthy();

        // 迁移自带的 (issuer, accountId) 唯一索引必须独立于应用代码阻止身份抢占。
        await expect(insertAccount("account-2")).rejects.toThrow();
    }, 60_000);
});
