# Task 3 independent acceptance review — final round 2/2

Reviewer: Opus (acceptance authority per AGENTS.md; implementer self-tests are development evidence only).
Scope reviewed: HEAD `0b36a53` in worktree `.worktrees/backend-architecture`; fix diff `9a4980d..0b36a53`.
Mandate: verify closure of the sole round-1 finding M1, recheck complete Task 3 state only for
regressions introduced by that fix. No third round is permitted. Optional points are not reopened;
per the final-round rule, optional observations are recorded as residual risks, not findings.

## Verdict

**APPROVE** — C0 / I0 / M0.

M1 is closed at the code, test and plan level. The equal-`savedAt` tiebreak is now an explicit
UTF-16 code-unit comparison, and the existing ordering case pins a mixed-case pair (`"A"` before
`"a"`) at an identical timestamp. I independently confirmed the assertion is load-bearing: a
`localeCompare` relapse turns it red under every locale I tested, while the committed comparator
is invariant across en / sv / tr / C. The fix introduced no regression: it changed one expression
plus its comment in production and added three lines of setup to one existing test, the `it` count
is still 12, and every other Task 3 axis accepted in round 1 still passes.

## Independent test evidence (run by me)

Mandated command, in the worktree, unmodified tracked files:

```
cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-draft.test.ts

 RUN  v4.1.11 /home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture/web
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Duration  148ms
exit=0
```

**12/12 as expected**, 1 test file, no other suite executed. `grep -c 'it('` = 12, so the case count
is unchanged from the accepted round-1 baseline. No build, typecheck, dev server, browser
automation or broader suite was run.

Locale invariance of the committed code, same suite run against an untracked `/tmp` copy with the
runtime locale forced (Node 22.23.2, full ICU 78.2; `Intl.Collator.supportedLocalesOf` confirms
real en/sv/tr/de collation data is present, so divergence is measurable rather than stubbed):

| Runtime locale | Committed comparator |
|---|---|
| `sv_SE.UTF-8` | 12 passed (12) |
| `tr_TR.UTF-8` | 12 passed (12) |
| `en_US.UTF-8` | 12 passed (12) |
| `C` | 12 passed (12) |

## M1 closure matrix

| Round-1 M1 requirement | Status | Evidence |
|---|---|---|
| Tiebreak for equal `savedAt` must be locale-independent UTF-16 code-unit order | CLOSED | [store.ts](/home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture/web/src/services/canvas-recovery/store.ts:66) is `Date.parse(b.savedAt) - Date.parse(a.savedAt) \|\| (a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0)`; no `localeCompare` remains in the module |
| A mixed-case pair must be pinned so a locale-aware relapse regresses | CLOSED | [store-draft.test.ts](/home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture/web/src/services/canvas-recovery/store-draft.test.ts:72) writes `"A"` and `"a"` at one `savedAt` and asserts `["d3","d1","A","a","d2"]` |
| That assertion must be load-bearing, not decorative | CLOSED | `localeCompare` relapse mutant → 1 failed / 11 passed under en, sv, tr and C; received `["d3","d1","a","A","d2"]` |
| Primary instant ordering must survive the new tie rows | CLOSED | The tied pair lands between `d1`@7000ms and `d2`@1000ms, and `d3`@`+275760-09-13` stays first, so the tiebreak cannot mask the instant comparison |
| Deterministic-ordering claim in the plan must match the code | CLOSED | Plan comparator sample (line 1349) and test sample (lines 1135, 1141) are byte-identical to the shipped code and test |

The round-1 compliance matrix row "Deterministic recovery ordering (corrected plan)" therefore
moves from **FAIL (M1)** to **PASS**. All other rows were PASS in round 1 and are unaffected by
this fix (see regression check below).

## Mutant / probe evidence

