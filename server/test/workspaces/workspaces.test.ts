import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sql } from "drizzle-orm";

import { withUserTransaction } from "../../src/infrastructure/database/transactions.js";
import { hashInvitationToken, provisionPersonalWorkspace } from "../../src/modules/workspaces/service.js";
import {
    APP_ORIGIN,
    PASSWORD,
    cookieHeader,
    createAuthTestHarness,
    registerUserWithoutVerification,
    registerVerifiedUser,
    verifyLatestEmail,
    type AuthApp,
    type MemoryMailer,
    type VerifiedUser,
} from "../helpers/auth.js";

const harness = createAuthTestHarness();

type VerificationCallback = (user: { id: string; name: string; email: string }) => Promise<void>;

function requireVerificationCallback(app: AuthApp): VerificationCallback {
    const emailVerification = app.auth?.options.emailVerification as
        | { afterEmailVerification?: VerificationCallback }
        | undefined;
    expect(emailVerification?.afterEmailVerification).toBeTypeOf("function");
    return emailVerification!.afterEmailVerification!;
}

function latestInvitationToken(mailer: MemoryMailer): string {
    const url = new URL(mailer.invitations.at(-1)?.invitationUrl ?? "");
    const token = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    if (!token) throw new Error("Invitation URL has no token");
    return token;
}

async function createTeam(app: AuthApp, owner: VerifiedUser, name: string, slug: string) {
    const response = await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: { cookie: owner.cookie },
        payload: { name, slug },
    });

    expect(response.statusCode).toBe(201);
    return response.json().workspace as { id: string; name: string; slug: string };
}

