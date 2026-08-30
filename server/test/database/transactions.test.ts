import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/infrastructure/database/client.js";
import {
    withPlatformAdminTransaction,
    withTenantTransaction,
    withUserTransaction,
    withWorkerTransaction,
    WORKSPACE_ADMIN_PURPOSES,
} from "../../src/infrastructure/database/transactions.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { adoptOwnedWorkspaceContext } from "../../src/modules/workspaces/context.js";
import { createTeamWorkspace, type ResolvedOwnedWorkspaceId } from "../../src/modules/workspaces/service.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

let postgres: StartedRoleDatabase | undefined;
let seed: Pool | undefined;
let admin: Pool | undefined;
let api: DatabaseHandle | undefined;
let worker: DatabaseHandle | undefined;

const users = { admin: "", memberA: "", outsider: "" };
let workspaceA = "";
let workspaceB = "";

function apiHandle(): DatabaseHandle {
    if (!api) throw new Error("app_api handle is not ready");
    return api;
}

function workerHandle(): DatabaseHandle {
    if (!worker) throw new Error("app_worker handle is not ready");
    return worker;
}

function seedPool(): Pool {
    if (!seed) throw new Error("seed pool is not ready");
    return seed;
}

function adminPool(): Pool {
    if (!admin) throw new Error("administrator pool is not ready");
    return admin;
}

async function insertUser(name: string): Promise<string> {
    const id = randomUUID();
    await seedPool().query(
        'insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)',
        [id, name, name + "@example.com"],
    );
    return id;
}

/** owner 不变量是延迟约束，空间与 owner 成员必须在同一个事务里提交。 */
async function seedWorkspace(ownerUserId: string): Promise<string> {
    const client = await seedPool().connect();
    const id = randomUUID();
    try {
        await client.query("begin");
        await client.query(
            "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, $2, $3, 'team', $4, 'active')",
            [id, "ws-" + id, "slug-" + id, ownerUserId],
        );
        await client.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
            [randomUUID(), id, ownerUserId],
        );
        await client.query("commit");
    } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
    return id;
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
    seed = new Pool({ connectionString: postgres.schemaOwner, max: 4 });
    admin = new Pool({ connectionString: postgres.admin, max: 1 });

    users.admin = await insertUser("admin-" + randomUUID().slice(0, 8));
    users.memberA = await insertUser("member-a-" + randomUUID().slice(0, 8));
    users.outsider = await insertUser("outsider-" + randomUUID().slice(0, 8));
    workspaceA = await seedWorkspace(users.memberA);
    workspaceB = await seedWorkspace(users.outsider);
    await seedPool().query(
        "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'member', 'active')",
        [randomUUID(), workspaceA, users.outsider],
    );

    await seedPool().query("insert into public.platform_admins (user_id, status) values ($1, 'active')", [users.admin]);

    // 连接池上限设为 1，事务结束后必然复用同一条物理连接。
    api = createDatabase({ url: postgres.api, poolMax: 1, expectedRole: "app_api" });
    worker = createDatabase({ url: postgres.worker, poolMax: 1, expectedRole: "app_worker" });
}, 240_000);

afterAll(async () => {
    await api?.pool.end().catch(() => {});
    await worker?.pool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await seed?.end().catch(() => {});
    await postgres?.stop().catch(() => {});
    postgres = undefined;
}, 60_000);

describe("transaction-local GUC", () => {
    it("does not leak app.user_id through a reused pool connection", async () => {
        await withUserTransaction(apiHandle().db, users.memberA, async (tx) => {
            const inside = await tx.execute("select current_setting('app.user_id', true) as user_id");
            expect(inside.rows[0]).toMatchObject({ user_id: users.memberA });
        });

        const leaked = await apiHandle().pool.query(
            "select current_setting('app.user_id', true) as user_id, current_setting('app.workspace_id', true) as workspace_id",
        );
        expect([null, ""]).toContain(leaked.rows[0].user_id);
        expect([null, ""]).toContain(leaked.rows[0].workspace_id);
    });

    it("never sets a workspace context in a user-only transaction", async () => {
        await withUserTransaction(apiHandle().db, users.memberA, async (tx) => {
            const inside = await tx.execute("select current_setting('app.workspace_id', true) as workspace_id");
            expect([null, ""]).toContain(inside.rows[0]!.workspace_id);
        });
    });
});

