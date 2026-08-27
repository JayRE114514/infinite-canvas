# Gate 0 Backend Architecture Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the existing backend foundation so Identity, Workspaces, Canvas snapshot persistence, database credentials, transactions, and PostgreSQL RLS match the approved architecture before Billing, Assets, or AI Tasks are added.

**Architecture:** Keep the TypeScript/Fastify modular monolith and the existing API/Worker process split. Establish real PostgreSQL login-role boundaries first, remove Better Auth Organization as a business writer second, move Workspace invariants into the Workspaces module and database third, then enable transaction-scoped application context and default-deny RLS. This plan covers the backend half of Gate 0; native IndexedDB CAS is an independent plan because it has a separate storage model and browser verification matrix.

**Tech Stack:** Node.js 24 LTS, Bun 1.3.13 workspaces, TypeScript 5.9, Fastify 5, Better Auth 1.7.1 without the Organization plugin, Drizzle ORM 0.45, PostgreSQL 18, Vitest 4.1.11, Testcontainers 12.

**Spec:** `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`

## Global Constraints

- `schema_owner`, `app_api`, `app_worker`, and `app_maintenance` are separate PostgreSQL login roles and credentials; no runtime process uses `SET ROLE` to simulate isolation.
- All four roles are `NOSUPERUSER NOBYPASSRLS`; runtime roles do not own business objects. `schema_owner` is used only by the release migration job.
- Better Auth owns only users, sessions, accounts, verification, and identity callbacks. `better-auth*` imports remain under `server/src/modules/identity/**`.
- Workspaces owns `workspaces`, `workspace_members`, and `workspace_invitations`; no route or service calls Better Auth Organization APIs.
- `organizationId` is renamed to `workspace_id`, `workspace_type` is renamed to `type`, and no compatibility columns or views remain.
- Business services receive one already-open transaction handle. Membership verification and business SQL run on that same transaction and connection.
- Pool context uses only transaction-local `set_config(..., true)` and missing-ok `current_setting(..., true)`; no session-level application variables are permitted.
- Workspace RLS is application authorization's second boundary, not a replacement. Every route still checks membership and role in the transaction.
- `canvases.document_mode` is read-only to clients, defaults to `snapshot`, and normal create/save routes never change it.
- Do not add Wallet, Ledger, Asset, Provider, AI Task, pg-boss job, Redis, RabbitMQ, Keycloak, Yjs, or Kubernetes implementation in this plan.
- Tests use production-equivalent `app_api`, `app_worker`, and `app_maintenance` login connections. Superuser/schema-owner tests cannot count as RLS evidence.
- Write the focused failing test before production code, run that focused test to observe the expected failure, then implement and rerun it. User-owned `web` typecheck and real-browser evidence remain outside this backend plan.

---

## File Responsibility Map

| Area | Files | Responsibility |
|---|---|---|
| Role provisioning | `server/database/bootstrap/roles.sql` | Idempotently create fixed role names and harden role attributes; passwords remain deployment secrets outside the repository. |
| Runtime configuration | `server/src/config.ts`, `server/drizzle.config.ts`, `.env.example` | Select exactly one process credential and the schema-owner migration credential. |
| Pool identity | `server/src/infrastructure/database/client.ts`, `role-assertions.ts`, `plugin.ts`, `types.ts` | Build one role-specific pool, verify effective role/ownership/BYPASSRLS, and gate readiness. |
| Transaction context | `server/src/infrastructure/database/transactions.ts` | Own all transaction-local user/workspace/admin context and expose the only business transaction entry points. |
| Identity | `server/src/modules/identity/auth-schema.ts`, `auth.ts`, `types.ts` | Better Auth identity tables and verified-email callback only. |
| Workspaces | `server/src/modules/workspaces/schema.ts`, `service.ts`, `authorization.ts`, `routes.ts` | Workspace/member/invitation schema, business invariants, authorization, and HTTP mapping. |
| Canvas snapshot | `server/src/modules/canvases/schema.ts`, `service.ts`, `routes.ts`, `packages/contracts/src/canvases.ts` | Snapshot-mode resource contract, revision lock, and stable error ordering. |
| Database policy | `server/migrations/0002_workspace_authority.sql`, `0003_transaction_context.sql`, `0004_tenant_rls.sql` | Final column layout, constraints, helpers, grants, and RLS policies. |
| Test database | `server/test/helpers/postgres.ts`, `server/test/helpers/database.ts`, `server/test/helpers/auth.ts` | Bootstrap roles, run migrations in journal order, and expose separate role handles. |
| Boundary verification | `server/scripts/check-module-boundaries.ts`, `server/test/architecture/module-boundaries.test.ts` | Parse TypeScript imports and fail if Better Auth escapes Identity. |

---

### Task 1: PostgreSQL Login Roles, Role-Specific Configuration, and Test Harness

