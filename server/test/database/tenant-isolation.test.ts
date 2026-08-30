import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/infrastructure/database/client.js";
import { withTenantTransaction, withUserTransaction } from "../../src/infrastructure/database/transactions.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { requireWorkspaceAccess } from "../../src/modules/workspaces/authorization.js";
import { adoptOwnedWorkspaceContext } from "../../src/modules/workspaces/context.js";
import { createTeamWorkspace, listWorkspaces } from "../../src/modules/workspaces/service.js";
import type { ResolvedOwnedWorkspaceId } from "../../src/modules/workspaces/service.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

let postgres: StartedRoleDatabase | undefined;
let api: DatabaseHandle | undefined;
let apiPool: Pool | undefined;
let workerPool: Pool | undefined;
let maintenancePool: Pool | undefined;

const userA = { id: "", email: "" };
const userB = { id: "", email: "" };
let workspaceA = "";
let workspaceB = "";
let canvasA = "";
let canvasB = "";

function handle(): DatabaseHandle {
    if (!api) throw new Error("app_api handle is not ready");
    return api;
}

function pool(candidate: Pool | undefined, name: string): Pool {
    if (!candidate) throw new Error(name + " pool is not ready");
    return candidate;
}

/** 一次性容器管理员连接串，仅供编排型夹具使用。 */
function adminUrl(): string {
    if (!postgres) throw new Error("PostgreSQL container is not started");
    return postgres.admin;
}

async function withRawApiContext<T>(
    userId: string,
    workspaceId: string | undefined,
    work: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool(apiPool, "api").connect();
    try {
        await client.query("begin");
        await client.query("select set_config($1, $2, true)", ["app.user_id", userId]);
        if (workspaceId) await client.query("select set_config($1, $2, true)", ["app.workspace_id", workspaceId]);
        return await work(client);
    } finally {
        await client.query("rollback").catch(() => {});
        client.release();
    }
}

async function insertInvitation(client: PoolClient, email = userA.email): Promise<string> {
    const invitationId = randomUUID();
    await client.query(
        `insert into public.workspace_invitations
            (id, workspace_id, email, role, status, token_digest, inviter_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => 7))`,
        [invitationId, workspaceA, email, "member", "pending", randomUUID().replaceAll("-", "").repeat(2), userA.id],
    );
    return invitationId;
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);

    // 播种只走一次性容器管理员（超级用户，绕过 RLS），随后立即关闭该通道。
    const admin = new Pool({ connectionString: postgres.admin, max: 2 });
    const client = await admin.connect();
    try {
        userA.id = randomUUID();
        userA.email = "user-a-" + userA.id.slice(0, 8) + "@example.com";
        userB.id = randomUUID();
        userB.email = "user-b-" + userB.id.slice(0, 8) + "@example.com";
        workspaceA = randomUUID();
        workspaceB = randomUUID();

        await client.query("begin");
        for (const user of [userA, userB]) {
            await client.query(
                'insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)',
                [user.id, "name-" + user.id.slice(0, 8), user.email],
            );
        }
        for (const [workspaceId, owner] of [[workspaceA, userA], [workspaceB, userB]] as const) {
            await client.query(
                "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, $2, $3, 'team', $4, 'active')",
                [workspaceId, "ws-" + workspaceId.slice(0, 8), "slug-" + workspaceId.slice(0, 8), owner.id],
            );
            await client.query(
                "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
                [randomUUID(), workspaceId, owner.id],
            );
        }
        const insertedA = await client.query(
            "insert into public.canvases (workspace_id, title, snapshot_json) values ($1, $2, $3::jsonb) returning id",
            [workspaceA, "canvas-a", JSON.stringify({ nodes: [] })],
        );
        const insertedB = await client.query(
            "insert into public.canvases (workspace_id, title, snapshot_json) values ($1, $2, $3::jsonb) returning id",
            [workspaceB, "canvas-b", JSON.stringify({ nodes: [] })],
        );
        canvasA = insertedA.rows[0].id;
        canvasB = insertedB.rows[0].id;
        await client.query("commit");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
        await admin.end().catch(() => {});
    }

    api = createDatabase({ url: postgres.api, poolMax: 1, expectedRole: "app_api" });
    apiPool = new Pool({ connectionString: postgres.api, max: 1 });
    workerPool = new Pool({ connectionString: postgres.worker, max: 1 });
    maintenancePool = new Pool({ connectionString: postgres.maintenance, max: 1 });
}, 240_000);

