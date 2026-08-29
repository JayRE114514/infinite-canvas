import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/infrastructure/database/client.js";
import { withUserTransaction } from "../../src/infrastructure/database/transactions.js";
import { listWorkspaces } from "../../src/modules/workspaces/service.js";
import {
    assertImmutableMigrationHashes,
    IMMUTABLE_MIGRATION_HASHES,
    latestJournalEntry,
    migrationHash,
    readJournal,
    readMigrationSql,
    runMigrations,
    runMigrationsAsRole,
} from "../helpers/database.js";
import { readAdoptOwnershipSql, startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

const LEGACY_OWNER_PASSWORD = "test-legacy-owner";
const IMMUTABLE_TAGS = ["0000_auth_and_workspaces", "0001_canvases"];
const POLICY_PREREQUISITE_TAGS = [
    "0000_auth_and_workspaces",
    "0001_canvases",
    "0002_workspace-authority",
    "0003_transaction-context",
];
const PRE_CANVAS_MODE_TAGS = [
    ...POLICY_PREREQUISITE_TAGS,
    "0004_tenant-rls",
    "0005_workspace-provisioning-audit-fix",
];

let postgres: StartedRoleDatabase | undefined;
const openPools: Pool[] = [];

function roles(): StartedRoleDatabase {
    if (!postgres) throw new Error("PostgreSQL container is not started");
    return postgres;
}

function openPool(connectionString: string): Pool {
    const pool = new Pool({ connectionString, max: 1 });
    openPools.push(pool);
    return pool;
}

function legacyOwnerUrl(): string {
    const url = new URL(roles().admin);
    url.username = "legacy_owner";
    url.password = LEGACY_OWNER_PASSWORD;
    return url.toString();
}

/** 把库恢复成“干净且由 schema_owner 持有”的状态。 */
async function resetToSchemaOwner(admin: Pool): Promise<void> {
    await admin.query("drop schema if exists drizzle cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    await admin.query("alter schema public owner to schema_owner");
    await admin.query("revoke create on schema public from public");
    await admin.query("grant create, usage on schema public to schema_owner");
}

/** 模拟上线前状态：public 由 legacy_owner 持有并可建对象。 */
async function resetToLegacyOwner(admin: Pool): Promise<void> {
    await admin.query(`
        DO $legacy$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacy_owner') THEN
                CREATE ROLE legacy_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
            END IF;
        END
        $legacy$;
    `);
    await admin.query(`ALTER ROLE legacy_owner PASSWORD '${LEGACY_OWNER_PASSWORD}'`);
    await admin.query("GRANT CONNECT ON DATABASE test TO legacy_owner");
    // 遗留迁移同样要建 drizzle 模式，需要库级 CREATE。
    await admin.query("GRANT CREATE ON DATABASE test TO legacy_owner");
    await admin.query("drop schema if exists drizzle cascade");
    await admin.query("drop schema if exists public cascade");
    await admin.query("create schema public");
    await admin.query("alter schema public owner to legacy_owner");
    await admin.query("grant create, usage on schema public to legacy_owner");
}

type OwnershipRow = { schema_name: string; object_name: string; owner: string };

async function relationOwners(pool: Pool): Promise<OwnershipRow[]> {
    const result = await pool.query<OwnershipRow>(`
        select n.nspname as schema_name,
               c.relname as object_name,
               pg_get_userbyid(c.relowner) as owner
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'drizzle')
          and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
        order by n.nspname, c.relname
    `);
    return result.rows;
}

type MigrationHistoryRow = { id: number; hash: string; created_at: string | null };

async function migrationHistory(pool: Pool): Promise<MigrationHistoryRow[]> {
    const result = await pool.query<MigrationHistoryRow>(
        'select id, hash, created_at::text as created_at from drizzle."__drizzle_migrations" order by id',
    );
    return result.rows;
}

function postgresCode(error: unknown): string | undefined {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const value = current as Record<string, unknown>;
        if (typeof value.code === "string") return value.code;
        current = value.cause;
    }
    return undefined;
}

async function seedCanvasBackfillFixture(admin: Pool) {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const activeCanvasId = randomUUID();
    const deletedCanvasIds = [randomUUID(), randomUUID()];
    const deletedAt = [new Date("2026-01-02T03:04:05.000Z"), new Date("2026-02-03T04:05:06.000Z")];

    await admin.query("begin");
    try {
        await admin.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            userId,
            "canvas migration owner",
            `canvas-migration-${userId}@example.com`,
        ]);
        await admin.query(
            "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, $2, $3, 'team', $4, 'active')",
            [workspaceId, "canvas migration workspace", `canvas-migration-${workspaceId}`, userId],
        );
        await admin.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
            [randomUUID(), workspaceId, userId],
        );
        await admin.query(
            "insert into public.canvases (id, workspace_id, title, snapshot_json) values ($1, $2, $3, $4::jsonb)",
            [activeCanvasId, workspaceId, "active before 0006", JSON.stringify({ active: true })],
        );
        for (const [index, canvasId] of deletedCanvasIds.entries()) {
            await admin.query(
                "insert into public.canvases (id, workspace_id, title, snapshot_json, deleted_at) values ($1, $2, $3, $4::jsonb, $5)",
                [canvasId, workspaceId, `deleted before 0006 ${index}`, JSON.stringify({ deleted: index }), deletedAt[index]],
            );
        }
        await admin.query("commit");
    } catch (error) {
        await admin.query("rollback").catch(() => {});
        throw error;
    }

    return { workspaceId, activeCanvasId, deletedCanvasIds, deletedAt };
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
}, 180_000);

