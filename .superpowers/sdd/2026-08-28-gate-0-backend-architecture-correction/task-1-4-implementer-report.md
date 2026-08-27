# Atomic Tasks 1–4 implementer report

## Revision scope

- BASE: `2d78c2427c950f819118f6068ff99fc9910fb4b4`
- Initial implementation commit reviewed: `d6fd0f90dce8401c19c410b141c32c8cafa48609`.
- Updated-review baseline independently reproduced: `802d8bdfabec8ad2043d3adad868eba3aa4c7e5f`.
- Latest-review baseline independently reproduced: `d4f7c0ca2157b1f800461f07971feef17e1f4b60`.
- Effective-column/admin-first review baseline independently reproduced: `0cdfc17f90a6637f6d8e5d51d1297cbcb212f74a`.
- Final HEAD: the single commit containing this report, with subject `feat: establish transaction-scoped PostgreSQL tenant security`. Its SHA is necessarily recorded in the handoff after Git creates the commit; a commit cannot embed its own SHA.
- Worktree/branch: `/home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture`, `design/backend-architecture`.

## Interruption audit

The prior provider-level failure left no report, no commit, and no recoverable RED transcript. I treated every uncommitted file as untrusted, read the approved spec/plan, all four task briefs, `ledger.md`, `AGENTS.md`, and audited the complete tracked/untracked diff against BASE before preserving any partial work.

The partial state contained migrations `0002`–`0004`, schema/service drafts, and some database tests, but the route cutover, composition-root wiring, browser token-body cutover, lifecycle coverage, exact snapshot assertions, and several RLS/grant tests were incomplete or failing. Correct fragments were retained; incomplete behavior was repaired against newly reproduced failures.

## Recreated RED evidence

Because the interrupted agent left no usable RED evidence, failures were freshly re-established before repair:

- Module-boundary command: 2 real violations (`better-auth` outside Identity and a private `identity/auth-schema` import).
- Transaction suite: 8 passing control tests and 6 unresolved `todo` tenant/worker cases.
- Tenant isolation suite: 23 tests with 2 failures, including API self-create under RLS; the Maintenance catalog assertion also used the wrong visibility path.
- Boundary/constraint checks: the executable boundary remained RED and four physical invitation/owner checks failed when FORCE-RLS behavior was incorrectly attributed to `schema_owner`.
- Route/application focused set: 44 failures and 24 passes while Organization-backed routes and the pre-journal migration harness were still active.
- A consolidated 68-test reconstruction produced 13 failures and 55 passes, covering deleted-at/status coherence, self-create RLS, exact role assertions, policy role parsing, and absent/blocked platform-admin routes.
- A dedicated runtime-role assertion failed because `DatabaseHandle` did not carry the expected `app_api` role.

No `todo`, `skip`, or `not_implemented` marker remains in the security paths.

## Independent review reproduction and remediation

Every Critical/Important finding was independently checked against a freshly migrated real PostgreSQL container before editing. The direct `app_api` probe established all reported semantics:

```text
invitationEscalation = [{ role: "admin" }]
unrestrictedWorkspaceTypeUpdate = [{ type: "personal" }]
inactivePersonalVisible = []
replacementInsertCode = "23505"
inactiveTenantEntry = { code: "workspace_forbidden", statusCode: 403 }
capacityCounts = { all_count: 3, active_count: 2 }
```

Focused public/negative tests were then written against the unchanged implementation. The first consolidated review RED run produced:

```text
./node_modules/.bin/vitest run \
  test/database/tenant-isolation.test.ts \
  test/database/roles.test.ts \
  test/database/migration-upgrade.test.ts \
  test/platform-admin/workspace-lifecycle.test.ts \
  test/workspaces/workspaces.test.ts

Test Files  5 failed (5)
Tests       18 failed | 64 passed (82)
```

The failures proved all five invitation metadata columns were writable, the complete self-invitation/cross-tenant admin chain inserted an `admin` membership, protected Workspace columns were writable, table/column/startup assertions accepted broad grants, an absent `drizzle` schema broke `0004`, inactive metadata returned 403, inactive personal listing returned 500, the personal unique violation was unmapped, and a removed member consumed capacity.

Review remediation:

1. `workspace_invitations` now has only `UPDATE (status)`. Manager RLS permits only `pending -> canceled`; a verified unexpired recipient can only perform `pending -> accepted/rejected`. Real-role tests deny rewrites of `workspace_id`, `role`, `email`, `expires_at`, and `token_digest`, exercise the complete escalation chain, and retain positive cancel/accept/reject controls.
2. `workspaces` now has only `UPDATE (name, slug, status, deleted_at, updated_at)`. `canvases` is likewise narrowed to its six service-owned mutable columns. Startup checks enumerate every application column for every runtime role and fail on both missing and extra `app_api` business UPDATE privileges.
3. Active members can read Workspace root metadata independent of Workspace lifecycle status, while active-status checks remain on Canvas/resources and ordinary mutations. Direct metadata and GET list stay 200 for suspended/deactivated personal and team Workspaces, healthy teams remain reachable, and no second personal row is attempted. The `workspaces_owner_personal_unique` violation maps to stable `409 personal_workspace_already_exists` when membership loss still hides the lifetime row.
4. Invitation capacity counts only active memberships; a real removed-member regression proves one of two concurrent candidates can occupy the final active slot.
5. The `drizzle` schema revoke is conditional, affected test SQL is parameterized, and the retained `has_accepted_workspace_invitation` function explicitly documents that Gate 0 has no caller. No Task 5 behavior was implemented.

The updated independent review then identified two coupled database-boundary defects in the reviewed commit: a nonmember platform administrator could use the direct Workspace RLS policy to perform a lifecycle UPDATE without an audit, and the same direct grant/policy path could smuggle `name` and `slug` changes into an otherwise authorized lifecycle UPDATE. Before editing, a fresh real-`app_api` probe reproduced both findings exactly:

```text
{"noAuditUpdate":[{"status":"suspended"}],"stored":[{"status":"suspended","operations":1,"audits":0}]}
{"smuggledUpdate":[{"name":"smuggled-name","slug":"smuggled-slug","status":"suspended"}],"stored":[{"name":"smuggled-name","slug":"smuggled-slug","status":"suspended","audits":1}]}
```

Focused negative/public tests were added before implementation. The first updated-review RED run was:

```text
./node_modules/.bin/vitest run \
  test/database/transactions.test.ts \
  test/database/tenant-isolation.test.ts \
  test/database/migration-upgrade.test.ts \
  test/platform-admin/workspace-lifecycle.test.ts

Test Files  3 failed | 1 passed (4)
Tests       11 failed | 66 passed (77)
```

Those failures covered direct nonmember SELECT/UPDATE, zero-audit lifecycle mutation, metadata smuggling, direct admin-audit insertion, the absent operation boundary and ACL/catalog rules, and the missing schema-level operation/audit uniqueness invariant. After the first implementation, audit fault injection was strengthened from an exception to a `BEFORE INSERT ... RETURN NULL` trigger. That produced a second deliberate RED result (`1 failed | 9 skipped`): the transition returned 200 even though PostgreSQL suppressed the audit row. The operation function was then changed to assert the audit INSERT row count is exactly one.

Updated-review remediation:

1. All nonmember platform-admin direct Workspace SELECT/UPDATE policies were removed. `app_api` now reaches that data only through zero-argument `public.execute_workspace_admin_operation()`.
2. The SECURITY DEFINER function has a fixed `search_path`, uses only fully qualified static SQL, and accepts no actor, target, purpose, or lifecycle arguments. It derives all three authorities from the active administrator operation bound to the same user and `xid`, and rejects unsupported purposes, wrong users, stale xids, and absent operation context.
3. Read or lifecycle mutation and exactly one immutable audit happen in one transaction. `workspace_audit_logs.operation_id` is unique in the Drizzle schema, migration `0003`, and snapshots `0003`/`0004`; duplicate execution fails closed. The function also checks the audit INSERT row count, so a suppressed insertion rolls the operation back.
4. FORCE RLS remains enabled on `workspace_audit_logs`. The former broad `app_api` admin policy was removed; `app_api` retains only the owner-deactivation audit path. A narrow `schema_owner` INSERT policy validates operation ID, actor, action, target, and current xid for the definer boundary.
5. The function writes only `status`, `deleted_at`, and `updated_at`. Direct raw attacks cannot read or update the nonmember Workspace, and lifecycle calls cannot alter `id`, `name`, `slug`, `type`, `owner_user_id`, or `created_at`. Tenant-manager rename, owner team deactivation, and all admin lifecycle routes remain covered positive controls.
6. Missing targets and invalid/final-conflict transitions raise dedicated database codes mapped to the existing stable 404/409 application errors. Because they abort the transaction, no operation, audit, or Workspace change commits.
7. The exact function ACL expands from seven to eight signatures solely for this cohesive operation boundary. Reverse enumeration, PUBLIC denial, worker/maintenance denial, zero-argument signature, SECURITY DEFINER, and fixed-search-path properties are all asserted.

