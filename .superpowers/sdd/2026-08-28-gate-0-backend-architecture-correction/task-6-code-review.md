# Task 6 fixed-commit adversarial code review

- Range: `47be7a2ac5fb0216757dea837500e6d40eecf6a9..6b58d4138ef9985d5446cea114db2b9eb71d10fc`
- Commit count: exactly 1 (`feat: lock Canvas snapshot mode and deletion receipt`)
- Review package integrity: the embedded diff and actual `git diff --unified=10` both hash to `1534653ecc340f6489fee27c3d781f1eb44e85cbcb79c010802d56f36ee4dcde`.
- Requirement value: **accepted**. A persisted read-only document mode, revision-locked saves, and durable deletion proof are necessary Gate 0 foundations.
- Implementation quality: **not accepted for Task 7**. The main save/migration happy paths are well structured, but one database-level receipt-integrity defect, one production invariant-reporting defect, and two Important test gaps remain.

## Verdict

**NOT APPROVED for Task 7.**

No Critical finding was found. Four Important findings must be closed before Task 7. The full suite being green does not change this verdict because the missing fault/data-transition cases are exactly where the defects remain hidden.

## Important findings

### Important — `app_api` can rewrite an already-issued deletion receipt and deletion timestamp

**Files and lines**

- `server/migrations/0004_tenant-rls.sql:46,250-253`
- `server/migrations/0006_canvas_document_mode.sql:27`
- `server/src/modules/canvases/schema.ts:42-47`
- `server/src/modules/canvases/service.ts:215-220`
- `server/test/database/tenant-isolation.test.ts:430-450`

**Concrete reproduced scenario**

On a fresh PostgreSQL 18 database, I connected as the real `app_api`, set valid transaction-local user/Workspace context for an active owner, and executed the intended first transition:

```sql
UPDATE public.canvases
SET deleted_at = now(), deletion_receipt_id = gen_random_uuid()
WHERE id = $1
RETURNING deletion_receipt_id, deleted_at;
```

It succeeded, as the service requires. In the same real-role transaction, a second UPDATE on the now-deleted row also succeeded:

```sql
UPDATE public.canvases
SET deletion_receipt_id = gen_random_uuid(),
    deleted_at = deleted_at + interval '1 second'
WHERE id = $1
RETURNING deletion_receipt_id, deleted_at;
```

The persisted receipt changed from `cdfd23c7-2e70-4996-b37d-7548458fd21d` to `b127dec2-6d8d-46fb-a522-51eff706203b`, and `deleted_at` changed too. The existing CHECK only requires both values to be null or both non-null; the permissive UPDATE policy checks tenant membership/context but not the old-to-new deletion transition. The same grants and predicate also contain no rule preventing both fields from being cleared together. Therefore byte-identical replay is a TypeScript calling convention, not a database invariant. A future buggy `app_api` SQL path or SQL-injection primitive within an authorized tenant could invalidate a previously issued receipt or resurrect the row.

For comparison, direct `app_api` UPDATE of `document_mode` and `workspace_id` reproduced SQLSTATE `42501`, and setting only `deletion_receipt_id` on an active row reproduced `23514`. The hole is specifically the allowed pair after the first transition.

**Why current tests do not catch it**

`routes.test.ts:355-438,561-588,784-830` only calls `deleteCanvas`, whose SQL has `deleted_at IS NULL`, so it never attempts a post-delete mutation. The grant test merely asserts that `deletion_receipt_id` is writable, and the schema test only checks uniqueness/coherence; neither verifies null→non-null as the sole allowed transition or immutability after issuance.

**Focused fix**

Make receipt generation and immutability a database invariant. The strongest narrow fix is a schema-owner trigger that generates `deletion_receipt_id` when `deleted_at` first changes from null to non-null, rejects any later change/clear of either field, and allows ordinary non-deletion Canvas updates. Then remove `deletion_receipt_id` from the `app_api` UPDATE allowlist and from service SET input; return the trigger-generated value through `UPDATE ... RETURNING`. Freeze real-role tests proving first transition succeeds, receipt/timestamp rewrite and pair-clear fail, replay stays byte-identical, and `document_mode`/`workspace_id` remain denied. Because 0006 is not approved yet, amend its final migration artifacts consistently; do not edit 0000-0005.

### Important — DELETE loses the required structured invariant diagnostics and uses the generic error protocol

**Files and lines**

