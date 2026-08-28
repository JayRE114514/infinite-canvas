# Task 3 independent acceptance review — round 1/2

Reviewer: Kimi (acceptance authority per AGENTS.md; implementer self-tests treated as non-acceptance).
Scope: diff `a805cdd..9a4980d` in worktree `.worktrees/backend-architecture`.

## Verdict

**NOT APPROVED** — C0 / I0 / M1.

The store is correct on every data-safety axis I could attack: one-transaction consistent open,
exact-scope enumeration with a post-enumeration scope re-check, per-`[scopeId, draftId]` writeSeq
CAS that survives 40/40 adversarial two-connection races, zero coupling to `coordinationRevision`,
correct tombstone/generation precedence, fail-closed corrupt epoch/marker/target-row handling, and
invalid input rejected before any transaction opens. The single finding is a determinism defect in
the snapshot tiebreak that contradicts the plan's own normative ordering claim; the fix is one line.
One fix pass plus one final review can settle this.

## Independent test evidence (run by me, not quoted)

- `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-draft.test.ts`
  → **12 passed (12)**, twice (before and after probe cleanup). File count 1, no other suites run.
- Untracked probe suite `zz-review-probe.test.ts` (created, run, deleted; `git status` clean after):
  - P1: guard mutant `>=` → `>` in an isolated copy → two-connection race collapses to
    `["written","written"]` and equal-seq becomes `written` — independently reproduces the
    implementer's fake-green evidence; the CAS boundary is load-bearing.
  - P2: real store, 40 two-connection equal-writeSeq races → 40/40 exactly one winner
    (`["superseded","written"]`).
  - P3: unequal-seq races (5 vs 3, both commit orders) → final stored row always writeSeq 5 with
    the seq-5 content; the loser is either `superseded {storedWriteSeq:5}` or was legitimately
    `written` first and then overwritten by the strictly-greater write. No lost update either way.
  - P4: pre-aborted signal → `unavailable: aborted` for both `upsertDraft` and `readOpenSnapshot`;
    zero rows persisted.
  - P5: `database.run` spy → invalid input returns `unavailable: corrupt` with **zero transactions
    opened**; same with an aborted signal stacked on top.
  - P6: invalid input against a tombstoned scope → `unavailable: corrupt`, drafts store stays empty.
  - P7: two drafts with identical `savedAt` → tie broken by `draftId` (`["a","b"]`) in the default locale.
- Pure-Node determinism probe: `Date.parse(new Date(ms).toISOString()) === ms` exactly for
  `ms ∈ {8.64e15, -8.64e15, 0, 1000}` (both expanded-year extremes); comparator sign correct at the
  extremes. `localeCompare` divergence demonstrated (see M1).

## Explicit adjudications requested by the controller

1. **Validation before opening the transaction — no violation.** The pre-transaction
   `asDraftRecord` gate is pure and synchronous, so it opens no race window. Combined-outcome
   cases: invalid+tombstoned → `corrupt` (P6), invalid+aborted → `corrupt` (P5), invalid alone →
   `corrupt` with no transaction at all. Nothing is written in any of these, so the promised
   safety semantics (tombstoned scopes cannot be resurrected, aborted work persists nothing) hold.
   The spec's ordering sentence (先拒绝 tombstone 或 deletionGeneration 不匹配，再拒绝
   stored.writeSeq ≥ incoming) constrains the in-transaction rejection order, which the
   implementation follows exactly: corrupt epoch → tombstoned → generation-changed → corrupt
   stored row → superseded → write. No spec text promises `tombstoned`/`aborted` precedence for an
   input that is itself invalid; `unavailable: corrupt` for invalid input is the brief-codified
   contract (suite case 10). Reason-string precedence between caller-bug input and environmental
   states is a diagnostic nuance, not a semantic violation.
2. **Date.parse ordering: deterministic and correct for every timestamp Task 2 admits.**
   `isIsoDate` requires `new Date(v).toISOString() === v`, so every admitted `savedAt` is exactly a
   `toISOString()` output — a conforming ECMA-262 Date Time String (including the ±YYYYYY
   expanded-year form), whose parsing is spec-mandated, not implementation-defined. Verified
   round-trip exactness at both range extremes. The subtraction comparator cannot flip sign (both
   operands are exact integers ≤ 2^53; correctly-rounded subtraction preserves the sign of a
   nonzero difference). **localeCompare tiebreak: NOT deterministic across browsers/locales** —
   see M1.
