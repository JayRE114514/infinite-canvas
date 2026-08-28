# Task 1 independent acceptance review — round 1 of 2

Reviewer: Kimi (acceptance authority per progress.md). Role: acceptance only; no production
code, tests, manifests, lockfile or progress.md were modified. No subagents were spawned.
Commit range reviewed: 767035b..77c2fba (exactly one commit, 77c2fba, verified via
git log --oneline). Worktree status: clean except the user's pre-existing untracked
.superpowers/research/, which is untouched.

## Verdict: APPROVE

## Acceptance test evidence (run independently by this reviewer)

Command, run in the worktree:

    cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/database.test.ts

Result (2026-08-28 19:32 CST, exit code 0):

    RUN  v4.1.11 /home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture/web
    Test Files  1 passed (1)
         Tests  7 passed (7)
      Duration  190ms (transform 31ms, setup 25ms, import 22ms, tests 78ms)

The "1 passed (1)" test-file count also independently confirms the include-glob scoping:
only the service test was collected.

Contract-fidelity check: I extracted the four full-file ts blocks from the task brief
(vitest.config.ts, test/setup-indexeddb.ts, database.test.ts, database.ts) and diffed each
against the committed blob at 77c2fba. All four are byte-identical to the brief. Zero
deviation from the written Task 1 contract.

Package/lockfile integrity (independently verified):
- web/package.json: only the two pinned devDependencies (fake-indexeddb 6.2.5, vitest 4.1.11)
  and the "test": "vitest run" script were added; nothing else changed.
- bun.lock: +4 lines total; fake-indexeddb@6.2.5 recorded with no transitive dependencies;
  exactly one vitest resolution remains (rg -o 'vitest@[0-9.]+' bun.lock | uniq -c => 1x 4.1.11).
- Installed tree matches: node_modules/vitest is 4.1.11, node_modules/fake-indexeddb is 6.2.5,
  web/node_modules/.bin/vitest exists.

## Independent adversarial validation (temporary /tmp probes, tracked files untouched)

All probes ran under /tmp/ic-t1-review/probe with the worktree's vitest 4.1.11 and
fake-indexeddb 6.2.5, against byte-exact copies of the committed database.ts (real) and
three mechanically generated mutants. Probe suite: 7/7 green after fixing one bug in my own
probe mock (a fake connection lacking transaction(); the runner correctly classified that as
"error" — itself a small confirmation of the error path).

Does the suite detect a late commit? YES — proven, not assumed. Mutant m1 removes only
transaction.abort() from the deadline handler (database.ts, the setTimeout(timeoutMs) block).
Against m1 the 100,000-request loop drains and the transaction COMMITS: the read-back returned
the stored epoch { scopeId, coordinationRevision: 1, deletionGeneration: 0, tombstonedAt: null },
not undefined. The committed test's rollback assertion (database.test.ts:78,
toEqual({ status: "ok", value: undefined })) therefore necessarily turns red under this
mutation, with exactly the signature the implementer reported. The timeout result still says
{ failed, "timeout" }, so the test genuinely distinguishes rollback from a bare timed-out promise.

Does the suite detect a blocked upgrade? YES — proven. Mutant m2 keeps the onversionchange
handler but removes db.close() from it (database.ts, the db.onversionchange block). Against m2
the raw version-2 open fired onblocked; the committed test's onblocked reject
(database.test.ts:126) therefore fires and the test turns red. Handler-existence alone would
pass; only actually releasing the connection passes.

First-principles semantics probes against the REAL committed implementation (all green):
1. ConstraintError mid-transaction (add on an existing key after a valid put) =>
   { status: "failed", reason: "error" }, and full rollback: the valid write is absent and the
   pre-existing row is untouched. Confirms request-error propagation classifies as error, not
   aborted, and that the abort handler ordering (first finish wins) is correct.
2. Pre-aborted AbortSignal => { failed, "aborted" } and factory.open was never called
   (open-counting factory). The signal check precedes any storage side effect.
3. Two concurrent first run() calls coalesce into exactly one factory.open call, both resolve ok.
4. A totally silent open (no onblocked/onerror/onsuccess ever) settles { failed, "blocked" } at
   ~2008 ms — the RECOVERY_OPEN_TIMEOUT_MS timer path, which the committed suite does NOT cover
   (its blocked test fires onblocked explicitly). The bound works. Afterwards, a late onsuccess
   connection is close()d and NOT published; the next run() retries through a fresh factory.open
   and succeeds against a real schema.
5. A late onupgradeneeded arriving after the open already settled blocked aborts the upgrade
   transaction (request.transaction.abort() called), so no late schema mutation can slip through.

## Findings

Critical: none.

Important: none.

Minor: none.

Assessment of the implementer's flagged observation (report deviation 5): confirmed factual —
web/tsconfig.json include is ["vite.config.ts", "src/**/*.ts", "src/**/*.tsx"], so
web/vitest.config.ts sits outside the typecheck program; web/test/setup-indexeddb.ts is pulled
in transitively via database.test.ts but has no direct include entry. Judged against Task 1
requirements this is NOT a finding: the brief pins the exact file set and prescribes no tsconfig
change; both files execute correctly under vitest (7/7 green); the produced module and its test
are inside the program. Expanding tsconfig would exceed the Task 1 contract. Recorded as an
observation for the user's own typecheck gate, which remains user-owned per progress.md.

