# SDD ledger — plan: /home/jin/code/personal/infinite-canvas/.worktrees/backend-architecture/docs/superpowers/plans/2026-08-26-cloud-canvases-assets.md

Branch base: `b949fb9486ddbf7970f53b28b9fb5cc9b0ea9f2a`
Plan baseline: `c0bf69d`

## Preflight scan

| Scope | Shared surface / dependency | Ruling |
| --- | --- | --- |
| Task 1 | Contracts barrel, Drizzle schema, migration sequence | Canvas IDs are UUIDs; Workspace IDs always use the shared opaque `WorkspaceIdSchema`. Update SQL, snapshot, and journal together. Revision is a non-negative integer and snapshots are JSON objects. |
| Task 2 | `server/src/app.ts`, Workspace authorization, Fastify body limits | Route membership is authoritative. Canvas save routes alone use a 10 MiB body limit and stable 413 code. Soft delete is idempotent only after authenticating Workspace membership and never reveals cross-Workspace rows. |
| Task 3 | Large existing local Canvas store and project page | Server data becomes authoritative; Zustand may cache loaded records in memory but must not persist `projects[]`. Drafts use localforage keys scoped by user, Workspace, Canvas, and revision. Do not add a frontend test harness solely for this task; record manual verification. |
| Task 4 | Config, app construction, S3 lifecycle, migration sequence | Define an injected storage interface for tests; construct one S3 client only when config is present. Add binary upload validation and a durable database cleanup record in the same soft-delete transaction; a later maintenance worker may consume it. |
| Task 5 | Existing Asset store/page/import/export/picker and Canvas consumers | Server list is authoritative. Cache summaries only by user + Workspace. Signed URLs live in memory only and never enter Canvas snapshots. Preserve text creation, metadata editing, import/export, and image/video insertion; add controlled unavailable states. |
| Tasks 1 ↔ 2 | Canvas contracts and table | Task 2 consumes only shared contracts/schema and must use conditional revision updates. No last-write-wins fallback. |
| Tasks 2 ↔ 3 | Canvas response/snapshot contract | Repository maps the existing `CanvasProject` snapshot without changing node/connection semantics. Media portability remains limited until Asset/AI cutover; docs must not overclaim cross-device media before that cutover. |
| Tasks 3 ↔ 5 | Canvas snapshots and Asset references | Persist Asset IDs/object-independent metadata, never signed/blob URLs. Existing local storage keys remain draft-only compatibility during this unlaunched transition; no legacy migration layer is required. |
| Tasks 4 ↔ 5 | Asset contracts, storage, direct browser upload | Add typed text-create and metadata-update routes omitted by the original route list because existing product UX requires them. Browser bytes go directly to S3-compatible storage; API only signs and verifies metadata. |
| Task 4 ↔ later worker plan | Object deletion | A durable cleanup/outbox row is required; do not claim physical deletion is complete until a worker consumes it. Soft-deleted Assets are immediately inaccessible through API. |

Preflight Ruling: Repository instructions prohibit executing tests, builds, typechecks, syntax/format checks, migrations, servers, installs, Docker, or browser automation. Agents keep test-first edit order where practical, write focused tests, and record exact human-run commands without executing them.

Preflight Ruling: Tasks are sequential because contracts, migrations, server routes, and frontend repositories share state. Each task receives an independent read-only review before the next begins.

## Task status

- Task 1: complete (commits `b949fb9`..`ec2850e`, review clean)
- Task 2: complete (commits `ec2850e`..`fa7e297`, review clean)
- Task 3: in progress (BASE `fa7e297`)
- Task 4: pending
- Task 5: pending

Task 1: fix round 1/5 requested (1 Critical, 4 Important, 2 Minor — destructive actor/Workspace cascades, unsafe revision range, non-JSON snapshot values, missing revision-aware rename, non-strict summary, plan envelope mismatch, and under-asserted schema tests; commit `14b6610`).

Task 1: fix round 1/5 result (6 resolved, 1 partial, 1 new Important open — recursive JSON record pattern does not cover line-break-containing property names; commit `07ed71e`).

Task 2 Ruling: Fastify HTTP routes must reject unknown request fields rather than silently stripping them. Configure/verify AJV behavior without weakening Foundation contracts, and cover both create/save body limits plus line-break JSON-key wire round-trip.

Task 1: minor (deferred to lifecycle design): deleting a Workspace owner currently conflicts with restrictive Canvas ownership until explicit Workspace ownership transfer/deletion lifecycle exists; docs must not claim every account deletion simply clears Canvas attribution.

Task 1: fix round 2/5 (1 addressed, 0 open — all JSON string keys now receive recursive value validation; commit `ec2850e`).

Task 1: complete (commits `b949fb9`..`ec2850e`, review clean; runtime verification pending by policy).

Task 2: fix round 1/5 requested (2 Important, 1 Minor — max-safe stale revision misclassified; tests under-protect Workspace/Canvas/deleted predicates and save/delete concurrency; implementer report overstates mutation coverage; commit `eb3fbc8`).

Task 2: fix round 1/5 (2 addressed, 0 open — max-safe classification and predicate/concurrency test coverage; commit `fa7e297`).

Task 2: minor (deferred): the ignored implementer report still overstates which exact test detects selecting snapshots internally and removing only the Workspace predicate; production/test code is unaffected.

Task 2: complete (commits `ec2850e`..`fa7e297`, review clean; runtime verification pending by policy).

