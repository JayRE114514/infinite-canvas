# Task 2 independent acceptance — review round 1 of 2 (Opus)

Reviewer: Opus, acting as independent acceptance authority. The implementation agent's self-test is development evidence only and was not treated as acceptance.

Range reviewed: `0b1077b..12197f0`. Worktree: `.worktrees/backend-architecture`.

## Verdict

**NOT APPROVED** — 2 Critical, 3 Important, 2 Minor.

The scope-identity design is sound and the cross-scope isolation guard is genuinely load-bearing (independently re-proved below). The blocker is narrower: `asDraftRecord` returns values that violate its own declared type, and the viewport gate admits values that make a recovered canvas unrenderable. Both defeat the spec rule that corruption is rejected rather than carried forward, and Task 3 is specified to trust these validators as the only boundary between stored bytes and typed records.

Both Criticals are one-line-class fixes. I built the full corrected validator set in `/tmp` and confirmed it keeps all 17 committed expectations green while killing every adversarial probe, so one fix pass plus one re-review should settle this.

## Acceptance command and result

Exact command, run by me, twice:

`cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery`

```
 RUN  v4.1.11 /home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture/web

 Test Files  3 passed (3)
      Tests  17 passed (17)
   Duration  194ms / 191ms
```

Baseline of 17 tests matches the brief exactly (database 7, scope 5, types 5). No web build, typecheck, dev server, browser automation or broader suite was run. No tracked production, test, config or progress file was modified by this review; the only file I wrote is this report. Probes were untracked files under `/tmp/ic-t2-probe` operating on copies.

### Independent fake-green re-proof

I did not rely on the reported mutation. Removing `value.scopeId !== scopeId` from `asDraftRecord` in a `/tmp` copy leaves the "rejects a record whose stored scope differs" assertion as the only failure, so that assertion is genuinely the cross-scope guard and is not redundant with any other test. Confirmed independently.

I also brute-forced scope-id collisions across an 8-symbol alphabet containing the literal separators (`local`, `account`, `workspace`, `canvas`, `a-b`, `a_b`): 576 distinct ids, **0 collisions**. No `local` source can forge an `account` id and no component regrouping is possible, because `:` cannot appear inside a validated component. The two-shape identity scheme holds.

## Critical findings

### C1 — asDraftRecord returns records that violate its own declared type; asset entries and object shapes are unchecked

`web/src/services/canvas-recovery/types.ts:64` (`isRecord`) and `types.ts:77`–`types.ts:82` (`asEnvelope`).

`isRecord` accepts any non-array object, and `assets` entry *values* are never inspected. Measured on the committed code:

| Stored envelope fragment | Committed result | Declared type says |
|---|---|---|
| `assets: { k: { assetId: null, uploadState: "totally-bogus" } }` | accepted | `uploadState` in the 4-value union |
| `assets: { k: 42 }` | accepted | entry is an object |
| `assets: { k: { assetId: 7, uploadState: "ready" } }` | accepted | `assetId: string \| null` |
| `assets: new Date()` | accepted | `CanvasAssetMapping` |
| `snapshot: new Date()` / `new Map()` | accepted | `CanvasSnapshot = JsonObject` |

Failure scenario: a partially written or bug-produced draft carries `uploadState: "totally-bogus"`. `asDraftRecord` returns it as a valid `CanvasDraftRecord`, so Task 3 and the Task 6 manager see a value TypeScript guarantees is one of four states. Any exhaustive `switch` on `uploadState` has no reachable default, so the asset is matched by no branch and is silently dropped from the recovered document: the user reopens after a crash and an image is simply gone, with no corruption signal and no controlled-unavailable state. `assetId: 7` reaches asset-ID conversion as a non-string. A `Date` snapshot survives `structuredClone` as a `Date` (verified) and then serializes to a JSON string rather than an object, so a corrupt snapshot can reach a cloud document save shaped as something the contract forbids.

Violated requirement: the produced Task 2 contract declares `CanvasAssetMapping` as a closed union and `CanvasSnapshot` as `JsonObject`; a validator that returns `CanvasDraftRecord` while those invariants are false is unsound, and it is the sole corruption boundary. Spec line 497 fixes the envelope's third part as `storageKey -> assetId/uploadState`, and spec line 604 requires the asset layer to handle an unparseable local `storageKey` state — rejecting it at the boundary is the specified behaviour, not passing it inward. Spec line 484's reject-never-repair posture applies.