**Files:**
- Create: `server/database/bootstrap/roles.sql`
- Create: `server/src/infrastructure/database/role-assertions.ts`
- Create: `server/test/helpers/database.ts`
- Create: `server/test/database/roles.test.ts`
- Modify: `server/src/config.ts`
- Modify: `server/src/infrastructure/database/client.ts`
- Modify: `server/src/infrastructure/database/types.ts`
- Modify: `server/src/infrastructure/database/plugin.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/api.ts`
- Modify: `server/src/worker.ts`
- Modify: `server/drizzle.config.ts`
- Modify: `server/test/helpers/postgres.ts`
- Modify: `server/test/helpers/auth.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `type DatabaseLoginRole = "schema_owner" | "app_api" | "app_worker" | "app_maintenance"`.
- Produces: `type DatabaseConfig = { url: string; poolMax: number; expectedRole: DatabaseLoginRole }`.
- Produces: `createDatabase(config: DatabaseConfig): DatabaseHandle` where `DatabaseHandle` includes `role`.
- Produces: `inspectDatabaseRole(pool, expectedRole): Promise<DatabaseRoleInspection>` and `assertDatabaseRole(...)`.
- Produces: `startRoleDatabase(): Promise<StartedRoleDatabase>` with `admin`, `schemaOwner`, `api`, `worker`, and `maintenance` URLs and cleanup.
- Consumes later: all tests and application processes use these handles; Task 4 adds privilege assertions to the same inspector.

- [ ] **Step 1: Write the failing role-isolation tests**

Create `server/test/database/roles.test.ts` with production-observable assertions rather than source-text assertions:

```ts
it.each(["schema_owner", "app_api", "app_worker", "app_maintenance"] as const)(
    "%s is a real non-superuser login without BYPASSRLS",
    async (role) => {
        const pool = databases[role].pool;
        const result = await pool.query(`
            select current_user as role, r.rolsuper, r.rolbypassrls, r.rolcanlogin
            from pg_roles r where r.rolname = current_user
        `);
        expect(result.rows).toEqual([{ role, rolsuper: false, rolbypassrls: false, rolcanlogin: true }]);
    },
);

