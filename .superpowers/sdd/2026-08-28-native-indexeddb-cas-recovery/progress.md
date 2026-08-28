# SDD ledger — plan: docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md

## Identity

- Plan commit: `767035b90d60d5599b5b9aeed4c07dd3d5ba54a0`
- Authoritative spec: `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`
- Execution mode: sequential subagent-driven development; no parallel writers.
- Acceptance authority: Opus or Kimi only. Sol implementation self-tests are development evidence, never acceptance.
- Independent review cap: two rounds per task.

## Plan-review ruling

Plan final review cap reached after two independent rounds. The author applied the final C1/I2/M4 exact corrections without a third review. Implementation Task 1 RED/GREEN and task-level Opus/Kimi acceptance are the next executable evidence. If Task 1 or Task 6 surfaces a load-bearing plan defect, stop that task rather than layering compatibility patches. The plan is corrected and implementation-authorized; it is not recorded as independently approved.

## Preflight overlap and dependency table

| Task | Primary ownership | Shared boundary / dependency | Execution rule |
|---|---|---|---|
| 1 | `web/package.json`, `bun.lock`, Vitest config/setup, recovery `database.ts` | Produces the injected database and one-transaction runner used by all storage tasks | First; isolated harness and runner only |
| 2 | recovery `scope.ts`, `types.ts` and focused tests | Consumes only Task 1 failure type; produces scope, envelope and CAS outcome contracts | After Task 1 acceptance |
| 3 | recovery `store.ts` draft/open operations and tests | Shares the future `store.ts` with Task 4; consumes Tasks 1–2 | Task 4 must extend, not rewrite, Task 3 |
| 4 | recovery `store.ts` coordination/deletion/GC plus `bootstrap.ts` and tests | Extends Task 3 store; owns coordination and destructive storage semantics | After Task 3 acceptance |
| 5 | canvas API/repository/delete contracts and tests | Consumes existing backend `CanvasDeletionReceipt`; no storage implementation dependency | Kept sequential to preserve one-writer review history |
| 6 | sync types/session/manager and their tests | Load-bearing atomic consumer cutover; overlaps contracts introduced by Tasks 2–5 | No dual persistence protocol; stop on interface mismatch |
| 7 | legacy recovery deletion, app/consumer wiring, i18n, docs | Removes the superseded module only after Task 6 has no imports | Final integration and manual-browser handoff |

## Task status

| Task | Implementation | Independent acceptance | Commit |
|---|---|---|---|
| 1 | complete (self-tested) | APPROVE round 1/2 — Kimi, C0/I0/M0, 7/7 | `77c2fba` |
| 2 | pending | pending | — |
| 3 | pending | pending | — |
| 4 | pending | pending | — |
| 5 | pending | pending | — |
| 6 | pending | pending | — |
| 7 | pending | pending | — |

## Decisions and evidence

- Existing untracked `.superpowers/research/**` belongs to the user and is excluded from every task commit.
- Web build, web typecheck, dev server and browser automation remain user-owned. Focused Node Vitest commands in the plan are required and must be run by the Opus/Kimi implementation or acceptance agent assigned to that task.
- Task 1: implementation complete and self-tested only; see `.superpowers/sdd/2026-08-28-native-indexeddb-cas-recovery/task-1-report.md`. RED was observed as an unresolved `./database` import with the suite already collected by the service-scoped include glob; GREEN is 7/7 on `vitest run src/services/canvas-recovery/database.test.ts`. Both required fake-green mutations were executed and restored: removing the deadline `transaction.abort()` let the finite request loop commit and turned the rollback assertion red, and removing `db.close()` from `onversionchange` turned the upgrade test red through its `onblocked` branch. Only the restored aborting version is committed.
- Task 1 environment note: `bun` is absent from `PATH`; the install used the already-staged `/tmp/ic-bun-1313/bun-linux-x64/bun`, version `1.3.13`, matching the repo's pinned `packageManager`. A reviewer reproducing the lockfile needs the same binary available.
- Task 1 open observation for acceptance: `web/tsconfig.json` `include` covers `vite.config.ts` and `src/**` only, so `web/vitest.config.ts` and `web/test/setup-indexeddb.ts` sit outside the typecheck program. No tsconfig change was made because the brief does not request one.
- Task 1: independent Kimi acceptance round 1/2 APPROVE, C0/I0/M0. The reviewer independently reran `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/database.test.ts` with 7/7 passing, re-proved late-commit and blocked-upgrade detection using isolated mutants, and verified package/lockfile integrity. See `task-1-review-round-1.md`. No second round is needed.