Smallest principled correction (two lines):

`+ const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);`

and inside `asEnvelope`, before returning:

`+ if (!Object.values(value.assets).every((e) => isRecord(e) && (e.assetId === null || typeof e.assetId === "string") && ["local-only", "uploading", "ready", "failed"].includes(e.uploadState as string))) return null;`

The prototype form is required rather than merely `!Array.isArray`, because IndexedDB's structured clone faithfully restores `Date` and `Map` (verified), so class instances are genuinely reachable stored values, not theoretical ones. Note this legitimately admits null-prototype objects, which structured clone can also produce.

### C2 — viewport gate admits NaN, infinities and non-positive scale, producing an unrenderable recovered canvas with no fallback

`web/src/services/canvas-recovery/types.ts:81`.

`typeof viewport.k === "number"` is true for every one of these, all measured as **accepted** on the committed code: `k = NaN`, `k = Infinity`, `k = -Infinity`, `k = 0`, `k = -1`, `k = -0.5`, and `x = NaN` with `y = Infinity`.

Failure scenario: a draft stores `viewport: { x: NaN, y: 0, k: 0 }`. `asDraftRecord` accepts it, and spec line 497 mandates that on open **the local viewport wins for rendering**, with the shared `defaultViewport` used only when no local viewport exists. Because a corrupt local viewport is present and valid, the good shared fallback is never consulted. Every screen-to-world transform becomes `NaN`, and `k = 0` divides by zero, so the user recovers a permanently blank canvas containing their content with no way to reset it and no corruption signal. `NaN` and `Infinity` survive `structuredClone` intact (verified), so this is reachable from a real stored record, and `JSON.stringify` later coerces them to `null`, propagating the damage.

Violated requirement: correctness and data-safety of the recovery path, plus the spec-mandated local-viewport-wins / shared-default-fallback ordering (line 497), which only holds if a stored local viewport is either usable or rejected. Rejecting is also consistent with the brief's own stated intent that corruption is rejected rather than repaired.

Smallest principled correction (one line):

`+ if (!isRecord(viewport) || !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.k) || (viewport.k as number) <= 0) return null;`

`k > 0` is the minimum, not a zoom-range policy: a scale of zero or negative has no meaningful rendering interpretation. I deliberately did **not** propose min/max zoom clamping, which would be scope expansion. Verified that `k = 0.25` with `x = -100.5` still passes.

## Important findings

### I1 — readInstallationId persists an id the module itself always rejects, and lets storage exceptions escape the recovery boundary

`web/src/services/canvas-recovery/scope.ts:28`–`scope.ts:34`.

Two measured behaviours on the committed code:

1. With `createId: () => "bad:id"`, the function returns `"bad:id"` **and writes it to localStorage**. `buildRecoveryScopeId` then returns `null` for that installation id, forever. Because the stored value also fails the same `safe()` check on the next call, every subsequent call regenerates and rewrites a fresh id: the installation identity is never stable, so recovery is permanently unavailable for local scope and the key is rewritten on every read.
2. A `getItem` or `setItem` that throws propagates out of `readInstallationId` (measured: both throw). Real browsers throw `SecurityError` on `localStorage` access when storage is blocked and `QuotaExceededError` on write in Safari private mode.

Failure scenario: Task 7 bootstrap calls `readInstallationId` while building the scope. In a storage-blocked browser the call throws and takes out canvas open entirely, instead of degrading to the controlled-unavailable state this whole subsystem is built around (spec line 488 requires keeping the draft and showing controlled unavailability; spec line 630 requires that local recovery failure never damage the authoritative path). With a generator whose output is not in the safe charset, the caller receives a `string` that the module guarantees cannot form a scope id — the function validates the *stored* value but not the *generated* one, which is an internal inconsistency in its own contract.

Violated requirement: the function's own contract (returns an id usable as a scope component) and the subsystem's controlled-unavailable failure model. This is the observation you asked me to adjudicate, and it is a real defect, not optional hardening: the write happens *before* any validation, so the module durably persists data it will always reject.

