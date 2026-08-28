# Task 2 independent acceptance — review round 2 of 2 (Kimi, final)

Reviewer: Kimi, acting as final independent acceptance authority. No third review is permitted. The implementation agent's self-test was treated as development evidence only.

Range reviewed: `12197f0..33f97dd` (fix commit `33f97dd` "fix: harden recovery identity and record validation"). Worktree: `.worktrees/backend-architecture`. Round-1 report: `task-2-review-round-1.md`.

## Verdict

**APPROVE** — C0/I0/M0.

All five round-1 defects (C1, C2, I1, I2, I3) and accepted minor M1 are correctly closed at HEAD `33f97dd`. The controller-strengthened C1 — reject non-JSON values at any depth and cycles while allowing shared acyclic references — is fully implemented by an iterative active-path DFS and was independently stress-verified (3,000 random DAGs accepted, 2,000 random cyclic graphs rejected, 50k-deep structures handled without stack overflow). No load-bearing regression was introduced: legitimate shapes (shared references, all four asset states, fractional/huge-but-finite viewports, canonical timestamps, unknown extra keys, null-prototype and frozen plain objects, dense nested arrays) are all still accepted, and the real snapshot producer (`projectToSnapshot`, contract `CanvasSnapshot = JsonObject`) emits only values the guard admits.

Every new guard was independently proven load-bearing by me via 11 targeted mutants built in `/tmp` on copies of the committed sources; each mutation flips exactly the behavior the guard exists for.

## Acceptance command and result

Exact command, run by me at HEAD `33f97dd`:

`cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery`

```
 RUN  v4.1.11 /home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture/web

 Test Files  3 passed (3)
      Tests  17 passed (17)
   Duration  202ms
```

17 tests reconcile exactly: database 7, scope 5, types 5 (counted `it(` blocks per file). The ruling's test-count constraint (still 5+5, cases extended in place) is satisfied. No build, typecheck, dev server, browser automation or broader suite was run.

## Closure matrix

| Finding | Required correction | Fix at HEAD | Independent verification | Status |
|---|---|---|---|---|
| C1 assets unchecked | validate `assetId: string \| null` + 4-state `uploadState` per entry | `isAssetMapping` checks every own string-keyed entry (`types.ts`) | probes: bogus `uploadState`, scalar entry, `assetId: 7`, `Date`/array/null assets, class entry, missing/undefined fields all rejected; all four valid states + extras accepted; mutant F (drop entry check) flips to accept | CLOSED |
| C1 snapshot shape (strengthened: any-depth non-JSON + cycles rejected, shared acyclic allowed) | full JSON-object invariant | `isJsonObject`: prototype-strict records, iterative active-path cycle detection, sparse/extended array rejection, accessor and symbol-key rejection, finite numbers only | probes: `Date`/`Map`/`Set`/class/`Uint8Array`/`ArrayBuffer`/`DataView`/RegExp/Error/WeakMap/Promise/boxed primitives at root and depth 5; `undefined`/bigint/symbol/function/NaN/±Infinity; holes (3 constructions), extra array props; self/mutual/array/middle/deep/20k-deep cycles; getters, symbol keys. Accepted: shared object/array/diamond/10k-shared, 50k-deep acyclic, 3,000 random DAGs, -0, null-proto, frozen. Mutant A (root-only `isRecord`) flips nested-`Date` and cycle to accepted; mutant K (never leave active set) falsely rejects shared acyclic refs | CLOSED |
| C2 viewport | finite x/y/k, `k > 0` | `isFiniteNumber` + `viewport.k <= 0` rejection | probes: NaN/±Inf in each field, `k` 0/-0/-1/-0.5, string/array/Date/null/missing-k viewports rejected; 0.25/-100.5/MIN_VALUE/1e308 accepted; mutant B (drop `k <= 0`) accepts `k=0`, `k=-1` | CLOSED |
| I1 installation id | `string \| null`, validate before persist, contain storage exceptions | exactly as reviewed; `createId` throw propagates (ruling: caller-owned) | probes: roundtrip generates once; corrupt stored id replaced; `bad:id` generator returns null with zero writes; `getItem`/`setItem` throws contained (generator not called on get failure); empty/129-char generator rejected; mutants I (catch removed → exception escapes) and J (validation removed → bad id returned and persisted) both flip | CLOSED |
| I2 timestamps | canonical UTC only | round-trip rule: `new Date(v).toISOString() === v` with finite guard | probes: `2020`, `Jan 1 2020`, padded, `+01:00`/`+00:00` offsets, no-millis, date-only, space-separated, month 13, Feb 30, hour 25, empty all rejected; canonical zero/nonzero/max-ms accepted; `tombstonedAt` bare year / no-millis / undefined rejected, canonical/null accepted; mutant E (loose `Date.parse`) accepts `"2020"` and `"Jan 1 2020"` | CLOSED |
| I3 marker integrity | reject holes and duplicate `draftId`s | `Array.from` materialization + `Set` distinctness check | probes: hole at index 0/1, duplicates (same id with different timestamps, identical object twice), 3-entry cap, noncanonical entry date, missing/negative/fractional `baseRevision`, empty `draftId` rejected; 0/1/2 distinct entries and extra entry keys accepted; mutants C (Set check removed → dups accepted) and D (no materialization → hole accepted) both flip | CLOSED |
| M1 unknown scope kind | reject non-`local`/`account` discriminants | `if (source.kind !== "account") return null;` | probes: `"bogus"`, `"unknown"`, `"Local"`, missing kind all return null; mutant H (guard removed) mints `account:u1:workspace:w1:canvas:c1` from `kind: "bogus"` | CLOSED |

