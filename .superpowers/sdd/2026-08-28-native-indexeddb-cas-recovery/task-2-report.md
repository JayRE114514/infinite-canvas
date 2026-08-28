# Task 2 implementation report — scope identity, draft envelope records, CAS outcome types

Status: implementation complete, self-tested only. Independent acceptance by Opus or Kimi is pending. The evidence below is development evidence, not acceptance.

Baseline: HEAD `0b1077b` (Task 1 independently accepted). Worktree: `.worktrees/backend-architecture`.

## Changed files

| File | Kind |
|---|---|
| `web/src/services/canvas-recovery/scope.ts` | new implementation |
| `web/src/services/canvas-recovery/scope.test.ts` | new test |
| `web/src/services/canvas-recovery/types.ts` | new implementation |
| `web/src/services/canvas-recovery/types.test.ts` | new test |

No other source file was created, modified or deleted. No Task 3 store work, no session/manager change, no unrelated refactor. Untracked `.superpowers/research/**` was left in place and excluded from staging.

## RED evidence

Both RED runs failed at module resolution with the suite collected by the existing service-scoped include glob, which is the same RED shape Task 1 recorded.

`vitest run src/services/canvas-recovery/scope.test.ts` before `scope.ts` existed:

```
FAIL  src/services/canvas-recovery/scope.test.ts [ src/services/canvas-recovery/scope.test.ts ]
Error: Cannot find module './scope' imported from .../canvas-recovery/scope.test.ts
Test Files  1 failed (1)
      Tests  no tests
```

`vitest run src/services/canvas-recovery/types.test.ts` before `types.ts` existed:

```
FAIL  src/services/canvas-recovery/types.test.ts [ src/services/canvas-recovery/types.test.ts ]
Error: Cannot find module './types' imported from .../canvas-recovery/types.test.ts
Test Files  1 failed (1)
      Tests  no tests
```

## GREEN evidence

`cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/scope.test.ts` → `Test Files 1 passed (1)`, `Tests 5 passed (5)`.

`cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery` → `Test Files 3 passed (3)`, `Tests 17 passed (17)`, matching the brief's expected split of database 7, scope 5, types 5.

Only these two scoped Vitest commands were run. Web build, web typecheck, dev server, browser automation and broader suites were not run and remain user-owned.

## Fake-green evidence

Required mutation: remove the `value.scopeId !== scopeId` comparison from `asDraftRecord`, leaving `if (!isRecord(value)) return null;`.

Result on `vitest run src/services/canvas-recovery`:

```
FAIL src/services/canvas-recovery/types.test.ts > rejects a record whose stored scope differs from the requesting scope
  ❯ types.test.ts:23  expect(asDraftRecord({ ...draft, scopeId: other }, scopeId)).toBeNull()
  received: { ..., "scopeId": "local:inst1:c2", ... }
Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 16 passed (17)
```

The mutant was killed by exactly the scope-isolation assertion and by no other test, so that assertion is genuinely load-bearing for cross-scope addressing. The comparison was restored and `vitest run src/services/canvas-recovery` returned to 17/17. All three validators keep their scope comparison in the committed code (`types.ts` lines 69, 86, 94). Only the restored version is committed.

## Validator invariants

Scope identity (`scope.ts`):

- Exactly two id shapes are producible: `local:<installationId>:<localCanvasId>` and `account:<userId>:workspace:<workspaceId>:canvas:<canvasId>`.
- Every component must match `/^[A-Za-z0-9_-]{1,128}$/`, so the `:` separator, whitespace, empty strings and over-long ids are impossible inside a component. A malformed source yields `null` and is never sanitised into a usable id, which is what stops a bad identity from silently addressing a neighbouring scope.
- `RecoveryScopeId` is a branded string, so an arbitrary string cannot be passed where a scope id is required without an explicit cast.
- `readInstallationId` persists one id under `canvas-recovery-installation`, reuses a valid stored id without calling the generator, and replaces a stored id that fails the same charset check.

Record validators (`types.ts`):