Smallest principled correction: widen the return to `string | null`, validate before persisting, and contain storage exceptions.

```ts
export function readInstallationId(storage: Pick<Storage, "getItem" | "setItem">, createId: () => string): string | null {
    let existing: string | null = null;
    try { existing = storage.getItem(INSTALLATION_KEY); } catch { return null; }
    if (safe(existing)) return existing;
    const created = createId();
    if (!safe(created)) return null;
    try { storage.setItem(INSTALLATION_KEY, created); } catch { return null; }
    return created;
}
```

This widens the plan's interface at plan line 547, so the same fix pass should update that line. I judged the widening correct rather than scope creep because the only alternatives are returning a knowingly unusable string or throwing, and `buildRecoveryScopeId` already establishes `null` as this module's idiom for a refused identity. `readInstallationId` has no consumer yet (Task 7), so the widening costs nothing today. Verified the brief's five committed scope expectations still pass with this version, including "replaces a corrupted stored installation id".
+
### I2 — isIsoDate accepts non-ISO strings, weakening tombstone evidence and conflict ordering

`web/src/services/canvas-recovery/types.ts:66`.

Measured accepted: `savedAt: "2020"`, `"Jan 1 2020"`, `"  2020-01-01  "`, `"-000001-01-01T00:00:00Z"`, and `tombstonedAt: "2020"`. Correctly rejected: `""`, `"not-a-date"`, `"2020-13-45T99:99:99Z"`.

Failure scenario: two conflicting drafts are presented to the user, one with `savedAt: "2020-01-01T00:00:00.000Z"` and a corrupt one with `"Jan 1 2020"`. `Date.parse` interprets the bare-date and named-month forms in *local* time and the ISO form in UTC, so ordering by parsed time silently shifts by the UTC offset and the newer draft can sort as older. Spec line 600 requires the double-tab conflict path to preserve and present both entries; if resolution or display picks by recency, the user is steered to discard the wrong draft. `tombstonedAt` is long-lived deletion evidence per spec line 488, so a non-ISO value there degrades the permanent record.

Violated requirement: data-safety of conflict presentation, and the integrity of persistent tombstone evidence (spec line 488).

Smallest principled correction:

`+ const isIsoDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));`

Keeping `Date.parse` after the pattern test still rejects structurally-valid-but-impossible dates. All committed timestamps in the suite are `toISOString()` form, so nothing legitimate is excluded.

### I3 — marker entries accept duplicate draftIds and array holes, which can silently drop a conflicting draft

`web/src/services/canvas-recovery/types.ts:97`.

Measured: `entries: [e1, e1]` with identical `draftId` is **accepted**, and `entries: [, e1]` (a hole in index 0) is **accepted** because `Array.prototype.every` skips holes. Structured clone preserves the hole (verified), so this is reachable from storage.

Failure scenario: `MAX_CONFLICT_MARKER_ENTRIES` is 2 and spec line 600 requires a two-tab conflict to preserve **two** entries. If a repair bug writes the same `draftId` twice, the cap is fully consumed by one draft, the genuine second conflicting draft can never be recorded, and the user loses it with the marker still looking well-formed. Separately, a hole means `entries[0]` is `undefined` while typed as `CanvasConflictMarkerEntry`, so any consumer reading `entries[0].draftId` throws inside a recovery transaction, converting a presentable conflict into a hard failure.

Violated requirement: the marker's purpose per spec lines 488 and 600 — one marker per scope enumerating the *distinct* conflicting drafts — and type soundness of the returned array.

Smallest principled correction, inside `asMarkerRecord` after the existing per-entry check:

```ts
const valid = Array.from(entries).every((entry) => isRecord(entry) && typeof entry.draftId === "string" && Boolean(entry.draftId) && isCount(entry.baseRevision) && isIsoDate(entry.savedAt));
if (!valid) return null;
if (new Set(entries.map((e) => e.draftId)).size !== entries.length) return null;
```

`Array.from` materialises holes as `undefined` so they are rejected by `isRecord`.

## Minor findings

### M1 — no kind discriminant guard in buildRecoveryScopeId