3. **No path overwrites a corrupt row or enumerates another scope.** Write path touches only
   `[input.scopeId, validated draftId]`; a corrupt row at the target key returns
   `unavailable: corrupt` and is preserved (suite case 10). Corrupt rows at other keys are never
   read on the write path and are skipped, not repaired, on the read path (suite case 9).
   Enumeration is `index(by_scope).getAll(scopeId)` (exact equality, no IDBKeyRange, no ambient
   globals — suite case 6 asserts both globals are `undefined`), and `asDraftRecord(row, scopeId)`
   re-checks `row.scopeId === scopeId` after enumeration, so even a corrupt index entry pointing
   at a foreign-scope row is filtered. Epoch and marker reads are exact-key gets.
4. **The two-connection test genuinely proves one winner for equal writeSeq.** Two connections
   from one factory produce overlapping readwrite transactions on `[epochs, drafts]`, which
   IndexedDB serializes; the loser's read of the target key observes the winner's committed row and
   is refused as `superseded`. The mutant evidence (P1: guard weakened to `>` yields
   `["written","written"]`, a lost update) proves the test detects exactly the failure mode it
   exists to prevent, and P2 shows the real code yields exactly one winner in 40/40 adversarial
   runs. Which tab wins is scheduling-dependent by design; the outcome multiset is not.

## Findings

### M1 — `localeCompare` tiebreak is locale-dependent, violating the plan's deterministic-ordering invariant

- **File:line:** `web/src/services/canvas-recovery/store.ts:63` —
  `drafts.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || a.draftId.localeCompare(b.draftId))`.
- **Scenario:** two drafts in one scope share the same `savedAt` millisecond (two conflict/session
  drafts written within one ms, or restored rows). The tiebreak then decides the recovery order,
  i.e. which draft is `drafts[0]` for Task 6/7 consumers. `localeCompare` with no arguments uses
  the runtime default locale, per ECMA-402. Measured: `["a","A"]` orders as `a<A` under every
  locale but `A<a` in code units; `["z2","ä1"]` flips between `sv` and `en`/`de`; `["i1","I2"]`
  flips between `tr` and `en`/`sv`/`de`. The same stored rows therefore produce a different
  recovery order across browsers, across users, and even across sessions of one browser profile
  after an OS locale change.
- **Requirement:** the corrected plan text for this very comparator claims "draftId breaks ties so
  the same stored rows always produce the same recovery order", and the review mandate lists
  deterministic recovery ordering as a first-principles axis. Mixed-case/non-ASCII draftIds are
  realistic: the storage boundary imposes no charset (Task 2 ruling), and likely generators
  (nanoid-style, per the `[A-Za-z0-9_-]` convention already used for scope components) produce
  exactly the mixed-case IDs where collation diverges from code-unit order.
- **Impact bounds (why M, not I):** ties only; all drafts are still enumerated, nothing is lost or
  corrupted; within one browser+locale the order is stable.
- **Minimal principled fix:** replace the tiebreak with a locale-independent code-unit comparison,
  e.g. `a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0`, and extend the existing
  tie-order probe/assertion (a mixed-case pair such as `A`/`a` pinned to code-unit order would
  regress against a future locale-aware relapse; the current suite only ties `a`/`b`, which all
  locales order identically).

No C or I findings.

## Compliance matrix