## Spec compliance table (every produced interface/invariant)

| Contract item (brief/plan/spec) | Status | Evidence |
|---|---|---|
| RECOVERY_DB_NAME = "infinite-canvas-recovery" | PASS | byte-identical; spec line 483 name match |
| RECOVERY_DB_VERSION = 1 | PASS | test 1 asserts opened.version === 1 |
| DRAFTS/MARKERS/EPOCHS store names | PASS | test 1 asserts exact store set, nothing else |
| SCOPE_INDEX = "by_scope" | PASS | test 1 asserts index names on drafts/markers |
| RECOVERY_OPEN_TIMEOUT_MS = 2_000 | PASS | byte-identical; probe 4 measured settle at ~2008 ms |
| RECOVERY_TRANSACTION_TIMEOUT_MS = 2_000 | PASS | byte-identical; exported for later tasks |
| RecoveryFailureReason 6-member union | PASS | byte-identical to plan lines 124/354 |
| RecoveryRun<T> union | PASS | byte-identical |
| RecoveryStoreName union | PASS | byte-identical |
| RecoveryTxn { store, req } | PASS | exercised by every test; probe 1 |
| RecoveryDatabase { run, close } + createRecoveryDatabase(factory) | PASS | all tests |
| Fixed v1 schema: drafts [scopeId,draftId], markers [scopeId,markerId], epochs scopeId, one by_scope index each on drafts/markers | PASS | test 1; spec line 484 |
| Lazy open, no import/construction side effect | PASS | test 2 (factory.databases() empty) |
| Injected IDBFactory, no ambient global | PASS | node environment, no polyfill; all core tests inject |
| blocked is bounded and typed | PASS | test 3 (< 2000 ms) + probe 4 (silent-open timer) |
| Deadline aborts; no late commit | PASS | test 4 + mutant m1 detection proof |
| Work-throw rolls back every write (multi-store) | PASS | test 5 + probe 1 |
| Owner AbortSignal aborts and rolls back, reason aborted | PASS | test 6 + probe 2 |
| onversionchange closes old connection; never the blocker | PASS | test 7 + mutant m2 detection proof |
| Post-upgrade open reports bounded failure | PASS | test 7 (failed via VersionError path) |
| Late open success after settle is closed, not published | PASS | probe 4 |
| Late upgrade after settle is aborted | PASS | probe 5; comment in database.ts onupgradeneeded |
| Harness scoped: no DOM/React test framework | PASS | include glob src/services/**/*.test.ts; run collected exactly 1 file |
| package.json: two pinned devDeps + test script only | PASS | diff inspection |
| bun.lock: fake-indexeddb@6.2.5, single vitest@4.1.11 | PASS | lockfile + installed tree inspection |

## Adversarial reasoning summary

- Late-commit detection: proven by mutant m1 (see above). The finite hold loop is the right
  design: under the mutation the queue drains and commits, turning the rollback assertion red
  instead of hanging; the illegal never-resolving external await was correctly avoided.
- Blocked-upgrade detection: proven by mutant m2 through the onblocked branch.
- Coverage gap honestly noted, deliberately NOT a finding: neutralizing the open-timeout timer
  (mutant m3) leaves all 7 committed tests green, because the suite's blocked test fires
  onblocked explicitly. The brief pins the exact test file and exactly two fake-green mutations,
  so the implementation cannot deviate here; my probe 4 supplies the missing evidence that the
  timer works (~2008 ms settle on a silent factory). Flagged as residual risk, not a violation.
- Failure-classification spot check: request errors classify as error (probe 1), owner cancel as
  aborted (test 6, probe 2), deadline as timeout (test 4), blocked as blocked (test 3, probe 4).
  First-finish-wins ordering verified sound in each path.
- Timing sensitivity: the 50 ms deadline and 20 ms cancel window rely on the 100k-request queue
  staying live (~225-244 ms measured drain, ~4.5x margin). Failure direction on a much faster
  machine is false-RED (the commit beats the deadline and assertions fail loudly), never
  false-green. Safe as designed; the test comment correctly forbids reducing the bound.

## Scope integrity / unrelated changes

The commit touches exactly the brief's file list plus the two SDD ledger artifacts
(progress.md, task-1-report.md) required by the process. No unrelated source, config or
document changes. The user's untracked .superpowers/research/ is preserved and unstaged.
The implementer's reported accidental edit to the MAIN checkout's web/package.json was
independently verified reverted: the main checkout shows only the user's pre-existing
AGENTS.md modification.

## Residual risks (accepted, none blocking)

1. fake-indexeddb proves single-process API semantics only; the spec (line 602) already defers
   real-browser versionchange/blocked/durability verification to the three-browser manual gate.
2. The open-timeout timer path is outside the committed suite's mutation coverage (see above);
   compensated by probe 4 evidence. Future maintainers editing database.ts should re-run a
   silent-factory check.
3. A synchronously throwing (non-async) work callback would escape run() as an uncontrolled
   rejection; the RecoveryTxn contract types work as returning Promise<T>, so this is
   caller-contract territory, and Tasks 3/4 consume it with async functions.
4. close() during an in-flight open does not cancel the pending open; a later run() would adopt
   the eventually-opened connection. No Task 1 invariant covers close-during-open.
5. tsconfig observation above remains for the user-owned typecheck gate.

## Counts

C: 0 / I: 0 / M: 0 — verdict APPROVE.