`web/src/services/canvas-recovery/scope.ts:19`–`scope.ts:24`. A runtime object with `kind: "bogus"` falls through to the account branch and, given `userId`/`workspaceId`/`canvasId`, mints an `account:` scope id. TypeScript prevents this at compile time and the account fields must still pass `safe()`, so no forged identity is currently reachable; but the source is assembled from server response fields at plan line 3429, where an unexpected shape is plausible. Correction: `if (source.kind !== "account") return null;` before line 23. Verified harmless to the committed tests.

### M2 — draftId is unbounded and may contain the scope separator

`web/src/services/canvas-recovery/types.ts:88`. Measured accepted: a 10,000-character `draftId` and `"a:b"`. `draftId` is the second half of the `[scopeId, draftId]` compound key, so an oversized value bloats every key and index entry. The brief explicitly justifies the looser rule because `draftId` is key material rather than scope identity, and cross-scope addressing is impossible regardless since `scopeId` is a separate key component. Acceptable as-is provided Task 3 generates `draftId` internally and never accepts it from a caller; worth a bound if that ever changes.

## Adjudication of the implementation agent's observations

You asked for a ruling on six flagged items before Task 3 trusts these records.

| Observation | Ruling | Basis |
|---|---|---|
| `asDraftRecord`/`asMarkerRecord` return validated input by cast, preserving unknown fields | **No finding.** Same-object identity confirmed (`validated === input`), unknown keys survive. Records are written only by this service, the pass-through is the brief's specified behaviour, and stripping would add copying cost with no safety gain. Task 3 must not assume an exact key set, and must not re-persist a validated record as if normalised. | Contained; no spec rule requires normalisation |
| `assets` entries are not validated | **Critical (C1).** Not merely missing robustness: it makes the returned type unsound and can silently drop a user's asset. | Produced contract plus spec 497/604 |
| `CanvasSnapshot` internals only checked as a plain object | **Partly upheld, folded into C1.** Declining structural snapshot validation is correct — `CanvasSnapshot = JsonObject` in contracts, and deep validation would be scope expansion. But `isRecord` must reject `Date`/`Map`/class instances, which are not `JsonObject` and are reachable through structured clone. | `packages/contracts/src/canvases.ts:47` |
| `Date.parse` is looser than strict ISO | **Important (I2).** Upheld, because timezone-dependent parsing can misorder conflict entries and weakens permanent tombstone evidence. | Spec 488/600 |
| viewport accepts `NaN`/`Infinity` and non-positive `k` | **Critical (C2).** Upheld. Defeats the spec-mandated shared-default fallback and yields an unrenderable canvas. | Spec 497 |
| `readInstallationId` does not validate `createId()` before persisting | **Important (I1).** Upheld, and worse than described: the unusable id is durably written before any check, and storage exceptions escape. | Function contract plus spec 488/630 failure model |

## Spec and interface compliance