afterAll(async () => {
    await api?.pool.end().catch(() => {});
    for (const candidate of [apiPool, workerPool, maintenancePool]) await candidate?.end().catch(() => {});
    await postgres?.stop().catch(() => {});
    postgres = undefined;
}, 60_000);

describe("row level security flags", () => {
    it("enables RLS on every tenant table and forces it on leaf tables", async () => {
        const result = await pool(apiPool, "api").query(
            "select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = any($1::text[]) order by c.relname",
            [["canvases", "workspace_audit_logs", "workspace_invitations", "workspace_members", "workspaces"]],
        );

        expect(result.rows).toEqual([
            { relname: "canvases", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "workspace_audit_logs", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "workspace_invitations", relrowsecurity: true, relforcerowsecurity: true },
            { relname: "workspace_members", relrowsecurity: true, relforcerowsecurity: false },
            { relname: "workspaces", relrowsecurity: true, relforcerowsecurity: false },
        ]);
    });
});

describe("app_api default deny", () => {
    it("returns no canvas rows without transaction context", async () => {
        await expect(pool(apiPool, "api").query("select * from public.canvases")).resolves.toMatchObject({ rows: [] });
    });

    it("returns no rows for a directly forged workspace context", async () => {
        const client = await pool(apiPool, "api").connect();
        try {
            await client.query("begin");
            await client.query("select set_config($1, $2, true)", ["app.user_id", userA.id]);
            await client.query("select set_config($1, $2, true)", ["app.workspace_id", workspaceB]);
            const forged = await client.query("select id from public.canvases");
            expect(forged.rows).toEqual([]);
        } finally {
            await client.query("rollback").catch(() => {});
            client.release();
        }
    });

    it("sees its own tenant canvas as a positive control before every negative control", async () => {
        const visible = await withTenantTransaction(
            handle().db,
            { userId: userA.id, workspaceId: workspaceA },
            async (tx) => (await tx.execute("select id from public.canvases")).rows,
        );

        expect(visible).toHaveLength(1);
        expect(visible[0]).toMatchObject({ id: canvasA });
    });

    it("rejects a cross-tenant workspace with workspace_forbidden", async () => {
        await expect(
            withTenantTransaction(handle().db, { userId: userA.id, workspaceId: workspaceB }, async () => "unreachable"),
        ).rejects.toMatchObject({ code: "workspace_forbidden" });
    });

    it("does not treat set_config as authorization", async () => {
        await expect(
            withUserTransaction(handle().db, userA.id, async (tx) => {
                await tx.execute(sql`select set_config('app.workspace_id', ${workspaceB}, true)`);
                return requireWorkspaceAccess(tx, { userId: userA.id, workspaceId: workspaceB });
            }),
        ).rejects.toMatchObject({ code: "workspace_forbidden" });
    });

    it("keeps another tenant child canvas invisible even by direct id", async () => {
        const rows = await withTenantTransaction(
            handle().db,
            { userId: userA.id, workspaceId: workspaceA },
            async (tx) => (await tx.execute(sql`select id from public.canvases where id = ${canvasB}`)).rows,
        );

        expect(rows).toEqual([]);
    });

    it("returns no rows for a join that mixes tenants", async () => {
        const rows = await withTenantTransaction(
            handle().db,
            { userId: userA.id, workspaceId: workspaceA },
            async (tx) =>
                (
                    await tx.execute(sql`
                        select c.id
                        from public.canvases c
                        join public.workspaces w on w.id = c.workspace_id
                        where w.id = ${workspaceB}
                    `)
                ).rows,
        );

        expect(rows).toEqual([]);
    });

    it("rejects a canvas insert without workspace context", async () => {
        await expect(
            pool(apiPool, "api").query(
                "insert into public.canvases (workspace_id, title, snapshot_json) values ($1, $2, $3::jsonb)",
                [workspaceA, "no-context", JSON.stringify({})],
            ),
        ).rejects.toMatchObject({ code: "42501" });
    });
});