- Every validator rejects a record whose stored `scopeId` differs from the requesting scope. This is the cross-scope isolation guarantee.
- Counters (`writeSeq`, `deletionGeneration`, `coordinationRevision`, `baseRevision`) must be safe non-negative integers, so negatives, fractions, `NaN`, unsafe magnitudes and numeric strings are rejected.
- `state` must be exactly `pending` or `synced`; unknown states are rejected rather than defaulted.
- The envelope must carry all three parts (`document`, `localUi`, `assets`); a partial envelope is rejected. `localUi.viewport` requires numeric `x`, `y`, `k`. Keeping viewport under `localUi` is what prevents pan/zoom from reaching a cloud document save.
- `savedAt` and a non-null `tombstonedAt` must be parseable date strings; `tombstonedAt` may be `null` to mean "not tombstoned".
- The marker record must use `markerId === CONFLICT_MARKER_ID`, and `entries.length` may not exceed `MAX_CONFLICT_MARKER_ENTRIES` (2); an over-cap or malformed-entry marker is rejected whole.
- Corruption is always rejected, never repaired: no validator returns a partially defaulted record.
- `initialEpoch` starts a scope at `coordinationRevision: 0`, `deletionGeneration: 0`, `tombstonedAt: null`.

## Interface conformance

The exported surface matches the brief's interface block exactly: `RecoveryScopeId`, `RecoveryScopeSource`, `buildRecoveryScopeId`, `readInstallationId`, `CONFLICT_MARKER_ID`, `MAX_CONFLICT_MARKER_ENTRIES`, the envelope and record types, `initialEpoch`, `asEpoch`, `asDraftRecord`, `asMarkerRecord`, and the three CAS outcome unions.

Task 1 is consumed as a type-only import of `RecoveryFailureReason` from `./database`, which is the only permitted dependency. Because the import is `import type`, importing `types.ts` does not pull in the database module at runtime and still never touches storage. `CanvasSnapshot` resolves from `@infinite-canvas/contracts` and `ViewportTransform` from `@/types/canvas`; both were confirmed present, and the `@` alias is configured in both `web/vitest.config.ts` and `web/tsconfig.json`.

## Risks, observations and deviations

No deviation from the brief: both modules were implemented as specified, and the tests are the brief's tests verbatim.

Observations for the independent reviewer, all inherent to the brief's specified validator code rather than added by this task:

- `asDraftRecord` and `asMarkerRecord` return the validated input by cast, so unknown extra properties on a stored record pass through instead of being stripped. Records are only ever written by this service, so today this is contained, but a later consumer must not assume an exact key set.
- `assets` is validated as a plain object only; individual `assetId`/`uploadState` values are not checked, so a corrupt `uploadState` would survive validation. Worth confirming against the spec before Task 3 relies on it.
- `snapshot` is validated as a plain object, which matches `CanvasSnapshot = JsonObject` in contracts; no structural snapshot validation happens at this layer.
- `isIsoDate` uses `Date.parse`, which accepts some non-ISO but parseable strings. It rejects the corruption the tests target; it is not a strict ISO-8601 gate.
- `draftId` is only required to be a non-empty string here. It is not charset- or length-bounded like scope components, because it is part of the compound key rather than the scope identity.

Process note: the first `apply_patch` attempt resolved against the turn cwd (the main checkout) instead of the worktree and created `web/src/services/canvas-recovery/scope.test.ts` there. That stray file and its directory were removed from the main checkout immediately, and all later edits used absolute worktree paths. The main checkout's pre-existing unstaged `AGENTS.md` change belongs to the user and was neither modified nor reverted.

## Fix round 1 after independent acceptance

Status: the single authorized implementation fix pass is complete and self-tested. Independent acceptance final round 2/2 is pending. This section records development evidence only.

Review input: `task-2-review-round-1.md` returned NOT APPROVED. The binding ruling accepted C1, C2, I1, I2, I3 and M1, rejected field stripping and a new `draftId` policy, and strengthened C1 from a root-prototype check to a complete JSON-object invariant for `CanvasSnapshot`.

### Fix-round RED

The existing five scope cases and five validator cases were extended before production edits; no new `it` block was added. The first scoped run was:

```
Test Files  2 failed | 1 passed (3)
     Tests  4 failed | 13 passed (17)
```

