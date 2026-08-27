import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    createAuthTestHarness,
    registerVerifiedUser,
    type AuthApp,
    type MemoryMailer,
    type VerifiedUser,
} from "../helpers/auth.js";

const harness = createAuthTestHarness();
const ADMIN_AUDIT_BLOCK_KEY = "86420378123";

async function createTeam(app: AuthApp, owner: VerifiedUser, slug: string): Promise<string> {
    const response = await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: { cookie: owner.cookie },
        payload: { name: slug, slug },
    });
    expect(response.statusCode).toBe(201);
    return response.json().workspace.id as string;
}

async function createAdmin(app: AuthApp, mailer: MemoryMailer, adminPool: Pool) {
    const admin = await registerVerifiedUser(app, mailer, {
        name: "平台管理员",
        email: `admin-${randomUUID()}@example.com`,
    });
    await adminPool.query("insert into public.platform_admins (user_id, status) values ($1, 'active')", [admin.userId]);
    return admin;
}

function adminWorkspaceRequest(
    app: AuthApp,
    admin: VerifiedUser,
    workspaceId: string,
    action?: "suspend" | "deactivate" | "restore",
) {
    return app.inject({
        method: action ? "POST" : "GET",
        url: action
            ? `/api/v1/admin/workspaces/${workspaceId}/${action}`
            : `/api/v1/admin/workspaces/${workspaceId}`,
        headers: { cookie: admin.cookie },
    });
}

async function waitForBlockedAdminOperation(adminPool: Pool): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const result = await adminPool.query<{ blocked: boolean }>(`
            select exists (
                select 1
                from pg_stat_activity
                where usename = 'app_api'
                  and state = 'active'
                  and wait_event_type = 'Lock'
                  and query like '%execute_workspace_admin_operation%'
            ) as blocked
        `);
        if (result.rows[0]?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("admin Workspace operation did not block on the tenant row lock");
}

async function waitForBlockedAppApiConnections(adminPool: Pool, minimum: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const result = await adminPool.query<{ count: number }>(
            `select count(*)::int as count
             from pg_stat_activity
             where usename = 'app_api'
               and state = 'active'
               and wait_event_type = 'Lock'`,
        );
        if ((result.rows[0]?.count ?? 0) >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`expected at least ${minimum} blocked app_api connections`);
}

async function beginTenantClient(client: PoolClient, userId: string, workspaceId: string): Promise<void> {
    await client.query("begin");
    await client.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [
        userId,
        workspaceId,
    ]);
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

