import type { Pool } from "pg";

import type { DatabaseLoginRole } from "../../config.js";

const RUNTIME_ROLES: readonly DatabaseLoginRole[] = ["app_api", "app_worker", "app_maintenance"];
const TABLE_PRIVILEGES = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
] as const;
const SEQUENCE_PRIVILEGES = ["USAGE", "SELECT", "UPDATE"] as const;
const COLUMN_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "REFERENCES"] as const;
const APPLICATION_TABLES = [
    "users",
    "sessions",
    "accounts",
    "verifications",
    "workspaces",
    "workspace_members",
    "workspace_invitations",
    "canvases",
    "workspace_audit_logs",
    "platform_admins",
    "admin_operations",
    "global_audit_logs",
    "workspace_provisioning_audits",
] as const;
const API_TABLE_PRIVILEGES: Readonly<Record<string, readonly (typeof TABLE_PRIVILEGES)[number][]>> = {
    users: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    accounts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    verifications: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    workspaces: ["SELECT", "INSERT"],
    workspace_members: ["SELECT", "INSERT", "DELETE"],
    workspace_invitations: ["SELECT", "INSERT"],
    canvases: ["SELECT", "INSERT"],
    workspace_audit_logs: ["INSERT"],
};

const API_BUSINESS_UPDATE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    workspaces: ["name", "slug", "status", "deleted_at", "updated_at"],
    workspace_invitations: ["status"],
    // document_mode/deletion_receipt_id 不在可写列表：前者只在创建时由服务端写入，后者由触发器生成。
    canvases: ["title", "snapshot_json", "revision", "updated_by", "updated_at", "deleted_at"],
};

const API_FUNCTIONS = [
    "is_active_workspace_member(text,text)",
    "is_workspace_manager(text,text)",
    "is_current_verified_email(text,text)",
    "has_accepted_workspace_invitation(text,text,text)",
    "begin_admin_operation(text,text,text,text)",
    "is_current_admin_operation(text,text,text)",
    "execute_workspace_admin_operation()",
    "record_workspace_provisioning(text,text,text)",
] as const;

export type DatabaseRoleInspection = {
    currentUser: string;
    expectedRole: DatabaseLoginRole | undefined;
    violations: string[];
};

function isRuntimeRole(role: DatabaseLoginRole | undefined): role is Exclude<DatabaseLoginRole, "schema_owner"> {
    return role !== undefined && RUNTIME_ROLES.includes(role);
}

async function inspectTablePrivileges(pool: Pool, role: Exclude<DatabaseLoginRole, "schema_owner">): Promise<string[]> {
    const violations: string[] = [];
    const privileges = await pool.query<{ table_name: string; privilege: (typeof TABLE_PRIVILEGES)[number]; allowed: boolean }>(
        `select c.relname as table_name,
                privilege,
                has_table_privilege($1, c.oid, privilege) as allowed
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join unnest($2::text[]) privilege
         where n.nspname = 'public'
           and c.relkind in ('r', 'p', 'v', 'm', 'f')
         order by c.relname, privilege`,
        [role, TABLE_PRIVILEGES],
    );
    const existingTables = new Set(privileges.rows.map((row) => row.table_name));
    for (const table of APPLICATION_TABLES) {
        if (!existingTables.has(table)) {
            violations.push(`required table public.${table} is missing`);
        }
    }

    for (const row of privileges.rows) {
        const expected = role === "app_api" && (API_TABLE_PRIVILEGES[row.table_name]?.includes(row.privilege) ?? false);
        if (row.allowed !== expected) {
            violations.push(`${role} ${row.privilege} privilege on public.${row.table_name} must be ${expected}`);
        }
    }
    return violations;
}

