import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

let postgres: StartedRoleDatabase | undefined;
let pool: Pool | undefined;
let adminPool: Pool | undefined;

/** 约束用例只用 schema_owner 播种并故意违反物理约束。 */
function db(): Pool {
    if (!pool) throw new Error("PostgreSQL pool is not started");
    return pool;
}

function forceRlsFixtureDb(): Pool {
    if (!adminPool) throw new Error("PostgreSQL administrator pool is not started");
    return adminPool;
}

async function insertUser(executor: Pool | PoolClient = db()): Promise<string> {
    const id = randomUUID();
    await executor.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
        id,
        `user-${id}`,
        `${id}@example.com`,
    ]);
    return id;
}

/** 单独取一条连接跑事务，保证延迟约束在 COMMIT 时报错并原样抛出。 */
async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db().connect();
    try {
        await client.query("begin");
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

async function insertWorkspace(
    executor: Pool | PoolClient,
    input: { ownerUserId: string; type?: string; status?: string; deletedAt?: string | null },
): Promise<string> {
    const id = randomUUID();
    await executor.query(
        `insert into public.workspaces (id, name, slug, type, owner_user_id, status, deleted_at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
            id,
            `ws-${id}`,
            `slug-${id}`,
            input.type ?? "team",
            input.ownerUserId,
            input.status ?? "active",
            input.deletedAt ?? null,
        ],
    );
    return id;
}

async function insertMember(
    executor: Pool | PoolClient,
    input: { workspaceId: string; userId: string; role?: string; status?: string },
): Promise<string> {
    const id = randomUUID();
    await executor.query(
        `insert into public.workspace_members (id, workspace_id, user_id, role, status)
         values ($1, $2, $3, $4, $5)`,
        [id, input.workspaceId, input.userId, input.role ?? "member", input.status ?? "active"],
    );
    return id;
}

async function insertInvitation(
    executor: Pool | PoolClient,
    input: { workspaceId: string; inviterId: string; email?: string; role?: string; status?: string; tokenDigest?: string },
): Promise<string> {
    const id = randomUUID();
    await executor.query(
        `insert into public.workspace_invitations
            (id, workspace_id, email, role, status, expires_at, inviter_id, token_digest)
         values ($1, $2, $3, $4, $5, now() + interval '7 days', $6, $7)`,
        [
            id,
            input.workspaceId,
            input.email ?? `invitee-${id}@example.com`,
            input.role ?? "member",
            input.status ?? "pending",
            input.inviterId,
            input.tokenDigest ?? randomUUID().replace(/-/g, "").padEnd(64, "a").slice(0, 64),
        ],
    );
    return id;
}

/** 完整的合法空间：唯一活跃 owner 成员且与 owner_user_id 一致。 */
async function seedWorkspace(type: "personal" | "team" = "team"): Promise<{ workspaceId: string; ownerId: string }> {
    return await withTransaction(async (client) => {
        const ownerId = await insertUser(client);
        const workspaceId = await insertWorkspace(client, { ownerUserId: ownerId, type });
        await insertMember(client, { workspaceId, userId: ownerId, role: "owner" });
        return { workspaceId, ownerId };
    });
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
    pool = new Pool({ connectionString: postgres.schemaOwner, max: 4 });
    // workspace_invitations is FORCE RLS; physical leaf constraints require the isolated container administrator.
    adminPool = new Pool({ connectionString: postgres.admin, max: 2 });
}, 240_000);

afterAll(async () => {
    await pool?.end().catch(() => {});
    await adminPool?.end().catch(() => {});
    pool = undefined;
    adminPool = undefined;
    await postgres?.stop().catch(() => {});
    postgres = undefined;
}, 60_000);

describe("workspace physical constraints", () => {
    it("accepts an active workspace whose sole active owner matches owner_user_id", async () => {
        const { workspaceId, ownerId } = await seedWorkspace("team");

        const result = await db().query(
            `select w.owner_user_id, m.user_id, m.role, m.status
             from public.workspaces w
             join public.workspace_members m on m.workspace_id = w.id
             where w.id = $1`,
            [workspaceId],
        );

        expect(result.rows).toEqual([{ owner_user_id: ownerId, user_id: ownerId, role: "owner", status: "active" }]);
    });

    it("rejects an unsupported member role", async () => {
        const { workspaceId } = await seedWorkspace();
        const outsider = await insertUser();

        await expect(insertMember(db(), { workspaceId, userId: outsider, role: "viewer" })).rejects.toMatchObject({
            code: "23514",
            constraint: "workspace_members_role_allowed",
        });
    });

    it("rejects a second active owner member", async () => {
        const { workspaceId } = await seedWorkspace();
        const outsider = await insertUser();

        await expect(insertMember(db(), { workspaceId, userId: outsider, role: "owner" })).rejects.toMatchObject({
            code: "23505",
            constraint: "workspace_members_one_active_owner_unique",
        });
    });

    it("rejects committing an active workspace without an owner member", async () => {
        await expect(
            withTransaction(async (client) => {
                const ownerId = await insertUser(client);
                await insertWorkspace(client, { ownerUserId: ownerId });
            }),
        ).rejects.toMatchObject({ code: "23514" });
    });

    it("rejects committing a workspace whose active owner is not owner_user_id", async () => {
        await expect(
            withTransaction(async (client) => {
                const ownerId = await insertUser(client);
                const otherId = await insertUser(client);
                const workspaceId = await insertWorkspace(client, { ownerUserId: ownerId });
                await insertMember(client, { workspaceId, userId: otherId, role: "owner" });
            }),
        ).rejects.toMatchObject({ code: "23514" });
    });

    it("rejects deleting a user who still owns a workspace", async () => {
        const { ownerId } = await seedWorkspace();

        // 外键是 ON DELETE RESTRICT，PostgreSQL 对它抛 23001 restrict_violation；
        // 23503 只会出现在 NO ACTION 外键上。这里保留 RESTRICT 语义并断言真实错误码。
        await expect(db().query("delete from public.users where id = $1", [ownerId])).rejects.toMatchObject({
            code: "23001",
        });
    });

    it("rejects an active workspace that carries deleted_at", async () => {
        const ownerId = await insertUser();

        await expect(
            insertWorkspace(db(), { ownerUserId: ownerId, status: "active", deletedAt: new Date().toISOString() }),
        ).rejects.toMatchObject({ code: "23514", constraint: "workspaces_deleted_at_status_coherent" });
    });

    it("requires deleted_at exactly for deactivated workspaces", async () => {
        const ownerId = await insertUser();

        await expect(
            insertWorkspace(db(), { ownerUserId: ownerId, status: "suspended", deletedAt: new Date().toISOString() }),
        ).rejects.toMatchObject({ code: "23514", constraint: "workspaces_deleted_at_status_coherent" });
        await expect(
            insertWorkspace(db(), { ownerUserId: ownerId, status: "deactivated", deletedAt: null }),
        ).rejects.toMatchObject({ code: "23514", constraint: "workspaces_deleted_at_status_coherent" });
        await expect(
            insertWorkspace(db(), {
                ownerUserId: ownerId,
                status: "deactivated",
                deletedAt: new Date().toISOString(),
            }),
        ).resolves.toEqual(expect.any(String));
    });

    it("rejects unsupported workspace status and type values", async () => {
        const ownerId = await insertUser();

        await expect(insertWorkspace(db(), { ownerUserId: ownerId, status: "archived" })).rejects.toMatchObject({
            code: "23514",
            constraint: "workspaces_status_allowed",
        });
        await expect(insertWorkspace(db(), { ownerUserId: ownerId, type: "shared" })).rejects.toMatchObject({
            code: "23514",
            constraint: "workspaces_type_allowed",
        });
    });

    it("rejects a second personal workspace for the same owner", async () => {
        const { ownerId } = await seedWorkspace("personal");

        await expect(
            withTransaction(async (client) => {
                const workspaceId = await insertWorkspace(client, { ownerUserId: ownerId, type: "personal" });
                await insertMember(client, { workspaceId, userId: ownerId, role: "owner" });
            }),
        ).rejects.toMatchObject({ code: "23505", constraint: "workspaces_owner_personal_unique" });
    });
});

describe("workspace invitation physical constraints", () => {
    it("accepts a normalized pending invitation", async () => {
        const { workspaceId, ownerId } = await seedWorkspace();

        const id = await insertInvitation(forceRlsFixtureDb(), {
            workspaceId,
            inviterId: ownerId,
            email: "invitee@example.com",
        });

        const result = await forceRlsFixtureDb().query(
            "select email, role, status from public.workspace_invitations where id = $1",
            [id],
        );
        expect(result.rows).toEqual([{ email: "invitee@example.com", role: "member", status: "pending" }]);
    });

    it("rejects a non-normalized invitation email", async () => {
        const { workspaceId, ownerId } = await seedWorkspace();

        await expect(
            insertInvitation(forceRlsFixtureDb(), { workspaceId, inviterId: ownerId, email: " Mixed@Example.com " }),
        ).rejects.toMatchObject({ code: "23514", constraint: "workspace_invitations_email_normalized" });
    });

    it("rejects an owner invitation role and an unsupported status", async () => {
        const { workspaceId, ownerId } = await seedWorkspace();

        await expect(
            insertInvitation(forceRlsFixtureDb(), { workspaceId, inviterId: ownerId, role: "owner" }),
        ).rejects.toMatchObject({
            code: "23514",
            constraint: "workspace_invitations_role_allowed",
        });
        await expect(
            insertInvitation(forceRlsFixtureDb(), { workspaceId, inviterId: ownerId, status: "expired" }),
        ).rejects.toMatchObject({
            code: "23514",
            constraint: "workspace_invitations_status_allowed",
        });
    });

    it("rejects a token digest that is not 64 characters", async () => {
        const { workspaceId, ownerId } = await seedWorkspace();

        await expect(
            insertInvitation(forceRlsFixtureDb(), { workspaceId, inviterId: ownerId, tokenDigest: "tooshort" }),
        ).rejects.toMatchObject({ code: "23514", constraint: "workspace_invitations_token_digest_length" });
    });
});