- `server/src/modules/canvases/service.ts:199-250`
- `server/src/modules/canvases/routes.ts:116-136,140-154`
- `server/src/error-handler.ts:35-36`
- `server/test/canvases/routes.test.ts:711-831`

**Concrete reproduced scenario**

I installed a disposable `BEFORE UPDATE ... RETURN NULL` trigger after the DELETE had successfully locked an active Canvas. `deleteCanvas` reached its zero-row branch at `service.ts:250`, threw `CanvasSaveInvariantError(canvasId, workspaceId, -1)`, and the transaction correctly rolled back with `deleted_at` and `deletion_receipt_id` still null. Unlike PUT, however, DELETE has no catch/mapping block. The real HTTP result was:

```json
{
  "error": {
    "code": "internal_error",
    "message": "服务内部错误，请稍后重试",
    "retryable": true,
    "requestId": "req-7"
  }
}
```

Its only log fields were `requestId`, `kind: "unhandled_error"`, and `msg`; `canvasId`, `workspaceId`, the operation/error object, and useful invariant diagnostics were absent. The equivalent forced save returned the intended non-retryable `canvas_save_invariant_failed` and logged `requestId`, `canvasId`, `workspaceId`, `expectedRevision`, and the serialized error. Thus rollback/sanitization work, but DELETE violates the required diagnosable internal-invariant protocol and the implementer report's invariant claim.

**Why current tests do not catch it**

There is no trigger/fault test or logger spy in `routes.test.ts`; searching the tests finds no reference to `CanvasSaveInvariantError` or `canvas_save_invariant_failed`. The new tests cover only normal mode/receipt paths. Consequently the implementer report at `task-6-implementer-report.md:97` claims a behavior that was not tested and is false for DELETE.

**Focused fix**

Use a distinct delete invariant error (or a shared error carrying an explicit operation) with meaningful Canvas/Workspace diagnostics instead of `expectedRevision = -1`. Catch it outside `withTenantTransaction`, log the structured fields plus `err`, and map it to an approved stable, sanitized, non-generic 500 code. Add deterministic `BEFORE UPDATE RETURN NULL` tests for both PUT and DELETE that assert rollback, exact response envelope, and captured structured log fields.

### Important — Migration tests never exercise legacy Canvas backfill or transactional failure recovery

**Files and lines**

- `server/migrations/0006_canvas_document_mode.sql:1-27`
- `server/test/database/migration-upgrade.test.ts:135-234,237-274,277-338`
- `server/test/canvases/schema.test.ts:199-218`
- Pinned migrator transaction: `node_modules/.bun/drizzle-orm@0.45.2+e3d16f08e2206e90/node_modules/drizzle-orm/pg-core/dialect.js:60-71`

**Concrete reproduced scenario**

I applied 0000-0005, seeded two already-deleted Canvases and one active Canvas, and installed a trigger that raises `P0001` during the 0006 backfill. Running the exact journaled migration through pinned Drizzle failed between `NO FORCE` and the explicit `FORCE`. PostgreSQL correctly rolled the transaction back: FORCE remained true, both new columns were absent, and migration history still ended at 0005. After removing the fault and retrying, both deleted rows retained their original timestamps and received distinct non-null UUID receipts; the active row had `document_mode = 'snapshot'` and a null receipt.

That verifies the current migration and pinned migrator are safe, but none of it is encoded in the repository suite. The fresh-install test migrates an empty schema. The legacy-owner fixture creates Workspace/member/invitation rows but no active or deleted Canvas before upgrading. The snapshot and Drizzle-schema tests inspect declarations, not migrated data or rollback state.

**Why current tests do not catch it**

A wrong backfill predicate, omitted receipt uniqueness, a moved/missing FORCE statement, non-transactional migration runner change, or a failure that leaves a partial schema could all escape the current empty-data/snapshot assertions. The planned `canvases_deletion_receipt_unique` absence/presence assertion is also missing from `migration-upgrade.test.ts:213-233`; it is checked only against the TypeScript schema config.

**Focused fix**

Extend the real PostgreSQL migration suite to stop at 0005, seed active plus multiple soft-deleted Canvases, then apply exact 0006 through the pinned migrator and verify defaults, preserved timestamps, distinct receipts, all three catalog constraints, FORCE RLS, grants, ownership, and history. Add a second exact-migrator case with a preinstalled raising trigger during backfill; assert columns/receipts/history/relforcerowsecurity all roll back, remove the trigger, retry, and assert clean success.