it("rejects readiness when the configured role and effective login differ", async () => {
    await expect(inspectDatabaseRole(databases.api.pool, "app_worker"))
        .resolves.toMatchObject({ ok: false, violations: [expect.stringContaining("app_worker")] });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun --cwd server run test -- test/database/roles.test.ts`

Expected: FAIL because the four roles, role-aware handles, and `startRoleDatabase` do not exist.

- [ ] **Step 3: Add the idempotent role bootstrap**

`server/database/bootstrap/roles.sql` must create fixed names without repository passwords and re-assert every attribute on repeated runs:

```sql
DO $roles$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schema_owner') THEN
        CREATE ROLE schema_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
        CREATE ROLE app_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
        CREATE ROLE app_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
        CREATE ROLE app_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
END
$roles$;

ALTER ROLE schema_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE app_api NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE app_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE app_maintenance NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
```

The test helper executes this as the ephemeral container administrator, assigns test-only passwords with static role names and parameter-escaped values, grants database `CONNECT`, grants schema-owner `CREATE` on `public`, then executes every `server/migrations/[0-9]*.sql` in lexical order as `schema_owner`.

- [ ] **Step 4: Split process configuration by credential**

Keep `loadConfig` as the API parser to minimize call-site churn, but map it only to `DATABASE_URL_API`:

```ts
export type DatabaseLoginRole = "schema_owner" | "app_api" | "app_worker" | "app_maintenance";
export type DatabaseConfig = { url: string; poolMax: number; expectedRole: DatabaseLoginRole };

export function loadDatabaseConfig(
    env: NodeJS.ProcessEnv,
    urlName: "DATABASE_URL_API" | "DATABASE_URL_WORKER" | "DATABASE_URL_MAINTENANCE",
    expectedRole: Exclude<DatabaseLoginRole, "schema_owner">,
): DatabaseConfig {
    return { url: requiredEnv(env, urlName), poolMax: boundedPool(env.DB_POOL_MAX), expectedRole };
}
```

`drizzle.config.ts` reads only `DATABASE_URL_SCHEMA_OWNER`. `.env.example` lists four separate URLs and explicitly says role creation/password assignment is a deployment bootstrap action.

- [ ] **Step 5: Add role-aware pools and readiness inspection**

`createDatabase` copies `expectedRole` into the handle. `inspectDatabaseRole` checks `current_user`, `rolsuper`, `rolbypassrls`, and current ownership of `workspaces`, `workspace_members`, `workspace_invitations`, and `canvases` when those tables exist. A missing table is not a violation during Task 1; a runtime role owning an existing table is.

`checkDatabaseReady` performs both `select 1` and `inspectDatabaseRole`. It returns false for any mismatch. API builds only an `app_api` pool; Worker builds only an `app_worker` pool. No process accepts a list of URLs.

- [ ] **Step 6: Run focused and existing database tests to verify GREEN**

Run:

```bash
bun --cwd server run test -- test/database/roles.test.ts test/database/connection.test.ts test/config.test.ts test/app-runtime.test.ts
```

Expected: PASS; every role query reports a distinct login, runtime roles own no current business table, and wrong-role readiness is rejected.

- [ ] **Step 7: Commit**

```bash
git add .env.example server/database server/drizzle.config.ts server/src server/test
git commit -m "feat: isolate PostgreSQL process credentials"
```

---

### Task 2: Workspaces Module Ownership and Final Workspace Constraints

**Files:**
- Create: `server/src/modules/workspaces/schema.ts`
- Create: `server/scripts/check-module-boundaries.ts`
- Create: `server/test/architecture/module-boundaries.test.ts`
- Create: `server/test/workspaces/constraints.test.ts`
- Create: `server/migrations/0002_workspace_authority.sql`
- Modify: `server/package.json`
- Modify: `server/src/modules/identity/auth-schema.ts`
- Modify: `server/src/modules/identity/auth.ts`
- Modify: `server/src/modules/identity/types.ts`
- Modify: `server/src/modules/workspaces/service.ts`
- Modify: `server/src/modules/workspaces/authorization.ts`
- Modify: `server/src/modules/workspaces/routes.ts`
- Modify: `server/src/infrastructure/database/schema.ts`
- Modify: `server/src/app.ts`
- Modify: `server/test/identity/auth.test.ts`
- Modify: `server/test/workspaces/workspaces.test.ts`
- Modify: `server/migrations/meta/_journal.json`
- Generate: `server/migrations/meta/0002_snapshot.json`

**Interfaces:**
- Produces: `workspaces`, `workspaceMembers`, `workspaceInvitations` only from `modules/workspaces/schema.ts`.
- Produces: `type AppTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0]`; Workspace services use this final signature immediately.
- Produces direct services: `updateWorkspace`, `listWorkspaceMembers`, `removeWorkspaceMember`, `createWorkspaceInvitation`, `cancelWorkspaceInvitation`.
- Produces: `checkModuleBoundaries(rootDir): Promise<BoundaryViolation[]>` using the TypeScript parser.
- Removes: all Better Auth Organization API calls, Organization plugin hooks, Organization DTO aliases, and `sessions.activeOrganizationId`.
- Consumes: Task 1 schema-owner migration path and role test harness.

- [ ] **Step 1: Write boundary and database-invariant tests**

The boundary test creates a temporary source fixture and proves the checker catches a real import:

```ts
it("rejects better-auth imports outside Identity", async () => {
    await writeFixture("src/modules/workspaces/bad.ts", `import { APIError } from "better-auth/api";`);
    await expect(checkModuleBoundaries(fixtureRoot)).resolves.toEqual([
        expect.objectContaining({ module: "better-auth/api", file: expect.stringContaining("workspaces/bad.ts") }),
    ]);
});
```

`constraints.test.ts` must use `schema_owner` only to seed and deliberately violate physical constraints, and assert:

```ts
await expect(insertMember({ role: "viewer" })).rejects.toMatchObject({ code: "23514" });
await expect(insertSecondOwner()).rejects.toMatchObject({ code: "23505" });
await expect(commitActiveWorkspaceWithoutOwner()).rejects.toMatchObject({ code: "23514" });
await expect(deleteOwnerUser()).rejects.toMatchObject({ code: "23503" });
await expect(insertActiveWorkspaceWithDeletedAt()).rejects.toMatchObject({ code: "23514" });
```

Also assert a second personal Workspace for the same owner fails after the column rename and that `workspaces.owner_user_id` equals the sole active owner member at commit.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
bun --cwd server run test -- test/architecture/module-boundaries.test.ts test/workspaces/constraints.test.ts
```

Expected: FAIL because Workspaces schema lives under Identity, Better Auth imports escape Identity, and the database has no status/owner/deletion constraints.

- [ ] **Step 3: Move Workspace tables out of Identity and remove Organization**

`identity/auth-schema.ts` exports only `users`, `sessions`, `accounts`, `verifications`, and `authSchema`. `authSchema` contains only those four Better Auth model keys.

`workspaces/schema.ts` exposes the final application names:

```ts
export const workspaces = pgTable("workspaces", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    type: text("type").$type<"personal" | "team">().notNull(),
    ownerUserId: text("owner_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    status: text("status").$type<"active" | "suspended" | "deactivated">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
```

Members use `workspace_id`, `user_id`, `role`, `status`, and `joined_at`. Invitations use `workspace_id`, normalized target email, role `admin | member`, status `pending | accepted | rejected | canceled`, `token_digest`, inviter, expiry, and timestamps.

Remove `organization()` and all Organization hooks from `identity/auth.ts`. `registerWorkspaceRoutes` no longer receives `Auth`; it receives the application mailer needed to send an invitation URL after the Workspaces transaction commits.

- [ ] **Step 4: Implement the corrective migration**

`0002_workspace_authority.sql` must preserve existing row IDs while applying the final names and constraints:

```sql
ALTER TABLE public.sessions DROP COLUMN "activeOrganizationId";
ALTER TABLE public.workspaces RENAME COLUMN workspace_type TO type;
ALTER TABLE public.workspace_members RENAME COLUMN "organizationId" TO workspace_id;
ALTER TABLE public.workspace_invitations RENAME COLUMN "organizationId" TO workspace_id;

ALTER TABLE public.workspaces ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.workspaces ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.workspace_members ADD COLUMN status text NOT NULL DEFAULT 'active';
ALTER TABLE public.workspace_members RENAME COLUMN "createdAt" TO joined_at;
ALTER TABLE public.workspace_invitations ADD COLUMN token_digest text;
UPDATE public.workspace_invitations SET token_digest = md5(id || clock_timestamp()::text) WHERE token_digest IS NULL;
ALTER TABLE public.workspace_invitations ALTER COLUMN token_digest SET NOT NULL;
```

The same migration drops and recreates affected foreign keys as `ON DELETE RESTRICT`, adds CHECK constraints for Workspace type/status/deleted-at coherence, member role/status, and invitation role/status, rebuilds every renamed index, preserves `workspaces_owner_personal_unique` with predicate `type = 'personal'`, adds one-owner partial uniqueness, and adds DEFERRABLE INITIALLY DEFERRED constraint triggers on both `workspaces` and `workspace_members`. The trigger raises SQLSTATE `23514` unless every active Workspace has exactly one active owner member whose `user_id` equals `owner_user_id`.

At the end, transfer all application tables/functions/sequences to `schema_owner`, grant Identity-table DML to `app_api`, grant schema `USAGE`, and revoke all business-table privileges from `PUBLIC`.

- [ ] **Step 5: Replace Organization route calls with Workspaces services**

Implement each direct service against a passed `AppTransaction`. Routes may open a plain `db.transaction` in this task, but no service accepts `AppDatabase` or starts a nested transaction. Task 4 replaces the remaining two-stage route authorization with the central transaction entrypoints without changing service signatures.

Invitation creation generates `randomBytes(32).toString("base64url")`, persists `sha256(token)` only, and sends a URL containing the raw token. Acceptance looks up by digest, expected `pending`, unexpired timestamp, and the current user's verified email. Raw tokens never enter responses, logs, or the database.

Member removal uses a conditional delete that excludes `role = 'owner'`. Workspace updates accept only name/slug. Direct services convert unique violations to existing stable application errors without Better Auth error-code mapping.

- [ ] **Step 6: Add the executable boundary command**

Add `"check:boundaries": "tsx scripts/check-module-boundaries.ts src"` to `server/package.json`. The script parses `ImportDeclaration`, `ExportDeclaration`, and dynamic `import()` string literals with the TypeScript compiler API; it exits non-zero when a module beginning `better-auth` originates outside `src/modules/identity/`.

- [ ] **Step 7: Run focused and regression tests to verify GREEN**

Run:

```bash
bun --cwd server run check:boundaries
bun --cwd server run test -- test/architecture/module-boundaries.test.ts test/workspaces/constraints.test.ts test/identity/auth.test.ts test/workspaces/workspaces.test.ts
```

Expected: PASS; Organization auth endpoints remain unregistered, direct Workspace flows pass, raw invitation tokens are not persisted, and database owner/member constraints reject invalid commits.

- [ ] **Step 8: Commit**

```bash
git add server packages/contracts/src/workspaces.ts bun.lock
git commit -m "refactor: make Workspaces an independent domain"
```

---

### Task 3: Transaction Context Entrypoints and Admin Operation Binding

**Files:**
- Create: `server/src/infrastructure/database/transactions.ts`
- Create: `server/src/modules/workspaces/context.ts`
- Create: `server/test/database/transactions.test.ts`
- Create: `server/migrations/0003_transaction_context.sql`
- Modify: `server/src/infrastructure/database/types.ts`
- Modify: `server/src/infrastructure/database/schema.ts`
- Modify: `server/migrations/meta/_journal.json`
- Generate: `server/migrations/meta/0003_snapshot.json`

**Interfaces:**
- Consumes: Task 2 `AppTransaction`.
- Produces: `withUserTransaction(db, userId, work)`.
- Produces: `withTenantTransaction(db, { userId, workspaceId, minimumRole? }, work)` returning `WorkspaceAccess` to the callback.
- Produces: `withWorkerTransaction(db, { workspaceId, verify }, work)`; `verify(tx)` is mandatory and must return a verified resource or null.
- Produces: `withPlatformAdminTransaction(db, { userId, requestId, target, purpose }, work)`.
- Produces: `adoptOwnedWorkspaceContext(tx, userId, resolvedWorkspaceId)`; callers can pass only a database-returned ID.
- Consumes later: Task 4 routes and services.

- [ ] **Step 1: Write transaction-context tests**

Use the `app_api` login and prove transaction-local isolation:

```ts
it("does not leak user or workspace context through a reused pool connection", async () => {
    await withTenantTransaction(apiDb, { userId: owner.id, workspaceId }, async (tx) => {
        expect(await context(tx)).toEqual({ userId: owner.id, workspaceId });
    });
    const leaked = await apiPool.query(`select current_setting('app.user_id', true) user_id,
        current_setting('app.workspace_id', true) workspace_id`);
    expect(leaked.rows[0]).toEqual({ user_id: "", workspace_id: "" });
});

it("rejects adopting a workspace not resolved as the current user's owned workspace", async () => {
    await expect(withUserTransaction(apiDb, userA.id, (tx) =>
        adoptOwnedWorkspaceContext(tx, userA.id, userBWorkspace.id),
    )).rejects.toMatchObject({ code: "workspace_context_adoption_forbidden" });
});
```

Add tests proving `withWorkerTransaction` cannot be called without a verifier, verifier-null aborts, and an admin operation ID cannot be reused in another transaction or for a different target/purpose.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun --cwd server run test -- test/database/transactions.test.ts`

Expected: FAIL because transaction entrypoints and admin control tables/functions do not exist.

- [ ] **Step 3: Implement transaction-local entrypoints**

Every entrypoint starts `db.transaction`, immediately executes transaction-local context, performs authorization on the same `tx`, and calls the supplied function with that `tx`:

```ts
async function setLocal(tx: AppTransaction, key: "app.user_id" | "app.workspace_id", value: string) {
    await tx.execute(sql`select set_config(${key}, ${value}, true)`);
}

export async function withTenantTransaction<T>(
    db: AppDatabase,
    input: { userId: string; workspaceId: string; minimumRole?: WorkspaceRole },
    work: (tx: AppTransaction, access: WorkspaceAccess) => Promise<T>,
): Promise<T> {
    return db.transaction(async (tx) => {
        await setLocal(tx, "app.user_id", input.userId);
        await setLocal(tx, "app.workspace_id", input.workspaceId);
        const access = await requireWorkspaceAccess(tx, input);
        return work(tx, access);
    });
}
```

`withWorkerTransaction` requires `verify` in its TypeScript input and throws `worker_resource_not_found` when it returns null. It sets only `app.workspace_id`; it never synthesizes `app.user_id`.

- [ ] **Step 4: Add admin control tables and SECURITY DEFINER functions**

The migration creates `platform_admins` and immutable `admin_operations`. `begin_admin_operation` validates current active admin status and this exact purpose set: platform targets accept `user_read | model_read | model_write | provider_route_read | provider_route_write`; Workspace targets accept `workspace_read | workspace_suspend | workspace_deactivate | workspace_restore | wallet_adjust | wallet_status_write | billing_confirm_charge | billing_confirm_no_charge | ledger_compensate | workspace_export`. It writes `pg_current_xact_id()` and sets `app.admin_operation_id` with `is_local = true`. `is_current_admin_operation` checks operation ID, current transaction xid, current `app.user_id`, target, purpose, row Workspace, and current admin status.

Both functions use `SECURITY DEFINER SET search_path = pg_catalog, public`, fully qualified names, no dynamic SQL, `REVOKE ALL ... FROM PUBLIC`, and signature-specific `GRANT EXECUTE TO app_api`.

Create the minimal non-recursive `is_active_workspace_member(workspace_id, user_id)` and `is_workspace_manager(...)` helpers under the same ownership rules. They read only `workspaces` and `workspace_members`.

- [ ] **Step 5: Implement owned-context adoption**

`adoptOwnedWorkspaceContext` locks the target Workspace and verifies all of: `owner_user_id = userId`, current transaction `app.user_id = userId`, and either the ID was just inserted by the provisioning function or it is the unique `type = 'personal'` row selected for this user. Only then does it set `app.workspace_id` transaction-locally.

- [ ] **Step 6: Run the focused tests to verify GREEN**

Run: `bun --cwd server run test -- test/database/transactions.test.ts`

Expected: PASS; pool reuse is clean, arbitrary context adoption fails, mandatory Worker verification runs, and admin operation replay across transaction/target/purpose fails.

- [ ] **Step 7: Commit**

```bash
git add server/src/infrastructure/database server/src/modules/workspaces/context.ts server/test/database/transactions.test.ts server/migrations
git commit -m "feat: add transaction-scoped database context"
```

---

### Task 4: Default-Deny RLS and Single-Transaction Business Services

**Files:**
- Create: `server/test/database/tenant-isolation.test.ts`
- Create: `server/migrations/0004_tenant_rls.sql`
- Modify: `server/migrations/meta/_journal.json`
- Generate: `server/migrations/meta/0004_snapshot.json`
- Modify: `server/src/modules/workspaces/authorization.ts`
- Modify: `server/src/modules/workspaces/service.ts`
- Modify: `server/src/modules/workspaces/routes.ts`
- Modify: `server/src/modules/canvases/service.ts`
- Modify: `server/src/modules/canvases/routes.ts`
- Modify: `server/src/infrastructure/database/role-assertions.ts`
- Modify: `server/test/workspaces/workspaces.test.ts`
- Modify: `server/test/canvases/routes.test.ts`

**Interfaces:**
- Consumes: all Task 3 transaction entrypoints and helpers.
- Produces: every Workspace and Canvas service accepts `AppTransaction`, never `AppDatabase` or `Pool`.
- Produces: explicit `TO app_api`, `TO app_worker`, and allowlisted `TO app_maintenance` policies.
- Produces: readiness privilege audit for each runtime role.

- [ ] **Step 1: Write production-equivalent isolation tests**

All assertions use runtime role connections. Required cases:

```ts
await expect(apiPool.query(`select * from canvases`)).resolves.toMatchObject({ rows: [] });
await expect(readCanvasAs(userA, workspaceB, canvasB.id)).rejects.toMatchObject({ code: "workspace_forbidden" });
await expect(queryWrongJoinAsTenantA()).resolves.toMatchObject({ rows: [] });
await expect(writeCanvasWithoutContext()).rejects.toMatchObject({ code: "42501" });
await expect(maintenancePool.query(`update canvases set title = 'x'`)).rejects.toMatchObject({ code: "42501" });
```

Also test: missing context defaults to no rows; forged path Workspace fails at application authorization; a child Canvas ID from another tenant remains invisible; `app_api` cannot set a Workspace where the user has no active membership; worker context sees only the verified Workspace; maintenance can select only `workspace_id`, `id`, `revision`, `deleted_at`, `updated_at` from Canvas and only `id`, `status`, `deleted_at` from Workspace; pool reuse does not leak context.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun --cwd server run test -- test/database/tenant-isolation.test.ts`

Expected: FAIL because tables do not have RLS and runtime roles lack final command/column policies.

- [ ] **Step 3: Enable and FORCE RLS in dependency order**

In `0004_tenant_rls.sql`:

```sql
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvases FORCE ROW LEVEL SECURITY;
```

Authorization tables are not FORCE so tightly scoped owner helpers can read them. Canvas is FORCE. Every policy is command-specific and role-specific; no policy is left with the implicit `PUBLIC` target.

`app_api` Canvas policies require both `workspace_id = current_setting('app.workspace_id', true)` and `is_active_workspace_member(workspace_id, current_setting('app.user_id', true))`. Worker policies require only the matching Workspace context and are separate policies `TO app_worker`. Maintenance receives only column-level SELECT grants plus a read-only policy; it gets no table DML grants.

Workspace/member/invitation self-create and invitation-accept paths use dedicated helpers and predicates. `workspace_members` self-read directly compares `user_id` to current context; its policy never queries `workspace_members` recursively.

- [ ] **Step 4: Refactor routes to transaction callbacks**

Routes first call `requireSession` outside the business transaction to obtain a trusted `userId`, then call exactly one entrypoint. Example:

```ts
const { userId } = await requireSession(request);
const { db } = requireDatabase(request.server);
return withTenantTransaction(
    db,
    { userId, workspaceId: request.params.workspaceId },
    (tx, access) => saveCanvas(tx, access, request.params.canvasId, request.body),
);
```

Delete the two-stage `requireWorkspaceMember(request, workspaceId)` API. Its replacement `requireWorkspaceAccess(tx, input)` accepts only an `AppTransaction`. Services do not call `transaction()` internally.

- [ ] **Step 5: Extend startup assertions to privileges**

`role-assertions.ts` now rejects runtime ownership, `rolbypassrls`, table DML not on the role allowlist, and maintenance access to non-allowlisted columns. A production process with any violation fails readiness rather than logging and continuing.

- [ ] **Step 6: Run isolation and route regressions to verify GREEN**

Run:

```bash
bun --cwd server run test -- test/database/tenant-isolation.test.ts test/workspaces/workspaces.test.ts test/canvases/routes.test.ts
```

Expected: PASS under runtime roles; cross-tenant and missing-context cases default deny, ordinary routes still work, and maintenance remains read-only.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat: enforce tenant isolation with PostgreSQL RLS"
```

---

### Task 5: Verified-Email Personal Workspace Provisioning

**Files:**
- Modify: `server/src/modules/identity/auth.ts`
- Modify: `server/src/modules/identity/types.ts`
- Modify: `server/src/modules/workspaces/service.ts`
- Modify: `server/src/modules/workspaces/routes.ts`
- Modify: `server/src/app.ts`
- Modify: `server/test/workspaces/workspaces.test.ts`
- Modify: `server/test/helpers/auth.ts`

**Interfaces:**
- Produces: `onEmailVerified(user: { id: string; name: string; email: string }): Promise<void>` injected into Identity by the composition root.
- Produces: `provisionPersonalWorkspace(db, user): Promise<WorkspaceSummary>` using `withUserTransaction` and `adoptOwnedWorkspaceContext`.
- Removes: personal Workspace creation from `GET /api/v1/workspaces`.
- Defers: Wallet and signup-grant creation to the Gate 3 ledger plan; the adoption callback remains inside the same transaction so Gate 3 can append those writes without changing Identity.

- [ ] **Step 1: Write provisioning tests**

```ts
it("verification provisions one personal Workspace before the workspace list is read", async () => {
    const user = await registerUserWithoutVerification(app, mailer);
    expect(await countPersonalWorkspaces(schemaOwnerPool, user.userId)).toBe(0);
    await verifyLatestEmail(app, mailer);
    expect(await countPersonalWorkspaces(schemaOwnerPool, user.userId)).toBe(1);
});

it("GET workspaces is read-only and never repairs a missing personal Workspace", async () => {
    await deletePersonalWorkspaceForFixture(schemaOwnerPool, user.userId);
    await app.inject({ method: "GET", url: "/api/v1/workspaces", headers: { cookie: user.cookie } });
    expect(await countPersonalWorkspaces(schemaOwnerPool, user.userId)).toBe(0);
});
```

Add a concurrent test invoking `onEmailVerified` twice and asserting one Workspace, one owner member, and identical returned Workspace ID. Inject a failure after Workspace insert but before owner insert and assert the transaction leaves neither row.

- [ ] **Step 2: Run the provisioning tests and verify RED**

Run: `bun --cwd server run test -- test/workspaces/workspaces.test.ts -t "personal Workspace provisioning"`

Expected: FAIL because current provisioning occurs as a GET side effect and does not use the owned-context transaction.

- [ ] **Step 3: Inject Better Auth's verified-email callback**

Set Better Auth's supported callback:

```ts
emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => mailer.sendVerification(user.email, url),
    afterEmailVerification: async (user) => onEmailVerified({
        id: user.id,
        name: user.name,
        email: user.email,
    }),
},
```

Identity does not import Workspaces. `app.ts` composes `createAuth` with a callback that invokes `provisionPersonalWorkspace` on the API database.

- [ ] **Step 4: Implement idempotent provisioning**

Inside `withUserTransaction`: lock the current user row `FOR UPDATE`; select the lifetime-unique personal Workspace; insert when absent with `ON CONFLICT` on `owner_user_id WHERE type = 'personal'`; insert the owner member; resolve the committed row; call `adoptOwnedWorkspaceContext`; return the existing or created summary. The GET list route only selects active memberships and cannot mutate.

- [ ] **Step 5: Run provisioning and identity regressions to verify GREEN**

Run:

```bash
bun --cwd server run test -- test/workspaces/workspaces.test.ts test/identity/auth.test.ts
```

Expected: PASS; verification provisions exactly once, concurrent callbacks converge, failures roll back, and GET remains read-only.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/identity server/src/modules/workspaces server/src/app.ts server/test
git commit -m "feat: provision personal Workspaces on verification"
```