The updated-review files are `AGENTS.md`, migrations `0003`/`0004`, snapshots `0003`/`0004`, platform-admin schema/service/routes, transaction documentation, role assertions, the four focused database/lifecycle tests, and this report. `_journal.json` remains unchanged because no compatibility migration or migration-order change was added.

The latest independent review identified two further Important gaps. Both were reproduced before permanent test or production edits with a disposable real-PostgreSQL probe, then the probe was removed:

```text
{"violations":[],"canvasRows":0}
{"waitState":"blocked","returned":[{"workspace_name":"before","workspace_status":"suspended"}],"committed":[{"name":"renamed-concurrently","status":"suspended"}]}
```

The first line proves the production inspector accepted an `app_api` credential after `GRANT TRUNCATE ON public.canvases`, while the same real role successfully truncated the table. The second proves the administrator blocked only at its final UPDATE, returned pre-rename metadata, and committed a different final row.

Permanent privilege-drift tests were written next and run against the unchanged inspector:

```text
./node_modules/.bin/vitest run test/database/roles.test.ts --reporter=verbose

Test Files  1 failed (1)
Tests       4 failed | 5 passed (9)
```

The four expected failures covered real API readiness under `app_api` TRUNCATE drift, the real Worker entrypoint under `app_worker` TRUNCATE drift, REFERENCES/TRIGGER drift, and injected public-sequence USAGE/SELECT/UPDATE drift. The lifecycle concurrency tests were then written against the unchanged database function:

Because the deployment target is PostgreSQL 18, a follow-up real-role mutation also granted its additional table privilege, `MAINTAIN`, to `app_worker`. The unchanged inspector missed it (`1 failed | 8 filtered`); this was added to the same closed table-privilege enumeration before the final GREEN run.

```text
./node_modules/.bin/vitest run test/platform-admin/workspace-lifecycle.test.ts --reporter=verbose

Test Files  1 failed (1)
Tests       1 failed | 11 passed (12)
```

The failing assertion showed the 200 response still contained the old Workspace name while the committed row contained the concurrent manager rename.

Latest-review remediation:

1. Readiness now reverse-enumerates every public table-like relation across PostgreSQL 18's complete table privilege set: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN. Unknown public relations and every privilege outside the explicit role/object matrix default deny. Existing per-column UPDATE allowlists remain independently enforced.
2. Readiness independently enumerates USAGE, SELECT, and UPDATE on every public sequence and requires all three to be false for `app_api`, `app_worker`, and `app_maintenance` in Gate 0. Tests inject each privilege across the three real roles, then revoke/drop the probe sequence and prove all inspections recover to clean.
3. Real-role drift tests grant TRUNCATE separately to `app_api` and `app_worker`. The former drives the production readiness route to 503; the latter makes the real `src/worker.ts` process exit before its startup marker. Revocation restores a 200 readiness response and successful Worker startup.
4. Lifecycle operations retain the Workspace-key advisory lock because it coordinates the existing invitation-capacity and owned-context protocols, then acquire `FOR UPDATE` on the actual Workspace row before reading status or response metadata. Read-only administrator operations do not take this row lock.
5. The final conditional lifecycle UPDATE keeps its status predicate and now uses `RETURNING workspace.* INTO v_workspace`. The function returns that actual candidate row and no longer hand-assembles lifecycle fields onto an earlier snapshot; zero-row conflict still raises `P4092` and rolls operation/audit back.
6. Two-connection `app_api` tests prove a manager rename commits before admin suspension proceeds and the admin response equals the entire committed row without overwriting the rename. A concurrent owner deactivation wins exactly once; the waiting admin sees the locked final state, returns stable `409 workspace_status_transition_invalid`, and commits no operation or admin audit.

