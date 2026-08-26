import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { users } from "../../src/modules/identity/auth-schema.js";
import { ensurePersonalWorkspace } from "../../src/modules/workspaces/service.js";
import {
    createAuthTestHarness,
    registerVerifiedUser,
    type AuthApp,
    type MemoryMailer,
    type VerifiedUser,
} from "../helpers/auth.js";

const harness = createAuthTestHarness();

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
    const invited = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/invitations`,
        headers: { cookie: inviter.cookie },
        payload: { email: invitee.email, role: invitee.role },
    });

    expect(invited.statusCode).toBe(201);
    const invitationId = invited.json().invitation.id as string;
    const user = await registerVerifiedUser(app, mailer, invitee);
    const accepted = await app.inject({
        method: "POST",
        url: `/api/v1/workspace-invitations/${invitationId}/accept`,
        headers: { cookie: user.cookie },
    });

    expect(accepted.statusCode).toBe(200);
    return { ...user, invitationId };
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
        const { database } = await harness.openAuthApp();
        const user = { id: "personal-repeated", name: "重复用户" };
        await database.db.insert(users).values({ ...user, email: "repeated@example.com", emailVerified: true });

        const first = await ensurePersonalWorkspace(database.db, user);
        const second = await ensurePersonalWorkspace(database.db, user);
        const stored = await database.pool.query(
            'select "id", "slug" from "workspaces" where "owner_user_id" = $1 and "workspace_type" = \'personal\'',
            [user.id],
        );

        expect(second.id).toBe(first.id);
        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0]?.slug).toMatch(new RegExp(`^personal-${user.id}`));
    }, 60_000);

    it("returns the committed winner for concurrent personal creation", async () => {
        const { database } = await harness.openAuthApp();
        const user = { id: "personal-concurrent", name: "并发用户" };
        await database.db.insert(users).values({ ...user, email: "concurrent@example.com", emailVerified: true });

        const results = await Promise.all(
            Array.from({ length: 8 }, () => ensurePersonalWorkspace(database.db, user)),
        );
        const stored = await database.pool.query(
            'select w."id", m."role" from "workspaces" w join "workspace_members" m on m."organizationId" = w."id" where w."owner_user_id" = $1 and w."workspace_type" = \'personal\'',
            [user.id],
        );

        expect(new Set(results.map((workspace) => workspace.id))).toEqual(new Set([results[0]!.id]));
        expect(stored.rows).toEqual([{ id: results[0]!.id, role: "owner" }]);
    }, 60_000);

    it("guarantees a personal workspace when a verified user lists workspaces", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const user = await registerVerifiedUser(app, mailer, { name: "个人用户", email: "personal@example.com" });

        const before = await database.pool.query('select count(*)::int as count from "workspaces"');
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
});

describe("workspace routes", () => {
    it("requires an authenticated verified user to create a team", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const user = await registerVerifiedUser(app, mailer, { name: "待验证所有者", email: "unverified@example.com" });
        await database.pool.query('update "users" set "emailVerified" = false where "id" = $1', [user.userId]);

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
        const stored = await database.pool.query(
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
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "团队所有者", email: "owner@example.com" });

        const workspace = await createTeam(app, owner, "产品团队", "product-team");
        const stored = await database.pool.query(
            'select w."workspace_type", w."owner_user_id", m."role" from "workspaces" w join "workspace_members" m on m."organizationId" = w."id" where w."id" = $1',
            [workspace.id],
        );

        expect(workspace).toMatchObject({ name: "产品团队", slug: "product-team" });
        expect(stored.rows).toEqual([{ workspace_type: "team", owner_user_id: owner.userId, role: "owner" }]);
    }, 60_000);

    it("rolls back the team row when owner membership insertion fails", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "事务所有者", email: "transaction@example.com" });
        await database.pool.query(`
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
        const stored = await database.pool.query('select "id" from "workspaces" where "slug" = $1', ["failed-team"]);

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

    it("authorizes from database membership without Better Auth activeOrganizationId", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
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
        await database.pool.query(
            'delete from "workspace_members" where "organizationId" = $1 and "userId" = $2',
            [workspace.id, member.userId],
        );
        const session = await database.pool.query(
            'select "activeOrganizationId" from "sessions" where "userId" = $1',
            [member.userId],
        );
        const after = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}`,
            headers: { cookie: member.cookie },
        });

        expect(before.statusCode).toBe(200);
        expect(session.rows[0]?.activeOrganizationId).toBeNull();
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
        const { app, mailer, database } = await harness.openAuthApp();
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
        const directInvite = await app.inject({
            method: "POST",
            url: "/api/auth/organization/invite-member",
            headers: { cookie: owner.cookie },
            payload: { organizationId: workspaceId, email: "direct@example.com", role: "member" },
        });
        const additionalUser = await registerVerifiedUser(app, mailer, {
            name: "额外用户",
            email: "additional@example.com",
        });
        if (!app.auth) throw new Error("Auth is not registered");
        await expect(
            app.auth.api.addMember({
                body: { organizationId: workspaceId, userId: additionalUser.userId, role: "member" },
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const storedInvitations = await database.pool.query(
            'select count(*)::int as count from "workspace_invitations" where "organizationId" = $1',
            [workspaceId],
        );

        expect(invited.statusCode).toBe(409);
        expect(invited.json().error.code).toBe("personal_workspace_single_member");
        expect(removed.statusCode).toBe(409);
        expect(removed.json().error.code).toBe("personal_workspace_single_member");
        expect(directInvite.statusCode).toBe(404);
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
        const { app, mailer, database } = await harness.openAuthApp();
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
        const stored = await database.pool.query(
            'select lower("email") as "email", "status" from "workspace_invitations" where "organizationId" = $1 and lower("email") = lower($2)',
            [workspace.id, "invitee@example.com"],
        );

        expect(sorted.map((response) => response.statusCode)).toEqual([201, 409]);
        expect(sorted[1]!.json().error.code).toBe("workspace_invitation_conflict");
        expect(stored.rows).toEqual([{ email: "invitee@example.com", status: "pending" }]);
    }, 90_000);

    it("cancels an expired pending invitation before generating its replacement", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "重新邀请团队", "reinvite-team");
        const first = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        await database.pool.query('update "workspace_invitations" set "expiresAt" = now() - interval \'1 second\' where "id" = $1', [
            first.json().invitation.id,
        ]);

        const replacement = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "INVITEE@example.com", role: "member" },
        });
        const stored = await database.pool.query(
            'select "id", "status" from "workspace_invitations" where "organizationId" = $1 order by "createdAt", "id"',
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
        const { app, mailer, database } = await harness.openAuthApp();
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
        const pending = await database.pool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);
        const canceled = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${first.id}/invitations/${invitationId}`,
            headers: { cookie: owner.cookie },
        });
        const stored = await database.pool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);

        expect(crossWorkspace.statusCode).toBe(403);
        expect(crossWorkspace.json().error.code).toBe("workspace_forbidden");
        expect(pending.rows[0]?.status).toBe("pending");
        expect(canceled.statusCode).toBe(200);
        expect(stored.rows[0]?.status).toBe("canceled");
    }, 90_000);

    it("never removes the team owner", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
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
        const stored = await database.pool.query(
            'select "role" from "workspace_members" where "organizationId" = $1 and "userId" = $2',
            [workspace.id, owner.userId],
        );

        expect(removed.statusCode).toBe(409);
        expect(removed.json().error.code).toBe("workspace_owner_cannot_be_removed");
        expect(stored.rows).toEqual([{ role: "owner" }]);
    }, 60_000);

    it("blocks owner-role creation through application contracts and internal hooks", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "唯一所有者团队", "single-owner-team");
        await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "管理员",
            email: "admin@example.com",
            role: "admin",
        });
        const candidate = await registerVerifiedUser(app, mailer, {
            name: "候选所有者",
            email: "owner-candidate@example.com",
        });
        const ownerInvite = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "second-owner@example.com", role: "owner" },
        });
        if (!app.auth) throw new Error("Auth is not registered");
        await expect(
            app.auth.api.addMember({
                body: { organizationId: workspace.id, userId: candidate.userId, role: "owner" },
            }),
        ).rejects.toMatchObject({ statusCode: 409 });
        const roles = await database.pool.query(
            'select "role" from "workspace_members" where "organizationId" = $1 order by "role"',
            [workspace.id],
        );
        const invitations = await database.pool.query(
            'select count(*)::int as count from "workspace_invitations" where "organizationId" = $1 and "role" = \'owner\'',
            [workspace.id],
        );

        expect(ownerInvite.statusCode).toBe(400);
        expect(roles.rows).toEqual([{ role: "admin" }, { role: "owner" }]);
        expect(invitations.rows[0]?.count).toBe(0);
    }, 90_000);
});

