import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { users } from "../../src/modules/identity/auth-schema.js";
import { ensurePersonalWorkspace } from "../../src/modules/workspaces/service.js";
import {
    APP_ORIGIN,
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
        url: "/api/auth/organization/accept-invitation",
        headers: { origin: APP_ORIGIN, cookie: user.cookie },
        payload: { invitationId },
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
    it("creates a team through Better Auth with one owner member", async () => {
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

    it("denies access immediately after database membership removal despite an active client id", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "实时权限团队", "fresh-membership");
        const member = await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "普通成员",
            email: "member@example.com",
            role: "member",
        });
        const activated = await app.inject({
            method: "POST",
            url: "/api/auth/organization/set-active",
            headers: { origin: APP_ORIGIN, cookie: member.cookie },
            payload: { organizationId: workspace.id },
        });
        expect(activated.statusCode).toBe(200);

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
        expect(session.rows[0]?.activeOrganizationId).toBe(workspace.id);
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
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
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
        expect(directInvite.statusCode).toBe(409);
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

    it("blocks owner-role creation through direct Better Auth mutation routes", async () => {
        const { app, mailer, database } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "唯一所有者团队", "single-owner-team");
        const admin = await inviteAndAccept(app, mailer, owner, workspace.id, {
            name: "管理员",
            email: "admin@example.com",
            role: "admin",
        });
        const candidate = await registerVerifiedUser(app, mailer, {
            name: "候选所有者",
            email: "owner-candidate@example.com",
        });
        const memberRow = await database.pool.query(
            'select "id" from "workspace_members" where "organizationId" = $1 and "userId" = $2',
            [workspace.id, admin.userId],
        );

        const ownerInvite = await app.inject({
            method: "POST",
            url: "/api/auth/organization/invite-member",
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
            payload: { organizationId: workspace.id, email: "second-owner@example.com", role: "owner" },
        });
        const ownerPromotion = await app.inject({
            method: "POST",
            url: "/api/auth/organization/update-member-role",
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
            payload: { organizationId: workspace.id, memberId: memberRow.rows[0]?.id, role: "owner" },
        });
        const compositeRole = await app.inject({
            method: "POST",
            url: "/api/auth/organization/update-member-role",
            headers: { origin: APP_ORIGIN, cookie: owner.cookie },
            payload: {
                organizationId: workspace.id,
                memberId: memberRow.rows[0]?.id,
                role: ["admin", "member"],
            },
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
        expect(ownerPromotion.statusCode).toBe(409);
        expect(compositeRole.statusCode).toBe(400);
        expect(roles.rows).toEqual([{ role: "admin" }, { role: "owner" }]);
        expect(invitations.rows[0]?.count).toBe(0);
    }, 90_000);
});