Task 3: fix round 1/5 requested after commit `f70d8af` (initial hydration caused empty saves; outgoing edits could be dropped or target mutable active state; local draft rejection poisoned saves; partial delete/import/export and title bounds were incomplete; transient object URLs could enter authoritative snapshots).

Task 3: fix round 1 implementation statically re-audited and resolved in commit `bea1396`. Save candidates now capture immutable content and scope plus a per-open revision lineage, successful requests advance only that lineage before later queued edits run, conflicts block all queued descendants, scope-stale candidates never write current UI state, duplicate canvas-specific flushes do not create saves, and failed draft persistence remains best-effort. Partial operations, 200-character titles, bounded export, exact draft keys, and transient media sanitization are covered in code and manual acceptance documentation. Runtime verification remains pending by policy.

Task 3: fix round 2/5 requested after commit `bea1396` (same-scope late opens could replace the active canvas; conflict ownership was memory-only and single-canvas; edits after conflict were not persisted; lifecycle-only draft writes, unbounded localforage/hydration waits, save requests without a timeout, passive scope synchronization, global Canvas UI selection, scope-sticky Agent auto-open, broad blob sanitization, broad HTTP 409 conflict classification, and stacked viewport debounce remained open).

Task 3: fix round 2/5 implementation resolved in commit `ca466da` and follows the state-machine ruling: active ownership now has an operation generation in addition to the user/Workspace token and target ID; every canvas stores an independent `canvas-conflict` marker pointing to its exact revision-scoped draft; old-scope 409 results persist only to their captured local scope; conflicted edits continue writing the exact blocked draft without network writes; ordinary edits start an ordered localforage write immediately while the 400 ms timer applies only to network coalescing; successful saves hand newer payloads to the returned revision before deleting the prior key; local reads, revision handoff, media hydration, and save requests have bounded waits or timeouts so cloud access and later saves remain recoverable. Scope synchronization now runs before paint, project rendering requires a matching active ID and scope, Canvas list UI state clears with scope, Agent auto-open is keyed by user and Workspace, media sanitization is limited to built-in media nodes, and only `revision_conflict` blocks autosave. Page lifecycle flushing remains explicitly best-effort. Runtime verification remains pending by policy.

Task 3: fix round 3/5 requested after commit `ca466da` (1 Critical, 3 Important, 7 Minor — conflict reload left an interactive window in which one node edit silently overwrote the server copy; every edit synchronously serialized a full snapshot and queued a full IndexedDB write, so node dragging did this once per animation frame; a failed local marker read silently re-enabled autosave and left a dormant marker that resurfaces later; and no UI consumed `saveState`, so every non-conflict save failure was invisible).

Task 3 Ruling: local draft durability and local draft cost are separate concerns. Draft writes coalesce in a short 120 ms window per canvas and keep only the last pending record, while the network request stays strictly 400 ms from the last edit. Every flush path must force materialization first, so navigation, canvas creation, and page lifecycle events still capture the latest edit.

Task 3 Ruling: replacing the canvas content and replacing the save lineage must happen in one commit. Reload therefore fetches without touching the store, hydrates behind a closed loading gate, and commits the store and React content together; a failed reload restores the previous conflicted canvas rather than a refresh shell.

Task 3 Ruling: an unreadable local marker is a third state, not the absence of a conflict. It opens the server copy, keeps editing and local drafts working, blocks all network saves, and surfaces an explicit retry until a marker read succeeds. It never fabricates a conflict with a synthetic draft key and never deletes a marker or draft that has not been confirmed invalid.

Task 3 Ruling: recovery retry restores the correct lineage state (unlock, or a real conflict with its bar) but never swaps canvas content by itself. Auto-applying a recovered draft would both reintroduce the reload hydration window and silently discard edits made during recovery; the conflict bar's explicit reload/export actions remain the only content-replacing paths.

Task 3: fix round 3/5 implementation in commit `aa498df84e84b9158cdb743b568320ad4c598c39`. Also removed the unused `clearActive`, stopped the Agent canvas tool from issuing a duplicate list refresh while one is already in flight, and added a flat theme-consistent save-status indicator with working retries for both save failure and local recovery failure. Minor items were ruled as follows and deliberately not expanded: renaming during a conflict keeps writing to the local conflict draft with no success toast; a partial delete completed after a scope switch does not write into the new scope and is reflected by refreshing the old Workspace; a `mode=new` canvas already committed server-side before a scope switch is left in place rather than deleted by a risky compensating call; the per-canvas conflict marker stays shared across same-origin tabs so a draft is never lost by closing the tab that produced it; and the single global save chain keeps its 20 s network ceiling instead of being split into multiple chains. Runtime verification remains pending by policy.

Task 3 Ruling: the sync algorithm's ownership, lifecycle and state are consolidated into one `CanvasSyncSession` per open canvas with a `CanvasSyncManager` owning scope tokens, the single installed session and bounded detached sessions; Zustand is a view adapter and the page only hydrates and renders. The authoritative design is `docs/superpowers/specs/2026-08-27-canvas-sync-session-design.md` and the executable plan is `docs/superpowers/plans/2026-08-27-canvas-sync-session-refactor.md`. Later reviews of Task 3 judge against that spec rather than the earlier round-by-round fixes: content replacement only happens through prepare/commit, "已保存" only when `savedSeq === editSeq` with nothing in flight, unreadable local recovery is a third state that blocks network saves, and local draft writes stay bounded to one slot and one drain. No frontend test framework is added in this round; acceptance is the manual matrix in spec §14, recorded in `docs/content/docs/progress/pending-test.mdx`.