describe("workspace invitation acceptance", () => {
    it("atomically accepts one of two concurrent requests and creates one membership", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "接受邀请团队", "accept-invitation-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee@example.com" });
        const accept = () =>
            app.inject({
                method: "POST",
                url: `/api/v1/workspace-invitations/${invitationId}/accept`,
                headers: { cookie: invitee.cookie },
            });

        const responses = await Promise.all([accept(), accept()]);
        const sorted = responses.sort((left, right) => left.statusCode - right.statusCode);
        const members = await database.pool.query(
            'select "role" from "workspace_members" where "organizationId" = $1 and "userId" = $2',
            [workspace.id, invitee.userId],
        );
        const invitation = await database.pool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);

        expect(sorted.map((response) => response.statusCode)).toEqual([200, 409]);
        expect(sorted[0]!.json()).toEqual({ workspaceId: workspace.id });
        expect(sorted[1]!.json().error.code).toBe("workspace_invitation_unavailable");
        expect(members.rows).toEqual([{ role: "member" }]);
        expect(invitation.rows).toEqual([{ status: "accepted" }]);
    }, 90_000);

    it("keeps the invitation pending when membership insertion fails", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "回滚邀请团队", "rollback-invitation-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee@example.com" });
        await database.pool.query(`
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
            url: `/api/v1/workspace-invitations/${invitationId}/accept`,
            headers: { cookie: invitee.cookie },
        });
        const invitation = await database.pool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);
        const members = await database.pool.query(
            'select "id" from "workspace_members" where "organizationId" = $1 and "userId" = $2',
            [workspace.id, invitee.userId],
        );

        expect(response.statusCode).toBe(500);
        expect(response.json().error.code).toBe("internal_error");
        expect(response.body).not.toContain("injected acceptance failure");
        expect(invitation.rows).toEqual([{ status: "pending" }]);
        expect(members.rows).toHaveLength(0);
    }, 90_000);

    it("rejects a different verified account without claiming the invitation", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "收件人团队", "recipient-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        const other = await registerVerifiedUser(app, mailer, { name: "其他用户", email: "other@example.com" });

        const response = await app.inject({
            method: "POST",
            url: `/api/v1/workspace-invitations/${invitationId}/accept`,
            headers: { cookie: other.cookie },
        });
        const invitation = await database.pool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);

        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe("workspace_invitation_recipient_mismatch");
        expect(invitation.rows).toEqual([{ status: "pending" }]);
    }, 90_000);

    it("does not claim an expired pending invitation", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "过期邀请团队", "expired-invitation-team");
        const invited = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/invitations`,
            headers: { cookie: owner.cookie },
            payload: { email: "invitee@example.com", role: "member" },
        });
        const invitationId = invited.json().invitation.id as string;
        await database.pool.query('update "workspace_invitations" set "expiresAt" = now() - interval \'1 second\' where "id" = $1', [
            invitationId,
        ]);
        const invitee = await registerVerifiedUser(app, mailer, { name: "受邀人", email: "invitee@example.com" });

        const response = await app.inject({
            method: "POST",
            url: `/api/v1/workspace-invitations/${invitationId}/accept`,
            headers: { cookie: invitee.cookie },
        });
        const invitation = await database.pool.query('select "status" from "workspace_invitations" where "id" = $1', [
            invitationId,
        ]);

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("workspace_invitation_unavailable");
        expect(invitation.rows).toEqual([{ status: "pending" }]);
    }, 90_000);
});