afterEach(async () => {
    for (const pool of openPools.splice(0)) {
        if (pool.ending || pool.ended) continue;
        await pool.end().catch(() => {});
    }
}, 30_000);

afterAll(async () => {
    await postgres?.stop().catch(() => {});
    postgres = undefined;
}, 60_000);

describe("immutable migration history", () => {
    it("keeps 0000/0001 SQL byte-for-byte identical to their pinned hashes", async () => {
        await expect(assertImmutableMigrationHashes()).resolves.toBeUndefined();

        for (const [tag, expected] of Object.entries(IMMUTABLE_MIGRATION_HASHES)) {
            expect(migrationHash(await readMigrationSql(tag))).toBe(expected);
        }
    });

    it("keeps generated snapshot ancestry and custom-migration schemas exact", async () => {
        type SnapshotTable = {
            columns: Record<string, unknown>;
            indexes: Record<string, unknown>;
            foreignKeys: Record<string, unknown>;
            checkConstraints: Record<string, { value: string }>;
            uniqueConstraints: Record<string, unknown>;
        };
        type Snapshot = {
            id: string;
            prevId: string;
            tables: Record<string, SnapshotTable>;
            [key: string]: unknown;
        };
        const readSnapshot = async (tag: string) =>
            JSON.parse(
                await readFile(new URL(`../../migrations/meta/${tag}_snapshot.json`, import.meta.url), "utf8"),
            ) as Snapshot;
        const [snapshot2, snapshot3, snapshot4, snapshot5, snapshot6] = await Promise.all([
            readSnapshot("0002"),
            readSnapshot("0003"),
            readSnapshot("0004"),
            readSnapshot("0005"),
            readSnapshot("0006"),
        ]);
        expect((await readJournal()).entries).toEqual([
            { idx: 0, version: "7", when: 1787735042446, tag: "0000_auth_and_workspaces", breakpoints: true },
            { idx: 1, version: "7", when: 1787821442446, tag: "0001_canvases", breakpoints: true },
            { idx: 2, version: "7", when: 1787867556275, tag: "0002_workspace-authority", breakpoints: true },
            { idx: 3, version: "7", when: 1787868758532, tag: "0003_transaction-context", breakpoints: true },
            { idx: 4, version: "7", when: 1787869148642, tag: "0004_tenant-rls", breakpoints: true },
            {
                idx: 5,
                version: "7",
                when: 1787885037416,
                tag: "0005_workspace-provisioning-audit-fix",
                breakpoints: true,
            },
            {
                idx: 6,
                version: "7",
                when: 1787900000000,
                tag: "0006_canvas_document_mode",
                breakpoints: true,
            },
        ]);

        expect(snapshot3.prevId).toBe(snapshot2.id);
        expect(snapshot4.prevId).toBe(snapshot3.id);
        expect(snapshot5.prevId).toBe(snapshot4.id);
        expect(snapshot6.prevId).toBe(snapshot5.id);
        expect(snapshot2.tables["public.workspaces"]!.checkConstraints.workspaces_deleted_at_status_coherent!.value).toBe(
            "(status = 'deactivated') = (deleted_at is not null)",
        );
        expect(Object.keys(snapshot3.tables["public.workspace_audit_logs"]!.columns)).toEqual([
            "id",
            "workspace_id",
            "actor_user_id",
            "action",
            "from_status",
            "to_status",
            "operation_id",
            "transaction_xid",
            "created_at",
        ]);
        expect(Object.keys(snapshot3.tables["public.workspace_audit_logs"]!.foreignKeys).sort()).toEqual([
            "workspace_audit_logs_actor_user_id_users_id_fk",
            "workspace_audit_logs_operation_id_admin_operations_id_fk",
            "workspace_audit_logs_workspace_id_workspaces_id_fk",
        ]);
        expect(Object.keys(snapshot3.tables["public.workspace_audit_logs"]!.indexes).sort()).toEqual([
            "workspace_audit_logs_operation_unique",
            "workspace_audit_logs_workspace_id_idx",
        ]);

        const normalize = ({ id: _id, prevId: _prevId, ...snapshot }: typeof snapshot3) => snapshot;
        expect(normalize(snapshot4)).toEqual(normalize(snapshot3));
        expect(normalize(snapshot5)).toEqual(normalize(snapshot4));

        // Canvas 的模式/回执列只在 0006 出现，0005 之前保持不变。
        const canvases5 = snapshot5.tables["public.canvases"]!;
        const canvases6 = snapshot6.tables["public.canvases"]!;
        expect(Object.keys(canvases5.columns)).not.toContain("document_mode");
        expect(Object.keys(canvases5.columns)).not.toContain("deletion_receipt_id");
        expect(Object.keys(canvases5.checkConstraints)).not.toContain("canvases_document_mode_check");
        expect(Object.keys(canvases5.checkConstraints)).not.toContain("canvases_deletion_state_check");
        expect(Object.keys(canvases5.uniqueConstraints)).not.toContain("canvases_deletion_receipt_unique");
        expect(Object.keys(canvases6.columns)).toEqual(expect.arrayContaining(["document_mode", "deletion_receipt_id"]));
        expect(canvases6.checkConstraints.canvases_document_mode_check!.value).toBe(
            "document_mode IN ('snapshot', 'collaborative')",
        );
        expect(canvases6.checkConstraints.canvases_deletion_state_check!.value).toBe(
            "(deleted_at IS NULL) = (deletion_receipt_id IS NULL)",
        );
        expect(canvases6.uniqueConstraints.canvases_deletion_receipt_unique).toEqual({
            name: "canvases_deletion_receipt_unique",
            columns: ["deletion_receipt_id"],
            nullsNotDistinct: false,
        });

        // 0006 只改 Canvas 一张表，其余表与 0005 完全一致。
        const withoutCanvases = ({ id: _id, prevId: _prevId, tables, ...rest }: typeof snapshot5) => ({
            ...rest,
            tables: Object.fromEntries(Object.entries(tables).filter(([name]) => name !== "public.canvases")),
        });
        expect(withoutCanvases(snapshot6)).toEqual(withoutCanvases(snapshot5));
    });
});

