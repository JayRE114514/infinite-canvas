# Task 4 implementer report — coordination CAS, deletion tombstone CAS, scoped GC and the explicit legacy upgrade

Baseline: worktree `.worktrees/backend-architecture` at accepted HEAD `b3b32e8`.
Status: implementation complete and self-tested only. Independent Opus/Kimi acceptance pending.

## Scope actually implemented

Task 4 only: `commitCoordination`, `confirmDeletion` and `collectGarbage` added to the existing
Task 3 `store.ts`, the lazy browser adapter, `bootstrap.ts`, and the two focused suites. No Task 5
repository/API, no sync session/manager, no UI, no unrelated refactor. Task 3's `readOpenSnapshot`
and `upsertDraft` were extended in place, never rewritten. `.superpowers/research/**` was left
untracked and unmodified.

## Files

- Modified `web/src/services/canvas-recovery/store.ts` (three operations, shared destructive-write
  guards, lazy adapter; `upsertDraft` now detaches its candidate)
- Modified `web/src/services/canvas-recovery/types.ts` (one-line change: the existing `isCount`
  predicate is renamed `isRecoveryCount` and exported, so the store reuses Task 2's single
  safe-count boundary instead of redefining one)
- Created `web/src/services/canvas-recovery/store-coordination.test.ts` (11 `it` cases, count as planned)
- Created `web/src/services/canvas-recovery/bootstrap.ts`
- Created `web/src/services/canvas-recovery/bootstrap.test.ts` (3 `it` cases, count as planned)
- Corrected Task 4 text only in `docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md`
  and in the untracked `task-4-brief.md` (see Rulings applied)

## RED evidence

`cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-coordination.test.ts`

```
TypeError: store.commitCoordination is not a function
TypeError: createLazyBrowserRecoveryStore is not a function
 Test Files  1 failed (1)
      Tests  11 failed (11)
```

All 11 cases failed on the absent operations, with the suite already collected by the
service-scoped include glob.

`cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/bootstrap.test.ts`

```
Error: Cannot find module './bootstrap' imported from .../canvas-recovery/bootstrap.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```

## GREEN evidence

```
store-coordination.test.ts   Tests  11 passed (11)
bootstrap.test.ts            Tests   3 passed (3)
src/services/canvas-recovery Test Files  6 passed (6)   Tests  43 passed (43)
```

43/43 matches the planned split: database 7, scope 5, types 5, store-draft 12, store-coordination 11,
bootstrap 3. Only these three scoped commands were run. No build, typecheck, dev server, browser
automation or non-recovery test was executed.

## Fake-green and mutation evidence

Six mutants, each applied to the restored-green tree, run, then reverted. Every one failed the
intended assertion, so no assertion is decorative.

| # | Mutation | Failing case | Result |
|---|---|---|---|
| A (required) | `confirmDeletion` writes the tombstone but skips the draft deletion enumeration | confirms deletion in one transaction | `expected [ { …(7) }, { …(7) } ] to deeply equal []` — 1 failed / 10 passed |
| B (required) | marker write moved before corrupt delete-target validation | fails a coordination delete atomically | `expected undefined to be 'd1'` — the marker vanished despite an unavailable outcome — 1 failed / 10 passed |
| C | marker input no longer detached (`detach(input.marker)` → `input.marker`) | writes the marker … atomically + refuses marker overflow | 2 failed / 9 passed |
| D | `nextEpoch` returns an unvalidated spread instead of `asEpoch(...)` | refuses marker overflow, unsafe epoch increments … | `expected { status: 'committed' } to deeply equal { status: 'unavailable' }` — 1 failed / 10 passed |
| E | confirmed deletion deletes only the canonical marker key | confirms deletion in one transaction | `expected [ { …(3) } ] to deeply equal []` — the noncanonical marker row survived — 1 failed / 10 passed |
| F | `upsertDraft` validates the caller's object instead of a detached clone | lets a private draft keep advancing … | `expected undefined to deeply equal { document: … }` — 1 failed / 10 passed |

