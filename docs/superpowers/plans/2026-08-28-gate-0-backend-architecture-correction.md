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
- Canvas deletion is an idempotent state transition with a durable `deletion_receipt_id`; a later local CAS may delete local data only after receiving that receipt.
- The complete approved admin-purpose vocabulary is fixed at Gate 0, but only Workspace read/suspend/deactivate/restore behavior is implemented here; future Billing and Provider purposes do not authorize any business mutation in this plan.
- Do not add Wallet, Ledger, Asset, Provider, AI Task, pg-boss job, Redis, RabbitMQ, Keycloak, Yjs, or Kubernetes implementation in this plan.
- Tests use production-equivalent `app_api`, `app_worker`, and `app_maintenance` login connections. Superuser/schema-owner tests cannot count as RLS evidence.
- Write the focused failing test before production code, run that focused test to observe the expected failure, then implement and rerun it. User-owned `web` typecheck and real-browser evidence remain outside this backend plan.

### Atomic implementation boundary

Tasks 1-4 are one database-security implementation unit and one deployable commit, assigned to one implementation agent. Their numbered sections are internal TDD checkpoints, not independently releasable states: no commit, handoff, deployment, or claim of a green full backend suite occurs after Tasks 1, 2, or 3. This avoids ever publishing `app_api` with missing grants, broad pre-RLS grants, moved schema with old routes, or a two-stage authorization bridge. The unit becomes reviewable only after Task 4 has installed final grants/RLS and switched all routes to final transaction entrypoints. Tasks 5-7 may then be implemented and reviewed separately.

---

## File Responsibility Map

| Area | Files | Responsibility |
|---|---|---|
| Role provisioning | `server/database/bootstrap/roles.sql`, `server/database/bootstrap/adopt-ownership.sql` | Idempotently create fixed role names, harden attributes, and let a deployment administrator transfer an existing pre-release schema to `schema_owner`; passwords remain deployment secrets outside the repository. |
| Runtime configuration | `server/src/config.ts`, `server/drizzle.config.ts`, `.env.example` | Select exactly one process credential and the schema-owner migration credential. |
| Pool identity | `server/src/infrastructure/database/client.ts`, `role-assertions.ts`, `plugin.ts`, `types.ts` | Build one role-specific pool, verify effective role/ownership/BYPASSRLS, and gate readiness. |
| Transaction context | `server/src/infrastructure/database/transactions.ts` | Own all transaction-local user/workspace/admin context and expose the only business transaction entry points. |
| Identity | `server/src/modules/identity/auth-schema.ts`, `auth.ts`, `types.ts` | Better Auth identity tables and verified-email callback only. |
| Workspaces | `server/src/modules/workspaces/schema.ts`, `service.ts`, `authorization.ts`, `routes.ts` | Workspace/member/invitation schema, business invariants, authorization, and HTTP mapping. |
| Canvas snapshot | `server/src/modules/canvases/schema.ts`, `service.ts`, `routes.ts`, `packages/contracts/src/canvases.ts` | Snapshot-mode resource contract, revision lock, durable deletion receipt, and stable error ordering. |
| Database policy | `server/migrations/0002_workspace_authority.sql`, `0003_transaction_context.sql`, `0004_tenant_rls.sql`, `0005_canvas_document_mode.sql` | Final column layout, constraints, helpers, grants, RLS policies, and Canvas mode/receipt fields. |
| Test database | `server/test/helpers/postgres.ts`, `server/test/helpers/database.ts`, `server/test/helpers/auth.ts` | Bootstrap roles, run migrations in journal order, and expose separate role handles. |
| Boundary verification | `server/scripts/check-module-boundaries.ts`, `server/test/architecture/module-boundaries.test.ts` | Parse TypeScript imports and fail if Better Auth escapes Identity. |

---

### Task 1: PostgreSQL Login Roles, Role-Specific Configuration, and Test Harness