describe("fresh install as schema_owner", () => {
    it("applies every journaled migration and leaves schema_owner owning all objects", async () => {
        const admin = openPool(roles().admin);
        await resetToSchemaOwner(admin);

        await runMigrations(roles().schemaOwner);

        const latest = await latestJournalEntry();
        const expectedHash = migrationHash(await readMigrationSql(latest.tag));
        const history = await admin.query<{ hash: string; created_at: string }>(
            'select hash, created_at::text as created_at from drizzle."__drizzle_migrations" order by created_at desc limit 1',
        );

        expect(history.rows[0]?.hash).toBe(expectedHash);
        expect(history.rows[0]?.created_at).toBe(String(latest.when));

        const owners = await relationOwners(admin);
        expect(owners.length).toBeGreaterThan(0);
        expect(owners.filter((row) => row.owner !== "schema_owner")).toEqual([]);
    }, 120_000);

    it("applies the policy migration when the optional drizzle schema is absent", async () => {
        const admin = openPool(roles().admin);
        await resetToSchemaOwner(admin);
        await runMigrationsAsRole(roles().schemaOwner, POLICY_PREREQUISITE_TAGS);
        await admin.query("drop schema drizzle cascade");

        const schemaOwner = openPool(roles().schemaOwner);
        const policyMigration = await readMigrationSql("0004_tenant-rls");

        await expect(
            (async () => {
                for (const statement of policyMigration.split("--> statement-breakpoint")) {
                    await schemaOwner.query(statement);
                }
            })(),
        ).resolves.toBeUndefined();
    }, 120_000);
});