describe("database mutation boundaries", () => {
    it.each([
        {
            column: "workspace_id",
            query: "update public.workspace_invitations set workspace_id = $1 where id = $2",
            values: (invitationId: string) => [workspaceB, invitationId],
        },
        {
            column: "role",
            query: "update public.workspace_invitations set role = $1 where id = $2",
            values: (invitationId: string) => ["admin", invitationId],
        },
        {
            column: "email",
            query: "update public.workspace_invitations set email = $1 where id = $2",
            values: (invitationId: string) => [`rewritten-${randomUUID()}@example.com`, invitationId],
        },
        {
            column: "expires_at",
            query: "update public.workspace_invitations set expires_at = now() + interval '30 days' where id = $1",
            values: (invitationId: string) => [invitationId],
        },
        {
            column: "token_digest",
            query: "update public.workspace_invitations set token_digest = $1 where id = $2",
            values: (invitationId: string) => ["0".repeat(64), invitationId],
        },
    ])("denies app_api invitation $column rewrites", async ({ query, values }) => {
        await expect(
            withRawApiContext(userA.id, workspaceA, async (client) => {
                const invitationId = await insertInvitation(client);
                await client.query(query, values(invitationId));
            }),
        ).rejects.toMatchObject({ code: "42501" });
    });

    it("blocks the complete self-invitation cross-tenant admin escalation chain", async () => {
        await expect(
            withRawApiContext(userA.id, workspaceA, async (client) => {
                const invitationId = await insertInvitation(client);
                await client.query(
                    "update public.workspace_invitations set workspace_id = $1, role = 'admin', status = 'accepted' where id = $2",
                    [workspaceB, invitationId],
                );
                return client.query(
                    "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'admin', 'active') returning role",
                    [randomUUID(), workspaceB, userA.id],
                );
            }),
        ).rejects.toMatchObject({ code: "42501" });
    });

    it.each([
        { column: "id", query: "update public.workspaces set id = id where id = $1", values: () => [workspaceA] },
        { column: "type", query: "update public.workspaces set type = 'personal' where id = $1", values: () => [workspaceA] },
        { column: "owner_user_id", query: "update public.workspaces set owner_user_id = $1 where id = $2", values: () => [userB.id, workspaceA] },
        { column: "created_at", query: "update public.workspaces set created_at = timestamp with time zone '2000-01-01 00:00:00+00' where id = $1", values: () => [workspaceA] },
    ])("denies app_api Workspace $column rewrites", async ({ query, values }) => {
        await expect(
            withRawApiContext(userA.id, workspaceA, (client) => client.query(query, values())),
        ).rejects.toMatchObject({ code: "42501" });
    });

    it("allows only the planned manager cancel and recipient accept/reject status transitions", async () => {
        const statuses = await withRawApiContext(userA.id, workspaceA, async (client) => {
            const canceledId = await insertInvitation(client);
            const canceled = await client.query<{ status: string }>(
                "update public.workspace_invitations set status = 'canceled' where id = $1 returning status",
                [canceledId],
            );

            const acceptedId = await insertInvitation(client, userB.email);
            await client.query("select set_config($1, $2, true)", ["app.user_id", userB.id]);
            await client.query("select set_config($1, $2, true)", ["app.workspace_id", ""]);
            const accepted = await client.query<{ status: string }>(
                "update public.workspace_invitations set status = 'accepted' where id = $1 returning status",
                [acceptedId],
            );

            await client.query("select set_config($1, $2, true)", ["app.user_id", userA.id]);
            await client.query("select set_config($1, $2, true)", ["app.workspace_id", workspaceA]);
            const rejectedId = await insertInvitation(client, userB.email);
            await client.query("select set_config($1, $2, true)", ["app.user_id", userB.id]);
            await client.query("select set_config($1, $2, true)", ["app.workspace_id", ""]);
            const rejected = await client.query<{ status: string }>(
                "update public.workspace_invitations set status = 'rejected' where id = $1 returning status",
                [rejectedId],
            );

            return [canceled.rows[0]?.status, accepted.rows[0]?.status, rejected.rows[0]?.status];
        });

        expect(statuses).toEqual(["canceled", "accepted", "rejected"]);
    });
});

describe("user dimensional workspace listing", () => {
    it("lists only workspaces where the user has active membership", async () => {
        const summaries = await withUserTransaction(handle().db, userA.id, (tx) => listWorkspaces(tx, userA.id));

        expect(summaries.map((item) => item.id)).toEqual([workspaceA]);
    });
});