All mutation and probe work was done in a disposable `/tmp` sandbox (real module sources copied,
dependencies reached through a symlink to the worktree's `node_modules`). No tracked file was
edited at any point; `git status --porcelain` before and after shows only the pre-existing
untracked `.superpowers/research/`, and HEAD is still `0b36a53`. The sandbox baseline reproduced
12/12 before any mutation.

Mutants against the committed suite, plus my own stronger round-2 probe:

| Mutant | Committed suite | Round-2 probe |
|---|---|---|
| `localeCompare` relapse (the exact M1 defect) | 1 failed / 11 passed | 1 failed |
| Tiebreak reversed (descending code units) | 1 failed / 11 passed | 1 failed |
| Tiebreak deleted (`|| 0`) | 12 passed | 1 passed |
| `savedAt` instant compare → `localeCompare` string compare | 1 failed / 11 passed (received `["d1","A","a","d2","d3"]`) | — |
| CAS guard `>=` → `>` | 2 failed / 10 passed (`["written","written"]`) | — |
| Restored to committed source | 12 passed | 1 passed |

The two mutants that embody an actual locale-aware relapse both regress, which is precisely what
the mandate required. The CAS and instant-ordering mutants confirm the fix did not blunt the
neighbouring guards that round 1 accepted.

Locale-divergence probe (pure Node, `localeCompare` vs explicit comparator over en / sv / tr / de /
en-US):

| Pair | `localeCompare` per locale (en,sv,tr,de,en-US) | Explicit comparator | Locale-divergent |
|---|---|---|---|
| `A` vs `a` | 1,1,1,1,1 | −1 | no, but **inverted** vs code units under every locale |
| `z2` vs `ä1` | 1,−1,1,1,1 | −1 | yes (sv flips) |
| `i1` vs `I2` | −1,−1,1,−1,−1 | 1 | yes (tr flips) |
| `draft-A` vs `draft-a` | 1,1,1,1,1 | −1 | inverted vs code units |

Pairs where `localeCompare` diverges across locales: 2. Pairs where the explicit comparator
diverges: **0**. Applied to the suite's tie fixture, `localeCompare` yields `["a","A"]` under all
five locales while the explicit comparator yields `["A","a"]`, so the committed assertion would
fail for a relapse regardless of which locale a developer or CI machine happens to run.

Round-2 probe (`zz-round2-probe.test.ts`, sandbox only, created / run / discarded): eleven drafts
with scrambled insertion order (`z2, ä1, i1, I2, a, A, _x, Z, 0a, draft-a, draft-A`) all sharing one
`savedAt` are returned by `readOpenSnapshot` in exactly the reference code-unit order, and that
order differs from both the `sv` and the `tr` collation orders, which themselves differ from each
other. This proves the fix end-to-end through real storage, not just at the comparator.

## Fix-regression review (C/I/M)

**No findings.** The fix diff is 6 files: production comparator + comment, three lines of test
setup and one updated expectation, the matching plan samples, plus `progress.md`,
`task-3-report.md` and the committed round-1 review. Checks performed:

- Production change is confined to the ordering expression inside `readScopeDrafts`. Transaction
  structure, epoch fail-closed handling, tombstone and generation precedence, pre-transaction
  validation, the `>=` CAS boundary and the `unavailable` mapping are byte-identical to the
  round-1-accepted revision.
- The comparator is total and antisymmetric on strings and returns 0 only for equal `draftId`,
  which cannot occur twice inside one scope because `[scopeId, draftId]` is the primary key. It
  cannot throw, so it cannot convert an ordering concern into a read failure.
- The two extra rows the test now writes live in `scopeA` of that single case; `beforeEach` builds a
  fresh factory per test, so no other case observes them. Confirmed by 12/12.
- The new upserts are asserted `{status:"written", writeSeq:1}`, so the tie fixture also re-confirms
  per-draft (not per-scope) `writeSeq` independence rather than weakening it.
- No new dependency, no new export, no public type or outcome-shape change.

## Plan coherence

Coherent. The plan's Task 3 comparator sample and its test sample were updated in the same commit
and match the shipped files exactly, so a future task extending this store copies the
locale-independent version. `progress.md` records the round-1 verdict (C0/I0/M1), the authorized
single-fix scope, the RED→GREEN transition and the restored-mutation evidence, and marks Task 3
`complete (fixed/self-tested)` with round 2 pending — accurate at the moment I started. The
report's fix section matches what I measured, including the received order `["d3","d1","a","A","d2"]`
for the relapse.

## Scope integrity

Intact. `git diff 9a4980d..0b36a53 --stat` is exactly the six files above; no unrelated file, no
drive-by refactor, no change to Task 1/2 modules, and `.superpowers/research/` stayed untracked and
untouched. Storage-access properties re-confirmed unchanged: exact-scope `index(by_scope).getAll(scopeId)`
with a post-enumeration `row.scopeId === scopeId` re-check, writes keyed on
`[input.scopeId, validated draftId]`, exact-key epoch and marker gets, and no ambient `indexedDB` /
`IDBKeyRange` in the module. My review added no tracked file and left HEAD unchanged.

## Residual risks (not findings; final round, so optional observations land here)

- Deleting the tiebreak entirely still passes both the committed suite and my stronger probe,
  because `Array.prototype.sort` is stable and IndexedDB returns `getAll` rows in primary-key
  (`[scopeId, draftId]`) order, which is already code-unit order. The explicit comparator is
  therefore defence-in-depth that makes the contract local and readable rather than the sole cause
  of the observed order. The assertion is still load-bearing against the regression it exists for —
  any locale-aware or reversed comparator fails it — so this is a test-strength nuance, not a gap.
- `web/src/services/canvas-local-recovery.ts:148` still sorts with `savedAt.localeCompare`. That is
  the pre-existing legacy service, outside Task 3's files and untouched by this commit; worth a look
  when it is retired or migrated.
- Carried forward unchanged from round 1: `asDraftRecord` validates by cast, so unknown extra
  envelope keys persist (accepted Task 2 behaviour); two-connection serialisation is proven only
  under `fake-indexeddb`, leaving real cross-tab behaviour as user-owned manual verification; a
  stale-`deletionGeneration` draft in a non-tombstoned scope would still be enumerated, which Task 4's
  GC owns; `store.ts` was not typechecked, per instruction.

## Counts

Critical: 0 · Important: 0 · Minor: 0 · M1 from round 1: closed.
Tests: 12/12 mandated suite in the worktree (exit 0) + 12/12 sandbox baseline + 12/12 under each of
sv/tr/en/C + 1/1 custom round-2 ordering probe + 6 mutant runs (5 mutants, all behaving as
required, source restored to 12/12). Sandbox and probe artifacts removed; worktree clean at
`0b36a53` with only the pre-existing untracked `.superpowers/research/`.