/** Gate 0 不消费 public sequence；任一运行期角色获得任一 sequence 权限都属于漂移。 */
async function inspectSequencePrivileges(
    pool: Pool,
    role: Exclude<DatabaseLoginRole, "schema_owner">,
): Promise<string[]> {
    const privileges = await pool.query<{
        sequence_name: string;
        privilege: (typeof SEQUENCE_PRIVILEGES)[number];
        allowed: boolean;
    }>(
        `select c.relname as sequence_name,
                privilege,
                has_sequence_privilege($1, c.oid, privilege) as allowed
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join unnest($2::text[]) privilege
         where n.nspname = 'public'
           and c.relkind = 'S'
         order by c.relname, privilege`,
        [role, SEQUENCE_PRIVILEGES],
    );
    return privileges.rows
        .filter((row) => row.allowed)
        .map((row) => `${role} ${row.privilege} privilege on sequence public.${row.sequence_name} must be false`);
}

async function inspectColumnPrivileges(
    pool: Pool,
    role: Exclude<DatabaseLoginRole, "schema_owner">,
): Promise<string[]> {
    const violations: string[] = [];
    const columns = await pool.query<{
        table_name: string;
        column_name: string;
        privilege: (typeof COLUMN_PRIVILEGES)[number];
        allowed: boolean;
    }>(
        `select c.relname as table_name,
                a.attname as column_name,
                privilege,
                has_column_privilege($1, c.oid, a.attnum, privilege) as allowed
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid
                            and a.attnum > 0
                            and not a.attisdropped
         cross join unnest($2::text[]) privilege
         where n.nspname = 'public'
           and c.relkind in ('r', 'p', 'v', 'm', 'f')
         order by c.relname, a.attnum, privilege`,
        [role, COLUMN_PRIVILEGES],
    );
    for (const row of columns.rows) {
        const expected =
            (role === "app_api" &&
                ((API_TABLE_PRIVILEGES[row.table_name]?.includes(row.privilege) ?? false) ||
                    (row.privilege === "UPDATE" &&
                        (API_BUSINESS_UPDATE_COLUMNS[row.table_name]?.includes(row.column_name) ?? false)))) ||
            (role === "app_maintenance" &&
                row.privilege === "SELECT" &&
                row.table_name === "workspaces" &&
                (row.column_name === "id" || row.column_name === "status"));
        if (row.allowed !== expected) {
            violations.push(
                `${role} ${row.privilege} privilege on public.${row.table_name}.${row.column_name} must be ${expected}`,
            );
        }
    }
    return violations;
}

async function inspectFunctionPrivileges(pool: Pool, role: Exclude<DatabaseLoginRole, "schema_owner">): Promise<string[]> {
    const violations: string[] = [];
    for (const signature of API_FUNCTIONS) {
        const result = await pool.query<{ exists: boolean; allowed: boolean; public_allowed: boolean }>(
            `select to_regprocedure($1) is not null as exists,
                    coalesce(has_function_privilege($2, to_regprocedure($1), 'EXECUTE'), false) as allowed,
                    coalesce(has_function_privilege('public', to_regprocedure($1), 'EXECUTE'), false) as public_allowed`,
            [`public.${signature}`, role],
        );
        const row = result.rows[0];
        if (!row?.exists) {
            violations.push(`required function public.${signature} is missing`);
            continue;
        }
        const expected = role === "app_api";
        if (row.allowed !== expected) {
            violations.push(`${role} EXECUTE privilege on public.${signature} must be ${expected}`);
        }
        if (row.public_allowed) violations.push(`PUBLIC must not EXECUTE public.${signature}`);
    }

    const functions = await pool.query<{ signature: string; allowed: boolean; public_allowed: boolean }>(
        `select p.oid::regprocedure::text as signature,
                has_function_privilege($1, p.oid, 'EXECUTE') as allowed,
                has_function_privilege('public', p.oid, 'EXECUTE') as public_allowed
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
         order by 1`,
        [role],
    );
    const expected = new Set<string>(role === "app_api" ? API_FUNCTIONS : []);
    for (const row of functions.rows) {
        if (row.allowed !== expected.has(row.signature)) {
            violations.push(`${role} has unexpected function privilege on public.${row.signature}`);
        }
        if (row.public_allowed) violations.push(`PUBLIC must not EXECUTE public.${row.signature}`);
    }
    return violations;
}