describe("owned workspace adoption", () => {
    it("adopts only the branded workspace returned by team creation", async () => {
        const created = await withUserTransaction(handle().db, userA.id, async (tx) => {
            const result = await createTeamWorkspace(tx, { id: userA.id, name: "team owner" }, {
                name: "adopted team",
                slug: "adopted-team-" + randomUUID().slice(0, 8),
            });
            const adopted = await adoptOwnedWorkspaceContext(tx, userA.id, result.resolvedWorkspaceId);
            return { workspaceId: result.summary.id, adopted };
        });

        expect(created.adopted).toBe(created.workspaceId);
    });

    it("rejects adopting a workspace not resolved as the current user's owned workspace", async () => {
        const forged = workspaceB as ResolvedOwnedWorkspaceId;

        await expect(
            withUserTransaction(handle().db, userA.id, (tx) => adoptOwnedWorkspaceContext(tx, userA.id, forged)),
        ).rejects.toMatchObject({ code: "workspace_context_adoption_forbidden" });
    });
});

describe("app_worker has no Gate 0 business privilege", () => {
    it("cannot select canvases at all", async () => {
        await expect(pool(workerPool, "worker").query("select id from public.canvases")).rejects.toMatchObject({
            code: "42501",
        });
    });

    it("cannot select workspaces at all", async () => {
        await expect(pool(workerPool, "worker").query("select id from public.workspaces")).rejects.toMatchObject({
            code: "42501",
        });
    });
});

describe("app_maintenance read-only allowlist", () => {
    it("reads the full global workspace candidate set through id and status only", async () => {
        const result = await pool(maintenancePool, "maintenance").query(
            "select id, status from public.workspaces order by id",
        );

        expect(result.rows.length).toBeGreaterThanOrEqual(2);
        expect(result.rows.every((row) => typeof row.status === "string")).toBe(true);
    });

    it("cannot read a non-allowlisted workspace column", async () => {
        await expect(pool(maintenancePool, "maintenance").query("select name from public.workspaces")).rejects.toMatchObject({
            code: "42501",
        });
    });

    it("cannot read any canvas column", async () => {
        await expect(pool(maintenancePool, "maintenance").query("select id from public.canvases")).rejects.toMatchObject({
            code: "42501",
        });
    });

    it("cannot write workspaces", async () => {
        await expect(
            pool(maintenancePool, "maintenance").query("update public.workspaces set status = 'suspended'"),
        ).rejects.toMatchObject({ code: "42501" });
    });
});