---

### Task 6: Snapshot `document_mode` Contract and Locked Save Ordering

**Files:**
- Create: `server/migrations/0005_canvas_document_mode.sql`
- Modify: `server/migrations/meta/_journal.json`
- Generate: `server/migrations/meta/0005_snapshot.json`
- Modify: `server/src/modules/canvases/schema.ts`
- Modify: `server/src/modules/canvases/service.ts`
- Modify: `server/src/infrastructure/database/role-assertions.ts`
- Modify: `packages/contracts/src/canvases.ts`
- Modify: `server/test/canvases/schema.test.ts`
- Modify: `server/test/canvases/routes.test.ts`
- Modify: `server/test/database/tenant-isolation.test.ts`

**Interfaces:**
- Produces: `type CanvasDocumentMode = "snapshot" | "collaborative"` and read-only `documentMode` in Canvas/summary responses.
- Produces: `canvas_document_mode_mismatch` with HTTP 409.
- Preserves: `canvas_not_found` before mode checks and `revision_conflict` after mode checks.
- Consumes: Task 4 `AppTransaction` service boundary and Canvas RLS.

- [ ] **Step 1: Write mode and error-order tests**

```ts
it("returns read-only snapshot mode and rejects client mode input", async () => {
    const created = await createCanvasAsOwner();
    expect(created.documentMode).toBe("snapshot");
    const response = await rawCreate({ title: "x", snapshot: {}, documentMode: "collaborative" });
    expect(response.statusCode).toBe(400);
});

it("checks visibility, mode, then revision under one row lock", async () => {
    await setModeAsSchemaOwner(canvasId, "collaborative");
    await expect(save({ canvasId, baseRevision: 999 })).rejects.toMatchObject({ code: "canvas_document_mode_mismatch" });
    await softDeleteAsSchemaOwner(canvasId);
    await expect(save({ canvasId, baseRevision: 999 })).rejects.toMatchObject({ code: "canvas_not_found" });
});
```