This remediation changes only `server/src/infrastructure/database/role-assertions.ts`, migration `0003`, `server/test/database/roles.test.ts`, `server/test/platform-admin/workspace-lifecycle.test.ts`, and this report. Schema shape, snapshots, journal order, FORCE RLS, the narrow zero-argument definer boundary, and the exact eight-function ACL are unchanged. `AGENTS.md` is deliberately unchanged because its existing platform-admin database-boundary rule already covers the recurring principle; another entry would be redundant.

No required reviewer finding was rejected. The review's fourth Minor observation (`workspace_provisioning_audits` is not yet called) remains deliberately deferred because it belongs to Task 5, which this remediation was explicitly forbidden to implement.

The next independent review identified two additional Important gaps. Both were first reproduced against `0cdfc17` with a disposable two-test probe, before any production edit; the probe was removed immediately after evidence capture:

```text
{"apiViolations":[],"workerViolations":[],"readiness":200,"apiSecret":"tenant-secret","workerSecret":"tenant-secret","workerStarted":true}
{"adminStatus":200,"managerStatus":500,"managerCode":"internal_error","stored":[{"name":"before","status":"suspended","operations":1,"audits":1}]}

Test Files  1 passed (1)
Tests       2 passed (2)
```

The first line proves effective column-only SELECT grants on an unexpected public relation were usable by both real runtime roles while inspection, API readiness, and Worker startup all accepted the drift. The second proves an administrator could hold the Workspace row lock, allow a manager PATCH to queue behind it, commit suspension, and leave the manager with a generic 500 even though the admin operation/audit were correct.

Permanent tests were then added while production remained unchanged. Their deliberate RED runs were:

```text
./node_modules/.bin/vitest run test/database/roles.test.ts --reporter=verbose
Test Files  1 failed (1)
Tests       2 failed | 10 passed (12)

./node_modules/.bin/vitest run test/platform-admin/workspace-lifecycle.test.ts --reporter=verbose
Test Files  1 failed (1)
Tests       1 failed | 12 passed (13)
```

Effective-column/admin-first remediation:

1. Role readiness now enumerates `SELECT`, `INSERT`, `UPDATE`, and `REFERENCES` with `has_column_privilege` for every non-dropped user column of every public relation already covered by the table scan. This is an effective-permission check, so direct-role and `PUBLIC` column ACLs are both visible.
2. The column matrix is closed: unknown relations and `app_worker` are all false; allowed `app_api` table operations imply the matching effective privilege on every column; business UPDATE allowlists remain exact; and `app_maintenance` has only Workspace `id`/`status` SELECT. The separate `has_table_privilege` scan remains authoritative for table-level grants, and a regression proves granting every Workspace SELECT column cannot substitute for the required table grant.
3. Real-role tests cover all four column privilege kinds, all three runtime roles, known and unexpected relations, plus a `PUBLIC` grant. An unexpected SELECT grant now makes API readiness return 503 and the real Worker entrypoint exit before startup; revoking/dropping probes restores clean inspection, readiness 200, and Worker startup. Every probe relation is dropped in `finally`, and known-relation grants are independently revoked.
4. Tenant manager Workspace updates now issue `SELECT ... FOR UPDATE` before the authoritative active-state check and write. PostgreSQL rechecks UPDATE RLS after a blocked row changes; if an admin lifecycle commit makes that version ineligible for the manager policy, the completed lock query returns no row and the service performs a member-authorized status read in the same transaction. Only an observed inactive target maps to stable `409 workspace_inactive`; arbitrary `42501` errors are not remapped.
5. A deterministic two-connection/HTTP test blocks the admin audit only after the SECURITY DEFINER operation holds the Workspace row lock, queues a real manager PATCH, then releases the admin. Suspension wins with exactly one operation/audit, the rename is absent, and PATCH returns `409 workspace_inactive`. Existing manager-first rename and owner/admin lifecycle races remain positive controls.
6. The reviewer Minor was applied locally: the new race test no longer introduces `noUncheckedIndexedAccess`/overload errors. A server-only TypeScript diagnostic still reports only the pre-existing errors in unchanged `error-handler.ts`, `transactions.test.ts`, and `helpers/postgres.ts`; those unrelated baseline files were not edited. Task 5 remains out of scope.

This final review remediation changes only `server/src/infrastructure/database/role-assertions.ts`, `server/src/modules/workspaces/service.ts`, `server/test/database/roles.test.ts`, `server/test/platform-admin/workspace-lifecycle.test.ts`, and this report. It does not change migrations, snapshots, the exact eight-function ACL, FORCE RLS, the narrow definer function, invitation controls, or admin lifecycle semantics. No reviewer finding was rejected, and `AGENTS.md` remains unchanged because the existing database-boundary rule is sufficient and the two fixes do not add a new recurring project-wide instruction.