async function inviteAndAccept(
    app: AuthApp,
    mailer: MemoryMailer,
    inviter: VerifiedUser,
    workspaceId: string,
    invitee: { name: string; email: string; role: "admin" | "member" },
) {
    const invitationCount = mailer.invitations.length;
    const invited = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/invitations`,
        headers: { cookie: inviter.cookie },
        payload: { email: invitee.email, role: invitee.role },
    });

    expect(invited.statusCode).toBe(201);
    const invitationId = invited.json().invitation.id as string;
    expect(mailer.invitations).toHaveLength(invitationCount + 1);
    const token = latestInvitationToken(mailer);
    const user = await registerVerifiedUser(app, mailer, invitee);
    const accepted = await app.inject({
        method: "POST",
        url: "/api/v1/workspace-invitations/accept",
        headers: { cookie: user.cookie },
        payload: { token },
    });

    expect(accepted.statusCode, accepted.body).toBe(200);
    return { ...user, invitationId, token };
}

beforeAll(async () => {
    await harness.start();
}, 180_000);

afterEach(async () => {
    await harness.cleanup();
}, 30_000);

afterAll(async () => {
    await harness.stop();
}, 60_000);

describe("personal Workspace provisioning", () => {
    it("concurrent direct provisioning converges on one Workspace, owner member, and audit", async () => {
        const { database, adminPool } = await harness.openAuthApp();
        const user = { id: "personal-concurrent", name: "并发用户", email: "concurrent@example.com" };
        await adminPool.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            user.id,
            user.name,
            user.email,
        ]);
        const event = {
            source: "email_verification" as const,
            eventId: `personal-workspace:email-verification:${user.id}`,
        };

        const [first, second] = await Promise.all([
            provisionPersonalWorkspace(database.db, user, event),
            provisionPersonalWorkspace(database.db, user, event),
        ]);
        const stored = await adminPool.query(
            `select w.id, w.status, m.role, m.status as member_status
             from public.workspaces w
             join public.workspace_members m on m.workspace_id = w.id
             where w.owner_user_id = $1 and w.type = 'personal'`,
            [user.id],
        );
        const audits = await adminPool.query(
            "select source, event_id, workspace_id from public.workspace_provisioning_audits where user_id = $1",
            [user.id],
        );

        expect(second.id).toBe(first.id);
        expect(stored.rows).toEqual([
            { id: first.id, status: "active", role: "owner", member_status: "active" },
        ]);
        expect(audits.rows).toEqual([
            { source: event.source, event_id: event.eventId, workspace_id: first.id },
        ]);
    }, 60_000);

    it("direct provisioning rolls back Workspace and audit when owner insertion fails", async () => {
        const { database, adminPool } = await harness.openAuthApp();
        const user = { id: "personal-rollback", name: "回滚用户", email: "rollback@example.com" };
        await adminPool.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            user.id,
            user.name,
            user.email,
        ]);
        await adminPool.query(`
            create function fail_provisioning_owner_insert() returns trigger language plpgsql as $$
            begin
                raise exception 'injected provisioning owner failure' using errcode = 'P5501';
            end
            $$;
            create trigger fail_provisioning_owner_insert before insert on public.workspace_members
            for each row execute function fail_provisioning_owner_insert();
        `);

        try {
            await expect(
                provisionPersonalWorkspace(database.db, user, {
                    source: "email_verification",
                    eventId: `personal-workspace:email-verification:${user.id}`,
                }),
            ).rejects.toMatchObject({ cause: { code: "P5501" } });
        } finally {
            await adminPool.query(`
                drop trigger fail_provisioning_owner_insert on public.workspace_members;
                drop function fail_provisioning_owner_insert();
            `);
        }
        const rows = await adminPool.query(
            `select
                (select count(*)::int from public.workspaces where owner_user_id = $1 and type = 'personal') as workspaces,
                (select count(*)::int from public.workspace_members where user_id = $1) as members,
                (select count(*)::int from public.workspace_provisioning_audits where user_id = $1) as audits`,
            [user.id],
        );

        expect(rows.rows).toEqual([{ workspaces: 0, members: 0, audits: 0 }]);
    }, 60_000);

    it("direct provisioning rejects an unverified persisted user", async () => {
        const { database, adminPool } = await harness.openAuthApp();
        const user = { id: "personal-unverified", name: "未验证用户", email: "unverified-direct@example.com" };
        await adminPool.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, false)', [
            user.id,
            user.name,
            user.email,
        ]);

        await expect(
            provisionPersonalWorkspace(database.db, user, {
                source: "explicit_repair",
                eventId: `personal-workspace:explicit-repair:${user.id}`,
            }),
        ).rejects.toMatchObject({ code: "email_verification_required", statusCode: 403 });

        const stored = await adminPool.query(
            "select count(*)::int as count from public.workspaces where owner_user_id = $1",
            [user.id],
        );
        expect(stored.rows).toEqual([{ count: 0 }]);
    }, 60_000);

    it("direct provisioning returns an inactive lifetime personal Workspace without replacing or reactivating it", async () => {
        const { database, adminPool } = await harness.openAuthApp();
        const user = { id: "personal-inactive", name: "停用用户", email: "inactive@example.com" };
        await adminPool.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            user.id,
            user.name,
            user.email,
        ]);
        await adminPool.query(
            "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, $2, $3, 'personal', $4, 'suspended')",
            ["inactive-personal-workspace", "停用个人空间", "inactive-personal-workspace", user.id],
        );
        await adminPool.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
            ["inactive-personal-owner", "inactive-personal-workspace", user.id],
        );

        const workspace = await provisionPersonalWorkspace(database.db, user, {
            source: "explicit_repair",
            eventId: `personal-workspace:explicit-repair:${user.id}`,
        });
        const stored = await adminPool.query(
            "select id, status, deleted_at from public.workspaces where owner_user_id = $1 and type = 'personal'",
            [user.id],
        );

        expect(workspace).toMatchObject({ id: "inactive-personal-workspace", status: "suspended" });
        expect(stored.rows).toEqual([{ id: "inactive-personal-workspace", status: "suspended", deleted_at: null }]);
    }, 60_000);

    it("direct provisioning rejects divergent audit history and rolls back a new personal Workspace", async () => {
        const { database, adminPool } = await harness.openAuthApp();
        const user = { id: "personal-divergent", name: "分叉用户", email: "divergent@example.com" };
        const client = await adminPool.connect();
        try {
            await client.query("begin");
            await client.query(
                'insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)',
                [user.id, user.name, user.email],
            );
            await client.query(
                "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, $2, $3, 'team', $4, 'active')",
                ["divergent-team", "分叉团队", "divergent-team", user.id],
            );
            await client.query(
                "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
                ["divergent-team-owner", "divergent-team", user.id],
            );
            await client.query(
                "insert into public.workspace_provisioning_audits (user_id, source, event_id, workspace_id, transaction_xid) values ($1, 'email_verification', $2, $3, pg_current_xact_id())",
                [user.id, "personal-workspace:email-verification:different", "divergent-team"],
            );
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        } finally {
            client.release();
        }

        await expect(
            provisionPersonalWorkspace(database.db, user, {
                source: "email_verification",
                eventId: `personal-workspace:email-verification:${user.id}`,
            }),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
        const personal = await adminPool.query(
            "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
            [user.id],
        );
        const audits = await adminPool.query(
            "select event_id, workspace_id from public.workspace_provisioning_audits where user_id = $1",
            [user.id],
        );

        expect(personal.rows).toEqual([]);
        expect(audits.rows).toEqual([
            { event_id: "personal-workspace:email-verification:different", workspace_id: "divergent-team" },
        ]);
    }, 60_000);

    it("concurrent composed verification callbacks converge with the deterministic verification event", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const user = await registerUserWithoutVerification(app, mailer, {
            name: "并发回调用户",
            email: "concurrent-callback@example.com",
        });
        await adminPool.query('update public.users set "emailVerified" = true where id = $1', [user.userId]);
        const callback = requireVerificationCallback(app);

        await Promise.all([
            callback({ id: user.userId, name: "并发回调用户", email: "concurrent-callback@example.com" }),
            callback({ id: user.userId, name: "并发回调用户", email: "concurrent-callback@example.com" }),
        ]);
        const stored = await adminPool.query(
            `select w.id, m.role, a.source, a.event_id
             from public.workspaces w
             join public.workspace_members m on m.workspace_id = w.id
             join public.workspace_provisioning_audits a on a.workspace_id = w.id
             where w.owner_user_id = $1 and w.type = 'personal'`,
            [user.userId],
        );

        expect(stored.rows).toEqual([
            {
                id: expect.any(String),
                role: "owner",
                source: "email_verification",
                event_id: `personal-workspace:email-verification:${user.userId}`,
            },
        ]);
    }, 60_000);

    it("provisions one personal Workspace when email verification succeeds", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const user = await registerUserWithoutVerification(app, mailer, {
            name: "验证开通用户",
            email: "verification-provisioning@example.com",
        });

        const before = await adminPool.query(
            "select count(*)::int as count from public.workspaces where owner_user_id = $1 and type = 'personal'",
            [user.userId],
        );
        const verification = await verifyLatestEmail(app, user);
        const after = await adminPool.query(
            "select count(*)::int as count from public.workspaces where owner_user_id = $1 and type = 'personal'",
            [user.userId],
        );
        const audits = await adminPool.query(
            "select source, event_id from public.workspace_provisioning_audits where user_id = $1",
            [user.userId],
        );

        expect(before.rows).toEqual([{ count: 0 }]);
        expect(verification.statusCode).toBe(302);
        expect(after.rows).toEqual([{ count: 1 }]);
        expect(audits.rows).toEqual([
            {
                source: "email_verification",
                event_id: `personal-workspace:email-verification:${user.userId}`,
            },
        ]);
    }, 60_000);

    it("keeps GET workspaces read-only when verified-user provisioning is missing", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const user = await registerUserWithoutVerification(app, mailer, {
            name: "缺失空间用户",
            email: "missing-personal@example.com",
        });
        await adminPool.query(`
            create function fail_personal_owner_insert() returns trigger language plpgsql as $$
            begin
                raise exception 'injected owner failure';
            end
            $$;
            create trigger fail_personal_owner_insert before insert on public.workspace_members
            for each row execute function fail_personal_owner_insert();
        `);
        try {
            await verifyLatestEmail(app, user);
        } finally {
            await adminPool.query(`
                drop trigger fail_personal_owner_insert on public.workspace_members;
                drop function fail_personal_owner_insert();
            `);
        }
        const signIn = await app.inject({
            method: "POST",
            url: "/api/auth/sign-in/email",
            headers: { origin: APP_ORIGIN },
            payload: { email: "missing-personal@example.com", password: PASSWORD },
        });

        const response = await app.inject({
            method: "GET",
            url: "/api/v1/workspaces",
            headers: { cookie: cookieHeader(signIn.headers["set-cookie"]) },
        });
        const stored = await adminPool.query(
            "select count(*)::int as count from public.workspaces where owner_user_id = $1 and type = 'personal'",
            [user.userId],
        );

        expect(signIn.statusCode).toBe(200);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ workspaces: [] });
        expect(stored.rows).toEqual([{ count: 0 }]);
    }, 90_000);

    it("replays explicit repair naturally and records one audit per trusted source", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const user = await registerVerifiedUser(app, mailer, {
            name: "修复用户",
            email: "repair-route@example.com",
        });
        const before = await adminPool.query(
            "select id from public.workspaces where owner_user_id = $1 and type = 'personal'",
            [user.userId],
        );

        const first = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces/personal/repair",
            headers: { cookie: user.cookie, "idempotency-key": "ignored-first-key" },
        });
        const replay = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces/personal/repair",
            headers: { cookie: user.cookie, "idempotency-key": "ignored-second-key" },
        });
        const audits = await adminPool.query(
            "select source, event_id, workspace_id from public.workspace_provisioning_audits where user_id = $1 order by source",
            [user.userId],
        );

        expect(first.statusCode).toBe(200);
        expect(replay.statusCode).toBe(200);
        expect(first.json().workspace).toMatchObject({
            id: before.rows[0]?.id,
            type: "personal",
            ownerUserId: user.userId,
            role: "owner",
        });
        expect(replay.json()).toEqual(first.json());
        expect(audits.rows).toEqual([
            {
                source: "email_verification",
                event_id: `personal-workspace:email-verification:${user.userId}`,
                workspace_id: before.rows[0]?.id,
            },
            {
                source: "explicit_repair",
                event_id: `personal-workspace:explicit-repair:${user.userId}`,
                workspace_id: before.rows[0]?.id,
            },
        ]);
    }, 90_000);

    it("keeps repair authenticated, bodyless, strict, and verified-only", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const unauthenticated = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces/personal/repair",
        });
        const user = await registerVerifiedUser(app, mailer, {
            name: "严格修复用户",
            email: "strict-repair@example.com",
        });
        const withBody = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces/personal/repair",
            headers: { cookie: user.cookie },
            payload: {
                source: "email_verification",
                eventId: "request-controlled-event",
            },
        });
        await adminPool.query('update public.users set "emailVerified" = false where id = $1', [user.userId]);
        const unverified = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces/personal/repair",
            headers: { cookie: user.cookie },
        });
        const repairAudits = await adminPool.query(
            "select count(*)::int as count from public.workspace_provisioning_audits where user_id = $1 and source = 'explicit_repair'",
            [user.userId],
        );

        expect(unauthenticated.statusCode).toBe(401);
        expect(withBody.statusCode).toBe(400);
        expect(unverified.statusCode).toBe(403);
        expect(unverified.json().error.code).toBe("email_verification_required");
        expect(repairAudits.rows).toEqual([{ count: 0 }]);
    }, 90_000);

    it("repairs after Better Auth commits verification but the callback fails", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const user = await registerUserWithoutVerification(app, mailer, {
            name: "回调失败用户",
            email: "callback-failure@example.com",
        });
        const emailVerification = app.auth?.options.emailVerification as
            | { afterEmailVerification?: VerificationCallback }
            | undefined;
        if (!emailVerification) throw new Error("Email verification is not configured");
        emailVerification.afterEmailVerification = async () => {
            throw new Error("injected post-commit callback failure");
        };

        const verification = await verifyLatestEmail(app, user);
        const afterFailure = await adminPool.query(
            `select u."emailVerified" as verified,
                    (select count(*)::int from public.workspaces w where w.owner_user_id = u.id and w.type = 'personal') as workspaces
             from public.users u where u.id = $1`,
            [user.userId],
        );
        const signIn = await app.inject({
            method: "POST",
            url: "/api/auth/sign-in/email",
            headers: { origin: APP_ORIGIN },
            payload: { email: "callback-failure@example.com", password: PASSWORD },
        });
        const cookie = cookieHeader(signIn.headers["set-cookie"]);
        const first = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces/personal/repair",
            headers: { cookie },
        });
        const replay = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces/personal/repair",
            headers: { cookie },
        });
        const stored = await adminPool.query(
            `select w.id,
                    count(distinct m.id)::int as members,
                    count(distinct a.id)::int as audits,
                    min(a.source) as source,
                    min(a.event_id) as event_id
             from public.workspaces w
             join public.workspace_members m on m.workspace_id = w.id and m.role = 'owner' and m.status = 'active'
             join public.workspace_provisioning_audits a on a.workspace_id = w.id
             where w.owner_user_id = $1 and w.type = 'personal'
             group by w.id`,
            [user.userId],
        );

        expect(verification.statusCode).toBe(500);
        expect(afterFailure.rows).toEqual([{ verified: true, workspaces: 0 }]);
        expect(signIn.statusCode).toBe(200);
        expect(first.statusCode).toBe(200);
        expect(replay.json()).toEqual(first.json());
        expect(stored.rows).toEqual([
            {
                id: first.json().workspace.id,
                members: 1,
                audits: 1,
                source: "explicit_repair",
                event_id: `personal-workspace:explicit-repair:${user.userId}`,
            },
        ]);
    }, 90_000);
});

describe("workspace routes", () => {
    it("requires an authenticated verified user to create a team", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const user = await registerVerifiedUser(app, mailer, { name: "待验证所有者", email: "unverified@example.com" });
        await adminPool.query('update "users" set "emailVerified" = false where "id" = $1', [user.userId]);

        const unauthenticated = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            payload: { name: "匿名团队", slug: "anonymous-team" },
        });
        const unverified = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            headers: { cookie: user.cookie },
            payload: { name: "未验证团队", slug: "unverified-team" },
        });
        const stored = await adminPool.query(
            'select "slug" from "workspaces" where "slug" in ($1, $2)',
            ["anonymous-team", "unverified-team"],
        );

        expect(unauthenticated.statusCode).toBe(401);
        expect(unauthenticated.json().error.code).toBe("unauthenticated");
        expect(unverified.statusCode).toBe(403);
        expect(unverified.json().error.code).toBe("email_verification_required");
        expect(stored.rows).toHaveLength(0);
    }, 60_000);

    it("creates a team transactionally with one owner member", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "团队所有者", email: "owner@example.com" });

        const workspace = await createTeam(app, owner, "产品团队", "product-team");
        const stored = await adminPool.query(
            'select w."type", w."owner_user_id", m."role" from "workspaces" w join "workspace_members" m on m."workspace_id" = w."id" where w."id" = $1',
            [workspace.id],
        );

        expect(workspace).toMatchObject({ name: "产品团队", slug: "product-team" });
        expect(stored.rows).toEqual([{ type: "team", owner_user_id: owner.userId, role: "owner" }]);
    }, 60_000);

    it("rolls back the team row when owner membership insertion fails", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "事务所有者", email: "transaction@example.com" });
        await adminPool.query(`
            create function fail_workspace_member_insert() returns trigger language plpgsql as $$
            begin
                raise exception 'injected membership failure';
            end
            $$;
            create trigger fail_workspace_member_insert before insert on "workspace_members"
            for each row execute function fail_workspace_member_insert();
        `);

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
            payload: { name: "失败团队", slug: "failed-team" },
        });
        const stored = await adminPool.query('select "id" from "workspaces" where "slug" = $1', ["failed-team"]);

        expect(response.statusCode).toBe(500);
        expect(response.json().error.code).toBe("internal_error");
        expect(response.body).not.toContain("injected membership failure");
        expect(stored.rows).toHaveLength(0);
    }, 60_000);

    it("returns a stable slug conflict when concurrent team creation collides", async () => {
        const { app, mailer } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "团队所有者", email: "slug-owner@example.com" });
        const create = (name: string) =>
            app.inject({
                method: "POST",
                url: "/api/v1/workspaces",
                headers: { cookie: owner.cookie },
                payload: { name, slug: "same-team" },
            });

        const responses = await Promise.all([create("团队甲"), create("团队乙")]);
        const sorted = responses.sort((left, right) => left.statusCode - right.statusCode);

        expect(sorted.map((response) => response.statusCode)).toEqual([201, 409]);
        expect(sorted[1]!.json().error.code).toBe("workspace_slug_taken");
    }, 60_000);

    it("denies a user outside the path workspace", async () => {
        const { app, mailer } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const outsider = await registerVerifiedUser(app, mailer, { name: "外部用户", email: "outsider@example.com" });
        const workspace = await createTeam(app, owner, "私有团队", "private-team");

        const response = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}`,
            headers: { cookie: outsider.cookie },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe("workspace_forbidden");
    }, 60_000);

    it("authorizes from current database membership on every request", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "实时权限团队", "fresh-membership");
        const member = await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "普通成员",
            email: "member@example.com",
            role: "member",
        });
        const before = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}`,
            headers: { cookie: member.cookie },
        });
        await adminPool.query(
            'update "workspace_members" set "status" = \'removed\' where "workspace_id" = $1 and "user_id" = $2',
            [workspace.id, member.userId],
        );
        const after = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}`,
            headers: { cookie: member.cookie },
        });

        expect(before.statusCode).toBe(200);
        expect(after.statusCode).toBe(403);
        expect(after.json().error.code).toBe("workspace_forbidden");
    }, 90_000);

    it("allows an owner to patch a team and rejects a member", async () => {
        const { app, mailer } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "旧名称", "old-name");
        const member = await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "普通成员",
            email: "member@example.com",
            role: "member",
        });

        const updated = await app.inject({
            method: "PATCH",
            url: `/api/v1/workspaces/${workspace.id}`,
            headers: { cookie: owner.cookie },
            payload: { name: "新名称", slug: "new-name" },
        });
        const denied = await app.inject({
            method: "PATCH",
            url: `/api/v1/workspaces/${workspace.id}`,
            headers: { cookie: member.cookie },
            payload: { name: "越权名称" },
        });

        expect(updated.statusCode).toBe(200);
        expect(updated.json().workspace).toMatchObject({ id: workspace.id, name: "新名称", slug: "new-name" });
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.code).toBe("workspace_admin_required");
    }, 90_000);
});