Retain the existing concurrent same-base save test and require exactly one winner.

- [ ] **Step 2: Run Canvas tests and verify RED**

Run: `bun --cwd server run test -- test/canvases/schema.test.ts test/canvases/routes.test.ts`

Expected: FAIL because the column and response field do not exist and saves do not check mode.

- [ ] **Step 3: Add the column and read-only contract**

Migration:

```sql
ALTER TABLE public.canvases
    ADD COLUMN document_mode text NOT NULL DEFAULT 'snapshot',
    ADD CONSTRAINT canvases_document_mode_check
        CHECK (document_mode IN ('snapshot', 'collaborative'));
```

Grant maintenance column-level SELECT for `document_mode`, extend the startup allowlist by that one column, and add an isolation assertion that Maintenance can read it but still cannot read `snapshot_json` or write Canvas rows. Contracts include `documentMode` in `CanvasSchema` and `CanvasSummarySchema`, but neither `CreateCanvasBodySchema` nor `SaveCanvasRequestSchema` contains it; `additionalProperties: false` rejects attempts to mutate it.

- [ ] **Step 4: Lock and validate save state in the fixed order**

`saveCanvas(tx, access, canvasId, input)` first selects the visible row with `workspace_id`, `deleted_at`, `document_mode`, and `revision` `FOR UPDATE`. It throws:

1. `404 canvas_not_found` when invisible, missing, or deleted;
2. `409 canvas_document_mode_mismatch` when mode is not `snapshot`;
3. `409 revision_conflict` when `revision !== baseRevision`;
4. `409 canvas_revision_limit_reached` at the safe integer ceiling.

Only then update with an explicit `WHERE id = ? AND workspace_id = ? AND document_mode = 'snapshot' AND revision = ? AND deleted_at IS NULL`, increment revision, and return the row. Create always writes `document_mode = 'snapshot'` explicitly.

- [ ] **Step 5: Run Canvas and tenant-isolation tests to verify GREEN**

Run:

```bash
bun --cwd server run test -- test/canvases/schema.test.ts test/canvases/routes.test.ts test/database/tenant-isolation.test.ts
```

Expected: PASS; mode is immutable through normal APIs, stable error ordering holds, and concurrent revision behavior remains linearizable.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/canvases.ts server
git commit -m "feat: lock Canvas snapshot document mode"
```

---

### Task 7: Backend Gate 0 Documentation and Verification Record

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/content/docs/progress/todo.mdx`
- Modify: `docs/content/docs/progress/todo.zh-CN.mdx`
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `docs/content/docs/progress/pending-test.zh-CN.mdx`
- Create: `docs/content/docs/progress/gate-0-backend-verification.mdx`