describe("0006 populated Canvas upgrade", () => {
    it("backfills deleted canvases and installs the final receipt boundary from a real 0005 schema", async () => {
        const admin = openPool(roles().admin);
        await resetToSchemaOwner(admin);
        await runMigrationsAsRole(roles().schemaOwner, PRE_CANVAS_MODE_TAGS);
        const fixture = await seedCanvasBackfillFixture(admin);

        await runMigrations(roles().schemaOwner);

        const rows = await admin.query<{
            id: string;
            document_mode: string;
            deleted_at: Date | null;
            deletion_receipt_id: string | null;
        }>(
            `select id, document_mode, deleted_at, deletion_receipt_id::text
             from public.canvases where id = any($1::uuid[]) order by id`,
            [[fixture.activeCanvasId, ...fixture.deletedCanvasIds]],
        );
        const byId = new Map(rows.rows.map((row) => [row.id, row]));
        expect(byId.get(fixture.activeCanvasId)).toEqual({
            id: fixture.activeCanvasId,
            document_mode: "snapshot",
            deleted_at: null,
            deletion_receipt_id: null,
        });
        for (const [index, canvasId] of fixture.deletedCanvasIds.entries()) {
            expect(byId.get(canvasId)).toEqual({
                id: canvasId,
                document_mode: "snapshot",
                deleted_at: fixture.deletedAt[index],
                deletion_receipt_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            });
        }
        expect(new Set(fixture.deletedCanvasIds.map((id) => byId.get(id)!.deletion_receipt_id)).size).toBe(2);

        const invalidInsert = (columns: string, values: string, parameters: unknown[]) =>
            admin.query(
                `insert into public.canvases (id, workspace_id, title, snapshot_json, ${columns})
                 values ($1, $2, $3, $4::jsonb, ${values})`,
                [randomUUID(), fixture.workspaceId, "invalid post-0006 canvas", JSON.stringify({}), ...parameters],
            );
        // 隔离验证物理约束本身；应用角色永远没有禁用触发器的权限。
        await admin.query("alter table public.canvases disable trigger canvases_enforce_deletion_receipt");
        try {
            await expect(invalidInsert("deleted_at", "$5", [new Date()])).rejects.toMatchObject({ code: "23514" });
            await expect(invalidInsert("deletion_receipt_id", "$5", [randomUUID()])).rejects.toMatchObject({ code: "23514" });
            await expect(invalidInsert("document_mode", "$5", ["invalid"])).rejects.toMatchObject({ code: "23514" });

            const duplicateReceipt = randomUUID();
            await invalidInsert("deleted_at, deletion_receipt_id", "$5, $6", [new Date(), duplicateReceipt]);
            await expect(
                invalidInsert("deleted_at, deletion_receipt_id", "$5, $6", [new Date(), duplicateReceipt]),
            ).rejects.toMatchObject({ code: "23505" });
        } finally {
            await admin.query("alter table public.canvases enable trigger canvases_enforce_deletion_receipt");
        }

        const catalog = await admin.query(`
            select c.relrowsecurity, c.relforcerowsecurity,
                   pg_get_userbyid(p.proowner) as function_owner,
                   p.prosecdef,
                   p.proconfig,
                   has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
                   array(
                       select con.conname::text
                       from pg_constraint con
                       where con.conrelid = c.oid
                         and con.conname = any(array[
                             'canvases_document_mode_check',
                             'canvases_deletion_state_check',
                             'canvases_deletion_receipt_unique'
                         ])
                       order by con.conname
                   ) as constraints,
                   exists (
                       select 1 from pg_trigger t
                       where t.tgrelid = c.oid
                         and t.tgname = 'canvases_enforce_deletion_receipt'
                         and t.tgenabled = 'O'
                         and not t.tgisinternal
                   ) as trigger_exists,
                   has_column_privilege('app_api', c.oid, 'deleted_at', 'UPDATE') as can_update_deleted_at,
                   has_column_privilege('app_api', c.oid, 'deletion_receipt_id', 'UPDATE') as can_update_receipt
            from pg_class c
            join pg_proc p on p.oid = 'public.enforce_canvas_deletion_receipt()'::regprocedure
            where c.oid = 'public.canvases'::regclass
        `);
        expect(catalog.rows).toEqual([
            {
                relrowsecurity: true,
                relforcerowsecurity: true,
                function_owner: "schema_owner",
                prosecdef: false,
                proconfig: ["search_path=pg_catalog, public"],
                public_execute: false,
                constraints: [
                    "canvases_deletion_receipt_unique",
                    "canvases_deletion_state_check",
                    "canvases_document_mode_check",
                ],
                trigger_exists: true,
                can_update_deleted_at: true,
                can_update_receipt: false,
            },
        ]);

        const history = await migrationHistory(admin);
        const entry = (await readJournal()).entries.find((candidate) => candidate.tag === "0006_canvas_document_mode")!;
        expect(history.at(-1)).toMatchObject({
            hash: migrationHash(await readMigrationSql(entry.tag)),
            created_at: String(entry.when),
        });
    }, 120_000);

    it("rolls the whole migration back on a mid-backfill fault and retries cleanly", async () => {
        const admin = openPool(roles().admin);
        await resetToSchemaOwner(admin);
        await runMigrationsAsRole(roles().schemaOwner, PRE_CANVAS_MODE_TAGS);
        const fixture = await seedCanvasBackfillFixture(admin);
        const faultCanvasId = fixture.deletedCanvasIds[0]!;

        await admin.query(`
            create function public.test_fail_canvas_receipt_backfill()
            returns trigger language plpgsql set search_path = pg_catalog, public
            as $function$
            begin
                if old.id = '${faultCanvasId}'::uuid then
                    raise exception 'injected 0006 backfill failure' using errcode = 'P0001';
                end if;
                return new;
            end
            $function$;
            create trigger a_test_fail_canvas_receipt_backfill
            before update on public.canvases
            for each row execute function public.test_fail_canvas_receipt_backfill();
        `);

        let failure: unknown;
        try {
            await runMigrations(roles().schemaOwner);
        } catch (error) {
            failure = error;
        }
        expect(postgresCode(failure)).toBe("P0001");

        const rolledBack = await admin.query(`
            select c.relforcerowsecurity,
                   array(
                       select a.attname::text
                       from pg_attribute a
                       where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                         and a.attname in ('document_mode', 'deletion_receipt_id')
                       order by a.attname
                   ) as new_columns
            from pg_class c where c.oid = 'public.canvases'::regclass
        `);
        expect(rolledBack.rows).toEqual([{ relforcerowsecurity: true, new_columns: [] }]);
        expect((await migrationHistory(admin)).at(-1)).toMatchObject({
            hash: migrationHash(await readMigrationSql("0005_workspace-provisioning-audit-fix")),
        });
        const preserved = await admin.query("select deleted_at from public.canvases where id = $1", [faultCanvasId]);
        expect(preserved.rows).toEqual([{ deleted_at: fixture.deletedAt[0] }]);

        await admin.query("drop trigger a_test_fail_canvas_receipt_backfill on public.canvases");
        await admin.query("drop function public.test_fail_canvas_receipt_backfill()");
        await runMigrations(roles().schemaOwner);

        const retried = await admin.query(
            "select document_mode, deleted_at, deletion_receipt_id::text from public.canvases where id = $1",
            [faultCanvasId],
        );
        expect(retried.rows).toEqual([
            {
                document_mode: "snapshot",
                deleted_at: fixture.deletedAt[0],
                deletion_receipt_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
            },
        ]);
        expect((await migrationHistory(admin)).at(-1)).toMatchObject({
            hash: migrationHash(await readMigrationSql("0006_canvas_document_mode")),
        });
    }, 120_000);
});