### Important — The committed behavior suite does not prove the required authorization and lock-race matrix

**Files and lines**

- `.superpowers/sdd/2026-08-28-gate-0-backend-architecture-correction/task-6-brief.md:40-44,104-113`
- `.superpowers/sdd/2026-08-28-gate-0-backend-architecture-correction/task-6-implementer-report.md:49-58`
- `server/test/canvases/routes.test.ts:527-642,745-831`
- `server/test/platform-admin/workspace-lifecycle.test.ts:194-230`

**Concrete failure scenario**

The receipt test covers an outsider who was never a member, a missing ID, and ordinary GET/LIST. It never calls DELETE after a member is removed or after the Workspace becomes suspended/deactivated, and it has no database/network fault path. A regression that moved `requireActiveWorkspace` after the deletion write could therefore issue a valid local-tombstone receipt to an inactive Workspace while every current assertion stayed green. I independently exercised the current code and observed the safe behavior—removed member `403`, suspended/deactivated `409`, and an injected after-update failure `500` with the row/receipt rolled back—but these protections have no committed regression.

The three concurrency tests start requests with `Promise.all` and use no barrier, lock-wait observation, or trigger. They can pass when the requests happen sequentially and the mixed save/delete test accepts either order, so they do not prove that both lock orderings were actually exercised. The implementer report also states that both post-migration ordering tests were immediately green, and the promised zero-row logger-spy test was never added.

**Why current tests do not catch it**

`platform-admin/workspace-lifecycle.test.ts:194-230` checks inactive Canvas GET/create, not DELETE or receipt exposure. `routes.test.ts:527-642` proves acceptable final outcomes but not overlap or lock waiting. No test deterministically pauses one request after `FOR UPDATE`, verifies the second waits, and releases each ordering.

**Focused fix**

Add real `app_api` route tests for removed-member, suspended, deactivated, missing, and injected transaction-failure DELETE paths, asserting no receipt in the response and no committed deletion state. Replace scheduler-dependent races with disposable trigger/advisory-lock barriers and `pg_stat_activity` polling that force save-first/delete-first and delete/delete overlap; assert the losing/waiting operation, exact responses, one persisted receipt, and final row all match a legal serialization. Ensure cleanup is in `finally` and prove readiness/test isolation recovers.

## Minor findings

### Minor — The ignored Task 6 brief still contains the superseded hyphenated generator command

**Files and lines**

- `.superpowers/sdd/2026-08-28-gate-0-backend-architecture-correction/task-6-brief.md:83`
- `docs/superpowers/plans/2026-08-28-gate-0-backend-architecture-correction.md:831`
- `.superpowers/sdd/2026-08-28-gate-0-backend-architecture-correction/task-6-implementer-report.md:8-12`

**Concrete failure scenario**

The tracked plan was correctly changed to `--name canvas_document_mode`, and the actual SQL/journal tag use underscores. The ignored brief still says `--name canvas-document-mode`, which pinned Drizzle preserves as a hyphenated tag. A later audit treating the brief as the Task 6 execution record will see a command that cannot have produced the committed canonical artifact.

**Why current tests do not catch it**

The brief is ignored and is neither compared with the corrected plan nor consumed by migration tests.

**Focused fix**

Regenerate the ignored Task 6 brief from the corrected Task 6 plan section. Do not rename or regenerate the committed migration merely to fit the stale brief.

### Minor — The pre-existing server strict TypeScript gate remains red

**Files and lines**

- `server/src/error-handler.ts:22,30`
- `server/test/database/transactions.test.ts:132,151,178,203,215,666`
- `server/test/helpers/postgres.ts:49`

**Concrete failure scenario**

`tsc -p server/tsconfig.json --noEmit` exits 2 with the same 12 strict errors carried from prior approved reviews. No Task 6 changed file introduced an additional error, but a CI typecheck gate still fails.

**Why current tests do not catch it**

Vitest transpiles TypeScript without enforcing the complete strict checker.

**Focused fix**

Narrow unknown Fastify errors, guard query result rows, and wrap Testcontainers `stop()` to return `Promise<void>` in a separate cleanup change.

## Verified non-findings and evidence

### Migration lineage and final catalog