After restoring each mutant the focused suite returned to 11/11. Only the restored versions are committed.

### Caller-mutation regressions

Mutants C and F are the two required caller-race proofs. Each test starts the operation without
awaiting it, mutates the caller's object synchronously, awaits a microtask so the mutation lands
while IndexedDB requests are still pending, mutates again, and only then awaits the result:

- marker/delete input: `markerInput` gains a third entry, has `draftId` rewritten to `"hijacked"`,
  `baseRevision` set to 999 and `savedAt` corrupted, and `deleteInput` gains `"d1"` twice. Stored
  marker is still exactly `[entry("d1")]` and draft `d1` still exists, so neither a cap bypass nor
  an unintended delete is reachable.
- draft envelope: title, `baseRevision: -5`, `assets` replaced by a string and `viewport.k = 0`.
  The stored envelope equals the original, so a caller cannot persist a row a later open would skip.
- keep list: `keepDraftIds` is emptied and then repopulated with `"stale"`. GC still keeps `live`
  and still collects `stale`, so a late mutation can neither widen nor narrow the deletion set.

Structured-clone failures are contained, not thrown: an envelope carrying a function and a marker
entry carrying a function both return `unavailable/corrupt`.

### Overflow and invalid-input evidence

With the epoch parked at `{ coordinationRevision: MAX_SAFE_INTEGER, deletionGeneration: MAX_SAFE_INTEGER }`,
all three operations return `unavailable/corrupt`. Invalid primitives (`-1`, `1.5`, `NaN`,
`MAX_SAFE_INTEGER + 2` revisions/generations; negative/`NaN`/infinite `now` and `minAgeMs`;
out-of-range deletion `now`; an empty keep id) are refused too. The final assertions re-read the
epoch row and the scope's drafts: the epoch equals the ceiling row byte for byte and `d1` is still
present, proving no partial write on any refusal path.

## Transaction scopes

All three operations use one `readwrite` transaction over `[EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE]`
with `RECOVERY_TRANSACTION_TIMEOUT_MS`, so epoch check, marker change and draft deletes commit or
roll back together. Ordering inside every operation is: validate detached input (before any await) →
read epoch → refuse tombstone → compare both expected values → compute and validate the next epoch →
validate every delete target → first write. `commitCoordination` and `collectGarbage` advance only
`coordinationRevision`; neither writes a tombstone nor touches `deletionGeneration`. `upsertDraft`
keeps Task 3's narrower `[EPOCHS_STORE, DRAFTS_STORE]` scope and still neither reads nor advances
`coordinationRevision`, so private draft writes cannot be starved by another tab's coordination.

## Deletion proof boundary

`confirmDeletion` is the only operation that advances `deletionGeneration`, and it always writes
`tombstonedAt` in the same transaction. Outcomes:

- present tombstone → `already-tombstoned`, whatever generation the caller expected, and nothing is
  deleted. A tombstone alone is sufficient proof the deletion already happened.
- non-tombstoned epoch with a generation mismatch → `unavailable/corrupt`. Because only this
  operation moves the generation and it never moves it without a tombstone, this state is
  unreachable under valid data, so it fails closed instead of destroying drafts.
- match → drafts and markers are enumerated by `SCOPE_INDEX` and every returned key is deleted,
  including corrupt draft rows and a marker parked under a noncanonical `markerId`. The test seeds
  a `"legacy-residue"` marker and a corrupt draft and asserts both stores hold nothing for the scope
  afterwards.

The caller must already hold proof (a matching DELETE receipt or an explicit local deletion); this
layer verifies epoch state, not authorization.

## GC invariants