describe("owner workspace lifecycle", () => {
    it("deactivates an active team and commits exactly one immutable audit", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "owner-deactivate-team");

        const response = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspaceId}/deactivate`,
            headers: { cookie: owner.cookie },
        });
        const stored = await adminPool.query(
            "select status, deleted_at from public.workspaces where id = $1",
            [workspaceId],
        );
        const audits = await adminPool.query(
            "select actor_user_id, action, from_status, to_status, operation_id, transaction_xid::text as transaction_xid from public.workspace_audit_logs where workspace_id = $1",
            [workspaceId],
        );

        expect(response.statusCode).toBe(200);
        expect(response.json().workspace).toMatchObject({ id: workspaceId, status: "deactivated" });
        expect(response.json().workspace.deletedAt).toEqual(expect.any(String));
        expect(stored.rows).toEqual([{ status: "deactivated", deleted_at: expect.any(Date) }]);
        expect(audits.rows).toEqual([
            {
                actor_user_id: owner.userId,
                action: "workspace_deactivate",
                from_status: "active",
                to_status: "deactivated",
                operation_id: null,
                transaction_xid: expect.any(String),
            },
        ]);
        await expect(
            adminPool.query("update public.workspace_audit_logs set action = 'tampered' where workspace_id = $1", [
                workspaceId,
            ]),
        ).rejects.toMatchObject({ code: "42501" });
    }, 90_000);

    it("rejects personal workspace self-deactivation", async () => {
        const { app, mailer } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "个人所有者", email: "personal@example.com" });
        const listed = await app.inject({ method: "GET", url: "/api/v1/workspaces", headers: { cookie: owner.cookie } });
        expect(listed.statusCode, listed.body).toBe(200);
        const workspaceId = listed.json().workspaces[0].id as string;

        const response = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspaceId}/deactivate`,
            headers: { cookie: owner.cookie },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("personal_workspace_cannot_be_deactivated");
    }, 90_000);

    it("keeps ordinary tenant mutations closed while a workspace is suspended or deactivated", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const member = await registerVerifiedUser(app, mailer, { name: "成员", email: "member@example.com" });
        const workspaceId = await createTeam(app, owner, "inactive-tenant-team");
        await adminPool.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'member', 'active')",
            [randomUUID(), workspaceId, member.userId],
        );
        const createdCanvas = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspaceId}/canvases`,
            headers: { cookie: member.cookie },
            payload: { title: "停用前画布" },
        });
        expect(createdCanvas.statusCode).toBe(201);

        await adminPool.query("update public.workspaces set status = 'suspended' where id = $1", [workspaceId]);
        const suspendedMetadata = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspaceId}`,
            headers: { cookie: member.cookie },
        });
        const suspendedPatch = await app.inject({
            method: "PATCH",
            url: `/api/v1/workspaces/${workspaceId}`,
            headers: { cookie: owner.cookie },
            payload: { name: "不应更新" },
        });
        const suspendedCanvas = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspaceId}/canvases/${createdCanvas.json().canvas.id}`,
            headers: { cookie: member.cookie },
        });
        await adminPool.query(
            "update public.workspaces set status = 'deactivated', deleted_at = now() where id = $1",
            [workspaceId],
        );
        const deactivatedMetadata = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspaceId}`,
            headers: { cookie: member.cookie },
        });
        const deactivatedCreate = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspaceId}/canvases`,
            headers: { cookie: member.cookie },
            payload: { title: "不应创建" },
        });
        const stored = await adminPool.query("select name, status from public.workspaces where id = $1", [workspaceId]);
        const canvases = await adminPool.query("select count(*)::int as count from public.canvases where workspace_id = $1", [
            workspaceId,
        ]);

        expect(suspendedMetadata.statusCode).toBe(200);
        expect(suspendedMetadata.json().workspace.status).toBe("suspended");
        expect(suspendedPatch.statusCode).toBe(409);
        expect(suspendedPatch.json().error.code).toBe("workspace_inactive");
        expect(suspendedCanvas.statusCode).toBe(409);
        expect(suspendedCanvas.json().error.code).toBe("workspace_inactive");
        expect(deactivatedMetadata.statusCode).toBe(200);
        expect(deactivatedMetadata.json().workspace.status).toBe("deactivated");
        expect(deactivatedCreate.statusCode).toBe(409);
        expect(deactivatedCreate.json().error.code).toBe("workspace_inactive");
        expect(stored.rows).toEqual([{ name: "inactive-tenant-team", status: "deactivated" }]);
        expect(canvases.rows).toEqual([{ count: 1 }]);
    }, 90_000);

    it("lists an inactive personal Workspace without reprovisioning and keeps healthy teams accessible", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "个人所有者", email: "owner@example.com" });
        const initialList = await app.inject({
            method: "GET",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
        });
        const personal = initialList.json().workspaces.find((workspace: { type: string }) => workspace.type === "personal");
        const teamId = await createTeam(app, owner, "healthy-team");
        const admin = await createAdmin(app, mailer, adminPool);

        const suspended = await adminWorkspaceRequest(app, admin, personal.id, "suspend");
        const suspendedList = await app.inject({
            method: "GET",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
        });
        const suspendedMetadata = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${personal.id}`,
            headers: { cookie: owner.cookie },
        });
        const healthyWhileSuspended = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${teamId}`,
            headers: { cookie: owner.cookie },
        });

        const deactivated = await adminWorkspaceRequest(app, admin, personal.id, "deactivate");
        const deactivatedList = await app.inject({
            method: "GET",
            url: "/api/v1/workspaces",
            headers: { cookie: owner.cookie },
        });
        const healthyWhileDeactivated = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${teamId}`,
            headers: { cookie: owner.cookie },
        });
        const personalRows = await adminPool.query(
            "select count(*)::int as count from public.workspaces where owner_user_id = $1 and type = 'personal'",
            [owner.userId],
        );

        expect(suspended.statusCode).toBe(200);
        expect(suspendedList.statusCode, suspendedList.body).toBe(200);
        expect(suspendedList.json().workspaces).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: personal.id, status: "suspended" }),
                expect.objectContaining({ id: teamId, status: "active" }),
            ]),
        );
        expect(suspendedMetadata.statusCode).toBe(200);
        expect(suspendedMetadata.json().workspace.status).toBe("suspended");
        expect(healthyWhileSuspended.statusCode).toBe(200);
        expect(deactivated.statusCode).toBe(200);
        expect(deactivatedList.statusCode, deactivatedList.body).toBe(200);
        expect(deactivatedList.json().workspaces).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: personal.id, status: "deactivated" }),
                expect.objectContaining({ id: teamId, status: "active" }),
            ]),
        );
        expect(healthyWhileDeactivated.statusCode).toBe(200);
        expect(personalRows.rows).toEqual([{ count: 1 }]);
    }, 120_000);
});

