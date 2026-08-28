# Task 3 implementer report — consistent open snapshot and per-draft writeSeq CAS

Baseline: worktree `.worktrees/backend-architecture` at accepted HEAD `a805cdd`.
Status: implementation complete and self-tested only. Independent Opus/Kimi acceptance pending.

## Scope actually implemented

Task 3 only: `readOpenSnapshot`, `upsertDraft` and `close` on a new `store.ts`, plus the 12-case
`store-draft.test.ts`. No Task 4 coordination, deletion, GC or bootstrap; no sync session/manager;
no unrelated refactor. `.superpowers/research/**` was left untracked and unmodified.

## Files

- Created `web/src/services/canvas-recovery/store.ts`
- Created `web/src/services/canvas-recovery/store-draft.test.ts` (12 `it` cases, count unchanged)
- Corrected Task 3 text only in `docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md`
  and in the untracked `task-3-brief.md` (see Rulings)

## RED evidence

`cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-draft.test.ts`

```
 ❯ src/services/canvas-recovery/store-draft.test.ts (0 test)
Error: Cannot find module './store' imported from .../canvas-recovery/store-draft.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

The intended unresolved `./store` RED, with the suite already collected by the service-scoped
include glob.

## GREEN evidence

Same command after implementing `store.ts`:

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

No build, typecheck, dev server, browser automation or broader suite was run.

## Fake-green mutation evidence

Mutation: the `stored.writeSeq >= record.writeSeq` guard in `upsertDraft` weakened to `>`.

```
 ❯ store-draft.test.ts (12 tests | 2 failed)
 FAIL  ... > accepts an increasing writeSeq and rejects equal or older ones
AssertionError: expected { status: 'written', writeSeq: 2 } to deeply equal { status: 'superseded', …(1) }
 FAIL  ... > serialises two connections writing the same key, ...
AssertionError: expected [ 'written', 'written' ] to deeply equal [ 'superseded', 'written' ]
 Tests  2 failed | 10 passed (12)