describe("admin operation binding", () => {
    it("binds an admin operation to the current transaction, user, target and purpose", async () => {
        const bound = await withPlatformAdminTransaction(
            apiHandle().db,
            {
                userId: users.admin,
                requestId: randomUUID(),
                target: { kind: "workspace", workspaceId: workspaceA },
                purpose: "workspace_read",
            },
            async (tx, operationId) => {
                const matched = await tx.execute(
                    "select public.is_current_admin_operation('workspace', 'workspace_read', '" + workspaceA + "') as ok",
                );
                return { operationId, ok: matched.rows[0]!.ok };
            },
        );

        expect(bound.operationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(bound.ok).toBe(true);
    });

    it("rejects a wrong purpose, wrong target and wrong workspace for the same operation", async () => {
        const checks = await withPlatformAdminTransaction(
            apiHandle().db,
            {
                userId: users.admin,
                requestId: randomUUID(),
                target: { kind: "workspace", workspaceId: workspaceA },
                purpose: "workspace_read",
            },
            async (tx) => {
                const wrongPurpose = await tx.execute(
                    "select public.is_current_admin_operation('workspace', 'workspace_suspend', '" + workspaceA + "') as ok",
                );
                const wrongTarget = await tx.execute(
                    "select public.is_current_admin_operation('platform', 'workspace_read', '" + workspaceA + "') as ok",
                );
                const wrongWorkspace = await tx.execute(
                    "select public.is_current_admin_operation('workspace', 'workspace_read', '" + workspaceB + "') as ok",
                );
                return [wrongPurpose.rows[0]!.ok, wrongTarget.rows[0]!.ok, wrongWorkspace.rows[0]!.ok];
            },
        );

        expect(checks).toEqual([false, false, false]);
    });

    it("cannot reuse an admin operation id in another transaction", async () => {
        const operationId = await withPlatformAdminTransaction(
            apiHandle().db,
            {
                userId: users.admin,
                requestId: randomUUID(),
                target: { kind: "workspace", workspaceId: workspaceA },
                purpose: "workspace_read",
            },
            async (_tx, id) => id,
        );

        // 换一个事务后手工塞回同一个操作 ID，事务 xid 不再匹配。
        const replayed = await withUserTransaction(apiHandle().db, users.admin, async (tx) => {
            await tx.execute("select set_config('app.admin_operation_id', '" + operationId + "', true)");
            const matched = await tx.execute(
                "select public.is_current_admin_operation('workspace', 'workspace_read', '" + workspaceA + "') as ok",
            );
            return matched.rows[0]!.ok;
        });

        expect(replayed).toBe(false);
    });

    it("rejects a forged admin operation id", async () => {
        const forged = await withUserTransaction(apiHandle().db, users.admin, async (tx) => {
            await tx.execute("select set_config('app.admin_operation_id', '" + randomUUID() + "', true)");
            const matched = await tx.execute(
                "select public.is_current_admin_operation('workspace', 'workspace_read', '" + workspaceA + "') as ok",
            );
            return matched.rows[0]!.ok;
        });

        expect(forged).toBe(false);
    });

    it("refuses to open an operation for a non-admin user", async () => {
        await expect(
            withPlatformAdminTransaction(
                apiHandle().db,
                {
                    userId: users.memberA,
                    requestId: randomUUID(),
                    target: { kind: "workspace", workspaceId: workspaceA },
                    purpose: "workspace_read",
                },
                async () => "unreachable",
            ),
            // Drizzle 把驱动错误包一层，真实 SQLSTATE 在 cause 上。
        ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("refuses an unsupported purpose for a workspace target", async () => {
        await expect(
            withPlatformAdminTransaction(
                apiHandle().db,
                {
                    userId: users.admin,
                    requestId: randomUUID(),
                    target: { kind: "workspace", workspaceId: workspaceA },
                    purpose: "user_read" as never,
                },
                async () => "unreachable",
            ),
        ).rejects.toMatchObject({ cause: { code: "22023" } });
    });

    // 闭世界门槛：曾经登记在白名单里、但缺少窄口执行函数 / 审计 CHECK / 审计 RLS 的用途
    // 必须在 begin 阶段就被拒绝，不能只依赖 TypeScript 类型收窄。
    it.each([
        "wallet_status_write",
        "billing_confirm_charge",
        "billing_confirm_no_charge",
        "ledger_compensate",
        "workspace_export",
    ])("refuses the unimplemented workspace purpose %s and commits no operation", async (purpose) => {
        const countOperations = async () =>
            (
                await adminPool().query<{ count: number }>(
                    "select count(*)::int as count from public.admin_operations",
                )
            ).rows[0]!.count;
        const before = await countOperations();

        await expect(
            withPlatformAdminTransaction(
                apiHandle().db,
                {
                    userId: users.admin,
                    requestId: randomUUID(),
                    target: { kind: "workspace", workspaceId: workspaceA },
                    purpose: purpose as never,
                },
                async () => "unreachable",
            ),
        ).rejects.toMatchObject({ cause: { code: "22023" } });

        expect(await countOperations()).toBe(before);
    });

    // 平台级目标当前没有任何四层齐备的用途：global_audit_logs 既无 action CHECK，
    // 也未启用 RLS，更没有窄口执行函数，因此在数据库边界一律拒绝。
    it.each(["user_read", "model_read", "model_write", "provider_route_read", "provider_route_write"])(
        "refuses the platform-target purpose %s at the database boundary",
        async (purpose) => {
            await expect(
                withUserTransaction(apiHandle().db, users.admin, (tx) =>
                    tx.execute(
                        sql`select public.begin_admin_operation('platform', null, ${purpose}, ${randomUUID()})`,
                    ),
                ),
            ).rejects.toMatchObject({ cause: { code: "22023" } });
        },
    );

    // TypeScript 可执行用途必须与数据库实际审计能力逐项一致，防止两侧再次漂移。
    it("keeps the TypeScript purpose list equal to the audited database capability", async () => {
        const constraint = await adminPool().query<{ definition: string }>(
            `select pg_get_constraintdef(oid) as definition
             from pg_constraint where conname = 'workspace_audit_logs_action_allowed'`,
        );
        const actions = [...constraint.rows[0]!.definition.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);

        expect(actions.sort()).toEqual([...WORKSPACE_ADMIN_PURPOSES].sort());
    });

    it("makes every audit and operation table append-only at the database boundary", async () => {
        const operation = await seedPool().query<{ id: string }>(
            `insert into public.admin_operations
                (admin_user_id, target_kind, target_workspace_id, purpose, request_id, transaction_xid)
             values ($1, 'workspace', $2, 'workspace_read', $3, pg_current_xact_id()) returning id`,
            [users.admin, workspaceA, randomUUID()],
        );
        const operationId = operation.rows[0]!.id;
        await seedPool().query(
            `insert into public.global_audit_logs (operation_id, actor_user_id, action, transaction_xid)
             values ($1, $2, 'workspace_read', pg_current_xact_id())`,
            [operationId, users.admin],
        );
        await adminPool().query(
            `insert into public.workspace_audit_logs
                (workspace_id, actor_user_id, action, from_status, to_status, operation_id, transaction_xid)
             values ($1, $2, 'workspace_read', 'active', 'active', $3, pg_current_xact_id())`,
            [workspaceA, users.admin, operationId],
        );
        await seedPool().query(
            `insert into public.workspace_provisioning_audits
                (user_id, source, event_id, workspace_id, transaction_xid)
             values ($1, 'explicit_repair', $2, $3, pg_current_xact_id())`,
            [users.memberA, randomUUID(), workspaceA],
        );

        for (const statement of [
            "update public.admin_operations set request_id = request_id",
            "update public.global_audit_logs set action = action",
            "update public.workspace_provisioning_audits set event_id = event_id",
        ]) {
            await expect(seedPool().query(statement)).rejects.toMatchObject({ code: "42501" });
        }
        await expect(
            adminPool().query("update public.workspace_audit_logs set action = action"),
        ).rejects.toMatchObject({ code: "42501" });
    });

    it("denies nonmember admin direct Workspace SELECT and zero-audit UPDATE", async () => {
        const workspaceId = await seedWorkspace(users.memberA);
        const attempted = await withPlatformAdminTransaction(
            apiHandle().db,
            {
                userId: users.admin,
                requestId: randomUUID(),
                target: { kind: "workspace", workspaceId },
                purpose: "workspace_suspend",
            },
            async (tx) => {
                const selected = await tx.execute(sql`select id from public.workspaces where id = ${workspaceId}`);
                const updated = await tx.execute(
                    sql`update public.workspaces
                        set status = 'suspended', deleted_at = null, updated_at = now()
                        where id = ${workspaceId}`,
                );
                return { selected: selected.rows, updated: updated.rowCount };
            },
        );
        const stored = await adminPool().query(
            `select w.status,
                    (select count(*)::int from public.admin_operations o where o.target_workspace_id = w.id) as operations,
                    (select count(*)::int from public.workspace_audit_logs a where a.workspace_id = w.id) as audits
             from public.workspaces w where w.id = $1`,
            [workspaceId],
        );

        expect(attempted).toEqual({ selected: [], updated: 0 });
        expect(stored.rows).toEqual([{ status: "active", operations: 1, audits: 0 }]);
    });

    it("denies lifecycle UPDATEs that smuggle Workspace name and slug", async () => {
        const workspaceId = await seedWorkspace(users.memberA);
        const updated = await withPlatformAdminTransaction(
            apiHandle().db,
            {
                userId: users.admin,
                requestId: randomUUID(),
                target: { kind: "workspace", workspaceId },
                purpose: "workspace_suspend",
            },
            (tx) =>
                tx.execute(
                    sql`update public.workspaces
                        set name = 'smuggled-name', slug = 'smuggled-slug',
                            status = 'suspended', deleted_at = null, updated_at = now()
                        where id = ${workspaceId}`,
                ),
        );
        const stored = await adminPool().query(
            `select w.name, w.slug, w.status,
                    (select count(*)::int from public.admin_operations o where o.target_workspace_id = w.id) as operations,
                    (select count(*)::int from public.workspace_audit_logs a where a.workspace_id = w.id) as audits
             from public.workspaces w where w.id = $1`,
            [workspaceId],
        );

        expect(updated.rowCount).toBe(0);
        expect(stored.rows).toEqual([
            {
                name: `ws-${workspaceId}`,
                slug: `slug-${workspaceId}`,
                status: "active",
                operations: 1,
                audits: 0,
            },
        ]);
    });

    it("denies app_api direct admin audit insertion even for a correctly bound operation", async () => {
        const workspaceId = await seedWorkspace(users.memberA);

        await expect(
            withPlatformAdminTransaction(
                apiHandle().db,
                {
                    userId: users.admin,
                    requestId: randomUUID(),
                    target: { kind: "workspace", workspaceId },
                    purpose: "workspace_read",
                },
                (tx, operationId) =>
                    tx.execute(sql`
                        insert into public.workspace_audit_logs
                            (workspace_id, actor_user_id, action, from_status, to_status, operation_id, transaction_xid)
                        values (${workspaceId}, ${users.admin}, 'workspace_read', 'active', 'active',
                                ${operationId}::uuid, pg_current_xact_id())
                    `),
            ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });

        const stored = await adminPool().query(
            `select (select count(*)::int from public.admin_operations where target_workspace_id = $1) as operations,
                    (select count(*)::int from public.workspace_audit_logs where workspace_id = $1) as audits`,
            [workspaceId],
        );
        expect(stored.rows).toEqual([{ operations: 0, audits: 0 }]);
    });

    it("derives the admin target from the bound operation and writes exactly one read audit", async () => {
        const workspaceId = await seedWorkspace(users.memberA);
        const result = await withPlatformAdminTransaction(
            apiHandle().db,
            {
                userId: users.admin,
                requestId: randomUUID(),
                target: { kind: "workspace", workspaceId },
                purpose: "workspace_read",
            },
            async (tx) => {
                await tx.execute(sql`select set_config('app.workspace_id', ${workspaceB}, true)`);
                return tx.execute<{
                    workspace_id: string;
                    workspace_status: string;
                }>(sql`select * from public.execute_workspace_admin_operation()`);
            },
        );
        const audits = await adminPool().query(
            "select workspace_id, actor_user_id, action, from_status, to_status from public.workspace_audit_logs where workspace_id = $1",
            [workspaceId],
        );

        expect(result.rows).toEqual([
            expect.objectContaining({ workspace_id: workspaceId, workspace_status: "active" }),
        ]);
        expect(audits.rows).toEqual([
            {
                workspace_id: workspaceId,
                actor_user_id: users.admin,
                action: "workspace_read",
                from_status: "active",
                to_status: "active",
            },
        ]);
    });

    it("executes a bound lifecycle transition without exposing metadata mutation", async () => {
        const workspaceId = await seedWorkspace(users.memberA);
        const result = await withPlatformAdminTransaction(
            apiHandle().db,
            {
                userId: users.admin,
                requestId: randomUUID(),
                target: { kind: "workspace", workspaceId },
                purpose: "workspace_suspend",
            },
            (tx) =>
                tx.execute<{
                    workspace_name: string;
                    workspace_slug: string;
                    workspace_status: string;
                }>(sql`select * from public.execute_workspace_admin_operation()`),
        );
        const stored = await adminPool().query(
            `select w.name, w.slug, w.status,
                    (select count(*)::int from public.workspace_audit_logs a where a.workspace_id = w.id) as audits
             from public.workspaces w where w.id = $1`,
            [workspaceId],
        );

        expect(result.rows).toEqual([
            expect.objectContaining({
                workspace_name: `ws-${workspaceId}`,
                workspace_slug: `slug-${workspaceId}`,
                workspace_status: "suspended",
            }),
        ]);
        expect(stored.rows).toEqual([
            { name: `ws-${workspaceId}`, slug: `slug-${workspaceId}`, status: "suspended", audits: 1 },
        ]);
    });

    it("fails closed when the same bound operation executes twice", async () => {
        const workspaceId = await seedWorkspace(users.memberA);

        await expect(
            withPlatformAdminTransaction(
                apiHandle().db,
                {
                    userId: users.admin,
                    requestId: randomUUID(),
                    target: { kind: "workspace", workspaceId },
                    purpose: "workspace_read",
                },
                async (tx) => {
                    await tx.execute(sql`select * from public.execute_workspace_admin_operation()`);
                    await tx.execute(sql`select * from public.execute_workspace_admin_operation()`);
                },
            ),
        ).rejects.toMatchObject({ cause: { code: "23505", constraint: "workspace_audit_logs_operation_unique" } });

        const stored = await adminPool().query(
            `select (select count(*)::int from public.admin_operations where target_workspace_id = $1) as operations,
                    (select count(*)::int from public.workspace_audit_logs where workspace_id = $1) as audits`,
            [workspaceId],
        );
        expect(stored.rows).toEqual([{ operations: 0, audits: 0 }]);
    });

    it("rejects wrong-purpose, wrong-xid and wrong-user operation execution", async () => {
        const purposeWorkspaceId = await seedWorkspace(users.memberA);
        // begin_admin_operation 现在已在白名单层拒绝未实现用途，该状态不再能从应用路径到达。
        // 这里改为在数据库边界伪造一条同 xid 的未实现用途操作，证明窄口执行函数
        // 自身仍然独立失败关闭，不依赖 begin 的白名单作为唯一防线。
        const forged = await seedPool().connect();
        try {
            await forged.query("begin");
            await forged.query("select set_config('app.user_id', $1, true)", [users.admin]);
            const operation = await forged.query<{ id: string }>(
                `insert into public.admin_operations
                    (admin_user_id, target_kind, target_workspace_id, purpose, request_id, transaction_xid)
                 values ($1, 'workspace', $2, 'workspace_export', $3, pg_current_xact_id()) returning id`,
                [users.admin, purposeWorkspaceId, randomUUID()],
            );
            await forged.query("select set_config('app.admin_operation_id', $1, true)", [operation.rows[0]!.id]);
            await expect(
                forged.query("select * from public.execute_workspace_admin_operation()"),
            ).rejects.toMatchObject({ code: "42501" });
        } finally {
            await forged.query("rollback").catch(() => {});
            forged.release();
        }

        const xidWorkspaceId = await seedWorkspace(users.memberA);
        const oldOperationId = await withPlatformAdminTransaction(
            apiHandle().db,
            {
                userId: users.admin,
                requestId: randomUUID(),
                target: { kind: "workspace", workspaceId: xidWorkspaceId },
                purpose: "workspace_read",
            },
            async (_tx, operationId) => operationId,
        );
        await expect(
            withUserTransaction(apiHandle().db, users.admin, async (tx) => {
                await tx.execute(sql`select set_config('app.admin_operation_id', ${oldOperationId}, true)`);
                await tx.execute(sql`select * from public.execute_workspace_admin_operation()`);
            }),
        ).rejects.toMatchObject({ cause: { code: "42501" } });

        const userWorkspaceId = await seedWorkspace(users.memberA);
        await expect(
            withPlatformAdminTransaction(
                apiHandle().db,
                {
                    userId: users.admin,
                    requestId: randomUUID(),
                    target: { kind: "workspace", workspaceId: userWorkspaceId },
                    purpose: "workspace_read",
                },
                async (tx) => {
                    await tx.execute(sql`select set_config('app.user_id', ${users.outsider}, true)`);
                    await tx.execute(sql`select * from public.execute_workspace_admin_operation()`);
                },
            ),
        ).rejects.toMatchObject({ cause: { code: "42501" } });
    });

    it("enforces one Workspace audit per non-null admin operation at schema level", async () => {
        const workspaceId = await seedWorkspace(users.memberA);
        const operation = await seedPool().query<{ id: string }>(
            `insert into public.admin_operations
                (admin_user_id, target_kind, target_workspace_id, purpose, request_id, transaction_xid)
             values ($1, 'workspace', $2, 'workspace_read', $3, pg_current_xact_id()) returning id`,
            [users.admin, workspaceId, randomUUID()],
        );
        const values = [workspaceId, users.admin, operation.rows[0]!.id];
        await adminPool().query(
            `insert into public.workspace_audit_logs
                (workspace_id, actor_user_id, action, from_status, to_status, operation_id, transaction_xid)
             values ($1, $2, 'workspace_read', 'active', 'active', $3, pg_current_xact_id())`,
            values,
        );

        await expect(
            adminPool().query(
                `insert into public.workspace_audit_logs
                    (workspace_id, actor_user_id, action, from_status, to_status, operation_id, transaction_xid)
                 values ($1, $2, 'workspace_read', 'active', 'active', $3, pg_current_xact_id())`,
                values,
            ),
        ).rejects.toMatchObject({ code: "23505", constraint: "workspace_audit_logs_operation_unique" });
    });
});

describe("tenant transactions", () => {
    it("does not leak user or workspace context through a reused pool connection", async () => {
        await withTenantTransaction(
            apiHandle().db,
            { userId: users.memberA, workspaceId: workspaceA },
            async (tx) => {
                const context = await tx.execute(
                    "select current_setting('app.user_id', true) as user_id, current_setting('app.workspace_id', true) as workspace_id",
                );
                expect(context.rows[0]).toEqual({ user_id: users.memberA, workspace_id: workspaceA });
            },
        );

        const leaked = await apiHandle().pool.query(
            "select current_setting('app.user_id', true) as user_id, current_setting('app.workspace_id', true) as workspace_id",
        );
        expect([null, ""]).toContain(leaked.rows[0].user_id);
        expect([null, ""]).toContain(leaked.rows[0].workspace_id);
    });

    it("rejects a forged workspace context with workspace_forbidden", async () => {
        await expect(
            withTenantTransaction(
                apiHandle().db,
                { userId: users.memberA, workspaceId: workspaceB },
                async () => "unreachable",
            ),
        ).rejects.toMatchObject({ code: "workspace_forbidden" });
    });

    it("enforces the minimum role on the same transaction", async () => {
        await expect(
            withTenantTransaction(
                apiHandle().db,
                { userId: users.outsider, workspaceId: workspaceA, minimumRole: "admin" },
                async () => "unreachable",
            ),
        ).rejects.toMatchObject({ code: "workspace_admin_required" });
    });
});

describe("owned workspace adoption", () => {
    it("rejects adopting a workspace not resolved as the current user's owned workspace", async () => {
        const forged = workspaceB as ResolvedOwnedWorkspaceId;

        await expect(
            withUserTransaction(apiHandle().db, users.memberA, (tx) =>
                adoptOwnedWorkspaceContext(tx, users.memberA, forged),
            ),
        ).rejects.toMatchObject({ code: "workspace_context_adoption_forbidden" });
    });

    it("adopts only the branded workspace returned by team creation", async () => {
        const result = await withUserTransaction(apiHandle().db, users.memberA, async (tx) => {
            const created = await createTeamWorkspace(
                tx,
                { id: users.memberA, name: "owner" },
                { name: "transaction team", slug: `transaction-team-${randomUUID().slice(0, 8)}` },
            );
            const adopted = await adoptOwnedWorkspaceContext(tx, users.memberA, created.resolvedWorkspaceId);
            return { created: created.summary.id, adopted };
        });

        expect(result.adopted).toBe(result.created);
    });
});

describe("worker transactions", () => {
    it("requires a verifier and aborts when it returns null", async () => {
        await expect(
            withWorkerTransaction(
                workerHandle().db,
                { workspaceId: workspaceA } as never,
                async () => "unreachable",
            ),
        ).rejects.toMatchObject({ code: "worker_verifier_required" });

        await expect(
            withWorkerTransaction(
                workerHandle().db,
                { workspaceId: workspaceA, verify: async () => null },
                async () => "unreachable",
            ),
        ).rejects.toMatchObject({ code: "worker_resource_not_found" });
    });

    it("sets only workspace context after a verifier succeeds", async () => {
        const context = await withWorkerTransaction(
            workerHandle().db,
            {
                workspaceId: workspaceA,
                verify: async (tx) => {
                    const row = await tx.execute("select current_setting('app.workspace_id', true) as workspace_id");
                    return row.rows[0];
                },
            },
            async (tx, resource) => {
                const row = await tx.execute("select current_setting('app.user_id', true) as user_id");
                return { resource, userId: row.rows[0]!.user_id };
            },
        );

        expect(context.resource).toEqual({ workspace_id: workspaceA });
        expect([null, ""]).toContain(context.userId);
    });
});