Nothing is collected unless it is both aged and unreferenced. The keep set is the union of the
detached `keepDraftIds` and the marker's current entries, re-read inside the deleting transaction,
so a draft another tab just published cannot be collected. Age uses `now - Date.parse(savedAt) > minAgeMs`;
an unparsable timestamp is kept rather than deleted. A stale epoch refuses the whole run, and a
corrupt marker fails closed instead of being treated as absent. Enumeration is exact scope-limited
`index(by_scope)`, so a second identity's drafts and epoch are untouched — asserted directly.

## Bootstrap behavior

`upgradeRecoveryStorage` only drops the legacy store; there is no legacy read path, and the test
pins the module's export surface to exactly `["upgradeRecoveryStorage"]`. Module import is
side-effect free. Every failure stays inside the declared union:

- unreadable `getItem` → `failed`, and `dropLegacy` is never called, because an unreadable flag
  cannot prove the upgrade state.
- `dropLegacy` throws → `failed`, receipt not written, retryable.
- drop succeeds but `setItem` throws → `failed` and still retryable, so the next explicit run drops
  again. `dropLegacy` must therefore be idempotent: dropping an absent legacy store has to resolve
  rather than throw. This is documented in the function's doc comment and asserted by a two-run case.

`createLazyBrowserRecoveryStore` reads `globalThis.indexedDB` only on the first operation, via a
default function parameter. With no ambient IndexedDB all five operations return
`unavailable/unsupported` and `close()` is safe; with an injected factory the same adapter performs
a real write.

## Rulings applied

All seven binding corrections fit the existing contracts. Public outcome unions
(`CanvasCoordinationOutcome`, `CanvasDeletionOutcome`, `LegacyUpgradeOutcome`), the produced input
types and the planned 11 + 3 case counts are unchanged; every added assertion extends an existing
`it`. No compatibility branch was invented and no conflict needs recording.

Corrected Task 4 plan/brief text, limited to where the rulings differ from the samples:

1. New shared `detach`/`nextEpoch`/`isDraftId`/`isElapsedMs`/`CORRUPT`/`MAX_TIME_VALUE_MS` block in
   Step 3, and an instruction that `upsertDraft` validates a detached clone.
2. `commitCoordination` validates and clones marker entries and delete IDs before opening the
   transaction, and stores the validated candidate rather than `input.marker`.
3. `confirmDeletion` enumerates both stores by `SCOPE_INDEX` instead of deleting the canonical
   marker key only, and a non-tombstoned generation mismatch now returns corrupt rather than
   `already-tombstoned`.
4. `collectGarbage` validates revisions/`now`/`minAgeMs`/keep IDs and snapshots the keep list.
5. Every increment goes through `nextEpoch` before the first write.
6. `upgradeRecoveryStorage` contains `getItem`/`setItem` failures and documents the idempotency
   requirement.
7. Both test samples were replaced with the implemented suites so the documents match the code.

`types.ts` needed one change outside the planned file list: exporting Task 2's count predicate as
`isRecoveryCount`. Ruling 5 requires validating safe nonnegative revisions/generations "using
existing validators/helpers as the single source", and that predicate was module-private. No
validation logic was altered.

## Residual risks

- Two-tab serialisation is proven with two connections from one `fake-indexeddb` factory. Real
  cross-tab browser behaviour, including `onversionchange` timing, remains user-owned manual
  verification.
- `asDraftRecord`/`asMarkerRecord` still return the validated input by cast, so unknown extra
  properties survive into storage. That is Task 2's accepted behaviour; `detach` now also means
  stored rows are plain structured clones.
- `detach` uses `structuredClone`, which requires Node 17+ and a modern browser. The repo's Vitest
  environment provides it; no polyfill was added.
- GC keeps drafts whose `savedAt` is unparsable. Such a row cannot pass `asDraftRecord`, so it is
  unreachable today and the branch is defensive only.
- `browserCanvasRecoveryStore` is exported but unconsumed until Task 6/7 wiring.
- Tombstones are retained indefinitely by design; no epoch-store compaction exists, so a client that
  deletes very many canvases accumulates one small row per canvas.