```

The equal-seq boundary is load-bearing as required, and the same mutant also collapses the
two-connection race into a lost update, which is the failure mode the CAS exists to prevent.
`>=` was restored and the suite returned to 12/12; only the restored version is committed.

## Transaction invariants

- `readOpenSnapshot` reads epoch, marker and drafts inside ONE `readonly` transaction over
  `[EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE]`, so the three parts cannot be torn by a
  concurrent writer.
- `upsertDraft` reads the epoch, checks the tombstone, checks the generation, reads the stored
  draft and puts inside ONE `readwrite` transaction over `[EPOCHS_STORE, DRAFTS_STORE]`. The
  compare and the swap are never split across transactions.
- Every await inside both bodies is a `txn.req(...)` on a live request, so the request queue never
  drains mid-body and Task 1's deadline abort stays able to roll the transaction back.
- Draft enumeration is exact scope-limited `index(SCOPE_INDEX).getAll(scopeId)`. No ambient
  `indexedDB`, no `IDBKeyRange`; one case asserts both globals are `undefined`.
- Timeouts and `AbortSignal` are delegated to Task 1's runner; a failed run maps to `unavailable`
  with the runner's reason, never to a silent success.

## CAS invariants

- Acceptance requires a strictly increasing `writeSeq` per exact `[scopeId, draftId]` key. Equal
  and older are refused as `superseded` carrying the stored sequence.
- `writeSeq` is per draft, not per scope: `d2` at 1 is accepted while `d1` sits at 7, and the same
  `draftId` in two scopes keeps independent sequences.
- `coordinationRevision` is never read for comparison and never advanced by a draft write, so
  another tab's marker work cannot starve an ordinary save.
- A missing epoch row is the ONLY path to generation zero. A present-but-invalid epoch is
  fail-closed `corrupt` for both read and write, so a malformed tombstone can never collapse to
  generation zero and revive a deleted canvas.
- A tombstoned scope refuses reads (`tombstoned` with the generation) and writes (`tombstoned`);
  the test proves no `writeSeq: 99` row was stored.
- A generation mismatch returns `generation-changed` with the stored generation and writes nothing.
- Corrupt draft rows are skipped on read so one bad row cannot hide the remaining recoverable
  drafts, but a corrupt row at the TARGET key of a write returns `unavailable: corrupt` and is left
  intact rather than overwritten with a guessed sequence.
- A present-but-invalid marker is `unavailable: corrupt`, not treated as absent, so unknown marker
  ownership stops the open instead of licensing later GC.

## Input-validation evidence (controller first-principles requirement)

The store constructs the candidate record and validates it through Task 2's `asDraftRecord` — the
same single-source boundary that rejects rows on read — BEFORE opening any transaction. Invalid
typed-at-runtime input returns `{ status: "unavailable", reason: "corrupt" }` with no transaction
and no write. The validated object returned by `asDraftRecord` is the exact object passed to `put`,
and it is never mutated in place; `deletionGeneration` is set from `expectedDeletionGeneration` at
construction time and the write only proceeds when the stored epoch still equals it, so the stored
row is exactly the validated candidate.

This makes it impossible for the recovery store to persist a record that a later
`readOpenSnapshot` would skip as corrupt.

Covered inside the existing "never overwrites a corrupt existing draft" case (no new `it`):
fractional, negative and `NaN` `writeSeq`; unparsable and noncanonical `savedAt`; an empty
envelope; an unusable viewport (`k: 0`); an unknown `state`; and an empty `draftId`. After all nine
rejections the scope-limited `getAll` contains only the pre-existing corrupt `bad` row, proving not
one invalid input reached storage.

## Ordering

Snapshot drafts are newest-first by INSTANT via `Date.parse`, with `draftId` as a deterministic
tiebreak. Task 2's strict canonical validator admits `toISOString`'s expanded-year form, and
`"+275760-09-13T00:00:00.000Z"` sorts BELOW `"1970-..."` lexicographically, so the brief's
`savedAt.localeCompare` sample would have ranked the chronologically newest draft last. The
"keeps writeSeq per draft" case now stores that timestamp and asserts the order
`["d3", "d1", "d2"]`.

## Rulings recorded

Two Task 3 sample corrections were applied in the plan and brief rather than layered as a
downstream patch, per the controller instruction:

1. `upsertDraft` validates the constructed record at the Task 2 boundary before writing and stores
   that validated object; the brief's version built an unvalidated record inline.
2. Snapshot ordering compares instants; the brief's `b.savedAt.localeCompare(a.savedAt)` is wrong
   for the expanded-year timestamps the validator accepts.

Public types, outcome shapes and the 12-case count are unchanged.

## Residual risks and open observations for acceptance

- `asDraftRecord` returns the validated input by cast, so unknown extra properties on an
  `upsertDraft` envelope survive into storage. This is Task 2's accepted, reviewed behaviour; the
  store adds no stripping.
- Two-tab serialisation is proven with two connections from ONE `fake-indexeddb` factory. Real
  cross-tab behaviour under browser IndexedDB remains user-owned manual verification.
- `Date.parse` is used only for ordering, never for validation; the canonical gate stays in Task 2.
  A row whose `savedAt` passed validation always parses, so no `NaN` can enter the comparator from
  a validated record.
- Task 4 must EXTEND this store: it owns coordination, deletion, GC and marker writes. The epoch
  fail-closed contract and the per-draft CAS must not be relaxed to make those easier.
- `store.ts` sits inside `src/**` and so inside the `web/tsconfig.json` program, but no typecheck
  was run here by instruction.

## Fix round 1 — locale-independent draftId tiebreak

Independent acceptance round 1/2 returned NOT APPROVED with C0/I0/M1. M1 identified that the
default-locale `draftId.localeCompare` tiebreak could order identical stored rows differently
across browsers, OS locales or locale changes. No other correction was authorized or made.

The existing expanded-year/ordering `it` case remains one of 12 and now writes `"A"` and
`"a"` with the same `savedAt`. The literal expected order puts `"A"` before `"a"`, as
required by UTF-16 code-unit comparison. Under the current `en-US` runtime, default collation
instead puts `"a"` first, so the regression is observable rather than theoretical.

### Fix-round RED

After extending the existing test and before changing production, the required focused command
failed exactly the ordering case:

```
 Test Files  1 failed (1)
      Tests  1 failed | 11 passed (12)
AssertionError: expected [ 'd3', 'd1', 'a', 'A', 'd2' ]
            to deeply equal [ 'd3', 'd1', 'A', 'a', 'd2' ]
```

### Fix-round GREEN

`readScopeDrafts` now uses the explicit locale-independent comparator
`a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0` after the chronological
`savedAt` comparison. The same focused command then passed:

```
 Test Files  1 passed (1)
      Tests  12 passed (12)
```

### Restored mutation evidence

Temporarily changing the tiebreak back to `a.draftId.localeCompare(b.draftId)` made the same
mixed-case assertion red with 1 failed / 11 passed and the received `["d3", "d1", "a", "A",
"d2"]`. The UTF-16 code-unit comparator was restored and the focused suite returned to 12/12.
Only the restored comparator is committed.

The only test command run in this fix pass was:
`cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-draft.test.ts`.
No build, typecheck, dev server, browser automation or broader suite was run.
