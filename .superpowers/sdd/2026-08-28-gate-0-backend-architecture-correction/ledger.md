# SDD ledger — plan: docs/superpowers/plans/2026-08-28-gate-0-backend-architecture-correction.md

## Approved plan

- Fixed commit: `2d78c24`
- Independent review: APPROVE
- Worktree: `/home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture`
- Branch: `design/backend-architecture`

## Preflight overlap scan

| Implementation unit | Writes | Produces / consumes | Overlap ruling |
|---|---|---|---|
| Atomic Tasks 1–4 | `.env.example`, `server/**`, `packages/contracts/src/workspaces.ts`, invitation browser client files | Produces role-specific DB handles, final Workspace schema/contracts, `AppTransaction`, transaction entrypoints, grants/RLS/admin lifecycle | One implementer and one commit; internal task boundaries are TDD checkpoints only. No parallel writer. |
| Task 5 | Identity composition, Workspace provisioning/service/routes, contracts/tests | Consumes final Task 1–4 transactions, policies, audit function | Sequential after atomic review; overlaps are intentional consumers, never parallel writes. |
| Task 6 | Canvas schema/service/routes/contracts/tests and migration `0005` | Consumes final transaction/RLS boundary | Sequential after Task 5 review; no shared-state parallelism. |
| Task 7 | Changelog and progress/verification docs | Consumes verified command/commit evidence | Documentation only after Tasks 1–6. |

## Shared interface rulings

- `AppTransaction`, database role types, Workspace schema/contracts, and transaction entrypoints are owned by atomic Tasks 1–4; later units may consume but not redefine them.
- Migrations remain journaled in exact order; no later unit edits an earlier migration.
- `packages/contracts/src/workspaces.ts` is touched by Tasks 1–4 and Task 5 sequentially; Task 5 may only add the repair contract.
- No implementation agents run concurrently because all implementation units share schema or service boundaries.

## Progress

- Atomic Tasks 1–4 BASE: `2d78c24`
- Atomic Tasks 1–4 approved HEAD: `57d82b0a7a567b2fe03962ddf881e73b5c760c01`
- Atomic Tasks 1–4 review: APPROVE; no Critical/Important findings; one non-blocking server TypeScript strictness cleanup remains.
- [x] Atomic Tasks 1–4 implementation
- [x] Atomic Tasks 1–4 independent code review
- Task 5 approved HEAD: `47be7a2ac5fb0216757dea837500e6d40eecf6a9`
- Task 5 review: APPROVE; no Critical/Important findings; migration `0005` is frozen for the provisioning function fix and Canvas is reserved for `0006`.
- [x] Task 5 implementation and review
- Task 6 approved HEAD: `542efd7b8169e96b85d1d1a71a225fda254eec5c`
- Task 6 acceptance round 1/2: Kimi ultra APPROVE; Critical 0, Important 0; independent full server suite 317/317 plus 29/29 PostgreSQL adversarial probes.
- Task 6 acceptance evidence: `task-6-independent-review.md` (force-added into version control as the authoritative acceptance record). The implementer's own self-test remains development evidence only.
- [x] Task 6 implementation and review
- Task 7 BASE: `542efd7b8169e96b85d1d1a71a225fda254eec5c`
- Task 7 implementer: Opus. Documentation-only unit; no production code, server test, or migration was modified.
- Task 7 status: implemented and accepted. Implementer-run evidence: full server suite 17 files 317/317, `check-module-boundaries` ok, `git diff --check` clean, `tsc --noEmit` reports the 15 pre-existing out-of-scope errors.
- Task 7 approved HEAD: `af37bfa355e6de411c46729c162d31c548ada92d`
- Task 7 acceptance round 1/2: Kimi APPROVE; Critical 0, Important 0, Minor 0. Independently re-run: commit count exactly 1, zero production files touched, server suite 317/317, `module boundaries: ok`, `tsc --noEmit` exactly 15 pre-existing errors, Gate 0 explicitly declared not closed, bilingual pages symmetric, navigation intact. Round 2 not required.
- Task 7 acceptance evidence: `task-7-independent-review.md` (force-added into version control as the authoritative acceptance record). The implementer's own self-test remains development evidence only.
- [x] Task 7 documentation implementation
- [x] Task 7 independent acceptance (Kimi; round 1/2; no second round)
- [ ] Branch review

