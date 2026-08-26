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
        const { app, mailer, database } = await openAuthApp();

        const owner = await registerVerifiedUser(app, mailer, { name: "工作区所有者", email: "owner@example.com" });

        const created = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
            payload: { name: "团队工作区", slug: "team-workspace" },
        });

        expect(created.statusCode).toBe(201);

        const workspaces = await database.pool.query(
            'select "id", "workspace_type", "status", "owner_user_id", "slug" from "workspaces"',
        );

        expect(workspaces.rows).toHaveLength(1);
        expect(workspaces.rows[0]).toMatchObject({
            id: created.json().workspace.id,
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
            organizationId: created.json().workspace.id,
        });
    }, 60_000);

    it("disallows direct Better Auth Organization creation as defense in depth", async () => {
        const { app, mailer } = await openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "工作区所有者", email: "owner@example.com" });
        if (!app.auth) throw new Error("Auth is not registered");

        await expect(
            app.auth.api.createOrganization({
                headers: new Headers({ origin: APP_ORIGIN, cookie: owner.cookie }),
                body: { name: "绕过团队", slug: "bypass-team" },
            }),
        ).rejects.toMatchObject({ statusCode: 403 });
    }, 60_000);

    it("disables Better Auth Organization deletion as defense in depth", async () => {
        const { app, mailer, database } = await openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "工作区所有者", email: "owner@example.com" });
        const created = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
            payload: { name: "保留团队", slug: "retained-team" },
        });
        const workspaceId = created.json().workspace.id as string;
        if (!app.auth) throw new Error("Auth is not registered");

        await expect(
            app.auth.api.deleteOrganization({
                headers: new Headers({ origin: APP_ORIGIN, cookie: owner.cookie }),
                body: { organizationId: workspaceId },
            }),
        ).rejects.toMatchObject({ statusCode: 404 });
        const stored = await database.pool.query('select "id" from "workspaces" where "id" = $1', [workspaceId]);

        expect(stored.rows).toEqual([{ id: workspaceId }]);
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

        const invitationId = new URL(mailer.invitations[0]!.invitationUrl).pathname.split("/").pop();
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee2@example.com" });

        const accepted = await app.inject({
            method: "POST",
            url: `/api/v1/workspace-invitations/${invitationId}/accept`,
            headers: { cookie: invitee.cookie },
        });

        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ workspaceId });

        const members = await database.pool.query(
            'select "userId", "role" from "workspace_members" where "organizationId" = $1',
            [workspaceId],
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