describe("platform-admin workspace lifecycle", () => {
    it("waits for a tenant rename and returns the final committed Workspace row", async () => {
        const { app, mailer, database, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "rename-race-team");
        const admin = await createAdmin(app, mailer, adminPool);
        const manager = await database.pool.connect();
        let managerOpen = false;
        let adminRequest: ReturnType<typeof adminWorkspaceRequest> | undefined;

        try {
            await beginTenantClient(manager, owner.userId, workspaceId);
            managerOpen = true;
            const renamed = await manager.query(
                "update public.workspaces set name = $1, updated_at = now() where id = $2 returning id",
                ["renamed-concurrently", workspaceId],
            );
            expect(renamed.rowCount).toBe(1);

            adminRequest = adminWorkspaceRequest(app, admin, workspaceId, "suspend");
            await waitForBlockedAdminOperation(adminPool);
            await manager.query("commit");
            managerOpen = false;

            const response = await adminRequest;
            const stored = await adminPool.query(
                `select id, name, slug, type, status, owner_user_id, created_at, updated_at, deleted_at
                 from public.workspaces where id = $1`,
                [workspaceId],
            );
            const workspace = stored.rows[0]!;

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().workspace).toEqual({
                id: workspace.id,
                name: workspace.name,
                slug: workspace.slug,
                type: workspace.type,
                status: workspace.status,
                ownerUserId: workspace.owner_user_id,
                createdAt: workspace.created_at.toISOString(),
                updatedAt: workspace.updated_at.toISOString(),
                deletedAt: null,
            });
            expect(workspace).toMatchObject({ name: "renamed-concurrently", status: "suspended" });
        } finally {
            if (managerOpen) await manager.query("rollback").catch(() => {});
            manager.release();
            await adminRequest?.catch(() => {});
        }
    }, 120_000);

    it("makes an admin-first suspension win over a waiting manager PATCH with a stable inactive error", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "admin-first-manager-race");
        const admin = await createAdmin(app, mailer, adminPool);
        const blocker = await adminPool.connect();
        let blockerLocked = false;
        let adminRequest: ReturnType<typeof adminWorkspaceRequest> | undefined;
        let managerRequest: ReturnType<typeof adminWorkspaceRequest> | undefined;

        await adminPool.query(`
            create function block_admin_workspace_audit() returns trigger language plpgsql as $trigger$
            begin
                perform pg_advisory_xact_lock(${ADMIN_AUDIT_BLOCK_KEY});
                return new;
            end
            $trigger$;
            create trigger block_admin_workspace_audit
            before insert on public.workspace_audit_logs
            for each row when (new.operation_id is not null)
            execute function block_admin_workspace_audit()
        `);

        try {
            await blocker.query("select pg_advisory_lock($1::bigint)", [ADMIN_AUDIT_BLOCK_KEY]);
            blockerLocked = true;
            const pendingAdmin = adminWorkspaceRequest(app, admin, workspaceId, "suspend");
            adminRequest = pendingAdmin;
            await waitForBlockedAdminOperation(adminPool);

            const pendingManager = app.inject({
                method: "PATCH",
                url: `/api/v1/workspaces/${workspaceId}`,
                headers: { cookie: owner.cookie },
                payload: { name: "rename-must-not-commit" },
            });
            managerRequest = pendingManager;
            await waitForBlockedAppApiConnections(adminPool, 2);

            await blocker.query("select pg_advisory_unlock($1::bigint)", [ADMIN_AUDIT_BLOCK_KEY]);
            blockerLocked = false;
            const [adminResponse, managerResponse] = await Promise.all([pendingAdmin, pendingManager]);
            const stored = await adminPool.query(
                `select w.name, w.status,
                        (select count(*)::int from public.admin_operations o where o.target_workspace_id = w.id) as operations,
                        (select count(*)::int from public.workspace_audit_logs a where a.workspace_id = w.id) as audits
                 from public.workspaces w where w.id = $1`,
                [workspaceId],
            );

            expect(adminResponse.statusCode, adminResponse.body).toBe(200);
            expect(managerResponse.statusCode, managerResponse.body).toBe(409);
            expect(managerResponse.json().error.code).toBe("workspace_inactive");
            expect(stored.rows).toEqual([
                { name: "admin-first-manager-race", status: "suspended", operations: 1, audits: 1 },
            ]);
        } finally {
            if (blockerLocked) {
                await blocker.query("select pg_advisory_unlock($1::bigint)", [ADMIN_AUDIT_BLOCK_KEY]).catch(() => {});
            }
            blocker.release();
            await adminRequest?.catch(() => {});
            await managerRequest?.catch(() => {});
        }
    }, 120_000);

    it("lets owner deactivation win one legal race and rolls the losing admin operation back", async () => {
        const { app, mailer, database, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "deactivate-race-team");
        const admin = await createAdmin(app, mailer, adminPool);
        const ownerClient = await database.pool.connect();
        let ownerOpen = false;
        let adminRequest: ReturnType<typeof adminWorkspaceRequest> | undefined;

        try {
            await beginTenantClient(ownerClient, owner.userId, workspaceId);
            ownerOpen = true;
            await ownerClient.query(
                `insert into public.workspace_audit_logs
                    (workspace_id, actor_user_id, action, from_status, to_status, transaction_xid)
                 values ($1, $2, 'workspace_deactivate', 'active', 'deactivated', pg_current_xact_id())`,
                [workspaceId, owner.userId],
            );
            const deactivated = await ownerClient.query(
                `update public.workspaces
                 set status = 'deactivated', deleted_at = now(), updated_at = now()
                 where id = $1 and status = 'active' and type = 'team'
                 returning id`,
                [workspaceId],
            );
            expect(deactivated.rowCount).toBe(1);

            adminRequest = adminWorkspaceRequest(app, admin, workspaceId, "suspend");
            await waitForBlockedAdminOperation(adminPool);
            await ownerClient.query("commit");
            ownerOpen = false;

            const response = await adminRequest;
            const stored = await adminPool.query(
                `select w.status,
                        (select count(*)::int from public.admin_operations o where o.target_workspace_id = w.id) as operations,
                        (select count(*)::int from public.workspace_audit_logs a where a.workspace_id = w.id) as audits
                 from public.workspaces w where w.id = $1`,
                [workspaceId],
            );
            const audits = await adminPool.query(
                "select actor_user_id, action, operation_id from public.workspace_audit_logs where workspace_id = $1",
                [workspaceId],
            );

            expect(response.statusCode).toBe(409);
            expect(response.json().error.code).toBe("workspace_status_transition_invalid");
            expect(stored.rows).toEqual([{ status: "deactivated", operations: 0, audits: 1 }]);
            expect(audits.rows).toEqual([
                { actor_user_id: owner.userId, action: "workspace_deactivate", operation_id: null },
            ]);
        } finally {
            if (ownerOpen) await ownerClient.query("rollback").catch(() => {});
            ownerClient.release();
            await adminRequest?.catch(() => {});
        }
    }, 120_000);

    it("maps missing admin read and lifecycle targets to 404 without committed control rows", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const admin = await createAdmin(app, mailer, adminPool);
        const missingId = randomUUID();

        const read = await adminWorkspaceRequest(app, admin, missingId);
        const transition = await adminWorkspaceRequest(app, admin, missingId, "suspend");
        const operations = await adminPool.query("select count(*)::int as count from public.admin_operations");
        const audits = await adminPool.query("select count(*)::int as count from public.workspace_audit_logs");

        expect(read.statusCode).toBe(404);
        expect(read.json().error.code).toBe("workspace_not_found");
        expect(transition.statusCode).toBe(404);
        expect(transition.json().error.code).toBe("workspace_not_found");
        expect(operations.rows).toEqual([{ count: 0 }]);
        expect(audits.rows).toEqual([{ count: 0 }]);
    }, 90_000);

    it("registers authenticated admin routes and audits reads without requiring membership", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "admin-read-team");
        const admin = await createAdmin(app, mailer, adminPool);

        const unauthenticated = await app.inject({ method: "GET", url: `/api/v1/admin/workspaces/${workspaceId}` });
        const response = await adminWorkspaceRequest(app, admin, workspaceId);
        const audits = await adminPool.query(
            `select a.action, a.operation_id,
                    a.transaction_xid::text as audit_xid,
                    o.transaction_xid::text as operation_xid
             from public.workspace_audit_logs a
             join public.admin_operations o on o.id = a.operation_id
             where a.workspace_id = $1`,
            [workspaceId],
        );

        expect(unauthenticated.statusCode).toBe(401);
        expect(response.statusCode).toBe(200);
        expect(response.json().workspace).toMatchObject({ id: workspaceId, status: "active" });
        expect(audits.rows).toEqual([
            {
                action: "workspace_read",
                operation_id: expect.any(String),
                audit_xid: expect.any(String),
                operation_xid: expect.any(String),
            },
        ]);
        expect(audits.rows[0]!.audit_xid).toBe(audits.rows[0]!.operation_xid);
    }, 90_000);

    it("enforces the suspend, deactivate and restore state matrix", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "admin-state-team");
        const admin = await createAdmin(app, mailer, adminPool);

        const invalidRestore = await adminWorkspaceRequest(app, admin, workspaceId, "restore");
        const suspended = await adminWorkspaceRequest(app, admin, workspaceId, "suspend");
        const invalidSuspend = await adminWorkspaceRequest(app, admin, workspaceId, "suspend");
        const deactivated = await adminWorkspaceRequest(app, admin, workspaceId, "deactivate");
        const restored = await adminWorkspaceRequest(app, admin, workspaceId, "restore");
        const audits = await adminPool.query(
            "select action, from_status, to_status, operation_id from public.workspace_audit_logs where workspace_id = $1 order by created_at, id",
            [workspaceId],
        );
        const operations = await adminPool.query(
            "select count(*)::int as count from public.admin_operations where target_workspace_id = $1",
            [workspaceId],
        );

        expect(invalidRestore.statusCode).toBe(409);
        expect(invalidRestore.json().error.code).toBe("workspace_status_transition_invalid");
        expect(suspended.json().workspace.status).toBe("suspended");
        expect(invalidSuspend.statusCode).toBe(409);
        expect(deactivated.json().workspace).toMatchObject({ status: "deactivated", deletedAt: expect.any(String) });
        expect(restored.json().workspace).toMatchObject({ status: "active", deletedAt: null });
        expect(operations.rows).toEqual([{ count: 3 }]);
        expect(audits.rows).toEqual([
            {
                action: "workspace_suspend",
                from_status: "active",
                to_status: "suspended",
                operation_id: expect.any(String),
            },
            {
                action: "workspace_deactivate",
                from_status: "suspended",
                to_status: "deactivated",
                operation_id: expect.any(String),
            },
            {
                action: "workspace_restore",
                from_status: "deactivated",
                to_status: "active",
                operation_id: expect.any(String),
            },
        ]);
    }, 120_000);

    it("denies inactive admins and commits no operation or audit", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "inactive-admin-team");
        const admin = await createAdmin(app, mailer, adminPool);
        await adminPool.query("update public.platform_admins set status = 'revoked' where user_id = $1", [admin.userId]);

        const response = await adminWorkspaceRequest(app, admin, workspaceId, "suspend");
        const operations = await adminPool.query("select count(*)::int as count from public.admin_operations");
        const audits = await adminPool.query("select count(*)::int as count from public.workspace_audit_logs");

        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe("platform_admin_forbidden");
        expect(operations.rows).toEqual([{ count: 0 }]);
        expect(audits.rows).toEqual([{ count: 0 }]);
    }, 90_000);

    it("rolls back status when audit insertion fails", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "audit-failure-team");
        const admin = await createAdmin(app, mailer, adminPool);
        await adminPool.query(`
            create function suppress_workspace_audit_insert() returns trigger language plpgsql as $$
            begin return null; end
            $$;
            create trigger suppress_workspace_audit_insert before insert on public.workspace_audit_logs
            for each row execute function suppress_workspace_audit_insert();
        `);

        const response = await adminWorkspaceRequest(app, admin, workspaceId, "suspend");
        const stored = await adminPool.query("select status from public.workspaces where id = $1", [workspaceId]);
        const controlRows = await adminPool.query(
            `select (select count(*)::int from public.admin_operations where target_workspace_id = $1) as operations,
                    (select count(*)::int from public.workspace_audit_logs where workspace_id = $1) as audits`,
            [workspaceId],
        );

        expect(response.statusCode).toBe(500);
        expect(stored.rows).toEqual([{ status: "active" }]);
        expect(controlRows.rows).toEqual([{ operations: 0, audits: 0 }]);
    }, 90_000);

    it("rolls the audit back when the final conditional update affects no row", async () => {
        const { app, mailer, adminPool } = await harness.openAuthApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspaceId = await createTeam(app, owner, "update-failure-team");
        const admin = await createAdmin(app, mailer, adminPool);
        await adminPool.query(`
            create function suppress_workspace_update() returns trigger language plpgsql as $$
            begin return null; end
            $$;
            create trigger suppress_workspace_update before update on public.workspaces
            for each row execute function suppress_workspace_update();
        `);

        const response = await adminWorkspaceRequest(app, admin, workspaceId, "suspend");
        const stored = await adminPool.query("select status from public.workspaces where id = $1", [workspaceId]);
        const audits = await adminPool.query("select count(*)::int as count from public.workspace_audit_logs");
        const operations = await adminPool.query(
            "select count(*)::int as count from public.admin_operations where target_workspace_id = $1",
            [workspaceId],
        );

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("workspace_status_transition_conflict");
        expect(stored.rows).toEqual([{ status: "active" }]);
        expect(audits.rows).toEqual([{ count: 0 }]);
        expect(operations.rows).toEqual([{ count: 0 }]);
    }, 90_000);
});