describe("legacy owner upgrade path", () => {
    it("adopts pre-release public and drizzle objects without rewriting migration history", async () => {
        const admin = openPool(roles().admin);
        await resetToLegacyOwner(admin);

        // 扩展自有对象必须留在原主人名下，用于验证收养脚本的排除逻辑。
        await admin.query("create extension if not exists pgcrypto with schema public");

        await runMigrationsAsRole(legacyOwnerUrl(), IMMUTABLE_TAGS);

        const legacyUserId = randomUUID();
        const legacyWorkspaceId = randomUUID();
        const legacyInvitationId = randomUUID();
        const legacy = openPool(legacyOwnerUrl());
        await legacy.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            legacyUserId,
            "legacy user",
            "legacy-owner@example.com",
        ]);
        await legacy.query(
            'insert into public.workspaces (id, name, slug, "createdAt", workspace_type, status, owner_user_id) values ($1, $2, $3, timestamp \'2026-01-02 03:04:05\', \'team\', \'active\', $4)',
            [legacyWorkspaceId, "legacy workspace", `legacy-${legacyWorkspaceId}`, legacyUserId],
        );
        await legacy.query(
            'insert into public.workspace_members (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, \'owner\', timestamp \'2026-01-02 03:04:05\')',
            [randomUUID(), legacyWorkspaceId, legacyUserId],
        );
        await legacy.query(
            'insert into public.workspace_invitations (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") values ($1, $2, $3, null, \'pending\', timestamp \'2026-01-09 03:04:05\', timestamp \'2026-01-02 03:04:05\', $4)',
            [legacyInvitationId, legacyWorkspaceId, " Legacy-Invitee@Example.com ", legacyUserId],
        );

        const before = await migrationHistory(admin);
        expect(before.map((row) => row.hash)).toEqual([
            IMMUTABLE_MIGRATION_HASHES["0000_auth_and_workspaces"],
            IMMUTABLE_MIGRATION_HASHES["0001_canvases"],
        ]);

        const ownedByLegacy = await relationOwners(admin);
        expect(ownedByLegacy.filter((row) => row.owner === "legacy_owner").length).toBeGreaterThan(0);
        expect(ownedByLegacy.some((row) => row.object_name === "__drizzle_migrations")).toBe(true);

        await admin.query(await readAdoptOwnershipSql());

        // 应用对象、迁移元数据表与其序列全部转移到 schema_owner。
        const afterOwners = await relationOwners(admin);
        expect(afterOwners.filter((row) => row.owner !== "schema_owner")).toEqual([]);
        expect(afterOwners.some((row) => row.object_name === "__drizzle_migrations")).toBe(true);
        expect(afterOwners.some((row) => row.object_name === "__drizzle_migrations_id_seq")).toBe(true);

        // 历史行逐字节保持不变。
        expect(await migrationHistory(admin)).toEqual(before);

        // 收养后由 schema_owner 继续 journal，不重写 0000/0001 历史。
        await runMigrations(roles().schemaOwner);
        const continuedHistory = await migrationHistory(admin);
        expect(continuedHistory.slice(0, before.length)).toEqual(before);
        const latest = await latestJournalEntry();
        expect(continuedHistory.at(-1)).toMatchObject({
            hash: migrationHash(await readMigrationSql(latest.tag)),
            created_at: String(latest.when),
        });

        const columns = await admin.query<{ table_name: string; columns: string[] }>(`
            select table_name, array_agg(column_name::text order by ordinal_position) as columns
            from information_schema.columns
            where table_schema = 'public'
              and table_name in ('workspaces', 'workspace_members', 'workspace_invitations')
            group by table_name
            order by table_name
        `);
        expect(columns.rows).toEqual([
            {
                table_name: "workspace_invitations",
                columns: ["id", "workspace_id", "email", "role", "status", "expires_at", "created_at", "inviter_id", "token_digest"],
            },
            {
                table_name: "workspace_members",
                columns: ["id", "workspace_id", "user_id", "role", "joined_at", "status"],
            },
            {
                table_name: "workspaces",
                columns: ["id", "name", "slug", "created_at", "type", "status", "owner_user_id", "updated_at", "deleted_at"],
            },
        ]);

        const converted = await admin.query(
            "select email, role, status, char_length(token_digest) as digest_length, created_at from public.workspace_invitations where id = $1",
            [legacyInvitationId],
        );
        expect(converted.rows).toEqual([
            {
                email: "legacy-invitee@example.com",
                role: "member",
                status: "canceled",
                digest_length: 64,
                created_at: new Date("2026-01-02T03:04:05.000Z"),
            },
        ]);

        const api = createDatabase({ url: roles().api, poolMax: 1, expectedRole: "app_api" });
        try {
            const summaries = await withUserTransaction(api.db, legacyUserId, (tx) => listWorkspaces(tx, legacyUserId));
            expect(summaries).toEqual([
                expect.objectContaining({ id: legacyWorkspaceId, type: "team", role: "owner", status: "active" }),
            ]);
        } finally {
            await api.pool.end().catch(() => {});
        }

        const finalOwners = await relationOwners(admin);
        expect(finalOwners.filter((row) => row.owner !== "schema_owner")).toEqual([]);

        // 扩展自有函数没有被转移。
        const extensionOwners = await admin.query<{ owner: string; total: string }>(`
            select pg_get_userbyid(p.proowner) as owner, count(*)::text as total
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            join pg_depend d on d.objid = p.oid and d.deptype = 'e'
            where n.nspname = 'public'
            group by 1
        `);
        expect(extensionOwners.rows.length).toBeGreaterThan(0);
        expect(extensionOwners.rows.every((row) => row.owner !== "schema_owner")).toBe(true);

        // 两个模式的 PUBLIC CREATE 权限都已收回。
        const schemaAcl = await admin.query<{ nspname: string; has_create: boolean }>(`
            select nspname, has_schema_privilege('public', nspname, 'CREATE') as has_create
            from pg_namespace
            where nspname in ('public', 'drizzle')
            order by nspname
        `);
        expect(schemaAcl.rows.every((row) => row.has_create === false)).toBe(true);
    }, 120_000);
});
