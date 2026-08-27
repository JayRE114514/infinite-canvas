import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { sql } from "drizzle-orm";

import { withUserTransaction } from "../../src/infrastructure/database/transactions.js";
import { hashInvitationToken, resolvePersonalWorkspace } from "../../src/modules/workspaces/service.js";
import {
    createAuthTestHarness,
    registerVerifiedUser,
    type AuthApp,
    type MemoryMailer,
    type VerifiedUser,
} from "../helpers/auth.js";

const harness = createAuthTestHarness();

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

describe("personal workspace provisioning", () => {
    it("creates exactly one personal workspace for repeated calls", async () => {
        const { database, adminPool } = await harness.openAuthApp();
        const user = { id: "personal-repeated", name: "重复用户" };
        await adminPool.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            user.id,
            user.name,
            "repeated@example.com",
        ]);

        const first = await withUserTransaction(database.db, user.id, (tx) => resolvePersonalWorkspace(tx, user));
        const second = await withUserTransaction(database.db, user.id, (tx) => resolvePersonalWorkspace(tx, user));
        const stored = await adminPool.query(
            'select "id", "slug" from "workspaces" where "owner_user_id" = $1 and "type" = \'personal\'',
            [user.id],
        );

        expect(second.summary.id).toBe(first.summary.id);
        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0]?.slug).toMatch(new RegExp(`^personal-${user.id}`));
    }, 60_000);

    it("returns the committed winner for concurrent personal creation", async () => {
        const { database, adminPool } = await harness.openAuthApp();
        const user = { id: "personal-concurrent", name: "并发用户" };
        await adminPool.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            user.id,
            user.name,
            "concurrent@example.com",
        ]);

        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                withUserTransaction(database.db, user.id, (tx) => resolvePersonalWorkspace(tx, user)),
            ),
        );
        const stored = await adminPool.query(
            'select w."id", m."role" from "workspaces" w join "workspace_members" m on m."workspace_id" = w."id" where w."owner_user_id" = $1 and w."type" = \'personal\'',
            [user.id],
        );

        expect(new Set(results.map((workspace) => workspace.summary.id))).toEqual(
            new Set([results[0]!.summary.id]),
        );
        expect(stored.rows).toEqual([{ id: results[0]!.summary.id, role: "owner" }]);
    }, 60_000);

    it("guarantees a personal workspace when a verified user lists workspaces", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const user = await registerVerifiedUser(app, mailer, { name: "个人用户", email: "personal@example.com" });

        const before = await adminPool.query('select count(*)::int as count from "workspaces"');
        const response = await app.inject({
            method: "GET",
            url: "/api/v1/workspaces",
            headers: { cookie: user.cookie },
        });

        expect(before.rows[0]?.count).toBe(0);
        expect(response.statusCode).toBe(200);
        expect(response.json().workspaces).toEqual([
            expect.objectContaining({ type: "personal", ownerUserId: user.userId, role: "owner" }),
        ]);
    }, 60_000);

    it("maps an invisible lifetime-unique personal Workspace to a stable conflict", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const user = await registerVerifiedUser(app, mailer, { name: "个人用户", email: "personal@example.com" });
        const initial = await app.inject({
            method: "GET",
            url: "/api/v1/workspaces",
            headers: { cookie: user.cookie },
        });
        const personalId = initial.json().workspaces[0].id as string;
        await adminPool.query("update public.workspaces set status = 'suspended' where id = $1", [personalId]);
        await adminPool.query(
            "update public.workspace_members set status = 'removed' where workspace_id = $1 and user_id = $2",
            [personalId, user.userId],
        );

        const response = await app.inject({
            method: "GET",
            url: "/api/v1/workspaces",
            headers: { cookie: user.cookie },
        });
        const stored = await adminPool.query(
            "select count(*)::int as count from public.workspaces where owner_user_id = $1 and type = 'personal'",
            [user.userId],
        );

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("personal_workspace_already_exists");
        expect(stored.rows).toEqual([{ count: 1 }]);
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