| Requirement | Source | Status |
|---|---|---|
| Two scope shapes `local:<installationId>:<localCanvasId>` and `account:<userId>:workspace:<workspaceId>:canvas:<canvasId>` | spec 484 | Pass — exact match; 576-id collision sweep clean |
| Ids come only from trusted local/server sources, never arbitrary page input | spec 484 | Pass — per-component charset gate; separator, whitespace, newline, NUL and non-ASCII digits all rejected; refuses rather than sanitises |
| Opaque scope id shared by all three stores | spec 484 | Pass — branded type prevents passing a bare string |
| All reads/CAS/GC confined to one scope; no cross-scope addressing | spec 484 | Pass — all three validators compare stored `scopeId`; independently mutation-proved |
| Other identities' drafts invisible and not GC-able by the current identity | spec 485 | Pass at this layer — `String` object and missing/foreign `scopeId` all rejected |
| `epochs` separates `coordinationRevision`, `deletionGeneration`, persistent `tombstonedAt` | spec 487 | Pass — three distinct fields; `initialEpoch` is 0/0/null |
| `tombstonedAt: null` means not tombstoned; a non-null value must be a timestamp | spec 487/488 | Partial — `undefined` and missing correctly rejected, but format is loose (I2) |
| Envelope separates canonical `document` / `localUi` / `assets`; cloud serializer reads only `document` | spec 497 | Pass structurally; `assets` values unvalidated (C1) |
| Viewport is local UI only, never in the cloud document | spec 497 | Pass — `viewport` lives solely under `localUi`; partial envelope rejected |
| Local viewport wins on open, shared `defaultViewport` is fallback | spec 497 | **Fail** — a corrupt-but-accepted local viewport suppresses the fallback (C2) |
| Corruption rejected, never repaired or defaulted | spec 484/488 | **Fail** — no validator repairs, but C1/C2 admit corrupt values as valid |
| Marker capped at 2 entries, one marker per scope, no key material in entries | spec 488/600 | Partial — cap and `markerId` enforced; duplicates and holes admitted (I3) |
| `writeSeq` monotonic per `[scopeId, draftId]`, safe non-negative integer | spec 487 | Pass — `-1`, `1.5`, `NaN`, `Infinity`, 2^53, `"3"` all rejected; `0` accepted |
| Consumes only `RecoveryFailureReason` from Task 1 | brief | Pass — `import type` only; importing `types.ts` touches no storage |
| Exported surface matches the brief interface block | brief | Pass with one proposed deviation: I1 widens `readInstallationId` to `string | null` |
| Three CAS outcome unions verbatim | brief | Pass — written/superseded/tombstoned/generation-changed/unavailable, coordination and deletion unions all exact |
| `CONFLICT_MARKER_ID = "conflict"`, `MAX_CONFLICT_MARKER_ENTRIES = 2` | brief | Pass |

Task 1 interfaces re-read at `web/src/services/canvas-recovery/database.ts`: `RecoveryFailureReason` is blocked/timeout/aborted/corrupt/unsupported/error, and the version 1 key layout is `drafts [scopeId, draftId]`, `markers [scopeId, markerId]`, `epochs scopeId`. Task 2's record shapes match those keyPaths exactly, and the `corrupt` reason is the intended signal for a rejected record — which is precisely why C1/C2 matter: values that should surface as `corrupt` currently surface as valid.
+
## Adversarial malformed-record and scope-isolation matrix

Measured against the committed modules. "Accepted" means the validator returned a record.

| # | Input | Committed | Wanted | Grade |
|---|---|---|---|---|
| 1 | `draft.scopeId = other` | rejected | rejected | pass |
| 2 | `epoch.scopeId = other` | rejected | rejected | pass |
| 3 | `marker.scopeId = other` | rejected | rejected | pass |
| 4 | `scopeId` missing | rejected | rejected | pass |
| 5 | `scopeId` as `new String(scopeId)` | rejected | rejected | pass |
| 6 | `scopeId` only on the prototype chain | accepted | — | no finding; structured clone drops inherited keys (verified) |
| 7 | `local` source forging an `account` id | impossible | impossible | pass (576-id sweep) |
| 8 | component containing `:` / newline / NUL / non-ASCII digit | rejected | rejected | pass |
| 9 | component of 128 / 129 chars | accepted / rejected | same | pass |
| 10 | `kind: "bogus"` with account fields | accepted as account | rejected | **M1** |
| 11 | `viewport.k` = `NaN`, infinities, `0`, `-1`, `-0.5` | accepted | rejected | **C2** |
| 12 | `viewport.x = NaN, y = Infinity` | accepted | rejected | **C2** |
| 13 | `uploadState: "totally-bogus"` | accepted | rejected | **C1** |
| 14 | `assets: { k: 42 }` | accepted | rejected | **C1** |
| 15 | `assetId: 7` | accepted | rejected | **C1** |
| 16 | `assets: new Date()` | accepted | rejected | **C1** |
| 17 | `snapshot: new Date()` / `new Map()` | accepted | rejected | **C1** |
| 18 | `assets` key missing entirely | rejected | rejected | pass |
| 19 | `savedAt` = `"2020"`, `"Jan 1 2020"`, padded, year `-000001` | accepted | rejected | **I2** |
| 20 | `savedAt` = `""`, `"not-a-date"`, `"2020-13-45T99:99:99Z"` | rejected | rejected | pass |
| 21 | `tombstonedAt` = `"2020"` | accepted | rejected | **I2** |
| 22 | `tombstonedAt` = `undefined` / missing | rejected | rejected | pass |
| 23 | marker entries with duplicate `draftId` | accepted | rejected | **I3** |
| 24 | marker entries `[, e1]` (hole) | accepted | rejected | **I3** |
| 25 | marker entries length 2 / 3 | accepted / rejected | same | pass |
| 26 | `markerId: "other"` | rejected | rejected | pass |
| 27 | `writeSeq` = `-1`, `1.5`, `NaN`, `Infinity`, 2^53, `"3"` | rejected | rejected | pass |
| 28 | `writeSeq = 0` | accepted | accepted | pass |
| 29 | `state: "unknown"` | rejected | rejected | pass |
| 30 | `draftId: ""` | rejected | rejected | pass |
| 31 | `draftId` 10k chars / containing `:` | accepted | bounded | **M2** |
| 32 | `value = null` | rejected | rejected | pass |
| 33 | `createId()` returns `"bad:id"` | returned **and persisted** | refused | **I1** |
| 34 | `getItem` / `setItem` throws | exception escapes | contained | **I1** |
| 35 | `createId = crypto.randomUUID` | accepted, forms valid scope | same | pass |