describe("workspace members and invitations", () => {
    it("rejects all personal member and invitation mutations with the stable conflict", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "个人用户", email: "personal@example.com" });
        const listed = await app.inject({ method: "GET", url: "/api/v1/workspaces", headers: { cookie: owner.cookie } });
        const workspaceId = listed.json().workspaces[0].id as string;
        const members = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspaceId}/members`,
            headers: { cookie: owner.cookie },
        });
        const memberId = members.json().members[0].id as string;

        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspaceId}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "other@example.com", role: "member" },
        });
        const removed = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${workspaceId}/members/${memberId}`,
            headers: { cookie: owner.cookie },
        });
        const storedInvitations = await adminPool.query(
            'select count(*)::int as count from "workspace_invitations" where "workspace_id" = $1',
            [workspaceId],
        );

        expect(invited.statusCode).toBe(409);
        expect(invited.json().error.code).toBe("personal_workspace_single_member");
        expect(removed.statusCode).toBe(409);
        expect(removed.json().error.code).toBe("personal_workspace_single_member");
        expect(storedInvitations.rows[0]?.count).toBe(0);
    }, 60_000);

    it("lets owners and admins manage invitations and members while members cannot", async () => {
        const { app, mailer } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "权限团队", "role-team");
        const member = await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "普通成员",
            email: "member@example.com",
            role: "member",
        });
        const admin = await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "管理员",
            email: "admin@example.com",
            role: "admin",
        });

        const memberInvite = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: member.cookie },
            payload: { email: "blocked@example.com", role: "member" },
        });
        const adminInvite = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: admin.cookie },
            payload: { email: "pending@example.com", role: "member" },
        });
        const invitationId = adminInvite.json().invitation.id as string;
        const canceled = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${workspace.id}/invitations/${invitationId}`,
            headers: { cookie: admin.cookie },
        });
        const listed = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/members`,
            headers: { cookie: member.cookie },
        });
        const target = listed.json().members.find((item: { userId: string }) => item.userId === member.userId);
        const memberRemove = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${workspace.id}/members/${target.id}`,
            headers: { cookie: member.cookie },
        });
        const adminRemove = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${workspace.id}/members/${target.id}`,
            headers: { cookie: admin.cookie },
        });

        expect(memberInvite.statusCode).toBe(403);
        expect(memberInvite.json().error.code).toBe("workspace_admin_required");
        expect(adminInvite.statusCode).toBe(201);
        expect(canceled.statusCode).toBe(200);
        expect(canceled.json()).toEqual({ success: true });
        expect(listed.statusCode).toBe(200);
        expect(listed.json().total).toBe(3);
        expect(memberRemove.statusCode).toBe(403);
        expect(memberRemove.json().error.code).toBe("workspace_admin_required");
        expect(adminRemove.statusCode).toBe(200);
        expect(adminRemove.json()).toEqual({ success: true });
    }, 120_000);

    it("lists only pending invitations for team owners and admins", async () => {
        const { app, mailer } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "邀请列表团队", "invitation-list-team");
        const member = await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "普通成员",
            email: "member@example.com",
            role: "member",
        });
        const admin = await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "管理员",
            email: "admin@example.com",
            role: "admin",
        });
        const pending = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "pending@example.com", role: "member" },
        });
        const ownerList = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
        });
        const adminList = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: admin.cookie },
        });
        const memberList = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: member.cookie },
        });
        const personalWorkspaces = await app.inject({ method: "GET", url: "/api/v1/workspaces", headers: { cookie: owner.cookie } });
        const personalId = personalWorkspaces.json().workspaces.find((item: { type: string }) => item.type === "personal").id;
        const personalList = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${personalId}/invitations`,
            headers: { cookie: owner.cookie },
        });

        expect(pending.statusCode).toBe(201);
        expect(ownerList.statusCode).toBe(200);
        expect(ownerList.json()).toEqual({ invitations: [pending.json().invitation] });
        expect(adminList.json()).toEqual(ownerList.json());
        expect(memberList.statusCode).toBe(403);
        expect(memberList.json().error.code).toBe("workspace_admin_required");
        expect(personalList.statusCode).toBe(409);
        expect(personalList.json().error.code).toBe("personal_workspace_single_member");
    }, 120_000);

    it("maps concurrent case-insensitive pending invitation conflicts to a stable envelope", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "并发邀请团队", "concurrent-invitation-team");
        const invite = (email: string) =>
            app.inject({
                method: "POST",
                url: `/api/v1/workspaces/${workspace.id}/invitations`,
                headers: { cookie: owner.cookie },
                payload: { email, role: "member" },
            });

        const responses = await Promise.all([invite("Invitee@Example.com"), invite("invitee@example.com")]);
        const sorted = responses.sort((left, right) => left.statusCode - right.statusCode);
        const stored = await adminPool.query(
            'select lower("email") as "email", "status" from "workspace_invitations" where "workspace_id" = $1 and lower("email") = lower($2)',
            [workspace.id, "invitee@example.com"],
        );

        expect(sorted.map((response) => response.statusCode)).toEqual([201, 409]);
        expect(sorted[1]!.json().error.code).toBe("workspace_invitation_conflict");
        expect(stored.rows).toEqual([{ email: "invitee@example.com", status: "pending" }]);
    }, 90_000);

    it("cancels an expired pending invitation before generating its replacement", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "重新邀请团队", "reinvite-team");
        const first = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        await adminPool.query('update "workspace_invitations" set "expires_at" = now() - interval \'1 second\' where "id" = $1', [
            first.json().invitation.id,
        ]);

        const replacement = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "INVITEE@example.com", role: "member" },
        });
        const stored = await adminPool.query(
            'select "id", "status" from "workspace_invitations" where "workspace_id" = $1 order by "created_at", "id"',
            [workspace.id],
        );

        expect(replacement.statusCode).toBe(201);
        expect(replacement.json().invitation.id).not.toBe(first.json().invitation.id);
        expect(stored.rows).toEqual([
            { id: first.json().invitation.id, status: "canceled" },
            { id: replacement.json().invitation.id, status: "pending" },
        ]);
    }, 90_000);

    it("binds invitation cancellation to the path workspace", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const first = await createTeam(app, owner, "团队一", "team-one");
        const second = await createTeam(app, owner, "团队二", "team-two");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${first.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;

        const crossWorkspace = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${second.id}/invitations/${invitationId}`,
            headers: { cookie: owner.cookie },
        });
        const pending = await adminPool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);
        const canceled = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${first.id}/invitations/${invitationId}`,
            headers: { cookie: owner.cookie },
        });
        const stored = await adminPool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);

        expect(crossWorkspace.statusCode).toBe(403);
        expect(crossWorkspace.json().error.code).toBe("workspace_forbidden");
        expect(pending.rows[0]?.status).toBe("pending");
        expect(canceled.statusCode).toBe(200);
        expect(stored.rows[0]?.status).toBe("canceled");
    }, 90_000);

    it("never removes the team owner", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "所有权团队", "owner-team");
        const members = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/members`,
            headers: { cookie: owner.cookie },
        });
        const ownerMember = members.json().members.find((member: { role: string }) => member.role === "owner");

        const removed = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${workspace.id}/members/${ownerMember.id}`,
            headers: { cookie: owner.cookie },
        });
        const stored = await adminPool.query(
            'select "role" from "workspace_members" where "workspace_id" = $1 and "user_id" = $2',
            [workspace.id, owner.userId],
        );

        expect(removed.statusCode).toBe(409);
        expect(removed.json().error.code).toBe("workspace_owner_cannot_be_removed");
        expect(stored.rows).toEqual([{ role: "owner" }]);
    }, 60_000);

    it("blocks owner-role creation through application contracts and internal hooks", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "唯一所有者团队", "single-owner-team");
        await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "管理员",
            email: "admin@example.com",
            role: "admin",
        });
        const ownerInvite = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "second-owner@example.com", role: "owner" },
        });
        const roles = await adminPool.query(
            'select "role" from "workspace_members" where "workspace_id" = $1 order by "role"',
            [workspace.id],
        );
        const invitations = await adminPool.query(
            'select count(*)::int as count from "workspace_invitations" where "workspace_id" = $1 and "role" = \'owner\'',
            [workspace.id],
        );

        expect(ownerInvite.statusCode).toBe(400);
        expect(roles.rows).toEqual([{ role: "admin" }, { role: "owner" }]);
        expect(invitations.rows[0]?.count).toBe(0);
    }, 90_000);
});

describe("workspace invitation acceptance", () => {
    it("accepts only the strict token body contract and never persists the raw token", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "令牌契约团队", "token-contract-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        const token = latestInvitationToken(mailer);
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee@example.com" });

        const extraBody = await app.inject({
            method: "POST",
            url: "/api/v1/workspace-invitations/accept",
            headers: { cookie: invitee.cookie },
            payload: { token, invitationId },
        });
        const oldPath = await app.inject({
            method: "POST",
            url: `/api/v1/workspace-invitations/${invitationId}/accept`,
            headers: { cookie: invitee.cookie },
        });
        const stored = await adminPool.query(
            "select token_digest, status from public.workspace_invitations where id = $1",
            [invitationId],
        );

        expect(extraBody.statusCode).toBe(400);
        expect(oldPath.statusCode).toBe(404);
        expect(stored.rows).toEqual([{ token_digest: expect.stringMatching(/^[0-9a-f]{64}$/), status: "pending" }]);
        expect(stored.rows[0]?.token_digest).not.toBe(token);
        expect(invited.body).not.toContain(token);
    }, 90_000);

    it("atomically accepts one of two concurrent requests and creates one membership", async () => {
        const { app, mailer, adminPool, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "接受邀请团队", "accept-invitation-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        const token = latestInvitationToken(mailer);
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee@example.com" });
        const acceptancePrerequisites = await withUserTransaction(database.db, invitee.userId, async (tx) => {
            const result = await tx.execute<{ verified: boolean; visible: number }>(sql`
                select public.is_current_verified_email(${'invitee@example.com'}, ${invitee.userId}) as verified,
                       count(*)::int as visible
                from public.workspace_invitations
                where token_digest = ${hashInvitationToken(token)}
            `);
            return result.rows[0];
        });
        expect(acceptancePrerequisites).toEqual({ verified: true, visible: 1 });
        const accept = () =>
            app.inject({
                method: "POST",
                url: "/api/v1/workspace-invitations/accept",
                headers: { cookie: invitee.cookie },
                payload: { token },
            });

        const responses = await Promise.all([accept(), accept()]);
        const sorted = responses.sort((left, right) => left.statusCode - right.statusCode);
        const members = await adminPool.query(
            'select "role" from "workspace_members" where "workspace_id" = $1 and "user_id" = $2',
            [workspace.id, invitee.userId],
        );
        const invitation = await adminPool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);

        expect(sorted.map((response) => response.statusCode)).toEqual([200, 409]);
        expect(sorted[0]!.json()).toEqual({ workspaceId: workspace.id });
        expect(sorted[1]!.json().error.code).toBe("workspace_invitation_unavailable");
        expect(members.rows).toEqual([{ role: "member" }]);
        expect(invitation.rows).toEqual([{ status: "accepted" }]);
    }, 90_000);

    it("serializes different invitation acceptances at the 100-member limit", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "容量上限团队", "member-limit-team");
        const seededUsers = Array.from({ length: 98 }, (_, index) => ({
            id: `capacity-user-${index}`,
            name: `容量成员${index}`,
            email: `capacity-user-${index}@example.com`,
            emailVerified: true,
        }));
        for (const [index, user] of seededUsers.entries()) {
            await adminPool.query(
                'insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)',
                [user.id, user.name, user.email],
            );
            await adminPool.query(
                "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'member', 'active')",
                [`capacity-member-${index}`, workspace.id, user.id],
            );
        }
        await adminPool.query(
            'insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)',
            ["capacity-removed-user", "已移除成员", "capacity-removed@example.com"],
        );
        await adminPool.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'member', 'removed')",
            ["capacity-removed-member", workspace.id, "capacity-removed-user"],
        );
        const before = await adminPool.query(
            `select count(*)::int as count,
                    count(*) filter (where status = 'active')::int as active_count
             from "workspace_members"
             where "workspace_id" = $1`,
            [workspace.id],
        );
        const firstInvitation = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "capacity-first@example.com", role: "member" },
        });
        const firstToken = latestInvitationToken(mailer);
        const secondInvitation = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "capacity-second@example.com", role: "member" },
        });
        const secondToken = latestInvitationToken(mailer);
        const firstInvitationId = firstInvitation.json().invitation.id as string;
        const secondInvitationId = secondInvitation.json().invitation.id as string;
        const firstInvitee = await registerVerifiedUser(app, mailer, {
            name: "容量候选人一",
            email: "capacity-first@example.com",
        });
        const secondInvitee = await registerVerifiedUser(app, mailer, {
            name: "容量候选人二",
            email: "capacity-second@example.com",
        });
        await adminPool.query(`
            create function delay_capacity_member_insert() returns trigger language plpgsql as $$
            begin
                perform pg_sleep(1);
                return new;
            end
            $$;
            create trigger delay_capacity_member_insert before insert on "workspace_members"
            for each row execute function delay_capacity_member_insert();
        `);
        const accept = async (invitationId: string, token: string, cookie: string) => ({
            invitationId,
            response: await app.inject({
                method: "POST",
                url: "/api/v1/workspace-invitations/accept",
                headers: { cookie },
                payload: { token },
            }),
        });

        const attempts = await Promise.all([
            accept(firstInvitationId, firstToken, firstInvitee.cookie),
            accept(secondInvitationId, secondToken, secondInvitee.cookie),
        ]);
        const winner = attempts.find(({ response }) => response.statusCode === 200)!;
        const loser = attempts.find(({ response }) => response.statusCode === 409)!;
        const after = await adminPool.query(
            `select count(*)::int as count,
                    count(*) filter (where status = 'active')::int as active_count
             from "workspace_members"
             where "workspace_id" = $1`,
            [workspace.id],
        );
        const invitations = await adminPool.query(
            'select "id", "status" from "workspace_invitations" where "id" = any($1::text[])',
            [[firstInvitationId, secondInvitationId]],
        );
        const invitationStatuses = Object.fromEntries(
            invitations.rows.map((invitation: { id: string; status: string }) => [invitation.id, invitation.status]),
        );

        expect(before.rows).toEqual([{ count: 100, active_count: 99 }]);
        expect([firstInvitation.statusCode, secondInvitation.statusCode]).toEqual([201, 201]);
        expect(attempts.map(({ response }) => response.statusCode).sort()).toEqual([200, 409]);
        expect(winner.response.json()).toEqual({ workspaceId: workspace.id });
        expect(loser.response.json().error.code).toBe("workspace_member_limit_reached");
        expect(after.rows).toEqual([{ count: 101, active_count: 100 }]);
        expect(invitationStatuses[winner.invitationId]).toBe("accepted");
        expect(invitationStatuses[loser.invitationId]).toBe("pending");
    }, 120_000);

    it("keeps the invitation pending when membership insertion fails", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "回滚邀请团队", "rollback-invitation-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        const token = latestInvitationToken(mailer);
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee@example.com" });
        await adminPool.query(`
            create function fail_workspace_member_insert() returns trigger language plpgsql as $$
            begin
                raise exception 'injected acceptance failure';
            end
            $$;
            create trigger fail_workspace_member_insert before insert on "workspace_members"
            for each row execute function fail_workspace_member_insert();
        `);

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/workspace-invitations/accept",
            headers: { cookie: invitee.cookie },
            payload: { token },
        });
        const invitation = await adminPool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);
        const members = await adminPool.query(
            'select "id" from "workspace_members" where "workspace_id" = $1 and "user_id" = $2',
            [workspace.id, invitee.userId],
        );

        expect(response.statusCode).toBe(500);
        expect(response.json().error.code).toBe("internal_error");
        expect(response.body).not.toContain("injected acceptance failure");
        expect(invitation.rows).toEqual([{ status: "pending" }]);
        expect(members.rows).toHaveLength(0);
    }, 90_000);

    it("rejects a different verified account without claiming the invitation", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "收件人团队", "recipient-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        const token = latestInvitationToken(mailer);
        const other = await registerVerifiedUser(app, mailer, { name: "其他用户", email: "other@example.com" });

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/workspace-invitations/accept",
            headers: { cookie: other.cookie },
            payload: { token },
        });
        const invitation = await adminPool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("workspace_invitation_unavailable");
        expect(invitation.rows).toEqual([{ status: "pending" }]);
    }, 90_000);

    it("does not claim an expired pending invitation", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "过期邀请团队", "expired-invitation-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        const token = latestInvitationToken(mailer);
        await adminPool.query('update "workspace_invitations" set "expires_at" = now() - interval \'1 second\' where "id" = $1', [
            invitationId,
        ]);
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee@example.com" });

        const response = await app.inject({
            method: "POST",
            url: "/api/v1/workspace-invitations/accept",
            headers: { cookie: invitee.cookie },
            payload: { token },
        });
        const invitation = await adminPool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("workspace_invitation_unavailable");
        expect(invitation.rows).toEqual([{ status: "pending" }]);
    }, 90_000);
});