Rejected-by-ruling items (unknown-field stripping, `draftId` charset/length policy) were not reopened, per instructions; the committed tests explicitly pin the ruled behavior (`asDraftRecord(extra) === extra`, `draftId: "internal:opaque"` accepted).

## Remaining C/I/M findings

None. No unresolved round-1 defect, no correctness/security/data-loss regression introduced by the fix, and no material test false-green was found.

The reported fix-round mutation evidence (nested-`Date` RED on the weakened snapshot guard; `Error: get failed` RED on the removed catch) was independently re-proven by my mutants A and I rather than taken on trust, and extended to nine more mutants covering every other new guard.

## Adversarial matrix (independent probes, /tmp copies of HEAD sources)

157 assertions in the main probe set plus 11 mutation proofs; all pass. Categories:

| Category | Probes | Result |
|---|---|---|
| Scope identity | bogus/unknown/mis-cased/missing kind; local+account shapes; cross-scope draft/epoch/marker; `new String(scopeId)`; missing scopeId | all as required |
| Installation id | valid roundtrip; corrupt stored; invalid/empty/oversized generator (no write); get/set throws contained; generator throw propagates (ruled caller-owned) | all as required |
| Assets (C1) | 10 malformed variants rejected; 4 valid states + extras + null-proto entry accepted | all as required |
| Snapshot non-JSON (C1) | 19 root-level non-JSON values rejected; 10 nested variants (depth 5, inside arrays) rejected; symbol keys and getters rejected | all as required |
| Sparse/extended arrays | `new Array(3)`, literal hole, `delete` hole, length-extension, string/symbol extra props | all rejected |
| Cycles | self, mutual, array-self, back-edge to head/middle, 20k-deep cycle; 2,000 seeded random cyclic graphs | all rejected |
| Shared acyclic | object/array/diamond/3-path/10k-fan-out sharing; 50k-deep acyclic; 3,000 seeded random DAGs | all accepted |
| Viewport (C2) | 14 malformed variants rejected; 4 boundary-valid accepted (fractional, tiny, huge finite) | all as required |
| Timestamps (I2) | 12 noncanonical forms rejected; 3 canonical accepted; tombstone field same rule | all as required |
| Markers (I3) | holes, duplicates, cap, malformed entries rejected; 0/1/2 distinct accepted | all as required |
| Prior guards intact | writeSeq -1/1.5/NaN/Inf/2^53/"3" rejected, 0 accepted; state, draftId, null, partial envelope, epoch counters | all as required |

Three initial probe failures were construction bugs in my own harness (disconnected "cycle", array-typed random root, unreachable forced back-edge); corrected constructions all pass, so no genuine validator defect was found.

## Plan/interface coherence

- Plan Task 2 (`docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md` lines 530–1033) now matches the committed implementation verbatim: `readInstallationId(...): string | null` (line 547), the kind guard, strict `isRecord`/round-trip `isIsoDate`/`isJsonObject`/asset/viewport/marker samples, extended test samples, and both new fake-green checks.
- The plan diff's hunks are all inside the Task 2 region (old lines 544–842); no Task 3+ interface or test count changed, as the ruling required. Task 1's consumed surface (`RecoveryFailureReason` import type) is untouched.
- progress.md rulings are accurately reflected: accepted C1/C2/I1/I2/I3/M1 all landed; rejected stripping/draftId-policy items were not implemented; the `string | null` widening cost (Task 7 must handle null as controlled-unavailable) is recorded.

## Scope integrity

Clean. `git diff --stat 12197f0..33f97dd -- web` touches exactly the four intended files (`scope.ts` +17, `scope.test.ts` +32, `types.ts` +85, `types.test.ts` +76). Non-web changes are the plan correction, this review series' evidence, `task-2-report.md` fix section, and the progress ledger — all mandated. `git status` shows only the user's untracked `.superpowers/research/`. My probes lived exclusively under `/tmp/ic-t2-r2`; no tracked code, test, config, doc or progress file was modified by this review.

## Residual risks (non-load-bearing observations, not findings)

- The strengthened C1 guard reads array elements via iteration, so a hostile *accessor on an array index* or a `Proxy` trap would execute during validation. Neither is producible by IndexedDB structured clone (data properties only, no proxies), so the actual storage boundary cannot reach this. Same reasoning covers getters on `assets` entries and symbol keys on the `assets` object (type is `Record<string, ...>`; string-keyed consumers never see them).
- Canonical-timestamp rule accepts expanded-year forms (e.g. `-000001-01-01T00:00:00.000Z`) because they exactly round-trip `toISOString()`; round-1's suggested four-digit-year regex would have rejected them. The chosen rule is self-consistent ("exactly what the serializer emits"), unambiguous UTC, and rejects every noncanonical form round 1 measured. Task consumers should compare timestamps via `Date.parse`, not lexicographically, if expanded years ever matter.
- `isJsonObject` admits null-prototype objects; structured clone normalizes them to `Object.prototype`, so this only widens acceptance of in-memory-constructed values harmlessly.
- Validators still return the validated input object by identity (ruled acceptable). Task 3 must not mutate a record in place after validation inside a transaction, and must generate `draftId` internally.
- The guard proves JSON *representation*, not canvas semantics; node-level validation remains the view adapter's job (unchanged from round 1).
- `createId` exceptions propagate from `readInstallationId` by design (ruling assigned only storage failures to this boundary); Task 7 wiring must treat a `null` installation id as controlled-unavailable.

## Counts

**Critical 0 / Important 0 / Minor 0.**

Round 2 of 2; review cap reached. Task 2 is accepted. Task 3 may proceed against these interfaces, subject to the recorded residual-risk obligations (internal `draftId` generation, no in-place mutation of validated records, `null` installation id handling at Task 7).
