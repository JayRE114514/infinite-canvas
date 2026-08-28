import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    APP_ORIGIN,
    PASSWORD,
    cookieHeader,
    createAuthTestHarness,
    registerVerifiedUser,
} from "../helpers/auth.js";

const harness = createAuthTestHarness();
const openApp = harness.openApp;
const openAuthApp = harness.openAuthApp;
const PRODUCTION_ORIGIN = "https://canvas.example.com";

beforeAll(async () => {
    await harness.start();
}, 180_000);

afterEach(async () => {
    await harness.cleanup();
}, 30_000);

afterAll(async () => {
    await harness.stop();
}, 60_000);

describe("session guard", () => {
    it("returns 401 from the workspace list without a session", async () => {
        const { app } = await openAuthApp();

        const response = await app.inject({ method: "GET", url: "/api/v1/workspaces" });

        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("unauthenticated");
    }, 60_000);

    it("keeps protected workspace routes absent from the pure app", async () => {
        const app = await openApp({ logger: false });

        const response = await app.inject({ method: "GET", url: "/api/v1/workspaces" });

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
        expect(String(signIn.headers["set-cookie"])).not.toContain("; Secure");
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

    it("accepts the session cookie on the protected workspace list", async () => {
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

        const response = await app.inject({ method: "GET", url: "/api/v1/workspaces", headers: { cookie } });

        expect(response.statusCode).toBe(200);
        expect(response.json().workspaces).toEqual([
            expect.objectContaining({ type: "personal", role: "owner" }),
        ]);
    }, 60_000);
});

describe("auth route mounting", () => {
    it("does not expose unsupported methods on identity endpoints", async () => {
        const { app } = await openAuthApp();

        const deleted = await app.inject({ method: "DELETE", url: "/api/auth/sign-out", headers: { origin: APP_ORIGIN } });

        expect(deleted.statusCode).toBe(404);
        expect(deleted.json().error.code).toBe("not_found");
    }, 60_000);

    it.each([
        ["POST", "/api/auth/organization/create"],
        ["POST", "/api/auth/organization/delete"],
        ["GET", "/api/auth/organization/list-invitations?organizationId=workspace-id"],
        ["POST", "/api/auth/organization/invite-member"],
        ["POST", "/api/auth/organization/update"],
        ["POST", "/api/auth/organization/add-member"],
        ["POST", "/api/auth/organization/remove-member"],
        ["POST", "/api/auth/organization/update-member-role"],
        ["POST", "/api/auth/organization/accept-invitation"],
    ] as const)("does not mount the Organization business route %s %s", async (method, url) => {
        const { app } = await openAuthApp();

        const response = await app.inject({
            method,
            url,
            headers: { origin: APP_ORIGIN },
            ...(method === "POST" ? { payload: {} } : {}),
        });

        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("not_found");
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

    it("sets Secure, HttpOnly, SameSite=Lax session cookies in production", async () => {
        const { app, mailer } = await openAuthApp({ nodeEnv: "production", appOrigin: PRODUCTION_ORIGIN });

        await app.inject({
            method: "POST",
            url: "/api/auth/sign-up/email",
            headers: { origin: PRODUCTION_ORIGIN },
            payload: { name: "生产用户", email: "production@example.com", password: PASSWORD },
        });
        const verificationUrl = new URL(mailer.messages[0]!.verificationUrl);
        await app.inject({ method: "GET", url: verificationUrl.pathname + verificationUrl.search });
        const signIn = await app.inject({
            method: "POST",
            url: "/api/auth/sign-in/email",
            headers: { origin: PRODUCTION_ORIGIN },
            payload: { email: "production@example.com", password: PASSWORD },
        });
        const setCookies = Array.isArray(signIn.headers["set-cookie"])
            ? signIn.headers["set-cookie"]
            : [signIn.headers["set-cookie"]].filter((value): value is string => Boolean(value));
        const sessionCookie = setCookies.find((value) => value.includes("session_token="));

        expect(signIn.statusCode).toBe(200);
        expect(sessionCookie).toContain("Secure");
        expect(sessionCookie).toContain("HttpOnly");
        expect(sessionCookie).toContain("SameSite=Lax");
    }, 60_000);
});

describe("workspace mapping", () => {
    it("stores an application-created team as a workspace row with one owner", async () => {
        const { app, mailer, adminPool } = await openAuthApp();

        const owner = await registerVerifiedUser(app, mailer, { name: "工作区所有者", email: "owner@example.com" });

        const created = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
            payload: { name: "团队工作区", slug: "team-workspace" },
        });

        expect(created.statusCode).toBe(201);

        const workspaces = await adminPool.query(
            `select "id", "type", "status", "owner_user_id", "slug"
             from "workspaces" where "type" = 'team'`,
        );

        expect(workspaces.rows).toHaveLength(1);
        expect(workspaces.rows[0]).toMatchObject({
            id: created.json().workspace.id,
            type: "team",
            status: "active",
            slug: "team-workspace",
            owner_user_id: owner.userId,
        });

        const members = await adminPool.query(
            'select "user_id", "role", "workspace_id" from "workspace_members" where "workspace_id" = $1',
            [created.json().workspace.id],
        );

        expect(members.rows).toHaveLength(1);
        expect(members.rows[0]).toMatchObject({
            user_id: owner.userId,
            role: "owner",
            workspace_id: created.json().workspace.id,
        });
    }, 60_000);

    it("does not expose identity APIs that can create or delete workspaces", async () => {
        const { app } = await openAuthApp();
        if (!app.auth) throw new Error("Auth is not registered");

        expect(app.auth.api).not.toHaveProperty("createOrganization");
        expect(app.auth.api).not.toHaveProperty("deleteOrganization");
        expect(app.auth.api).not.toHaveProperty("addMember");
        expect(app.auth.api).not.toHaveProperty("createInvitation");
    }, 60_000);

    it("allows only one personal workspace per owner", async () => {
        const { adminPool } = await openAuthApp();

        await adminPool.query(
            'insert into "users" ("id", "name", "email", "emailVerified") values ($1, $2, $3, true)',
            ["user-personal", "个人用户", "personal@example.com"],
        );
        const insertWorkspace = async (id: string, slug: string, type: string) => {
            const client = await adminPool.connect();
            try {
                await client.query("begin");
                await client.query(
                    'insert into "workspaces" ("id", "name", "slug", "type", "status", "owner_user_id") values ($1, $2, $3, $4, \'active\', $5)',
                    [id, slug, slug, type, "user-personal"],
                );
                await client.query(
                    'insert into "workspace_members" ("id", "workspace_id", "user_id", "role", "status") values ($1, $2, $3, \'owner\', \'active\')',
                    [`member-${id}`, id, "user-personal"],
                );
                await client.query("commit");
            } catch (error) {
                await client.query("rollback").catch(() => {});
                throw error;
            } finally {
                client.release();
            }
        };

        await insertWorkspace("ws-personal", "personal-one", "personal");

        await expect(insertWorkspace("ws-personal-2", "personal-two", "personal")).rejects.toThrow();

        await expect(insertWorkspace("ws-team", "team-one", "team")).resolves.toBeUndefined();
    }, 60_000);
});

describe("workspace invitations", () => {
    it("emails a same-origin acceptance URL carrying the raw token only", async () => {
        const { app, mailer, adminPool } = await openAuthApp();

        const owner = await registerVerifiedUser(app, mailer, { name: "邀请人", email: "inviter@example.com" });
        const created = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
            payload: { name: "受邀工作区", slug: "invited-workspace" },
        });

        expect(created.statusCode).toBe(201);
        const workspaceId = created.json().workspace.id as string;

        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspaceId}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });

        expect(invited.statusCode).toBe(201);

        const stored = await adminPool.query(
            'select "id", "email", "status", "expires_at", "token_digest" from "workspace_invitations"',
        );

        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0]?.status).toBe("pending");
        expect(stored.rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());

        expect(mailer.invitations).toHaveLength(1);
        expect(mailer.invitations[0]?.email).toBe("invitee@example.com");

        // 邮件给出同源 token 链接；数据库与响应都不包含原始 token。
        const acceptUrl = new URL(mailer.invitations[0]!.invitationUrl);
        const token = decodeURIComponent(acceptUrl.pathname.split("/").at(-1) ?? "");

        expect(acceptUrl.origin).toBe(APP_ORIGIN);
        expect(acceptUrl.pathname).toBe(`/accept-invitation/${encodeURIComponent(token)}`);
        expect(token).not.toBe(stored.rows[0]?.id);
        expect(stored.rows[0]?.token_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(stored.rows[0]?.token_digest).not.toBe(token);
        expect(invited.body).not.toContain(token);
    }, 60_000);

    it("accepts the invitation with the token carried by the emailed URL", async () => {
        const { app, mailer, adminPool } = await openAuthApp();

        const owner = await registerVerifiedUser(app, mailer, { name: "邀请人", email: "inviter2@example.com" });
        const created = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
            payload: { name: "接受邀请工作区", slug: "accepted-workspace" },
        });
        const workspaceId = created.json().workspace.id as string;
        await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspaceId}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee2@example.com", role: "member" },
        });

        expect(mailer.invitations).toHaveLength(1);

        const token = decodeURIComponent(new URL(mailer.invitations[0]!.invitationUrl).pathname.split("/").pop() ?? "");
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee2@example.com" });

        const accepted = await app.inject({
            method: "POST",
            url: "/api/v1/workspace-invitations/accept",
            headers: { cookie: invitee.cookie },
            payload: { token },
        });

        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ workspaceId });

        const members = await adminPool.query(
            'select "user_id", "role" from "workspace_members" where "workspace_id" = $1',
            [workspaceId],
        );

        expect(members.rows).toHaveLength(2);
        expect(members.rows).toEqual(
            expect.arrayContaining([
                { user_id: owner.userId, role: "owner" },
                { user_id: invitee.userId, role: "member" },
            ]),
        );

        const invitations = await adminPool.query('select "status" from "workspace_invitations"');

        expect(invitations.rows[0]?.status).toBe("accepted");
    }, 90_000);
});

describe("auth schema constraints", () => {
    it("rejects a duplicate provider identity at the database level", async () => {
        const { adminPool } = await openAuthApp();

        await adminPool.query(
            'insert into "users" ("id", "name", "email", "emailVerified") values ($1, $2, $3, true)',
            ["user-accounts", "凭据用户", "accounts@example.com"],
        );
        const insertAccount = (id: string) =>
            adminPool.query(
                'insert into "accounts" ("id", "issuer", "accountId", "providerId", "userId") values ($1, $2, $3, $4, $5)',
                [id, "https://accounts.google.com", "google-subject-1", "google", "user-accounts"],
            );

        await expect(insertAccount("account-1")).resolves.toBeTruthy();

        // 迁移自带的 (issuer, accountId) 唯一索引必须独立于应用代码阻止身份抢占。
        await expect(insertAccount("account-2")).rejects.toThrow();
    }, 60_000);
});