## Implemented files and behavior

- Role/bootstrap/configuration: `.env.example`, `server/database/bootstrap/*`, `server/src/config.ts`, database client/plugin/types/role assertions, Worker startup, Drizzle config, and role-aware test harnesses.
- Journaled schema history: `server/migrations/0002_workspace-authority.sql`, `0003_transaction-context.sql`, `0004_tenant-rls.sql`, snapshots `0002`–`0004`, and `_journal.json`. Immutable `0000`/`0001` hashes remain unchanged.
- Module ownership/contracts: public Identity and Workspaces schema entries, removal of Better Auth Organization production calls, strict token-body invitation acceptance, closed Workspace status/invitation-role contracts, and browser `/accept-invitation/:token` cutover.
- Transaction/security layer: `AppTransaction` services; user, tenant, worker, and platform-admin transaction entrypoints; branded owned-context adoption; exact role/grant assertions; default-deny RLS.
- Business cutover: Workspace and Canvas routes use one transaction boundary per request; platform-admin read/suspend/deactivate/restore and owner team deactivation are wired into the app; audits and operation IDs are transaction-bound.
- Tests: migration upgrade/fresh install, exact snapshots/journal, module boundaries, constraints, transactions, tenant isolation, role matrix, route regressions, and lifecycle/fault-injection coverage.
- Adjacent required regression correction: strict Fastify AJV coercion and finite Canvas JSON numbers, required to preserve numeric/boolean wire values in the complete planned Canvas route suite.

## Migrations, grants, policies, and ownership

- `0002` converts legacy Workspace tables in place, preserves IDs and UTC timestamps, removes Organization-only columns, normalizes/cancels legacy invitations, stores only 64-character token digests, adds closed checks/indexes/FKs, and installs deferred owner invariants.
- `0003` adds platform/admin/audit tables with `xid8`, restrictive FKs/checks, append-only mutation triggers, the unique operation-to-Workspace-audit invariant, and fixed-search-path SECURITY DEFINER control functions.
- `0004` revokes PUBLIC/runtime defaults before granting the closed matrix. `app_api` receives Better Auth DML; column-scoped UPDATE for Workspace, invitation, and Canvas lifecycle fields; only the owner-path audit INSERT; and eight signature-specific functions. `app_worker` receives no Gate 0 business table/function privilege. `app_maintenance` receives only `SELECT (id, status)` on `workspaces`.
- Runtime roles have `USAGE` but no `CREATE` on `public`, no `drizzle` access, no role memberships, no ownership, no superuser/BYPASSRLS, and no PUBLIC function execution.
- Runtime readiness fail-closes over all eight PostgreSQL 18 table privilege kinds and all four effective column privilege kinds on every user column of every public relation, plus all three sequence privilege kinds on every public sequence and the exact function ACL.
- `workspaces` and `workspace_members` are RLS-enabled authorization roots; `workspace_invitations`, `canvases`, and `workspace_audit_logs` are enabled and forced. Policies are command-specific and explicitly target `app_api`, `app_maintenance`, or the single narrow `schema_owner` audit INSERT. There is no direct nonmember admin Workspace policy; absent context and forged context default deny.
- Fresh install leaves all `public` and `drizzle` application/migration objects owned by `schema_owner`. The legacy upgrade adopts both schemas and objects while preserving the exact migration history rows and excluding extension-owned objects.

## Plan deviations and technical rulings