**Interfaces:**
- Consumes: test evidence from Tasks 1-6 and the final task review ledger.
- Produces: a user-testable record without claiming native IndexedDB CAS, browser verification, or full Gate 0 completion.

- [ ] **Step 1: Record the user-visible backend correction**

Add one `Unreleased` entry:

```md
- [调整] 后端改为独立数据库角色、业务自有 Workspace 与事务级 RLS 隔离，并固定画布 snapshot 文档模式。
```

- [ ] **Step 2: Move only completed backend items to pending-test**

The pending-test documents must list exact checks: registration verification creates one personal Workspace; team member/invitation operations no longer use Better Auth Organization; cross-Workspace access is denied; Canvas reports `documentMode: snapshot`; wrong mode and stale revision return distinct 409 codes. The todo documents must retain native IndexedDB CAS, three-browser evidence, user typecheck, Billing, Asset, and AI Task work.

- [ ] **Step 3: Create the verification record**

`gate-0-backend-verification.mdx` records exact focused commands, commit ranges, role names, policy tables, and whether each automated result passed. It explicitly states: `Gate 0 尚未关闭：原生 IndexedDB CAS、Chrome/Firefox/Safari 矩阵和用户 typecheck 证据仍待完成。`

- [ ] **Step 4: Run the complete backend suite**