/** 校验真实登录身份及最终最小权限矩阵；任何额外或缺失授权都视为未就绪。 */
export async function inspectDatabaseRole(
    pool: Pool,
    expectedRole: DatabaseLoginRole | undefined,
): Promise<DatabaseRoleInspection> {
    const violations: string[] = [];
    const identity = await pool.query<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolinherit: boolean;
    }>(`
        select current_user, r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolinherit
        from pg_roles r
        where r.rolname = current_user
    `);
    const row = identity.rows[0];
    if (!row) return { currentUser: "", expectedRole, violations: ["current login role is missing from pg_roles"] };

    if (!expectedRole) violations.push("database handle has no expected login role");
    else if (row.current_user !== expectedRole) {
        violations.push(`expected login role ${expectedRole} but connected as ${row.current_user}`);
    }
    if (row.rolsuper) violations.push(`login role ${row.current_user} must not be SUPERUSER`);
    if (row.rolbypassrls) violations.push(`login role ${row.current_user} must not have BYPASSRLS`);
    if (!row.rolcanlogin) violations.push(`login role ${row.current_user} must have LOGIN`);
    if (row.rolinherit) violations.push(`login role ${row.current_user} must be NOINHERIT`);

    if (isRuntimeRole(expectedRole)) {
        const owned = await pool.query<{ object_name: string }>(`
            select n.nspname || '.' || c.relname as object_name
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('public', 'drizzle')
              and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
              and pg_get_userbyid(c.relowner) = current_user
            order by 1
        `);
        for (const object of owned.rows) violations.push(`runtime role ${row.current_user} must not own ${object.object_name}`);

        const memberships = await pool.query<{ granted_role: string; member_role: string }>(`
            select granted.rolname as granted_role, member.rolname as member_role
            from pg_auth_members m
            join pg_roles granted on granted.oid = m.roleid
            join pg_roles member on member.oid = m.member
            where granted.rolname = $1 or member.rolname = $1
            order by 1, 2
        `, [expectedRole]);
        for (const membership of memberships.rows) {
            violations.push(`${expectedRole} must not participate in role membership ${membership.granted_role}->${membership.member_role}`);
        }

        const schemas = await pool.query<{ schema_name: string; usage: boolean; create: boolean }>(`
            select nspname as schema_name,
                   has_schema_privilege($1, nspname, 'USAGE') as usage,
                   has_schema_privilege($1, nspname, 'CREATE') as create
            from pg_namespace where nspname in ('public', 'drizzle') order by nspname
        `, [expectedRole]);
        const publicSchema = schemas.rows.find((schema) => schema.schema_name === "public");
        const drizzleSchema = schemas.rows.find((schema) => schema.schema_name === "drizzle");
        if (!publicSchema?.usage) violations.push(`${expectedRole} must have USAGE on schema public`);
        if (publicSchema?.create) violations.push(`${expectedRole} must not have CREATE on schema public`);
        if (drizzleSchema?.usage || drizzleSchema?.create) {
            violations.push(`${expectedRole} must not access schema drizzle`);
        }

        violations.push(...(await inspectTablePrivileges(pool, expectedRole)));
        violations.push(...(await inspectColumnPrivileges(pool, expectedRole)));
        violations.push(...(await inspectSequencePrivileges(pool, expectedRole)));
        violations.push(...(await inspectFunctionPrivileges(pool, expectedRole)));
    }

    return { currentUser: row.current_user, expectedRole, violations };
}

export async function assertDatabaseRole(pool: Pool, expectedRole: DatabaseLoginRole | undefined): Promise<void> {
    const inspection = await inspectDatabaseRole(pool, expectedRole);
    if (inspection.violations.length === 0) return;
    throw new Error(`Database role assertion failed: ${inspection.violations.join("; ")}`);
}