describe("explicit grant matrix", () => {
    it("grants app_api exactly the planned table commands", async () => {
        const result = await pool(apiPool, "api").query(
            "select table_name, privilege_type from information_schema.role_table_grants where grantee = 'app_api' and table_schema = 'public' order by table_name, privilege_type",
        );

        const matrix = new Map<string, string[]>();
        for (const row of result.rows) {
            matrix.set(row.table_name, [...(matrix.get(row.table_name) ?? []), row.privilege_type]);
        }

        expect(matrix.get("workspaces")).toEqual(["INSERT", "SELECT"]);
        expect(matrix.get("workspace_members")).toEqual(["DELETE", "INSERT", "SELECT"]);
        expect(matrix.get("workspace_invitations")).toEqual(["INSERT", "SELECT"]);
        expect(matrix.get("canvases")).toEqual(["INSERT", "SELECT"]);
        expect(matrix.get("workspace_audit_logs")).toEqual(["INSERT"]);
        for (const table of ["users", "sessions", "accounts", "verifications"]) {
            expect(matrix.get(table)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
        }
        expect(matrix.get("platform_admins")).toBeUndefined();
        expect(matrix.get("admin_operations")).toBeUndefined();
        expect(matrix.get("global_audit_logs")).toBeUndefined();
        expect(matrix.get("workspace_provisioning_audits")).toBeUndefined();
    });

    it("grants app_api UPDATE on exactly the planned business columns", async () => {
        const result = await pool(apiPool, "api").query(
            `select c.table_name, c.column_name
             from information_schema.columns c
             where c.table_schema = 'public'
               and c.table_name = any($1::text[])
               and has_column_privilege('app_api', format('%I.%I', c.table_schema, c.table_name), c.column_name, 'UPDATE')
             order by c.table_name, c.column_name`,
            [["canvases", "workspace_invitations", "workspace_members", "workspaces"]],
        );

        expect(result.rows).toEqual([
            { table_name: "canvases", column_name: "deleted_at" },
            { table_name: "canvases", column_name: "revision" },
            { table_name: "canvases", column_name: "snapshot_json" },
            { table_name: "canvases", column_name: "title" },
            { table_name: "canvases", column_name: "updated_at" },
            { table_name: "canvases", column_name: "updated_by" },
            { table_name: "workspace_invitations", column_name: "status" },
            { table_name: "workspaces", column_name: "deleted_at" },
            { table_name: "workspaces", column_name: "name" },
            { table_name: "workspaces", column_name: "slug" },
            { table_name: "workspaces", column_name: "status" },
            { table_name: "workspaces", column_name: "updated_at" },
        ]);
    });

    it("gives app_worker and app_maintenance no unexpected table privilege", async () => {
        const result = await pool(apiPool, "api").query(
            "select grantee, table_name, privilege_type from information_schema.role_table_grants where grantee in ('app_worker', 'app_maintenance') and table_schema = 'public' order by grantee, table_name",
        );

        expect(result.rows.filter((row) => row.grantee === "app_worker")).toEqual([]);
        expect(result.rows.filter((row) => row.grantee === "app_maintenance")).toEqual([]);
    });

    it("leaves PUBLIC with no application table privilege", async () => {
        const result = await pool(apiPool, "api").query(
            `select table_name, privilege_type
             from information_schema.table_privileges
             where grantee = 'PUBLIC'
               and table_schema = 'public'
               and table_name = any($1::text[])
             order by table_name, privilege_type`,
            [[
                "users", "sessions", "accounts", "verifications", "workspaces", "workspace_members",
                "workspace_invitations", "canvases", "workspace_audit_logs", "platform_admins",
                "admin_operations", "global_audit_logs", "workspace_provisioning_audits",
            ]],
        );

        expect(result.rows).toEqual([]);
    });

    it("limits app_maintenance to column level select on workspaces", async () => {
        const result = await pool(apiPool, "api").query(
            `select c.relname as table_name, a.attname as column_name
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
             where n.nspname = 'public'
               and has_column_privilege('app_maintenance', c.oid, a.attnum, 'SELECT')
             order by c.relname, a.attname`,
        );

        expect(result.rows).toEqual([
            { table_name: "workspaces", column_name: "id" },
            { table_name: "workspaces", column_name: "status" },
        ]);
    });

    it("grants only app_api the eight signature-specific control functions", async () => {
        const result = await pool(apiPool, "api").query(`
            select p.proname,
                   pg_get_function_identity_arguments(p.oid) as arguments,
                   has_function_privilege('app_api', p.oid, 'EXECUTE') as api,
                   has_function_privilege('app_worker', p.oid, 'EXECUTE') as worker,
                   has_function_privilege('app_maintenance', p.oid, 'EXECUTE') as maintenance,
                   exists (
                       select 1
                       from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                       where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
                   ) as public_execute
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname = any($1::text[])
            order by p.proname, arguments
        `, [[
            "begin_admin_operation",
            "execute_workspace_admin_operation",
            "has_accepted_workspace_invitation",
            "is_active_workspace_member",
            "is_current_admin_operation",
            "is_current_verified_email",
            "is_workspace_manager",
            "record_workspace_provisioning",
        ]]);

        expect(result.rows).toEqual([
            { proname: "begin_admin_operation", arguments: "target_kind text, target_workspace_id text, purpose text, request_id text", api: true, worker: false, maintenance: false, public_execute: false },
            { proname: "execute_workspace_admin_operation", arguments: "", api: true, worker: false, maintenance: false, public_execute: false },
            { proname: "has_accepted_workspace_invitation", arguments: "workspace_id text, user_id text, role text", api: true, worker: false, maintenance: false, public_execute: false },
            { proname: "is_active_workspace_member", arguments: "workspace_id text, user_id text", api: true, worker: false, maintenance: false, public_execute: false },
            { proname: "is_current_admin_operation", arguments: "required_target_kind text, required_purpose text, row_workspace_id text", api: true, worker: false, maintenance: false, public_execute: false },
            { proname: "is_current_verified_email", arguments: "candidate_email text, user_id text", api: true, worker: false, maintenance: false, public_execute: false },
            { proname: "is_workspace_manager", arguments: "workspace_id text, user_id text", api: true, worker: false, maintenance: false, public_execute: false },
            { proname: "record_workspace_provisioning", arguments: "source text, workspace_id text, event_id text", api: true, worker: false, maintenance: false, public_execute: false },
        ]);
    });

    it("defines the Workspace admin boundary as a zero-argument fixed-search-path SECURITY DEFINER", async () => {
        const result = await pool(apiPool, "api").query(
            `select p.prosecdef,
                    pg_get_function_identity_arguments(p.oid) as arguments,
                    p.proconfig
             from pg_proc p
             where p.oid = 'public.execute_workspace_admin_operation()'::regprocedure`,
        );

        expect(result.rows).toEqual([
            {
                prosecdef: true,
                arguments: "",
                proconfig: ["search_path=pg_catalog, public"],
            },
        ]);
    });

    it("targets every RLS policy at an explicit runtime role", async () => {
        const result = await pool(apiPool, "api").query(`
            select c.relname as table_name, p.polname, p.polcmd,
                   to_json(array(
                       select r.rolname
                       from unnest(p.polroles) role_oid
                       join pg_roles r on r.oid = role_oid
                       order by r.rolname
                   )) as roles
            from pg_policy p
            join pg_class c on c.oid = p.polrelid
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public'
            order by c.relname, p.polname
        `);

        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.rows.every((row) => row.roles.length === 1)).toBe(true);
        expect(new Set(result.rows.flatMap((row) => row.roles))).toEqual(
            new Set(["app_api", "app_worker", "app_maintenance", "schema_owner"]),
        );
        expect(result.rows.map((row) => row.polname)).not.toEqual(
            expect.arrayContaining([
                "workspaces_api_select_admin",
                "workspaces_api_update_admin_suspend",
                "workspaces_api_update_admin_deactivate",
                "workspaces_api_update_admin_restore",
                "workspace_audit_logs_api_insert_admin",
            ]),
        );
        expect(result.rows).toEqual(
            expect.arrayContaining([
                {
                    table_name: "workspace_audit_logs",
                    polname: "workspace_audit_logs_schema_owner_insert_admin",
                    polcmd: "a",
                    roles: ["schema_owner"],
                },
            ]),
        );
    });

    it("keeps runtime roles out of schema_owner and out of each other", async () => {
        const result = await pool(apiPool, "api").query(
            "select r.rolname as member, g.rolname as granted from pg_auth_members m join pg_roles r on r.oid = m.member join pg_roles g on g.oid = m.roleid where r.rolname in ('app_api', 'app_worker', 'app_maintenance')",
        );

        expect(result.rows).toEqual([]);
    });

    it("denies every runtime role CREATE on the public schema", async () => {
        const result = await pool(apiPool, "api").query(
            "select has_schema_privilege('app_api', 'public', 'CREATE') as api, has_schema_privilege('app_worker', 'public', 'CREATE') as worker, has_schema_privilege('app_maintenance', 'public', 'CREATE') as maintenance, has_schema_privilege('app_api', 'public', 'USAGE') as api_usage",
        );

        expect(result.rows[0]).toEqual({ api: false, worker: false, maintenance: false, api_usage: true });
    });
});