- HEAD resolves to `6b58d4138ef9985d5446cea114db2b9eb71d10fc`; BASE..HEAD contains exactly one commit.
- Fixed-range comparison shows no change to 0000-0005 SQL or snapshots. Journal index 6 is canonically `0006_canvas_document_mode`, and `snapshot6.prevId === snapshot5.id`.
- Normalized snapshot comparison shows every non-Canvas object equal between 0005 and 0006. The only Canvas additions are the two columns, two CHECKs, and one unique constraint.
- The real catalog has `document_mode text NOT NULL DEFAULT 'snapshot'`, nullable UUID `deletion_receipt_id`, exact mode/coherence/unique constraints, owner `schema_owner`, ENABLE + FORCE RLS, and `schema_owner.rolbypassrls = false`.
- Pinned Drizzle executes all pending migration statements and history INSERTs inside one transaction. The migration's ACCESS EXCLUSIVE table lock is retained to transaction end, so runtime sessions cannot observe a committed `NO FORCE` interval. Independent fault injection confirmed rollback and retry behavior.

### Runtime grants, contracts, services, and isolation

- Real catalog checks showed `app_api` UPDATE denied on `document_mode` and `workspace_id`, allowed on `deletion_receipt_id` as currently designed, and Worker/Maintenance denied on all three. Readiness inspection returned no violations for all runtime roles.
- A direct schema-owner UPDATE without tenant context affected zero rows, confirming FORCE RLS outside migration.
- Create/save bodies are strict and omit `documentMode`; response schemas include only `snapshot | collaborative`; normal Canvas responses do not contain receipts; DELETE alone returns the receipt contract.
- `saveCanvas` locks `id + workspace_id`, checks missing/deleted → mode → revision → limit, uses the complete conditional UPDATE predicate, and returns `UPDATE ... RETURNING` as authority. Independent trigger suppression confirmed its custom 500/log path and rollback.
- Normal route tests confirm one same-base save winner, idempotent same-receipt deletion, and no resurrection in a save/delete race. Code inspection confirms all three operations lock the same Canvas row.
- Missing/cross-tenant/deleted behavior does not leak mode or receipt. Independent negative probes confirmed removed/inactive/fault paths currently do not commit or return a receipt.
- Task 1-5 code outside the intended readiness change is untouched; the full suite includes role readiness, migration 0005 provisioning, module boundaries, Workspace lifecycle, invitation, and tenant isolation regressions.

## Verification results

```text
Full server suite:              17 files passed, 300 tests passed
Module-boundary check:          ok
Drizzle metadata check:         Everything's fine
Review-package diff hash:       exact match
git diff --check:               exit 0
Migration fault probe:          P0001; full rollback; clean retry/backfill
Direct app_api receipt rewrite: succeeded and changed receipt/timestamp (Important)
Direct mode/workspace updates:  SQLSTATE 42501
Receipt-only active update:     SQLSTATE 23514
schema_owner no-context update: 0 rows under FORCE RLS
Runtime role inspections:       app_api/worker/maintenance all clean
Save invariant probe:           structured custom 500; rollback
Delete invariant probe:         generic unstructured 500; rollback (Important)
Server strict typecheck:        exit 2, same 12 pre-existing errors
```

The repository tests use PostgreSQL 18, journaled migrations, real runtime login roles, production routes/services, and real transaction boundaries. Their green results are meaningful for covered behavior, but they do not cover the Important cases above.

## Follow-up adversarial review after repair

The original findings above are retained as the historical fixed-commit review. Two independent read-only `gpt-5.6-sol` xhigh follow-up passes then reviewed `47be7a2..HEAD` plus the tracked repair diff:

1. The first follow-up confirmed the four original Important findings were substantially repaired, but found two remaining Important gaps: `app_api` could forge a coherent receipt pair during INSERT, and physical CHECK/UNIQUE behavior was not executed against PostgreSQL.
2. The repair extended the database trigger to `BEFORE INSERT OR UPDATE`, rejects any INSERT-supplied lifecycle state, and added real-role regression coverage. Migration tests now independently execute both incoherent CHECK failures (`23514`), invalid mode (`23514`), and duplicate non-null receipt (`23505`).
3. The second follow-up returned **APPROVE**, with **Critical: 0** and **Important: 0**. Its only Minor identified imprecise snapshot metadata negation; that test was tightened to assert each 0005 absence separately and the exact 0006 unique-constraint metadata.

Final follow-up evidence:

```text
Focused Task 6 suite: 4 files passed, 104 tests passed
Full server suite:    17 files passed, 317 tests passed
Module boundaries:    ok
Critical remaining:   0
Important remaining:  0
```