1. PostgreSQL row locking on an RLS table also requires matching UPDATE visibility. Owned-context adoption, invitation-capacity serialization, and personal provisioning therefore use transaction-scoped advisory locks over the opaque ID. The definer-owned admin lifecycle boundary retains that same advisory key to coordinate those protocols and additionally locks the actual Workspace row `FOR UPDATE`, serializing against manager rename and owner deactivation before reading lifecycle metadata. Manager rename now also takes the row lock before its authoritative status check; when a waiting statement is filtered by post-admin UPDATE-RLS recheck, an immediate member-visible metadata read distinguishes inactive status from forbidden access without weakening or globally translating database authorization errors. Final conditional writes still detect injected/exceptional zero-row conflicts atomically.
2. Current Tasks 1–4 GET-side personal provisioning uses advisory lock + select/insert rather than `ON CONFLICT DO NOTHING`, because the latter requires conflicting-row visibility under RLS. Task 5 remains the approved owner of final verification/repair provisioning behavior.
3. A schema-owner SECURITY DEFINER function cannot read a FORCE-RLS invitation table when policies target only `app_api`. Invitation acceptance policies therefore use caller-visible direct `EXISTS` predicates plus `is_current_verified_email`; `has_accepted_workspace_invitation` remains available for its fixed protocol contract.
4. Physical invitation constraint tests use the isolated container administrator for deliberate invalid writes because `schema_owner` is correctly subject to FORCE RLS on the leaf table. Runtime authorization observations still use only runtime-role connections.
5. No compatibility migration or legacy Organization redemption path was added; the project is pre-release as specified.
6. The approved seven-function ACL was expanded to exactly eight signatures. This is the smallest database-enforced correction for the reviewed gap: one cohesive, zero-argument Workspace admin operation boundary replaces four direct admin RLS policies and prevents TypeScript call ordering or caller-supplied authority from separating data access from its audit.

## Fresh GREEN evidence

```text
./node_modules/.bin/tsx scripts/check-module-boundaries.ts src
module boundaries: ok

DATABASE_URL_SCHEMA_OWNER=postgres://schema_owner:unused@localhost:5432/infinite_canvas \
  ./node_modules/.bin/drizzle-kit check --config drizzle.config.ts
Everything's fine

git diff --check 2d78c2427c950f819118f6068ff99fc9910fb4b4
exit 0
```

A fresh temporary local Drizzle generation was also normalized against the checked-in `0003_snapshot.json`; it matched exactly. Normalized `0004_snapshot.json` equals `0003_snapshot.json`, as required for the policy-only migration. The journal/snapshot regression independently verifies IDs, ancestry, exact timestamps/tags, columns, FKs, checks, and immutable `0000`/`0001` hashes.

Final planned atomic server suite:

```text
./node_modules/.bin/vitest run \
  test/database/roles.test.ts \
  test/database/migration-upgrade.test.ts \
  test/database/connection.test.ts \
  test/config.test.ts \
  test/app-runtime.test.ts \
  test/database/transactions.test.ts \
  test/database/tenant-isolation.test.ts \
  test/architecture/module-boundaries.test.ts \
  test/workspaces/constraints.test.ts \
  test/workspaces/workspaces.test.ts \
  test/identity/auth.test.ts \
  test/canvases/routes.test.ts \
  test/platform-admin/workspace-lifecycle.test.ts \
  --reporter=dot

Test Files  13 passed (13)
Tests       242 passed (242)
Duration    13.75s
```

Review-focused GREEN checkpoints were also recreated after remediation:

```text
first-review set: 5 files passed, 82 tests passed
updated-review focused set: 4 files passed, 78 tests passed
updated-review affected regressions: 7 files passed, 123 tests passed
latest-review role drift: 1 file passed, 9 tests passed
latest-review lifecycle: 1 file passed, 12 tests passed
latest-review affected regressions: 7 files passed, 134 tests passed
effective-column review: 1 file passed, 12 tests passed
admin-first lifecycle review: 1 file passed, 13 tests passed
final atomic suite: 13 files passed, 242 tests passed
inactive lifecycle confirmation: 1 file passed, 9 tests passed
module boundaries: ok
Drizzle check: Everything's fine
```

## Residual user-owned verification

Per instruction, no Web build, Web typecheck, or browser automation was run. The user still owns Web typechecking and browser verification of the token-link acceptance flow. An optional server-only `tsc --noEmit` run exposed 12 existing strictness errors in unchanged `error-handler.ts`, `transactions.test.ts`, and `helpers/postgres.ts`; no file changed by this remediation appeared in that output. No server typecheck success is claimed, and those unrelated errors were not changed. The planned atomic acceptance gate is the focused server suite above.

## Git status and staging boundary

Before the final amend, the tracked diff consists only of the original atomic implementation plus this report and the review-remediation files listed above. The pre-existing untracked `.superpowers/research/**`, review package, and code-review report were neither edited nor staged. Final staging remains restricted to the original intended atomic implementation, these review-remediation files, and this report. The post-amend status, exact commit count, and final SHA are recorded in the handoff because a commit cannot record its own SHA.