Run: `bun --cwd server run test`

Expected: PASS with no warning/noise; tests use runtime roles for RLS evidence. Do not run the web build or user-owned typecheck here.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/content/docs/progress
git commit -m "docs: record Gate 0 backend verification"
```

---

## Plan Self-Review Record

- **Spec coverage:** Gate 0 backend ordering is fully mapped: role credentials/test connections (Task 1), Organization removal and final Workspace columns/constraints (Task 2), transaction context/helpers/admin binding (Task 3), RLS and same-transaction services (Task 4), GET-side-effect removal/provisioning (Task 5), and `document_mode` (Task 6). Native IndexedDB CAS is intentionally excluded into its own spec/plan; Billing, Assets, AI Tasks, and collaboration remain later gates.
- **Placeholder scan:** the plan contains no unresolved marker, generic error-handling step, or unnamed test. Every task names files, interfaces, focused commands, expected failures, and expected passing behavior.
- **Type consistency:** `DatabaseLoginRole`, `DatabaseConfig`, `DatabaseHandle.role`, `AppTransaction`, `WorkspaceAccess`, and the four transaction entrypoints are introduced before consumers. Workspace schema exports move once in Task 2; Tasks 3-6 consume only that final location.
- **Migration consistency:** fixed filenames `0002`, `0003`, `0004`, and `0005` are journaled in order and no later task edits an already-reviewed migration. Task 1 establishes roles before any migration references them; Task 2 removes Organization before renamed columns are consumed; Task 3 creates helpers before Task 4 policies call them; Task 6 extends the maintenance allowlist only after `document_mode` exists.