## Native IndexedDB CAS recovery plan

- Plan: `docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md`
- Authoritative spec: `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md` (§11, §16, §17 Gate 0). No competing spec was authored; the 2026-08-27 canvas-sync spec/plan stay superseded for local persistence, testing and viewport decisions.
- Approved approach: option B, native IndexedDB transaction/CAS. Approved by the user; architecture quality takes precedence over schedule.
- BASE: `af37bfa355e6de411c46729c162d31c548ada92d`
- Author: Opus (planning only). No production or test code was written, no subagent was dispatched, `.superpowers/research/**` was not touched.
- Scope: 7 tasks. Tasks 1-4 build the recovery database, scope identity, draft CAS, coordination/deletion/GC CAS and the explicit legacy upgrade; Task 5 makes DELETE return a receipt and defines the negative proof matrix; Task 6 is the single switch commit for Session/Manager; Task 7 removes the legacy localforage module and wires consumers and docs.
- Deleted by the plan, with no dual protocol retained: `canvas-local-recovery.ts`, `CanvasLocalRecovery`, `CanvasLocalWrite` (`settled`), `CanvasSyncSession.whenLocalSettled`, `deleteMarkerIfOwned`, `CanvasDraftScope`, marker `draftKey`, the manager's two-phase late-write cleanup, and `CANVAS_PATCH_FIELDS` as one flat list including `viewport`.
- Automated verification: scoped Vitest + fake-indexeddb under a Node environment only, no DOM/React harness.
- The Chrome/Firefox/Safari matrix is explicitly reserved for the user; the plan forbids any automated test from claiming it.
- Plan commit lineage: original `f782940` is amended in place; BASE remains `af37bfa355e6de411c46729c162d31c548ada92d`, so the range remains exactly one commit.
- Independent plan acceptance round 1/2: Kimi NOT APPROVED; Critical 3, Important 4, Minor 9. Evidence: `.superpowers/sdd/2026-08-28-native-indexeddb-cas-recovery/plan-independent-review.md` (force-added as the authoritative review record).
- Round-1 revision: all C3/I4/M9 findings are addressed in the same amended plan commit. The revision adds the legal deadline-abort request loop, independent local-UI counters, lazy browser singleton, frozen canonical viewport, complete tombstone state, bounded stale cleanup, explicit conflict/retry/export CAS paths, corrupt-epoch fail-closed handling, corrected task/count/install/account-scope/AGENTS details, and matching adversarial tests.
- Final plan acceptance round 2/2: Opus NOT APPROVED; Critical 1, Important 2, Minor 4. Evidence: `.superpowers/sdd/2026-08-28-native-indexeddb-cas-recovery/plan-final-review.md` (force-added as the authoritative final review record). Round 1's C3/I4/M9 were independently rechecked as closed; the final findings are the ambient `IDBKeyRange` dependency, 19 inconsistent Vitest path/precondition references, tombstoned rename, and four documentation/test precision issues.
- Final correction: exact scope queries now use `getAll(scopeId)` / `getAllKeys(scopeId)` with a zero-ambient execution test; every Vitest invocation resolves inside `web/node_modules/.bin`; tombstoned rename returns before mutation/registerEdit/timer scheduling and has an explicit event/test; all four Minors are incorporated. No third review will be requested.
- Ruling: plan final review cap reached — apply C1/I2/M4 exact corrections without third review; implementation Task 1 RED/GREEN and task-level Opus/Kimi acceptance become the next executable evidence. Cost if wrong: Task 1 or Task 6 will surface a plan defect and must stop as load-bearing.
- Status: corrected after final review; implementation authorized; no APPROVE claim.
- [x] IndexedDB CAS plan authored
- [x] IndexedDB CAS plan acceptance round 1 recorded (NOT APPROVED; C3/I4/M9)
- [x] IndexedDB CAS plan revised for all round-1 findings
- [x] IndexedDB CAS plan final review recorded (NOT APPROVED; C1/I2/M4; review cap reached)
- [x] IndexedDB CAS plan corrected for all final-review findings
- [ ] IndexedDB CAS plan independent acceptance (not achieved; no third review permitted)
- [ ] IndexedDB CAS implementation
