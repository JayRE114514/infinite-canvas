# Task 6 Implementer Report

## Commit boundary

- Branch: `design/backend-architecture`
- Base: `47be7a2ac5fb0216757dea837500e6d40eecf6a9`
- Commit policy: Task 6 remains exactly one commit after the base; the existing commit is amended after review.
- Historical migrations: `0000`–`0005` were not modified.

## Review repair summary

The fixed-commit adversarial review found four Important gaps. This repair closes them as follows:

1. **Database-owned deletion receipt.** `0006_canvas_document_mode.sql` installs a `schema_owner`-owned, fixed-search-path, `SECURITY INVOKER` `BEFORE INSERT OR UPDATE` trigger. Runtime INSERT cannot supply deletion lifecycle fields; the database generates the receipt only on the first `deleted_at: NULL -> NOT NULL` transition. Once issued, direct DML cannot alter the timestamp or receipt while the trigger remains enabled. `PUBLIC` and all runtime roles have no direct function EXECUTE, and `app_api` has no UPDATE on `deletion_receipt_id`.
2. **Delete invariant protocol.** `CanvasDeleteInvariantError` carries Canvas, Workspace and reason diagnostics. DELETE catches it outside the transaction, logs `requestId/canvasId/workspaceId/reason/err`, and returns sanitized non-retryable `canvas_delete_invariant_failed` without serializing the internal error.
3. **Real 0005→0006 migration coverage.** Tests stop at 0005, seed one active and two deleted Canvases, execute the exact pending migration through the pinned Drizzle migrator, and verify backfill, timestamps, distinct receipts, constraints, trigger owner/security/ACL, FORCE RLS, grants and migration history. Physical PostgreSQL tests independently prove both incoherent deletion states and an invalid mode fail with `23514`, while a duplicate non-null receipt fails with `23505`. A raising pre-0006 trigger injects a mid-backfill failure; the test proves columns and migration history roll back, FORCE remains enabled, data is preserved, and retry succeeds.
4. **Deterministic authorization/fault/race matrix.** Route tests cover removed members, suspended/deactivated Workspaces, missing/cross-tenant resources, post-update failure rollback, and forced save/delete zero-row invariant failures. Advisory-lock trigger barriers plus `pg_stat_activity` observations force save-first, delete-first and delete/delete overlap; no ordering relies on `Promise.all` scheduling.

The Task 6 brief now uses the canonical underscore command:

```text
bun --cwd server run db:generate -- --name canvas_document_mode
```

## Files changed by Task 6 and this repair

| File | Change |
|---|---|
| `server/migrations/0006_canvas_document_mode.sql` | Columns/backfill/constraints plus database-issued immutable deletion receipt trigger and minimal ACL |
| `server/migrations/meta/0006_snapshot.json` | Generated Canvas schema snapshot |
| `server/migrations/meta/_journal.json` | Canonical index-6 journal entry |
| `packages/contracts/src/canvases.ts` | Read-only document mode and DELETE receipt contract |
| `server/src/modules/canvases/schema.ts` | Canvas mode/receipt columns and constraints |
| `server/src/modules/canvases/service.ts` | Locked save ordering, trigger-authoritative delete, save/delete invariant errors |
| `server/src/modules/canvases/routes.ts` | Stable sanitized invariant responses and structured logging outside transactions |
| `server/src/infrastructure/database/role-assertions.ts` | Receipt column removed from the `app_api` writable allowlist |
| `server/test/canvases/schema.test.ts` | Read-only contract and physical schema declarations |
| `server/test/canvases/routes.test.ts` | Authorization, rollback, invariant logging and deterministic lock-order matrix |
| `server/test/database/migration-upgrade.test.ts` | Populated 0005→0006 upgrade, transactional fault rollback and retry |
| `server/test/database/tenant-isolation.test.ts` | Real-role grants plus receipt issuer/immutability/owner/ACL/FORCE-RLS tests |
| `server/test/helpers/auth.ts` | Optional test logger injection for structured route-log assertions |
| `docs/superpowers/plans/2026-08-28-gate-0-backend-architecture-correction.md` | Canonical migration command |
| `.superpowers/sdd/.../task-6-brief.md` | Canonical migration command in the execution brief |
| `.superpowers/sdd/.../task-6-code-review.md` | Historical findings plus final independent follow-up verdict/evidence |
| `.superpowers/sdd/.../task-6-implementer-report.md` | Audited implementation, verification and residual-risk record |

## Defect reproduction and regression evidence

The independent review reproduced the original fixed commit before repair:

- real `app_api` could rewrite both an issued receipt and `deleted_at`;
- forced DELETE zero-row update returned generic retryable `internal_error` and omitted Canvas/Workspace diagnostics;
- populated backfill rollback and deterministic overlap were not represented in the committed suite.

The inherited interrupted draft already contained part of the A/B production fix, so this continuation does not falsely claim that every new test preceded those inherited lines. It audited that draft, removed duplicate coverage, tightened expected SQLSTATEs, added the missing B–D tests, and ran the complete regression matrix. The first deterministic barrier run exposed a test-observation defect: the second request waits in `SELECT ... FOR UPDATE`, not in `UPDATE`; the `pg_stat_activity` predicate was corrected to observe both statements before any green claim.

The first independent follow-up review then found that table-level INSERT still allowed a coherent forged deletion pair and that constraint names alone did not prove physical behavior. Both were reproduced and closed. A second independent `gpt-5.6-sol` xhigh pass returned **APPROVE** with zero Critical and zero Important findings. Its sole metadata-test Minor was also fixed before final verification.

## Verification evidence

Commands were run through repository-local binaries because `bun` is not installed in the execution environment. No Web build, Web typecheck or browser session was run.

```text
server/node_modules/.bin/vitest run test/database/tenant-isolation.test.ts
  -> 1 file passed, 49 tests passed

server/node_modules/.bin/vitest run test/canvases/schema.test.ts \
  test/canvases/routes.test.ts \
  test/database/migration-upgrade.test.ts \
  test/database/tenant-isolation.test.ts
  -> 4 files passed, 104 tests passed

server/node_modules/.bin/vitest run
  -> 17 files passed, 317 tests passed

server/node_modules/.bin/tsx scripts/check-module-boundaries.ts src
  -> module boundaries: ok
```

All database evidence uses PostgreSQL 18. Runtime authorization, receipt issuance and forbidden mutation assertions use the real `app_api` login. The isolated container administrator is limited to fixture arrangement, explicit physical-constraint isolation, and privileged direct-DML trigger probes; a superuser can alter/disable a trigger and is not claimed to be constrained by runtime ACLs. The deterministic overlap tests explicitly observe the first request waiting on an advisory lock and the second waiting on the held Canvas row lock before releasing the barrier.

## Residual risks and Minors

- The pre-existing strict server TypeScript gate had 12 known errors before this Task 6 repair (`error-handler.ts`, `transactions.test.ts`, `helpers/postgres.ts`). Per task scope and project instructions it was not repaired or rerun here; Vitest transpilation does not close that separate Minor.
- The local executable is Node.js `v22.23.2`, while the approved production baseline is Node.js 24 LTS. PostgreSQL/route behavior is covered, but the same suite must also run in the Node 24 release environment before production acceptance.
- Native IndexedDB CAS, browser matrices and user-owned Web typecheck remain outside backend Task 6 and therefore Gate 0 is not yet closed.
- No Web build/typecheck/browser evidence and no production deployment evidence is claimed.