describe("canvas deletion receipt database invariant", () => {
    // 独立空间与成员，避免提交的软删除画布影响其他用例的可见性断言。
    const receiptUser = { id: "", email: "" };
    let receiptWorkspace = "";

    beforeAll(async () => {
        const admin = new Pool({ connectionString: adminUrl(), max: 1 });
        const client = await admin.connect();
        try {
            receiptUser.id = randomUUID();
            receiptUser.email = "receipt-" + receiptUser.id.slice(0, 8) + "@example.com";
            receiptWorkspace = randomUUID();
            // 空间与其唯一活跃 owner 必须在同一事务内建立，否则触发完整性校验。
            await client.query("begin");
            await client.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
                receiptUser.id,
                "receipt user",
                receiptUser.email,
            ]);
            await client.query(
                "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, $2, $3, 'team', $4, 'active')",
                [receiptWorkspace, "receipt ws", "receipt-" + receiptWorkspace.slice(0, 8), receiptUser.id],
            );
            await client.query(
                "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
                [randomUUID(), receiptWorkspace, receiptUser.id],
            );
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        } finally {
            client.release();
            await admin.end().catch(() => {});
        }
    }, 60_000);

    /** 编排型夹具走一次性容器管理员；行为断言始终经过真实 app_api。 */
    async function freshCanvas(): Promise<string> {
        const admin = new Pool({ connectionString: adminUrl(), max: 1 });
        try {
            const inserted = await admin.query(
                "insert into public.canvases (workspace_id, title, snapshot_json) values ($1, $2, $3::jsonb) returning id",
                [receiptWorkspace, "receipt-" + randomUUID().slice(0, 8), JSON.stringify({})],
            );
            return inserted.rows[0].id as string;
        } finally {
            await admin.end().catch(() => {});
        }
    }

    /** 提交型上下文：显式 commit，让后续事务能观察已签发的回执。 */
    async function commitAsApi<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await pool(apiPool, "api").connect();
        try {
            await client.query("begin");
            await client.query("select set_config($1, $2, true)", ["app.user_id", receiptUser.id]);
            await client.query("select set_config($1, $2, true)", ["app.workspace_id", receiptWorkspace]);
            const result = await work(client);
            await client.query("commit");
            return result;
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async function attemptAsApi(text: string, values: unknown[]): Promise<void> {
        await commitAsApi((client) => client.query(text, values));
    }

    async function readRow(canvasId: string) {
        const admin = new Pool({ connectionString: adminUrl(), max: 1 });
        try {
            const r = await admin.query(
                "select deletion_receipt_id::text as receipt, deleted_at::text as deleted_at, document_mode, revision::text as revision from public.canvases where id = $1",
                [canvasId],
            );
            return r.rows[0];
        } finally {
            await admin.end().catch(() => {});
        }
    }

    it("allows an active snapshot insert but denies app_api-supplied deletion lifecycle fields", async () => {
        const activeCanvasId = await commitAsApi(async (client) => {
            const inserted = await client.query<{ id: string }>(
                `insert into public.canvases
                    (workspace_id, title, snapshot_json, document_mode, created_by, updated_by)
                 values ($1, $2, $3::jsonb, 'snapshot', $4, $4)
                 returning id`,
                [receiptWorkspace, "active app_api insert", JSON.stringify({}), receiptUser.id],
            );
            return inserted.rows[0]!.id;
        });
        expect(await readRow(activeCanvasId)).toMatchObject({ document_mode: "snapshot", receipt: null });

        await expect(
            commitAsApi((client) =>
                client.query(
                    `insert into public.canvases
                        (id, workspace_id, title, snapshot_json, deleted_at, deletion_receipt_id)
                     values ($1, $2, $3, $4::jsonb, now(), $5)`,
                    [randomUUID(), receiptWorkspace, "forged deletion receipt", JSON.stringify({}), randomUUID()],
                ),
            ),
        ).rejects.toMatchObject({ code: "23514" });
    });

    it("generates the receipt inside the trigger on the sole allowed null to non-null transition", async () => {
        const canvasId = await freshCanvas();

        // app_api 只写 deleted_at；回执不在其列授权中，只能由触发器签发。
        const issued = await commitAsApi(async (client) => {
            const r = await client.query(
                "update public.canvases set deleted_at = now(), updated_at = now() where id = $1 returning deletion_receipt_id::text as receipt",
                [canvasId],
            );
            return r.rows[0];
        });
        const stored = await readRow(canvasId);

        expect(issued.receipt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(stored.receipt).toBe(issued.receipt);
        expect(stored.deleted_at).not.toBeNull();
    });

    it("rejects rewriting the receipt or the deletion timestamp after issuance", async () => {
        const canvasId = await freshCanvas();
        await attemptAsApi("update public.canvases set deleted_at = now() where id = $1", [canvasId]);
        const issued = await readRow(canvasId);

        await expect(
            attemptAsApi("update public.canvases set deletion_receipt_id = gen_random_uuid() where id = $1", [canvasId]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
            attemptAsApi("update public.canvases set deleted_at = deleted_at + interval '1 second' where id = $1", [canvasId]),
        ).rejects.toMatchObject({ code: "23514" });

        // 两次拒绝之后存储态必须逐字节保持首次签发结果。
        expect(await readRow(canvasId)).toEqual(issued);
    });

    it("rejects clearing the deletion pair so a deleted canvas cannot be resurrected", async () => {
        const canvasId = await freshCanvas();
        await attemptAsApi("update public.canvases set deleted_at = now() where id = $1", [canvasId]);
        const issued = await readRow(canvasId);

        await expect(
            attemptAsApi("update public.canvases set deleted_at = null, deletion_receipt_id = null where id = $1", [canvasId]),
        ).rejects.toMatchObject({ code: "42501" });

        expect(await readRow(canvasId)).toEqual(issued);
    });

    // 管理员探针绕过 RLS/列授权，只验证触发器启用时的直接 DML；不声称能约束可修改触发器的超级用户。
    it("enforces receipt immutability for privileged direct DML while the trigger remains enabled", async () => {
        const canvasId = await freshCanvas();
        await attemptAsApi("update public.canvases set deleted_at = now() where id = $1", [canvasId]);
        const issued = await readRow(canvasId);

        const admin = new Pool({ connectionString: adminUrl(), max: 1 });
        try {
            await expect(
                admin.query("update public.canvases set deletion_receipt_id = gen_random_uuid() where id = $1", [canvasId]),
            ).rejects.toMatchObject({ code: "23514" });
            await expect(
                admin.query("update public.canvases set deleted_at = null, deletion_receipt_id = null where id = $1", [canvasId]),
            ).rejects.toMatchObject({ code: "23514" });
            await expect(
                admin.query("update public.canvases set deleted_at = now() + interval '1 day' where id = $1", [canvasId]),
            ).rejects.toMatchObject({ code: "23514" });
        } finally {
            await admin.end().catch(() => {});
        }

        expect(await readRow(canvasId)).toEqual(issued);
    });

    it("overrides a caller-supplied first receipt so the database remains the sole issuer", async () => {
        const canvasId = await freshCanvas();
        const suppliedReceipt = randomUUID();
        const admin = new Pool({ connectionString: adminUrl(), max: 1 });
        try {
            const result = await admin.query(
                `update public.canvases
                 set deleted_at = now(), deletion_receipt_id = $2
                 where id = $1 returning deletion_receipt_id::text as receipt`,
                [canvasId, suppliedReceipt],
            );
            expect(result.rows[0]?.receipt).toMatch(/^[0-9a-f-]{36}$/);
            expect(result.rows[0]?.receipt).not.toBe(suppliedReceipt);
        } finally {
            await admin.end().catch(() => {});
        }
    });

    it("still allows ordinary active canvas saves without inventing a receipt", async () => {
        const canvasId = await freshCanvas();

        const saved = await commitAsApi(async (client) => {
            const r = await client.query(
                "update public.canvases set title = $2, revision = revision + 1, updated_at = now() where id = $1 returning revision::text as revision, deletion_receipt_id is null as no_receipt",
                [canvasId, "renamed"],
            );
            return r.rows[0];
        });

        expect(saved).toEqual({ revision: "1", no_receipt: true });
    });

    it("keeps document_mode and workspace_id denied and hard delete unavailable to app_api", async () => {
        const canvasId = await freshCanvas();

        await expect(
            attemptAsApi("update public.canvases set document_mode = 'collaborative' where id = $1", [canvasId]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
            attemptAsApi("update public.canvases set workspace_id = $2 where id = $1", [canvasId, workspaceB]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(attemptAsApi("delete from public.canvases where id = $1", [canvasId])).rejects.toMatchObject({
            code: "42501",
        });

        expect(await readRow(canvasId)).toMatchObject({ document_mode: "snapshot", receipt: null });
    });

    it("owns the trigger function by schema_owner with a fixed search path and no PUBLIC execute", async () => {
        const result = await pool(apiPool, "api").query(`
            select pg_get_userbyid(p.proowner) as owner,
                   p.prosecdef,
                   p.proconfig,
                   has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
                   t.tgname,
                   t.tgtype
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            left join pg_trigger t on t.tgfoid = p.oid and not t.tgisinternal
            where n.nspname = 'public' and p.proname = 'enforce_canvas_deletion_receipt'
        `);

        expect(result.rows).toEqual([
            {
                owner: "schema_owner",
                prosecdef: false,
                proconfig: ["search_path=pg_catalog, public"],
                public_execute: false,
                tgname: "canvases_enforce_deletion_receipt",
                // BEFORE(2) + ROW(1) + INSERT(4) + UPDATE(16) = 23
                tgtype: 23,
            },
        ]);
    });

    it("keeps canvases FORCE RLS and grants no app_api UPDATE on the receipt column", async () => {
        const [rls, grant] = await Promise.all([
            pool(apiPool, "api").query(
                "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.canvases'::regclass",
            ),
            pool(apiPool, "api").query(
                "select has_column_privilege('app_api', 'public.canvases', 'deletion_receipt_id', 'UPDATE') as can_update",
            ),
        ]);

        expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
        expect(grant.rows).toEqual([{ can_update: false }]);
    });
});