**Files:**
- Create: `server/database/bootstrap/roles.sql`
- Create: `server/database/bootstrap/adopt-ownership.sql`
- Create: `server/src/infrastructure/database/role-assertions.ts`
- Create: `server/test/helpers/database.ts`
- Create: `server/test/database/roles.test.ts`
- Create: `server/test/database/migration-upgrade.test.ts`
- Modify: `server/src/config.ts`
- Modify: `server/src/infrastructure/database/client.ts`
- Modify: `server/src/infrastructure/database/types.ts`
- Modify: `server/src/infrastructure/database/plugin.ts`
- Modify: `server/src/app.ts`
- Modify: `packages/contracts/src/workspaces.ts`
- Modify: `server/src/api.ts`
- Modify: `server/src/worker.ts`
- Modify: `server/drizzle.config.ts`
- Modify: `server/test/helpers/postgres.ts`
- Modify: `server/test/helpers/auth.ts`
- Modify: `server/test/config.test.ts`
- Modify: `server/test/database/connection.test.ts`
- Modify: `server/test/app-runtime.test.ts`
- Modify: `server/test/canvases/routes.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `type DatabaseLoginRole = "schema_owner" | "app_api" | "app_worker" | "app_maintenance"`.
- Produces: `type DatabaseConfig = { url: string; poolMax: number; expectedRole: DatabaseLoginRole }`.
- Produces: `createDatabase(config: DatabaseConfig): DatabaseHandle` where `DatabaseHandle` includes `role`.
- Produces: `inspectDatabaseRole(pool, expectedRole): Promise<DatabaseRoleInspection>` and `assertDatabaseRole(...)`.
- Produces: `startRoleDatabase(): Promise<StartedRoleDatabase>` with `admin`, `schemaOwner`, `api`, `worker`, and `maintenance` URLs and cleanup.
- Consumes later: all tests and application processes use these handles; Task 4 adds privilege assertions to the same inspector.

- [ ] **Step 1: Write the first failing role-isolation test without importing new modules**

Create `server/test/database/roles.test.ts` using only the existing `startPostgres` helper and `pg.Pool`. The first test is executable before any new production module exists and fails because the roles are absent:

```ts
it("defines every required login as NOSUPERUSER NOBYPASSRLS", async () => {
    const postgres = await startPostgres();
    const pool = new Pool({ connectionString: postgres.url });
    const result = await pool.query(`
        select rolname, rolsuper, rolbypassrls, rolcanlogin
        from pg_roles
        where rolname = any($1::text[])
        order by rolname
    `, [["app_api", "app_maintenance", "app_worker", "schema_owner"]]);
    expect(result.rows).toEqual([
        { rolname: "app_api", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
        { rolname: "app_maintenance", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
        { rolname: "app_worker", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
        { rolname: "schema_owner", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
    ]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun --cwd server run test -- test/database/roles.test.ts`

Expected: FAIL with an empty `rows` array because the four roles do not exist; the test itself compiles and reaches PostgreSQL.

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

After the first RED is observed, `startPostgres` executes this bootstrap as the ephemeral container administrator before returning. `startRoleDatabase` builds on it and uses fixed, test-only `ALTER ROLE app_api PASSWORD 'test-app-api'` statements for the four static role names; it does not attempt to bind a password parameter into utility SQL. The helper grants database `CONNECT`, transfers the `public` schema to `schema_owner`, and grants that role `CREATE`. Thus the original compile-valid test becomes green through the real bootstrap rather than by changing its assertion.

`adopt-ownership.sql` is an explicit deployment-administrator action for the pre-release database. It revokes `PUBLIC CREATE` on `public`, changes the schema owner, and enumerates existing application relations, sequences, and routines in `public`, executing catalog-derived, identifier-quoted `ALTER ... OWNER TO schema_owner`; it excludes extension-owned objects. The upgrade-path test creates `legacy_owner`, applies the real immutable `0000/0001` journal entries as that role, and runs adoption as the container administrator. Task 1 proves every current application object transferred and extension objects did not; Task 2 extends the same fixture to run `0002+` as `schema_owner`, assert the latest journal tag, and execute final application queries. A separate fresh-install path runs every available migration as `schema_owner`. The helper keeps known hashes for `0000/0001` so the upgrade fixture cannot silently follow rewritten historical SQL.

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

- [ ] **Step 5: Write the second failing test for role-aware readiness**

After the role bootstrap test is green, add the imports and assertions for `startRoleDatabase` and `inspectDatabaseRole`:

```ts
it("rejects readiness when the configured role and effective login differ", async () => {
    const databases = await startRoleDatabase();
    await expect(inspectDatabaseRole(databases.api.pool, "app_worker"))
        .resolves.toMatchObject({ ok: false, violations: [expect.stringContaining("app_worker")] });
});
```

Run: `bun --cwd server run test -- test/database/roles.test.ts -t "rejects readiness"`

Expected: FAIL because the existing readiness implementation checks only `select 1` and accepts the wrong effective login.

- [ ] **Step 6: Add role-aware pools and readiness inspection**

`createDatabase` copies `expectedRole` into the handle. `inspectDatabaseRole` checks `current_user`, `rolsuper`, `rolbypassrls`, and current ownership of `workspaces`, `workspace_members`, `workspace_invitations`, and `canvases` when those tables exist. A missing table is not a violation during Task 1; a runtime role owning an existing table is.

`checkDatabaseReady` performs both `select 1` and `inspectDatabaseRole`. It returns false for any mismatch. API builds only an `app_api` pool; Worker builds only an `app_worker` pool. No process accepts a list of URLs. Update `config.test.ts` expected objects to include `{ expectedRole: "app_api" }`; update `connection.test.ts` so normal readiness uses a real `app_api` handle and a separately injected superuser handle returns 503.

- [ ] **Step 7: Replace ad-hoc migration loading with the journaled migrator**

`test/helpers/database.ts` uses Drizzle's `migrate` from `drizzle-orm/node-postgres/migrator` against the schema-owner handle and `server/migrations/meta/_journal.json`; `auth.ts` and Canvas tests call that one helper and stop reading individual SQL files. Add a fresh-database assertion that the journal's latest tag is recorded and the expected schema is owned by `schema_owner`.

- [ ] **Step 8: Run focused and existing database tests to verify GREEN**

Run:

```bash
bun --cwd server run test -- test/database/roles.test.ts test/database/migration-upgrade.test.ts test/database/connection.test.ts test/config.test.ts test/app-runtime.test.ts
```

Expected: PASS; every role query reports a distinct login, runtime roles own no current business table, and wrong-role readiness is rejected.

- [ ] **Step 9: Keep the atomic unit uncommitted and continue to Task 2**

Record focused role/bootstrap evidence in the SDD ledger. Do not commit or hand off: application business routes are intentionally not considered deployable until Task 4 installs their final grants and RLS.

---

### Task 2: Workspaces Module Ownership and Final Workspace Constraints

**Files:**
- Create: `server/src/modules/workspaces/schema.ts`
- Create: `server/src/modules/identity/schema.ts`
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
- Modify: `server/src/modules/canvases/schema.ts`
- Modify: `server/src/infrastructure/database/schema.ts`
- Modify: `server/src/app.ts`
- Modify: `server/test/identity/auth.test.ts`
- Modify: `server/test/workspaces/workspaces.test.ts`
- Modify: `server/test/database/migration-upgrade.test.ts`
- Modify: `server/migrations/meta/_journal.json`
- Generate: `server/migrations/meta/0002_snapshot.json`

**Interfaces:**
- Produces: `users` as the Identity module's public database reference from `modules/identity/schema.ts`; `workspaces`, `workspaceMembers`, `workspaceInvitations` only from `modules/workspaces/schema.ts`. Canvas imports Workspace only through that public schema entry.
- Produces: `type AppTransaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0]`; Workspace services use this final signature immediately.
- Produces direct services: `listWorkspaces`, `createTeamWorkspace`, `updateWorkspace`, `listWorkspaceMembers`, `removeWorkspaceMember`, `createWorkspaceInvitation`, `cancelWorkspaceInvitation`, and `acceptWorkspaceInvitation`.
- Produces: `checkModuleBoundaries(rootDir): Promise<BoundaryViolation[]>` using the TypeScript parser; it rejects `better-auth*` outside Identity and rejects cross-module imports of private schema implementations such as `identity/auth-schema`.
- Removes: all Better Auth Organization API calls, Organization plugin hooks, Organization DTO aliases, and `sessions.activeOrganizationId`.
- Consumes: Task 1 schema-owner migration path and role test harness.

- [ ] **Step 1: Write compile-valid boundary and database-invariant tests**

The first boundary RED uses the TypeScript parser directly inside the test to scan the existing `server/src` tree and expects no `better-auth*` import outside Identity. It compiles against the current tree and fails by reporting the actual Workspaces violations rather than a missing future module. After that observed RED, extract the already-tested parser into `check-module-boundaries.ts`, import it from the test, and add a temporary source fixture proving the executable checker catches a real import:

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

`identity/schema.ts` owns and exports the `users` table as Identity's explicit cross-module database reference. `identity/auth-schema.ts` imports that public table, exports only `sessions`, `accounts`, `verifications`, and `authSchema`, and `authSchema` contains only the four Better Auth model keys. Workspaces imports `users` from `identity/schema.ts`; Canvas imports `workspaces` from `workspaces/schema.ts`; neither imports `identity/auth-schema.ts`.

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

Members use `workspace_id`, `user_id`, role `owner | admin | member`, status `active | removed`, and timezone-aware `joined_at`. Invitations use `workspace_id`, normalized target email, non-null role `admin | member`, status `pending | accepted | rejected | canceled`, `token_digest`, `inviter_id`, timezone-aware `expires_at`, and timezone-aware `created_at`. The legacy Workspace `logo` and `metadata` fields do not exist in the final schema.

Remove `organization()` and all Organization hooks from `identity/auth.ts`. `registerWorkspaceRoutes` no longer receives `Auth`; it receives the application mailer needed to send an invitation URL after the Workspaces transaction commits.

- [ ] **Step 4: Implement the corrective migration**

First update the Drizzle schema to its final shape, then run `bun --cwd server run db:generate -- --name workspace-authority` so `0002_workspace_authority.sql`, `_journal.json`, and `0002_snapshot.json` are one generated schema history. Review and extend that generated SQL with the data conversion and deferred invariant functions below; tests always execute it through the journaled migrator.

The migration preserves existing row IDs while applying every final name and type. Legacy timestamp columns are interpreted as UTC explicitly before becoming `timestamptz`:

| Table | Existing physical columns | Final physical columns |
|---|---|---|
| `workspaces` | `id,name,slug,logo,createdAt,metadata,workspace_type,status,owner_user_id` | `id,name,slug,type,status,owner_user_id,created_at,updated_at,deleted_at` |
| `workspace_members` | `id,organizationId,userId,role,createdAt` | `id,workspace_id,user_id,role,status,joined_at` |
| `workspace_invitations` | `id,organizationId,email,role,status,expiresAt,createdAt,inviterId` | `id,workspace_id,email,role,status,expires_at,created_at,inviter_id,token_digest` |

```sql
ALTER TABLE public.sessions DROP COLUMN "activeOrganizationId";
ALTER TABLE public.workspaces RENAME COLUMN workspace_type TO type;
ALTER TABLE public.workspaces RENAME COLUMN "createdAt" TO created_at;
ALTER TABLE public.workspace_members RENAME COLUMN "organizationId" TO workspace_id;
ALTER TABLE public.workspace_members RENAME COLUMN "userId" TO user_id;
ALTER TABLE public.workspace_invitations RENAME COLUMN "organizationId" TO workspace_id;
ALTER TABLE public.workspace_invitations RENAME COLUMN "inviterId" TO inviter_id;
ALTER TABLE public.workspace_invitations RENAME COLUMN "expiresAt" TO expires_at;
ALTER TABLE public.workspace_invitations RENAME COLUMN "createdAt" TO created_at;

ALTER TABLE public.workspaces
    ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE public.workspaces ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.workspaces ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.workspaces DROP COLUMN logo;
ALTER TABLE public.workspaces DROP COLUMN metadata;
ALTER TABLE public.workspace_members ADD COLUMN status text NOT NULL DEFAULT 'active';
ALTER TABLE public.workspace_members RENAME COLUMN "createdAt" TO joined_at;
ALTER TABLE public.workspace_members
    ALTER COLUMN joined_at TYPE timestamptz USING joined_at AT TIME ZONE 'UTC';
ALTER TABLE public.workspace_invitations ADD COLUMN token_digest text;
UPDATE public.workspace_invitations SET role = 'member' WHERE role IS NULL;
ALTER TABLE public.workspace_invitations ALTER COLUMN role SET NOT NULL;
UPDATE public.workspace_invitations
SET email = lower(trim(email)),
    status = CASE WHEN status = 'pending' THEN 'canceled' ELSE status END;
ALTER TABLE public.workspace_invitations
    ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC',
    ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
UPDATE public.workspace_invitations
SET token_digest = md5(id || ':legacy:1') || md5(id || ':legacy:2')
WHERE token_digest IS NULL;
ALTER TABLE public.workspace_invitations ALTER COLUMN token_digest SET NOT NULL;
```

Before making invitation role non-null, backfill null roles to `member`; normalize email with `lower(trim(email))`; mark all pre-release pending invitations `canceled`; and give those non-redeemable legacy rows a 64-character placeholder digest before the NOT NULL constraint. New invitations always persist a real application-computed SHA-256 digest, and no compatibility redemption path remains.

The same migration drops and recreates affected foreign keys as `ON DELETE RESTRICT`, adds CHECK constraints for Workspace type/status/deleted-at coherence, member role/status, normalized invitation email, 64-character token digest, and invitation role/status, rebuilds every renamed index, preserves `workspaces_owner_personal_unique` with predicate `type = 'personal'`, adds one-owner partial uniqueness, and adds DEFERRABLE INITIALLY DEFERRED constraint triggers on both `workspaces` and `workspace_members`. The trigger raises SQLSTATE `23514` unless every active Workspace has exactly one active owner member whose `user_id` equals `owner_user_id`.

The migration is run as `schema_owner`, so all newly created relations, sequences, and functions are owned correctly by construction. Existing-object adoption belongs only to Task 1's deployment-administrator bootstrap. Revoke all application-table privileges from `PUBLIC`; grant `app_api` the exact Better Auth DML needed on `users`, `sessions`, `accounts`, and `verifications` so identity regressions run under the real API login. Task 4 separately owns every business-table grant so grant and RLS evidence cannot be confused.

- [ ] **Step 5: Replace Organization route calls with Workspaces services**

Implement each direct service and `requireWorkspaceAccess` against a passed `AppTransaction`; no service accepts `AppDatabase` or starts a nested transaction. Do not create a plain-transaction route bridge. Old Organization routes remain part of the atomic unit's expected RED until Task 4 replaces them once with final `withUserTransaction`/`withTenantTransaction` entrypoints. Because Tasks 1-4 have no intermediate commit or handoff, this temporary source-level break is never a published architecture.

Invitation creation generates `randomBytes(32).toString("base64url")`, persists `sha256(token)` only, and sends a URL containing the raw token. Replace the old invitation-ID acceptance path with `POST /api/v1/workspace-invitations/accept` and strict body `{ token: string }`; acceptance hashes that raw token and conditionally claims the matching `pending`, unexpired invitation for the current user's verified email. An invitation ID cannot substitute for the token. Raw tokens never enter responses, logs, or the database, and duplicate/concurrent claims have exactly one winner.

Member removal uses a conditional delete that excludes `role = 'owner'`. Workspace updates accept only name/slug. `WorkspaceStatusSchema` is the closed union `active | suspended | deactivated`, never an arbitrary response string. Direct services convert unique violations to existing stable application errors without Better Auth error-code mapping.

- [ ] **Step 6: Add the executable boundary command**

Add `"check:boundaries": "tsx scripts/check-module-boundaries.ts src"` to `server/package.json`. The script parses `ImportDeclaration`, `ExportDeclaration`, and dynamic `import()` string literals with the TypeScript compiler API; it exits non-zero when a module beginning `better-auth` originates outside `src/modules/identity/`.

- [ ] **Step 7: Run schema/boundary checkpoints; keep the full application RED inside the atomic unit**

Run:

```bash
bun --cwd server run check:boundaries
bun --cwd server run test -- test/architecture/module-boundaries.test.ts test/workspaces/constraints.test.ts
```

Expected: schema/constraint tests PASS against fresh and upgraded databases, including exact `information_schema.columns` assertions for the complete old→new matrix and an application-level query through the final Drizzle schema. The boundary command may remain RED only for the explicitly enumerated old Organization route imports; Task 4 must remove those and make it fully green. Full route tests are not claimed green before final grants/RLS exist.

- [ ] **Step 8: Keep the atomic unit uncommitted and continue to Task 3**

Do not register or expose an interim route implementation and do not grant broad pre-RLS business DML. Continue in the same implementation task and working tree.

---

### Task 3: Transaction Context Entrypoints and Admin Operation Binding

**Files:**
- Create: `server/src/infrastructure/database/transactions.ts`
- Create: `server/src/modules/workspaces/context.ts`
- Create: `server/src/modules/platform-admin/schema.ts`
- Create: `server/test/database/transactions.test.ts`
- Create: `server/migrations/0003_transaction_context.sql`
- Modify: `server/src/infrastructure/database/types.ts`
- Modify: `server/src/infrastructure/database/schema.ts`
- Modify: `server/src/modules/workspaces/schema.ts`
- Modify: `server/migrations/meta/_journal.json`
- Generate: `server/migrations/meta/0003_snapshot.json`

**Interfaces:**
- Consumes: Task 2 `AppTransaction`.
- Produces: `withUserTransaction(db, userId, work)`.
- Produces: `withTenantTransaction(db, { userId, workspaceId, minimumRole? }, work)` returning `WorkspaceAccess` to the callback.
- Produces: `withWorkerTransaction(db, { workspaceId, verify }, work)`; `verify(tx)` is mandatory and must return a verified resource or null.
- Produces: `withPlatformAdminTransaction(db, { userId, requestId, target, purpose }, work)`.
- Produces: private branded `ResolvedOwnedWorkspaceId` values from team/personal insert-or-select repository functions and `adoptOwnedWorkspaceContext(tx, userId, resolvedWorkspaceId)`; routes cannot construct the brand.
- Produces: immutable `admin_operations`, `global_audit_logs`, `workspace_audit_logs`, and `workspace_provisioning_audits`; only narrow transaction-bound functions or Task 4 policies can append them.
- Consumes later: Task 4 routes and services.

- [ ] **Step 1: Write transaction-context tests**

Use the `app_api` login and prove transaction-local isolation. The leak test uses a dedicated pool with `max: 1`, so the post-transaction query is guaranteed to reuse the same physical connection after the helper releases it; it accepts PostgreSQL's missing value as `NULL` or empty text but rejects either old ID:

```ts
it("does not leak user or workspace context through a reused pool connection", async () => {
    await withTenantTransaction(apiDb, { userId: owner.id, workspaceId }, async (tx) => {
        expect(await context(tx)).toEqual({ userId: owner.id, workspaceId });
    });
    const leaked = await apiPool.query(`select current_setting('app.user_id', true) user_id,
        current_setting('app.workspace_id', true) workspace_id`);
    expect([null, ""]).toContain(leaked.rows[0].user_id);
    expect([null, ""]).toContain(leaked.rows[0].workspace_id);
});

it("rejects adopting a workspace not resolved as the current user's owned workspace", async () => {
    await expect(withUserTransaction(apiDb, userA.id, (tx) =>
        adoptOwnedWorkspaceContext(tx, userA.id, userBWorkspace.id),
    )).rejects.toMatchObject({ code: "workspace_context_adoption_forbidden" });
});
```

Add tests proving `withWorkerTransaction` cannot be called without a verifier, verifier-null aborts, and an admin operation ID cannot be reused in another transaction or for a different target/purpose. `withWorkerTransaction` has no production caller in Gate 0 and remains a tested, unexported-to-routes foundation until the Gate 4 Worker resource contract exists.

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

- [ ] **Step 4: Generate admin/audit tables and add SECURITY DEFINER functions**

Update the Drizzle schema first, then run `bun --cwd server run db:generate -- --name transaction-context` to create the journaled `0003` migration and snapshot. The migration creates `platform_admins`, immutable `admin_operations`, immutable platform-target `global_audit_logs`, Workspace-scoped immutable `workspace_audit_logs`, and global immutable `workspace_provisioning_audits`. `admin_operations.transaction_xid` and audit transaction references use PostgreSQL `xid8`. Audit tables have no UPDATE/DELETE path; schema-owner triggers reject mutation after insert. `workspace_provisioning_audits` has a unique `(user_id, source)` event key and can be appended only by a narrow SECURITY DEFINER function that records the current user, source `email_verification | explicit_repair`, resolved Workspace, a server-derived request ID, and current transaction ID.

`begin_admin_operation` validates current active admin status and this exact architecture-level purpose set: platform targets accept `user_read | model_read | model_write | provider_route_read | provider_route_write`; Workspace targets accept `workspace_read | workspace_suspend | workspace_deactivate | workspace_restore | wallet_adjust | wallet_status_write | billing_confirm_charge | billing_confirm_no_charge | ledger_compensate | workspace_export`. Gate 0 implements only Workspace read/suspend/deactivate/restore. The remaining names are fixed protocol vocabulary only: no Gate 0 policy or service consumes them, and they grant no business access. The function writes `pg_current_xact_id()` and sets `app.admin_operation_id` with `is_local = true`. `is_current_admin_operation` checks operation ID, current transaction xid, current `app.user_id`, target, purpose, row Workspace, and current admin status.

All control functions use `SECURITY DEFINER SET search_path = pg_catalog, public`, fully qualified names, no dynamic SQL, `REVOKE ALL ... FROM PUBLIC`, and signature-specific `GRANT EXECUTE TO app_api`. `app_api`, `app_worker`, and `app_maintenance` receive no direct table privileges on `platform_admins`, `admin_operations`, or `workspace_provisioning_audits`.

Create the minimal non-recursive `is_active_workspace_member(workspace_id, user_id)` and `is_workspace_manager(...)` helpers under the same ownership rules. They read only `workspaces` and `workspace_members`.

Task 2's deferred owner-invariant trigger functions are also `SECURITY DEFINER`, owned by `schema_owner`, fixed to `search_path = pg_catalog, public`, fully qualified, and read only the two authorization roots. This ensures a non-owner invitation acceptance sees the real owner at commit even after root-table RLS is enabled. Add a real `app_api` acceptance commit test plus an invalid-owner commit test.

- [ ] **Step 5: Implement owned-context adoption**

Only private repository functions brand an ID after a team/personal insert returns it or after the current user's lifetime-unique personal row is selected. `adoptOwnedWorkspaceContext` accepts that brand, locks the target Workspace, and still verifies at runtime that `owner_user_id = userId`, the active owner member matches, and transaction-local `app.user_id = userId`. The brand constructor and adoption function are not exported to routes and never accept a route/body Workspace ID. Only then does adoption set `app.workspace_id` transaction-locally.

- [ ] **Step 6: Run the focused tests to verify GREEN**

Run: `bun --cwd server run test -- test/database/transactions.test.ts`

Expected: PASS; pool reuse is clean, arbitrary context adoption fails, mandatory Worker verification runs, and admin operation replay across transaction/target/purpose fails.

- [ ] **Step 7: Keep the atomic unit uncommitted and continue to Task 4**

Record focused transaction/control-function evidence, but do not commit or hand off until those helpers bind real grants, policies, lifecycle operations, and final routes in Task 4.

---

### Task 4: Default-Deny RLS and Single-Transaction Business Services

**Files:**
- Create: `server/test/database/tenant-isolation.test.ts`
- Create: `server/migrations/0004_tenant_rls.sql`
- Modify: `server/migrations/meta/_journal.json`
- Create: `server/src/modules/platform-admin/service.ts`
- Create: `server/src/modules/platform-admin/routes.ts`
- Modify: `server/src/modules/workspaces/authorization.ts`
- Modify: `server/src/modules/workspaces/service.ts`
- Modify: `server/src/modules/workspaces/routes.ts`
- Modify: `server/src/modules/canvases/service.ts`
- Modify: `server/src/modules/canvases/routes.ts`
- Modify: `server/src/infrastructure/database/role-assertions.ts`
- Modify: `server/test/workspaces/workspaces.test.ts`
- Modify: `server/test/canvases/routes.test.ts`
- Create: `server/test/platform-admin/workspace-lifecycle.test.ts`
- Modify: `packages/contracts/src/workspaces.ts`

**Interfaces:**
- Consumes: all Task 3 transaction entrypoints and helpers.
- Produces: every Workspace and Canvas service accepts `AppTransaction`, never `AppDatabase` or `Pool`.
- Produces: explicit command grants and policies `TO app_api`, zero Gate 0 business-table privileges for `app_worker`, and allowlisted column SELECT plus read policies `TO app_maintenance`.
- Produces: readiness privilege audit for each runtime role.
- Produces: owner team deactivation plus platform-admin Workspace read/suspend/deactivate/restore, each with immutable audit and transaction-bound purpose.

- [ ] **Step 1: Write production-equivalent isolation tests**

The fixture first seeds two populated Workspaces and Canvases through the isolated Testcontainers administrator, then closes that setup path. All authorization observations use runtime role connections and include a same-tenant positive control before every cross-tenant negative control. The test also asserts `relrowsecurity`/`relforcerowsecurity` flags and exact command/column grants, so an empty table or missing SELECT grant cannot create a false green. Required cases:

```ts
await expect(apiPool.query(`select * from canvases`)).resolves.toMatchObject({ rows: [] });
await expect(readCanvasAs(userA, workspaceB, canvasB.id)).rejects.toMatchObject({ code: "workspace_forbidden" });
await expect(queryWrongJoinAsTenantA()).resolves.toMatchObject({ rows: [] });
await expect(writeCanvasWithoutContext()).rejects.toMatchObject({ code: "42501" });
await expect(maintenancePool.query(`update workspaces set status = 'suspended'`)).rejects.toMatchObject({ code: "42501" });
await expect(workerPool.query(`select id from canvases`)).rejects.toMatchObject({ code: "42501" });
```

Also test all of the following as distinct observations:

- missing context and a directly forged `app.workspace_id` both make RLS return no rows;
- `set_config(..., true)` itself is not treated as authorization: a forged path still reaches `workspace_forbidden` from `requireWorkspaceAccess`;
- a child Canvas ID from another tenant remains invisible;
- a user-only transaction can list only Workspaces where the current user has active membership;
- team creation under `withUserTransaction` can insert exactly its returned Workspace plus owner member and adopt only that branded returned ID; invitation acceptance can add only the current verified-email recipient, while an arbitrary route/body ID cannot be adopted;
- a role with table SELECT but no qualifying policy receives an empty row set, while a role with no table grant receives SQLSTATE `42501`;
- Maintenance can select only `id` and `status` from Workspace, sees its full global candidate set through explicit `USING (true)`, cannot read any Canvas column, and cannot write;
- `app_worker` has no business table privilege in Gate 0, and pool reuse does not leak context.

`workspace-lifecycle.test.ts` exercises the complete Gate 0 state matrix: an owner can deactivate an active team Workspace and gets one immutable audit row; an owner cannot deactivate a personal Workspace; normal members cannot mutate suspended/deactivated Workspaces; an active platform admin can read any status with `workspace_read`, transition `active -> suspended` only with `workspace_suspend`, transition `active|suspended -> deactivated` only with `workspace_deactivate`, and restore `suspended|deactivated -> active` only with `workspace_restore`. Wrong purpose, wrong target, inactive admin, forged GUC, reused operation ID, and operation from another transaction all deny access and create no audit row. Fault injection proves an audit insert failure leaves status unchanged and a final conditional-update failure rolls the earlier audit back.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun --cwd server run test -- test/database/tenant-isolation.test.ts`

Expected: FAIL because tables do not have RLS and runtime roles lack final command/column policies.

- [ ] **Step 3: Enable and FORCE RLS in dependency order**

Create the journal entry with `bun --cwd server run db:generate -- --custom --name tenant-rls`; this is a policy-only migration, so it does not fabricate a schema snapshot. The test migrator must discover it through `_journal.json`. In `0004_tenant_rls.sql`:

```sql
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canvases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.canvases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_audit_logs FORCE ROW LEVEL SECURITY;
```

Authorization roots `workspaces` and `workspace_members` are ENABLE but not FORCE so tightly scoped schema-owner helpers can read them without recursive policies. Leaf tables are FORCE. Every policy is command-specific and role-specific; no policy is left with the implicit `PUBLIC` target.

Before policies, explicitly revoke business privileges from `PUBLIC` and all runtime roles, then enumerate only the commands each role needs. `app_api` receives the exact Workspace/member/invitation/Canvas/audit SELECT/INSERT/UPDATE/DELETE subset exercised by services; unused hard DELETE grants are omitted. `app_worker` receives none. Gate 0 `app_maintenance` receives only column-level `SELECT (id, status)` on Workspaces plus explicit `TO app_maintenance USING (true)` Workspace SELECT policy; it receives no Canvas privilege, table-level SELECT, or DML. Task/Attempt/Hold/Wallet/Ledger/Asset columns are granted only when those real resources and consumers exist in later gates. Tests must distinguish a missing grant (`42501`) from an RLS denial (successful query with no rows).

`app_api` Canvas policies require both `workspace_id = current_setting('app.workspace_id', true)` and `is_active_workspace_member(workspace_id, current_setting('app.user_id', true))`. The Canvas SELECT policy does not use `deleted_at` as an RLS predicate: services hide deleted rows from normal GET/LIST, while Task 6's authorized DELETE can lock an already-deleted row and return its durable receipt. The `workspaces` SELECT policy is deliberately user-dimensional: under `withUserTransaction` it allows rows having an active member for `current_setting('app.user_id', true)` without requiring `app.workspace_id`, which makes the read-only list route functional. Tenant mutation policies additionally require the exact Workspace context. Platform-admin Workspace SELECT/UPDATE policies call `is_current_admin_operation` with the row target and exact lifecycle purpose. Workspace audit INSERT permits only the active owner lifecycle path or a currently bound admin operation with the matching purpose and row Workspace.

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

Add the team-owner deactivation route through `withTenantTransaction` and platform-admin read/status routes through `withPlatformAdminTransaction`. Each status service locks the Workspace, checks the exact allowed source/target state, appends `workspace_audit_logs`, then performs the conditional status update as the final business statement in the same transaction; this ordering keeps the tenant audit writable before `active -> deactivated` closes normal-member policies. Platform-admin routes map each requested transition to one fixed purpose server-side; clients cannot submit a purpose string. Personal Workspace owner deactivation is a stable 409 error. No hard-delete Workspace route is introduced.

- [ ] **Step 5: Extend startup assertions to privileges**

`role-assertions.ts` now rejects runtime ownership, `rolbypassrls`, table DML not on the role allowlist, any Gate 0 business privilege on `app_worker`, and maintenance access to non-allowlisted columns. A production process with any violation fails readiness rather than logging and continuing.

- [ ] **Step 6: Run isolation and route regressions to verify GREEN**

Run:

```bash
bun --cwd server run check:boundaries
bun --cwd server run test -- test/database/roles.test.ts test/database/connection.test.ts test/database/transactions.test.ts test/database/tenant-isolation.test.ts test/architecture/module-boundaries.test.ts test/workspaces/constraints.test.ts test/workspaces/workspaces.test.ts test/identity/auth.test.ts test/canvases/routes.test.ts test/platform-admin/workspace-lifecycle.test.ts
```

Expected: PASS for the complete atomic unit under runtime roles; module boundaries are clean, upgraded/fresh schemas match, cross-tenant and missing-context cases default deny, grant-denial and RLS-denial cases remain distinguishable, user-only Workspace listing works, lifecycle transitions obey the purpose/state matrix, immutable audits match committed changes, and Maintenance can globally read only Workspace ID/status.

- [ ] **Step 7: Commit**

```bash
git add .env.example packages/contracts/src/workspaces.ts server
git commit -m "feat: establish transaction-scoped PostgreSQL tenant security"
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
- Modify: `packages/contracts/src/workspaces.ts`

**Interfaces:**
- Produces: `onEmailVerified(user: { id: string; name: string; email: string }): Promise<void>` injected into Identity by the composition root.
- Produces: `provisionPersonalWorkspace(db, user): Promise<WorkspaceSummary>` using `withUserTransaction` and `adoptOwnedWorkspaceContext`.
- Produces: authenticated, naturally idempotent `POST /api/v1/workspaces/personal/repair`, requiring a verified identity, as the explicit recovery path for a failed post-verification callback.
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

Add a concurrent test calling `provisionPersonalWorkspace` twice and asserting identical returned Workspace IDs, one Workspace, and one owner member; separately invoke the `Promise<void>` verification callback concurrently and assert the same final database state. Inject a failure after Workspace insert but before owner insert and assert the transaction leaves neither row. Add a post-commit callback failure case through the real Better Auth verification endpoint: email verification remains complete, the automatic provisioning callback fails, then `POST /api/v1/workspaces/personal/repair` creates the missing Workspace; replay returns the same Workspace, leaves one owner member, and leaves exactly one immutable provisioning audit. An unverified user fails closed. The endpoint does not claim the generic `Idempotency-Key` protocol reserved by the architecture for later AI/ledger operations.

- [ ] **Step 2: Run the provisioning tests and verify RED**

Run: `bun --cwd server run test -- test/workspaces/workspaces.test.ts -t "personal Workspace provisioning"`

Expected: FAIL because current provisioning occurs as a GET side effect, has no explicit repair path, and does not use the owned-context transaction.

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

Inside `withUserTransaction`: lock the current user row `FOR UPDATE`; verify the persisted `emailVerified` state; select the lifetime-unique personal Workspace; insert when absent with `ON CONFLICT` on `owner_user_id WHERE type = 'personal'`; insert the owner member; resolve the committed row; call `adoptOwnedWorkspaceContext`; append `workspace_provisioning_audits` through its narrow function with a server-derived unique `(user_id, source)` event key; return the existing or created summary. Automatic verification and explicit repair converge on this same function, and replay is naturally idempotent through the lifetime-unique Workspace plus audit event constraints. The GET list route only selects active memberships and cannot mutate.

- [ ] **Step 5: Run provisioning and identity regressions to verify GREEN**

Run:

```bash
bun --cwd server run test -- test/workspaces/workspaces.test.ts test/identity/auth.test.ts
```

Expected: PASS; verification provisions exactly once, concurrent callbacks converge, in-transaction failures roll back, post-commit callback failure is recoverable through the audited idempotent repair path, and GET remains read-only.

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
- Modify: `server/src/modules/canvases/routes.ts`
- Modify: `packages/contracts/src/canvases.ts`
- Modify: `server/test/canvases/schema.test.ts`
- Modify: `server/test/canvases/routes.test.ts`
- Modify: `server/test/database/tenant-isolation.test.ts`

**Interfaces:**
- Produces: `type CanvasDocumentMode = "snapshot" | "collaborative"` and read-only `documentMode` in Canvas/summary responses.
- Produces: `CanvasDeletionReceipt = { canvasId, deletionReceipt, deletedAt }`; first soft-delete and authorized idempotent replay return the same durable receipt.
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
    await setModeAsContainerAdmin(canvasId, "collaborative");
    await expect(save({ canvasId, baseRevision: 999 })).rejects.toMatchObject({ code: "canvas_document_mode_mismatch" });
    await softDeleteAsContainerAdmin(canvasId);
    await expect(save({ canvasId, baseRevision: 999 })).rejects.toMatchObject({ code: "canvas_not_found" });
});
```

Retain the existing concurrent same-base save test and require exactly one winner.

Add deletion tests proving the first DELETE sets `deleted_at` and `deletion_receipt_id` atomically, replay through the same active Workspace authorization returns byte-for-byte the same receipt without another state change, ordinary GET/LIST 404 responses contain no receipt, and cross-Workspace, removed-member, suspended/deactivated-Workspace, network/error fixtures never produce a receipt. Direct schema tests reject rows where only one of `deleted_at` and `deletion_receipt_id` is set and reject duplicate receipts.

Because Canvas is `FORCE ROW LEVEL SECURITY` and `schema_owner` has no bypass, arrangement-only mode/deletion fixtures use the isolated Testcontainers administrator and assert the affected row count. Every behavior assertion still runs through production-equivalent `app_api`; no schema-owner policy, BYPASSRLS attribute, or persistent `NO FORCE` escape is added.

- [ ] **Step 2: Run Canvas tests and verify RED**

Run: `bun --cwd server run test -- test/canvases/schema.test.ts test/canvases/routes.test.ts`

Expected: FAIL because the column and response field do not exist and saves do not check mode.

- [ ] **Step 3: Add the column and read-only contract**

Migration:

```sql
ALTER TABLE public.canvases
    ADD COLUMN document_mode text NOT NULL DEFAULT 'snapshot',
    ADD COLUMN deletion_receipt_id uuid,
    ADD CONSTRAINT canvases_document_mode_check
        CHECK (document_mode IN ('snapshot', 'collaborative')),
    ADD CONSTRAINT canvases_deletion_state_check
        CHECK ((deleted_at IS NULL) = (deletion_receipt_id IS NULL)),
    ADD CONSTRAINT canvases_deletion_receipt_unique UNIQUE (deletion_receipt_id);
```

Update the Drizzle schema and run `bun --cwd server run db:generate -- --name canvas-document-mode` so `0005_canvas_document_mode.sql`, the journal, and snapshot are generated together. Review the generated order: add the columns first; in the same migration transaction temporarily set Canvas `NO FORCE ROW LEVEL SECURITY`, backfill `gen_random_uuid()` only for pre-release rows already having `deleted_at`, assert the affected count equals the pre-count and no deletion-state mismatch remains, then restore `FORCE ROW LEVEL SECURITY` before adding the coherence/unique constraints. Transaction rollback restores the original FORCE state on any failure. The final schema has `document_mode`, nullable unique `deletion_receipt_id uuid`, and a CHECK requiring `deleted_at` and the receipt to be either both null or both non-null.

Maintenance receives no Canvas privilege in Gate 0, so `document_mode` does not expand its allowlist. Contracts include `documentMode` in `CanvasSchema` and `CanvasSummarySchema`, but neither `CreateCanvasBodySchema` nor `SaveCanvasRequestSchema` contains it; `additionalProperties: false` rejects attempts to mutate it. The DELETE response alone exposes `deletionReceipt`; normal Canvas summaries/details never do.

- [ ] **Step 4: Lock and validate save state in the fixed order**

`saveCanvas(tx, access, canvasId, input)` first selects the visible row with `workspace_id`, `deleted_at`, `document_mode`, and `revision` `FOR UPDATE`. It throws:

1. `404 canvas_not_found` when invisible, missing, or deleted;
2. `409 canvas_document_mode_mismatch` when mode is not `snapshot`;
3. `409 revision_conflict` when `revision !== baseRevision`, including input `Number.MAX_SAFE_INTEGER` against a lower stored revision;
4. `409 canvas_revision_limit_reached` only when stored revision and `baseRevision` are both `Number.MAX_SAFE_INTEGER`.

Only then update with an explicit `WHERE id = ? AND workspace_id = ? AND document_mode = 'snapshot' AND revision = ? AND deleted_at IS NULL`, increment revision, and return the row. If that update returns zero rows after the locked checks succeeded, throw `canvas_save_invariant_failed` as a 500, roll back, and emit a structured error containing request ID, Canvas ID, Workspace ID, and expected revision; never re-query and guess a user-facing 409. Create always writes `document_mode = 'snapshot'` explicitly.

`deleteCanvas` runs under the same tenant authorization, locks by `id + workspace_id` even when already soft-deleted, and maps an invisible row to ordinary `canvas_not_found`. For an active row it generates one UUID and writes `deleted_at` plus `deletion_receipt_id` in one conditional update; for an already deleted row it returns the stored values. A zero-row update after the lock is an internal invariant failure, not a guessed 404. No GET/LIST path can serialize `deletionReceipt`.

- [ ] **Step 5: Run Canvas and tenant-isolation tests to verify GREEN**

Run:

```bash
bun --cwd server run test -- test/canvases/schema.test.ts test/canvases/routes.test.ts test/database/tenant-isolation.test.ts
```

Expected: PASS; mode is immutable through normal APIs, stable error ordering holds, safe-integer precedence is exact, concurrent revision behavior remains linearizable, and DELETE receipt replay is durable and cannot be inferred from a normal 404.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/canvases.ts server
git commit -m "feat: lock Canvas snapshot mode and deletion receipt"
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
- Modify: `docs/content/docs/progress/meta.json`
- Modify: `docs/content/docs/progress/meta.zh-CN.json`
- Modify: `docs/index.md`

**Interfaces:**
- Consumes: test evidence from Tasks 1-6 and the final task review ledger.
- Produces: a user-testable record without claiming native IndexedDB CAS, browser verification, or full Gate 0 completion.

- [ ] **Step 1: Record the user-visible backend correction**

Add one `Unreleased` entry:

```md
- [调整] 后端改为独立数据库角色、业务自有 Workspace 与事务级 RLS 隔离，并固定画布 snapshot 文档模式。
```

- [ ] **Step 2: Move only completed backend items to pending-test**

The pending-test documents must list exact checks: registration verification and explicit repair converge on one personal Workspace; team member/invitation operations no longer use Better Auth Organization; cross-Workspace access is denied; owner/admin Workspace lifecycle transitions follow the matrix; Canvas reports `documentMode: snapshot`; wrong mode and stale revision return distinct 409 codes; DELETE returns a stable receipt on replay while ordinary 404 never does. The todo documents must retain native IndexedDB CAS, three-browser evidence, user typecheck, Billing, Asset, and AI Task work.

- [ ] **Step 3: Create the verification record**

`gate-0-backend-verification.mdx` records exact focused commands, commit ranges, role names, command/column grants, policy tables, lifecycle matrix, repair evidence, deletion-receipt evidence, and whether each automated result passed. Add the page to both progress metadata files and `docs/index.md` so it is navigable. It explicitly states: `Gate 0 尚未关闭：原生 IndexedDB CAS、Chrome/Firefox/Safari 矩阵和用户 typecheck 证据仍待完成。`

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

- **Spec coverage:** Gate 0 backend ordering is fully mapped: role credentials/test connections and existing-object ownership adoption (Task 1); Organization removal, complete snake_case Workspace conversion, final constraints, and same-transaction service signatures (Task 2); transaction context, immutable audit/control tables, and admin binding (Task 3); explicit grants, RLS, user-only Workspace listing, and the owner/admin lifecycle matrix (Task 4); read-only GET plus audited explicit provisioning repair (Task 5); and `document_mode`, exact safe-integer ordering, and durable deletion receipts (Task 6). Native IndexedDB CAS is intentionally excluded into its own spec/plan; Billing, Assets, AI Tasks, and collaboration remain later gates.
- **Placeholder scan:** the plan contains no unresolved marker, generic error-handling step, or unnamed test. Every task names files, interfaces, focused commands, expected failures, and expected passing behavior.
- **Type consistency:** `DatabaseLoginRole`, `DatabaseConfig`, `DatabaseHandle.role`, `AppTransaction`, `WorkspaceAccess`, and the four transaction entrypoints are introduced before consumers. Workspace schema exports move once in Task 2; Tasks 3-6 consume only that final location.
- **Migration consistency:** fixed filenames `0002`, `0003`, `0004`, and `0005` are journaled in order and no later task edits an already-reviewed migration. Schema-changing `0002`, `0003`, and `0005` are generated from the final Drizzle schema and retain snapshots; policy-only `0004` is registered with `drizzle-kit generate --custom` and intentionally has no fabricated snapshot. All tests execute the journaled Drizzle migrator as `schema_owner`; no lexical SQL loader remains. Task 1 establishes roles before any migration references them; Task 2 removes Organization before renamed columns are consumed; Task 3 creates helpers before Task 4 policies call them; Task 6 changes Canvas without expanding the Gate 0 Maintenance allowlist.
- **Failure-path consistency:** missing grants (`42501`) are tested separately from successful empty RLS results; `set_config` is never asserted to be authorization; verification callback failure converges through an explicit verified-user repair path; ordinary Canvas 404 responses never become deletion proof; status audits are written before the final deactivation update.
- **Deployability consistency:** Tasks 1-4 have one implementer, one review boundary, and one commit only after final routes, grants, policies, and module boundaries are green. No intermediate broad-grant, missing-grant, moved-schema/old-route, or two-connection authorization state is published.
- **Upgrade consistency:** the real immutable `0000/0001` history is applied as a legacy owner, adopted by a deployment administrator, and continued as `schema_owner`; fresh install and upgrade are independent test paths, and FORCE-RLS fixture mutations use only the isolated container administrator.