### Corrected-implementation verification

I assembled the C1+C2+I1+I2+I3 corrections in `/tmp` and ran 49 assertions: all 17 committed expectations restated verbatim, plus 32 adversarial guards from the matrix above.

```
pass=49 fail=0
```

So the correction set is confirmed compatible with the committed tests — no committed expectation needs to be weakened or rewritten to adopt it. Fixing this does not require renegotiating the brief's tests, only adding assertions for the new guards.

## Scope integrity

Clean. `git diff --stat 0b1077b..12197f0 -- web` touches exactly the four intended files (`scope.ts` 34, `scope.test.ts` 36, `types.ts` 99, `types.test.ts` 44; 213 insertions, 0 deletions). No Task 3 store work, no session/manager change, no config or lockfile edit, no unrelated refactor. The only non-web changes are `task-2-report.md` and the `progress.md` ledger entry, both expected. `git status` shows only untracked `.superpowers/research/`, correctly left to the user and excluded from the commit.

The report's disclosure that a first `apply_patch` landed in the main checkout and was removed is credible and I verified the main checkout has no stray `web/src/services/canvas-recovery/` artifacts from it. The user's unstaged `AGENTS.md` change in the main checkout was not touched.

Tests are the brief's tests verbatim; no assertion was loosened to obtain green. Test count reconciles exactly to 17.

## Residual risks

- **Type-soundness debt is the real carrier of risk here.** These validators are the only boundary where `unknown` becomes typed, so every gap becomes a false compile-time guarantee downstream. Task 3 and Task 6 will write exhaustive switches over `uploadState` and arithmetic over `viewport`, and neither will defend itself. Fix at this layer or the same corruption reappears as unreachable-default bugs in two later tasks.
- Even after correction, `snapshot` is only shape-checked as a plain object. That matches `CanvasSnapshot = JsonObject` and is the right call for this layer, but nothing guarantees a *semantically* valid canvas document survives recovery. Node-level validation belongs to the view adapter, not here.
- `asDraftRecord` returning the input object means a caller mutating a validated record mutates the object it passed in. Harmless today; a hazard if Task 3 ever validates and then edits in place inside a transaction.
- `readInstallationId` has no consumer yet, so I1 is latent rather than live. It becomes user-visible at Task 7 wiring, which is the right moment to have already fixed it.
- The `local` scope constructor remains unwired by design (plan line 19). Its correctness is therefore proved only by unit tests, not by any integration path, until a local-only canvas entrypoint exists.
- Scope components are capped at 128 characters but `draftId` is not, so total key size stays unbounded (M2). Only matters if `draftId` ever becomes externally supplied.

## Counts

**Critical 2 / Important 3 / Minor 2.**

Round 1 of at most 2. C1 and C2 must be fixed before Task 3 begins, since Task 3's specified contract is to trust these records. I1, I2 and I3 should land in the same pass — all five are independently verified compatible with the committed suite. M1 and M2 are the author's call to take or document; neither blocks. The fix pass should also add one assertion per corrected guard so the new invariants are load-bearing, and update plan line 547 for the I1 signature.