The four expected failures were:

- unknown `source.kind` was minted as `account:u1:workspace:w1:canvas:c1` instead of returning `null`;
- generated `bad:id` was returned and persisted instead of returning `null` without a write;
- `tombstonedAt: "2020"` passed the loose `Date.parse` gate;
- two marker entries with the same `draftId` passed validation.

Those are the first assertions reached in four grouped test cases. The same cases also contain explicit guards for throwing `getItem`/`setItem`, all four valid and malformed asset states, finite positive viewport scale, canonical `toISOString()` timestamps, marker holes, nested non-JSON values, sparse arrays, non-finite numbers and cycles.

### Fix-round implementation

`scope.ts` now:

- rejects every discriminant other than `local` and `account`;
- returns `string | null` from `readInstallationId`;
- validates a generated installation id before writing it;
- returns controlled `null` when `getItem` or `setItem` throws.

`types.ts` now has one validation boundary for stored records:

- plain records accept only `Object.prototype` or `null` prototypes;
- an iterative active-path traversal proves the snapshot root is a JSON object and every nested value is JSON-safe, rejects cycles while allowing acyclic shared references, rejects sparse or extended arrays, and rejects accessors, symbol keys, `Date`/`Map`/class instances, `undefined`, bigint, symbol/function values and non-finite numbers;
- every asset mapping entry is checked for `assetId: string | null` and the four-value `uploadState` union;
- viewport `x`/`y`/`k` must be finite and `k > 0`;
- timestamps must exactly round-trip through `Date.prototype.toISOString()`;
- marker holes are materialized and rejected, and duplicate `draftId` values are rejected.

Unknown record properties remain on the original object, and validators still return that object rather than normalizing it. `draftId` remains any nonempty string; Task 3 must generate it internally.

### Fix-round GREEN

After implementation:

```
cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery
Test Files  3 passed (3)
     Tests  17 passed (17)
```

The same 17/17 result was obtained after restoring each mutation and again after both mutations were restored. No build, typecheck, dev server, browser automation or broader test command was run.

### Fix-round mutation evidence

Full JSON guard mutation: the tracked `types.ts` check in `asEnvelope` was temporarily weakened from `isJsonObject(snapshot)` to `isRecord(snapshot)`. The suite turned red at the nested `Date` assertion:

```
FAIL types.test.ts > recovery record validators > rejects corrupt shapes rather than repairing them
AssertionError: expected { ... snapshot: { nested: Date } ... } to be null
 ❯ types.test.ts:86
Test Files  1 failed | 2 passed (3)
     Tests  1 failed | 16 passed (17)
```

The guard was restored and the suite returned to 17/17.

Installation failure-containment mutation: the tracked `scope.ts` `getItem` catch was temporarily removed. The suite turned red with the injected storage exception escaping:

```
FAIL scope.test.ts > recovery scope id > replaces a corrupted id and contains generation or storage failures
Error: get failed
 ❯ readInstallationId scope.ts:31:24
Test Files  1 failed | 2 passed (3)
     Tests  1 failed | 16 passed (17)
```

The catch was restored and the suite returned to 17/17. Only restored source is included in the fix commit.

### Plan/interface correction

`docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md` Task 2 now declares `readInstallationId(...): string | null` and its scope/tests/validator samples match the strict implementation. Task 2 remains five scope tests plus five type tests, and no Task 3+ interface or test count changed.

### Fix-round files and residual concerns

The fix commit is limited to:

- `web/src/services/canvas-recovery/scope.ts`
- `web/src/services/canvas-recovery/scope.test.ts`
- `web/src/services/canvas-recovery/types.ts`
- `web/src/services/canvas-recovery/types.test.ts`
- `docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md`
- this report, `progress.md`, and the force-added round-1 review evidence.

Residual concerns are bounded by the ruling: `createId` exceptions remain the caller's responsibility because only storage failures were assigned to this boundary; unknown properties deliberately survive structural validation; and `draftId` has no charset/length rule until Task 3's internal generator owns it. Snapshot validation proves JSON representation, not semantic canvas-node correctness.