| Requirement (source) | Verdict | Evidence |
|---|---|---|
| Open reads epoch+marker+drafts of one scope in ONE readonly transaction (spec §488) | PASS | store.ts readOpenSnapshot; suite cases 1, 8, 9, 12 |
| All reads/CAS confined to one scope; no cross-scope enumeration; no ambient IDB globals (spec §484) | PASS | getAll(scopeId) + scopeId re-check; suite case 6 asserts globals undefined; scope A/B isolation |
| Per-`[scopeId,draftId]` writeSeq CAS; stored ≥ incoming → superseded carrying stored seq (spec §487) | PASS | suite cases 2, 3; probes P1/P2/P3 |
| Draft write neither compares nor advances coordinationRevision (spec §487) | PASS | store.ts reads only tombstonedAt/deletionGeneration; suite case 4 (stays 0) |
| Tombstone precedence: refuse read (with generation) and write; no resurrection (spec §487–488) | PASS | suite case 8 incl. no-writeSeq-99-row assertion; probe P6 |
| deletionGeneration mismatch → generation-changed carrying stored generation (spec §487) | PASS | suite case 5 |
| Missing epoch is the only generation-zero path; corrupt epoch fail-closed (plan ruling) | PASS | readEpoch; suite case 11 (malformed tombstoned epoch never collapses to 0) |
| Corrupt marker fail-closed, never treated as absent (plan) | PASS | suite case 12 |
| Corrupt draft rows skipped on open; corrupt target row preserved on write (plan) | PASS | suite cases 9, 10 |
| Invalid typed-at-runtime input rejected at the Task 2 boundary before any write (controller ruling) | PASS | suite case 10 extension (9 invalid classes, storage unchanged); probe P5 (zero transactions opened) |
| Signal/timeout map to `unavailable` with runner reason; deadline abort rolls back (spec §489, Task 1) | PASS | runner delegation + mapping in store.ts; probe P4; Task 1 accepted runner tests |
| Deterministic recovery ordering (corrected plan) | **FAIL (M1)** | Date.parse component proven exact; localeCompare tiebreak proven locale-dependent |
| Commit hygiene: only Task 3 files + plan/progress/report; no unrelated edits | PASS | `git diff a805cdd..9a4980d --stat` = 5 files; worktree clean after probes |

## Adversarial race / isolation / corruption matrix

| # | Scenario | Result | Evidence |
|---|---|---|---|
| R1 | Two connections, same key, equal writeSeq | exactly one `written`, loser `superseded` | P2 (40/40), suite case 7, mutant P1 collapses it |
| R2 | Two connections, same key, unequal writeSeq, both commit orders | final row always the higher seq with matching content; no lost update | P3 |
| R3 | Tombstone committed before late write | `tombstoned`, no row | suite case 8 |
| R4 | Invalid input + tombstoned / + aborted / alone | `corrupt`, zero writes, zero transactions for the pure-invalid case | P5, P6 |
| R5 | Corrupt epoch (incl. malformed tombstone) | `unavailable: corrupt` read+write; no collapse to generation 0 | suite case 11 |
| R6 | Corrupt marker | open `unavailable: corrupt` | suite case 12 |
| R7 | Corrupt row at write target key | `unavailable: corrupt`, row preserved intact | suite case 10 |
| R8 | Corrupt row elsewhere in scope | skipped on open; valid drafts still enumerated; other keys writable | suite case 9 |
| R9 | Same draftId in two scopes | independent writeSeq tracks; no cross-talk | suite case 6 |
| R10 | Pre-aborted signal on read and write | `unavailable: aborted`, nothing persisted | P4 |
| R11 | Timeout mid-transaction | deadline aborts → full rollback → `unavailable: timeout` | Task 1 runner (accepted); store maps reason |
| R12 | Far-future expanded-year savedAt vs 1970 strings | instant ordering, not string ordering | suite case 3; Node extremes probe |
| R13 | Equal savedAt ties | deterministic per locale, **not across locales** | P7; M1 |

## Scope integrity

Enumeration is exact-key `getAll(scopeId)` with a post-enumeration `row.scopeId === scopeId`
re-check; writes compute the key `[input.scopeId, draftId]` from the validated record whose
`scopeId` equals the addressed scope; epoch/marker access is exact-key. No ambient `indexedDB` /
`IDBKeyRange` anywhere in the module (asserted absent in-test). No path I constructed or found by
inspection reads, writes, or enumerates a scope other than the addressed one.

## Residual risks (not findings for this round)

- `asDraftRecord` returns the validated input by cast: unknown extra keys on an upsert envelope
  persist into storage. Accepted Task 2 behaviour; consistent read/write since the validator is
  the single boundary. Flag for Task 6/7 consumers.
- Two-tab serialisation is proven under fake-indexeddb only; real cross-tab browser IndexedDB
  behaviour remains user-owned manual verification (per progress.md).
- A stale-`deletionGeneration` draft in a *non-tombstoned* scope would be enumerated (shape-valid)
  because snapshot read does not filter drafts against the epoch generation. Reachable only through
  a torn delete transaction (impossible — single txn per spec §488) or manual corruption; Task 4's
  GC owns revalidation. Watch at Task 4 review.
- `store.ts` is inside `web/tsconfig.json` but no typecheck was run, per task instruction
  (user-owned).

## Counts

Critical: 0 · Important: 0 · Minor: 1 (M1) · Tests: 12/12 mandated suite (run twice) + 7/7 custom
probes + 40/40 race stress · Probe artifacts removed; worktree clean.
