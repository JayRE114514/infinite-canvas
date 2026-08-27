# Canvas Sync Session Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the implicit canvas sync algorithm scattered across module-level mutables and React effects with one explicit `CanvasSyncSession` per open canvas, owned by a `CanvasSyncManager`, so ownership, lifecycle and state have a single carrier.

**Architecture:** One canvas open creates one session. The session owns content, revision lineage, edit counters, the phase state machine, a 120 ms local-draft scheduler and a 400 ms network scheduler, and exports one immutable view. `CanvasSyncManager` owns scope tokens, the single installed session, bounded detached sessions, prepare/commit content replacement and list-level operations. Zustand becomes a view adapter; the canvas page only hydrates media, renders, and turns user actions into `update` calls.

**Tech Stack:** TypeScript 5, React 19, Zustand 5, localforage 1.10, nanoid 5, Ant Design 6, Tailwind, i18next, Vite 7 (bun scripts).

**Spec:** `docs/superpowers/specs/2026-08-27-canvas-sync-session-design.md`

## Global Constraints

- Scope is the `web/` canvas sync boundary only. Server Canvas HTTP contracts, `packages/contracts`, database migrations and everything under `server/` are not touched.
- No Asset Task 4/5 work, no CRDT/OT/operation log, no realtime channel, no Redis, no WebSocket, no Service Worker.
- **No frontend test framework is introduced in this round.** Spec §2.2 rules it out. Testability is carried by pure-TypeScript dependency injection (`repository`, `recovery`, `now`, `createDraftId`) plus the manual matrix in spec §14. Do not add Vitest, Testing Library, Playwright or any test harness for these tasks.
- **Implementation agents execute no verification commands.** The repository forbids running tests, builds, typechecks, lint, formatters, dev servers, migrations and browser automation. Each task lists the exact commands and expectations for the *user* to run; the agent writes them down and stops there.
- One-shot replacement, no compatibility layer: no dual code path, no feature flag, no legacy local-storage migration. `web/src/services/canvas-drafts.ts` is deleted in Task 3.
- The legacy localforage store `{ name: "infinite-canvas", storeName: "canvas_drafts" }` is dropped once, best-effort, on first load of the new recovery module. Failure is ignored and blocks nothing.
- Constants are fixed by spec §6.3 and used verbatim: `LOCAL_COALESCE_MS = 120`, `NETWORK_DEBOUNCE_MS = 400`, `NETWORK_MAX_WAIT_MS = 5000`, `SAVE_REQUEST_TIMEOUT_MS = 20000`, `LOAD_REQUEST_TIMEOUT_MS = 20000`, `LOCAL_READ_TIMEOUT_MS = 2000`, `LOCAL_FLUSH_TIMEOUT_MS = 2000`, `DETACHED_LOCAL_MS = 2000`, `DETACHED_NETWORK_MS = 10000`, `MAX_DETACHED_SESSIONS = 2`, `EXPORT_BATCH_SIZE = 3`, `DRAFT_GC_MIN_AGE_MS = 6 * 60 * 60 * 1000`. `CANVAS_TITLE_MAX_LENGTH = 200` already exists in `web/src/lib/canvas/canvas-snapshot.ts` and must be reused, never redeclared.
- Dependency direction (spec §3.1) is enforced: `canvas-repository.ts` and `canvas-local-recovery.ts` never import the store or the manager; `canvas-sync-session.ts` and `canvas-sync-manager.ts` never import React or components; components never import session or manager internals and reach sync state only through `useCanvasStore`.
- `revision_conflict` is the only error code that produces a conflict. `canvas_revision_limit_reached` and every other 409 are `save-error` with `kind: "server"`. `canvas_snapshot_too_large` is `save-error` with `kind: "server"` and its own message key.
- Every snapshot written to the server or to a local draft goes through the existing `projectToSnapshot` in `web/src/lib/canvas/canvas-snapshot.ts`. It already strips `blob:` URLs from built-in media nodes, alternative images, generation references and assistant references, and already leaves text and plugin `metadata.content` untouched. Do not add new sanitisation and do not bypass it.
- UI copy is Simplified Chinese first with an English peer in `web/src/i18n/locales/en-US.ts`. Icon-only buttons keep `aria-label`. Canvas surfaces use `canvasThemes` tokens and the existing flat, borderless, shadowless style; never hardcode stone/slate colors.
- Existing user edits in the worktree are preserved. Do not revert, reformat or refactor files outside each task's file list.

## Interface Deviations From The Spec Draft

Spec §9 states its signatures are drafts that constrain boundaries. Five deviations are required for the spec's own rules to hold. They are binding for every task in this plan.

| Spec draft | This plan | Why |
| --- | --- | --- |
| `install(): void`, `commitPrepared(prepared)` | `install(content: CanvasProject): void`, `commitPrepared(prepared, content)`, `commitServerCopy(prepared, content)` | §7.1 requires the installed session content and the objects written into React to be the same references. Media hydration happens in the page between prepare and commit, so the hydrated project must travel into the session at commit time. |
| `CanvasSyncView` without a saved marker | adds `savedOnce: boolean` | §9.5 needs two renderings of `clean`: "已保存" once this session has saved, nothing before that. |
| `listCanvases(): Promise<CanvasProjectSummary[]>` | `listCanvases(): Promise<CanvasListResult>` | §10 requires stale list results to be dropped by scope token; a bare array cannot express `scope-changed` versus `failed`. |
| store state `activeProject: CanvasProject` | store action `getActiveProject(): CanvasProject | null` reading the active session content | Content changes on every edit (about 180 times per 3 s drag). Mirroring it into Zustand state re-renders the whole canvas page per frame and breaks §12's update-cost invariant. Its only consumers (asset cleanup, export) already read imperatively. |
| `CanvasRenameResult` as a string union | discriminated union whose `saved` case carries the new `CanvasProjectSummary` and whose `failed` case carries a `messageKey`, plus a `conflict` case | §10 requires the list card to distinguish "open the canvas to resolve the conflict" from a generic failure, and the list must show the server's new title, revision and `updatedAt` after a rename without an extra list request. |
| page hook returns `{ ready, project, applyProject, reloadServerCopy }` | hook takes `{ projectId, hydrate, applyToCanvas }` and returns `{ ready, status, errorKey, title, reopen, reloadServerCopy }` | `applyProject` writes page-local React state, so it is an input rather than an output. `title` replaces `project` because the page keeps content in its own React state and only needs the title; `status`, `errorKey` and `reopen` implement §7.1's retryable gate error and §9.5's invariant action. |

One file outside spec §13.2's table changes: `web/src/components/canvas/infinite-canvas.tsx` (Task 4). Spec §7.5 mandates a callback ref on the canvas container, and that container element is rendered inside `InfiniteCanvas`, so its `containerRef` prop must accept a callback ref. The change is a merged ref plus moving the existing wheel listener into it; no rendering or interaction behavior changes.

`web/src/lib/agent/agent-site-tools.ts` appears in spec §13.2's modify table but needs no change: it only reads `scope`, `listStatus`, `listError` and `summaries` and calls `refreshList()`, all of which keep their names and types. Task 3 re-checks this and leaves the file untouched when the check holds.

## File Boundary

Create:

| File | Responsibility |
| --- | --- |
| `web/src/services/canvas-sync/types.ts` | Constants, phases, view model, patch/result/failure types, `CanvasSyncSession` and `CanvasSyncManager` interfaces, recovery record types and the `CanvasLocalRecovery` interface, `CanvasSyncInvariantError`, `sameCanvasScope`, `settleWithin`. Imports only domain types; imported by every other file in the boundary. |
| `web/src/services/canvas-local-recovery.ts` | localforage `canvas_recovery` store, key construction, record validation, bounded read/write/delete, draft enumeration, bounded garbage collection, one-time legacy store drop. |
| `web/src/services/canvas-sync/canvas-sync-session.ts` | `resolveCanvasOpenRecovery` (spec §4.4 decision table) and `createCanvasSyncSession`: phase machine, monotonic counters, local single-slot scheduler, network single-flight scheduler, conflict and recovery handling, bounded dispose, conflict export. |
| `web/src/services/canvas-sync/canvas-sync-manager.ts` | Scope and scope token, single installed session, bounded detached set, prepare/commit for open and server-copy reload, list-level operations, subscription fan-out, per-canvas local cleanup. |
| `web/src/pages/canvas/hooks/use-canvas-project-sync.ts` | Page-private: prepare → hydrate → commit → apply, render gate, open error state, server-copy reload, reopen. |

Modify: `web/src/types/canvas.ts`, `web/src/services/canvas-repository.ts`, `web/src/lib/canvas/canvas-snapshot.ts`, `web/src/lib/canvas/canvas-export.ts`, `web/src/types/canvas-export.ts`, `web/src/stores/canvas/use-canvas-store.ts`, `web/src/stores/use-asset-store.ts`, `web/src/hooks/use-canvas-scope-sync.ts`, `web/src/pages/canvas/project.tsx`, `web/src/pages/canvas/index.tsx`, `web/src/pages/canvas/hooks/use-agent-bridge.ts`, `web/src/components/canvas/infinite-canvas.tsx`, `web/src/components/canvas/canvas-save-status.tsx`, `web/src/components/canvas/canvas-conflict-bar.tsx`, `web/src/components/canvas/canvas-top-bar.tsx`, `web/src/components/canvas/canvas-project-card.tsx`, `web/src/components/canvas/canvas-delete-projects-dialog.tsx`, `web/src/i18n/locales/zh-CN.ts`, `web/src/i18n/locales/en-US.ts`, `CHANGELOG.md`, `docs/content/docs/progress/pending-test.mdx`, `docs/content/docs/progress/todo.mdx`, `.superpowers/sdd/2026-08-26-cloud-canvases-assets/progress.md`.

Delete: `web/src/services/canvas-drafts.ts` (Task 3, together with its last importer).

Unchanged: `web/src/services/api/canvases.ts`, `web/src/stores/canvas/use-canvas-ui-store.ts`, `web/src/components/canvas/canvas-refresh-shell.tsx`, `web/src/lib/agent/agent-site-tools.ts`, `docs/content/docs/overview/features.mdx`.

## Task Map And Commits

| Task | Deliverable | Depends on | Commit subject |
| --- | --- | --- | --- |
| 1 | Domain types, repository boundary, local recovery store | — | `refactor: add canvas recovery store and sync types` |
| 2 | `CanvasSyncSession` and the open-recovery resolver | 1 | `refactor: add canvas sync session state machine` |
| 3 | `CanvasSyncManager`, store adapter, scope and asset consumers, delete `canvas-drafts.ts` | 1, 2 | `refactor: drive canvas store by sync manager` |
| 4 | Page prepare/commit hook, Agent gate, container callback ref, viewport | 3 | `refactor: drive canvas page by prepare/commit` |
| 5 | Save status, conflict bar, list/rename/delete results, i18n | 3, 4 | `fix: align canvas sync ui with session view` |
| 6 | Changelog, pending-test, todo, SDD ledger | 1-5 | `docs: record canvas sync session refactor` |

Spec §13.1 suggests three commits; this plan keeps that intent (Tasks 1-3 extract the session, Task 4 moves the page, Tasks 5-6 align UI and docs) while giving every task its own reviewable commit.

## Spec §11 Concurrency And Failure Matrix Coverage

| Spec §11 row | Owning task |
| --- | --- |
| Slow open A, fast open B, A returns late | Task 3 (token check inside `commitPrepared`), Task 4 (`cancelled` stays silent) |
| Switch to B while A's save is in flight | Task 2 (bounded dispose with at most one final save), Task 3 (detach on install) |
| Keep editing while the same canvas is saving | Task 2 (single flight, `max(0, 400 - (now - lastEditAt))` reschedule, no "已保存" while `editSeq > savedSeq`) |
| Edit A then immediately create B | Task 3 (`createCanvas` never awaits dispose), Task 2 (final save inside dispose, marker on 409) |
| Keep editing within 2 s after a 409 | Task 2 (conflict phase set synchronously, later edits rewrite the conflict draft) |
| Refresh the page after a conflict | Task 1 (persisted marker), Task 2 (`resolveCanvasOpenRecovery`) |
| A and B each conflicted | Task 1 (per-canvas marker key), Task 2 (resolver) |
| Edited during `recovery-blocked` | Task 2 (`retryRecovery` lineage rules, spec §8.3) |
| localforage rejects | Task 2 (`localPersist = "degraded"`), Task 5 (status and conflict-bar copy) |
| localforage never settles | Task 1 (per-call bounds), Task 2 (one slot, one drain, every wait bounded) |
| Edit after a 20 s save timeout | Task 1 (timeout classification), Task 2 (`save-error`, reschedule on edit, explicit retry recaptures current content) |
| Old 409 returns after a Workspace switch | Task 2 (session writes only to its captured scope), Task 3 (`setScope` detaches and never writes new-scope state) |
| Reload hydration takes 5 s | Task 4 (gate closed, Agent offline, atomic commit, failure restores the conflict view) |
| Partial delete failure | Task 3 (`allSettled` semantics, cleanup only for deleted ids), Task 5 (dialog) |
| Workspace switch during `mode=new` | Task 3 (`scope-changed` without navigation), Task 5 (scope-keyed auto-open in `pages/canvas/index.tsx`) |
| `pagehide` and hidden visibility | Task 4 (best-effort `flushProject`, no durability promise) |
| Agent context | Task 4 (`enabled` gate publishes `null` and rejects `applyOps`) |
| ResizeObserver | Task 4 (callback ref installs the observer, initial centering only for a zero viewport) |

## Spec §12 Resource Invariant Coverage

| Spec §12 invariant | Owning task |
| --- | --- |
| `update` costs one reference comparison per field plus counter increments | Task 2 |
| At most 25 full snapshot serialisations per 3 s drag | Task 2 (120 ms coalescing, network reuses the cached snapshot) |
| At most 1 pending draft record | Task 2 (single slot, overwrite) |
| At most 1 parallel local write | Task 2 (single drain, no promise chain) |
| At most 1 network request during a drag plus 1 after 400 ms | Task 2 (single flight plus 5 s max wait) |
| At most 3 full snapshots per session | Task 2 (slot, in-flight write, request payload sharing one snapshot cache) |
| At most 2 detached sessions, each at most 10 s | Task 3 (`MAX_DETACHED_SESSIONS`, forced hard stop for the oldest) |
| At most 9 full snapshots globally | Task 3 (bounded session count) |
| No `blob:` or signed URLs in snapshots or drafts | Task 2 (every write goes through `projectToSnapshot`) |
| Text and plugin `metadata.content` preserved verbatim | Task 2 (no new sanitisation; existing behavior verified in manual step) |
| 10 MiB request limit surfaces as a save error, never a conflict | Task 1 (classification), Task 5 (copy) |
| `revision_conflict` is the only conflict trigger | Task 1 (classification) |

---

### Task 1: Domain Types, Repository Boundary, Local Recovery Store

**Files:**
- Modify: `web/src/types/canvas.ts` (add `CanvasProject` and `CanvasScope`)
- Modify: `web/src/stores/canvas/use-canvas-store.ts` (import both types instead of declaring them; no behavior change)
- Modify: `web/src/services/canvas-repository.ts`
- Modify: `web/src/lib/canvas/canvas-snapshot.ts`, `web/src/lib/canvas/canvas-export.ts`, `web/src/types/canvas-export.ts`, `web/src/pages/canvas/project.tsx` (import path only)
- Create: `web/src/services/canvas-sync/types.ts`
- Create: `web/src/services/canvas-local-recovery.ts`
- Modify: `web/src/i18n/locales/zh-CN.ts`, `web/src/i18n/locales/en-US.ts` (only the keys listed in Step 6)
- Test: none. Spec §2.2 forbids adding a frontend test framework in this round; verification is the user-run commands in Step 7.

**Interfaces:**
- Consumes: existing `platformRequest`, `PlatformApiError`, `platformErrorTranslationKey` from `web/src/services/api/platform-client.ts`; existing `fetchCanvasList`, `fetchCanvas`, `createCanvas`, `saveCanvas`, `deleteCanvas` from `web/src/services/api/canvases.ts` (unchanged); existing `canvasToProject`, `summaryToProjectSummary`, `projectToSnapshot`, `projectToImportBody`, `clampCanvasTitle`, `CANVAS_TITLE_MAX_LENGTH`, `CanvasProjectSummary` from `web/src/lib/canvas/canvas-snapshot.ts`.
- Produces for Tasks 2-5: everything exported from `@/services/canvas-sync/types` (constants, `CanvasSyncPhase`, `CanvasSyncView`, `CanvasProjectPatch`, `CanvasSyncSession`, `CanvasSyncManager`, `CanvasLocalRecovery`, `CanvasDraftRecord`, `CanvasConflictMarker`, `CanvasConflictMarkerEntry`, `CanvasDraftScope`, `CanvasLoadResult`, `CanvasSaveInput`, `CanvasSyncRepository`, `CanvasSaveFailure`, `CanvasOpenFailure`, `PreparedCanvasOpen`, `CanvasCreateResult`, `CanvasRenameResult`, `CanvasDeleteResult`, `CanvasListResult`, `CanvasCommitServerCopyResult`, `CanvasRetryRecoveryResult`, `CanvasDisposeReason`, `CanvasSyncInvariantError`, `CanvasLocalRecoveryError`, `sameCanvasScope`, `settleWithin`), plus `canvasRepository`, `classifyCanvasSaveError`, `classifyCanvasOpenError` from `@/services/canvas-repository`, plus `canvasLocalRecovery`, `canvasDraftKey`, `canvasDraftKeyPrefix`, `canvasConflictMarkerKey` from `@/services/canvas-local-recovery`, plus `CanvasProject` and `CanvasScope` from `@/types/canvas`.

- [ ] **Step 1: Move `CanvasProject` and `CanvasScope` into the domain type module**

Cut both declarations out of `web/src/stores/canvas/use-canvas-store.ts` and append them to `web/src/types/canvas.ts` (which currently has no imports, so this is the only new import there and creates no cycle: `web/src/lib/canvas-theme.ts` imports nothing).

```ts
// web/src/types/canvas.ts
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";

/** 画布的前端权威内容结构；服务端只存 snapshot，id/时间戳/revision 以服务端返回为准。 */
export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};

/** 画布数据作用域 = 已登录 userId + 当前 Workspace ID。 */
export type CanvasScope = { userId: string; workspaceId: string };
```

In `use-canvas-store.ts` replace the deleted declarations with `import type { CanvasProject, CanvasScope } from "@/types/canvas";` and keep every other line of that file untouched in this task.

- [ ] **Step 2: Repoint the five type importers**

Run `rg -n 'from "@/stores/canvas/use-canvas-store"' web/src` and change only the imports that pull `CanvasProject`: `web/src/services/canvas-repository.ts`, `web/src/types/canvas-export.ts`, `web/src/lib/canvas/canvas-snapshot.ts`, `web/src/lib/canvas/canvas-export.ts`, `web/src/pages/canvas/project.tsx`. Each becomes `import type { CanvasProject } from "@/types/canvas";`. In `project.tsx` the line is `import { isScopeChangedError, useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";`; split it into the value import (kept as-is minus the type) and a new type import. Value imports of `useCanvasStore` stay pointed at the store.

- [ ] **Step 3: Create `web/src/services/canvas-sync/types.ts` with the constants and the local recovery contract**

This file holds every shared type and constant of the sync boundary. It imports only `@infinite-canvas/contracts`, `@/lib/canvas/canvas-snapshot` (type only) and `@/types/canvas`, so nothing in the boundary can form an import cycle.

```ts
import type { CanvasSnapshot } from "@infinite-canvas/contracts";

import type { CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import type { CanvasProject, CanvasScope } from "@/types/canvas";

export const LOCAL_COALESCE_MS = 120;
export const NETWORK_DEBOUNCE_MS = 400;
export const NETWORK_MAX_WAIT_MS = 5_000;
export const SAVE_REQUEST_TIMEOUT_MS = 20_000;
export const LOAD_REQUEST_TIMEOUT_MS = 20_000;
export const LOCAL_READ_TIMEOUT_MS = 2_000;
export const LOCAL_FLUSH_TIMEOUT_MS = 2_000;
export const DETACHED_LOCAL_MS = 2_000;
export const DETACHED_NETWORK_MS = 10_000;
export const MAX_DETACHED_SESSIONS = 2;
export const EXPORT_BATCH_SIZE = 3;
export const DRAFT_GC_MIN_AGE_MS = 6 * 60 * 60 * 1_000;
export const MAX_CONFLICT_MARKER_ENTRIES = 2;

export type CanvasSyncPhase = "loading" | "clean" | "dirty" | "saving" | "save-error" | "conflict" | "recovery-blocked" | "disposing" | "disposed";
export type CanvasSaveErrorKind = "network" | "timeout" | "server" | "invariant";
export type CanvasLocalPersistState = "ok" | "degraded";
export type CanvasSyncSaveError = { kind: CanvasSaveErrorKind; messageKey: string };
export type CanvasSyncConflictView = { baseRevision: number; source: "save" | "restored"; extraDraftCount: number };

/** 会话对外导出的唯一可渲染事实；字段变化时整体替换。 */
export type CanvasSyncView = {
    canvasId: string;
    scope: CanvasScope;
    title: string;
    revision: number;
    phase: CanvasSyncPhase;
    hasUnsavedEdits: boolean;
    /** 本会话至少成功保存过一次，用于区分「已保存」与「打开后从未保存」。 */
    savedOnce: boolean;
    saveError: CanvasSyncSaveError | null;
    localPersist: CanvasLocalPersistState;
    conflict: CanvasSyncConflictView | null;
};

export type CanvasProjectPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>;
export const CANVAS_PATCH_FIELDS = ["nodes", "connections", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo", "viewport"] as const;

export type CanvasDisposeReason = "replaced" | "scope-changed" | "deleted" | "forced";
export type CanvasRetryRecoveryResult = "unlocked" | "conflict" | "failed";
export type CanvasRenameOutcome = "scheduled" | "local-only";

export type CanvasDraftScope = { userId: string; workspaceId: string; canvasId: string };
export type CanvasDraftState = "pending" | "synced";

export type CanvasDraftRecord = {
    userId: string;
    workspaceId: string;
    canvasId: string;
    draftId: string;
    /** 该内容所基于的服务端 revision。 */
    baseRevision: number;
    /** pending：尚未确认保存到服务端；synced：内容已被服务端在 baseRevision 确认。 */
    state: CanvasDraftState;
    title: string;
    snapshot: CanvasSnapshot;
    savedAt: string;
};

export type CanvasConflictMarkerEntry = { draftKey: string; draftId: string; baseRevision: number; savedAt: string };

export type CanvasConflictMarker = {
    userId: string;
    workspaceId: string;
    canvasId: string;
    /** 最新在前，最多 MAX_CONFLICT_MARKER_ENTRIES 条。 */
    entries: CanvasConflictMarkerEntry[];
};

/** 本地读取超时或抛错时抛出；与「记录无效」（返回 null）是两种不同结果。 */
export class CanvasLocalRecoveryError extends Error {
    constructor(readonly operation: string) {
        super("canvas_local_recovery_failed:" + operation);
        this.name = "CanvasLocalRecoveryError";
    }
}

/** 每个方法自带单次调用上界，只做存取与校验，不做调度，不判断冲突语义。 */
export interface CanvasLocalRecovery {
    readMarker(scope: CanvasDraftScope): Promise<CanvasConflictMarker | null>;
    writeMarker(marker: CanvasConflictMarker): Promise<void>;
    deleteMarker(scope: CanvasDraftScope): Promise<void>;
    readDraftByKey(key: string): Promise<CanvasDraftRecord | null>;
    writeDraft(record: CanvasDraftRecord): Promise<void>;
    deleteDraftByKey(key: string): Promise<void>;
    /** 前缀枚举该画布全部草稿，savedAt 新的在前。 */
    listCanvasDrafts(scope: CanvasDraftScope): Promise<CanvasDraftRecord[]>;
    /** 删除该画布下不在 keepKeys 中且超过 DRAFT_GC_MIN_AGE_MS 的草稿；失败忽略。 */
    collectGarbage(scope: CanvasDraftScope, keepKeys: string[]): Promise<void>;
}
```

The rest of the same file carries the network-boundary and orchestration contracts.

```ts
export type CanvasLoadResult = { project: CanvasProject; revision: number };
export type CanvasSaveInput = { baseRevision: number; title: string; snapshot: CanvasSnapshot };

/** 纯 HTTP 映射，不引用 store/manager；session 与 manager 通过它注入网络依赖。 */
export interface CanvasSyncRepository {
    list(workspaceId: string): Promise<CanvasProjectSummary[]>;
    load(workspaceId: string, canvasId: string): Promise<CanvasLoadResult>;
    create(workspaceId: string, title: string): Promise<CanvasLoadResult>;
    importProject(workspaceId: string, body: { title: string; snapshot: CanvasSnapshot }): Promise<CanvasLoadResult>;
    save(workspaceId: string, canvasId: string, input: CanvasSaveInput, signal?: AbortSignal): Promise<CanvasLoadResult>;
    remove(workspaceId: string, canvasId: string): Promise<void>;
}

export type CanvasSaveFailure = { kind: "conflict" } | { kind: "network" | "timeout" | "server"; messageKey: string };
export type CanvasOpenFailure = { kind: "missing" } | { kind: "failed"; messageKey: string };

export type CanvasSyncInvariantContext = { sessionId: number; canvasId: string; phase: CanvasSyncPhase; event: string; editSeq: number; savedSeq: number; inflightSeq: number; revision: number };

export class CanvasSyncInvariantError extends Error {
    constructor(readonly context: CanvasSyncInvariantContext) {
        super("canvas_sync_invariant_violation");
        this.name = "CanvasSyncInvariantError";
    }
}

export interface CanvasSyncSession {
    readonly sessionId: number;
    readonly canvasId: string;
    readonly scope: CanvasScope;
    readonly scopeToken: number;
    readonly openToken: number;
    /** 本会话唯一的草稿键，供 manager 在回收与清理时保留或删除。 */
    readonly draftKey: string;
    readonly view: CanvasSyncView;
    /** 当前权威前端内容，引用稳定，供导出与素材引用判定使用。 */
    readonly content: CanvasProject;
    /** 由 manager 在 commit 时调用，携带补水后的内容；重复调用视为不变量事故。 */
    install(content: CanvasProject): void;
    /** 返回是否记为一次真实编辑；字段引用全同或阶段不接受编辑时返回 false。 */
    update(patch: CanvasProjectPatch): boolean;
    /** 标题在调用前已由 clampCanvasTitle 截断到 CANVAS_TITLE_MAX_LENGTH。 */
    rename(title: string): CanvasRenameOutcome;
    /** 强制物化本地并在允许时提交一次；内部全部有界。 */
    flush(): Promise<void>;
    retrySave(): Promise<void>;
    retryRecovery(): Promise<CanvasRetryRecoveryResult>;
    exportConflictDrafts(): Promise<CanvasProject[]>;
    dispose(reason: CanvasDisposeReason): Promise<void>;
    subscribe(listener: (view: CanvasSyncView) => void): () => void;
}

export type PreparedCanvasOpen =
    | { status: "ready"; canvasId: string; project: CanvasProject; session: CanvasSyncSession }
    | { status: "cancelled" }
    | { status: "missing" }
    | { status: "failed"; messageKey: string };

export type CanvasCreateResult =
    | { status: "created"; canvasId: string; summary: CanvasProjectSummary }
    | { status: "scope-changed" }
    | { status: "failed"; messageKey: string };

export type CanvasListResult =
    | { status: "ready"; summaries: CanvasProjectSummary[] }
    | { status: "scope-changed" }
    | { status: "failed"; messageKey: string };

/** saved 携带服务端返回的新摘要，列表不必为一次重命名再刷新一次。 */
export type CanvasRenameResult =
    | { status: "scheduled" }
    | { status: "saved"; summary: CanvasProjectSummary }
    | { status: "local-only" }
    | { status: "conflict" }
    | { status: "scope-changed" }
    | { status: "failed"; messageKey: string };
export type CanvasDeleteResult = { deleted: string[]; failed: string[] };
export type CanvasCommitServerCopyResult = "committed" | "cancelled" | "failed";

export interface CanvasSyncManager {
    getScope(): CanvasScope | null;
    setScope(scope: CanvasScope | null): void;
    getActiveSession(): CanvasSyncSession | null;
    prepareOpen(canvasId: string): Promise<PreparedCanvasOpen>;
    /** content 必须是补水后的对象，与页面写入 React 的引用完全相同。 */
    commitPrepared(prepared: PreparedCanvasOpen, content: CanvasProject): boolean;
    prepareServerCopy(canvasId: string): Promise<PreparedCanvasOpen>;
    commitServerCopy(prepared: PreparedCanvasOpen, content: CanvasProject): CanvasCommitServerCopyResult;
    listCanvases(): Promise<CanvasListResult>;
    createCanvas(title: string): Promise<CanvasCreateResult>;
    importCanvas(source: Partial<CanvasProject>, fallbackTitle: string): Promise<CanvasCreateResult>;
    renameCanvas(canvasId: string, title: string): Promise<CanvasRenameResult>;
    deleteCanvases(canvasIds: string[]): Promise<CanvasDeleteResult>;
    loadForExport(canvasIds: string[]): Promise<CanvasProject[]>;
    subscribe(listener: () => void): () => void;
}

export function sameCanvasScope(a: CanvasScope | null | undefined, b: CanvasScope | null | undefined) {
    return Boolean(a && b && a.userId === b.userId && a.workspaceId === b.workspaceId);
}

export type BoundedResult<T> = { status: "ok"; value: T } | { status: "failed" };

/** 所有等待点都必须有上界：慢速或永不返回的本地存储不得冻结云端保存与打开画布。 */
export function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ status: "failed" });
        }, timeoutMs);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ status: "ok", value });
            },
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ status: "failed" });
            },
        );
    });
}
```

`CanvasRenameResult` is a discriminated union rather than the spec §9.3 draft's string union: `saved` carries the server's new summary so the list shows the real title, revision and `updatedAt` without another request, `conflict` lets the list card say "打开该画布处理冲突" instead of a generic failure (spec §10 requires that distinction), and `failed` carries the message key to render.

- [ ] **Step 4: Harden `web/src/services/canvas-repository.ts` and expose it as `canvasRepository`**

`web/src/services/api/canvases.ts` stays unchanged (spec §13.2), so read requests cannot be aborted; their 20 s bound only stops the wait, and the late response is discarded by the caller's token check. Save requests already accept a signal, so they abort for real and also accept an external signal used by forced dispose in Task 3.

```ts
import type { Canvas, CanvasSnapshot } from "@infinite-canvas/contracts";

import { canvasToProject, summaryToProjectSummary, type CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import { createCanvas, deleteCanvas, fetchCanvas, fetchCanvasList, saveCanvas } from "@/services/api/canvases";
import { PlatformApiError, platformErrorTranslationKey } from "@/services/api/platform-client";
import { LOAD_REQUEST_TIMEOUT_MS, SAVE_REQUEST_TIMEOUT_MS, type CanvasLoadResult, type CanvasOpenFailure, type CanvasSaveFailure, type CanvasSaveInput, type CanvasSyncRepository } from "@/services/canvas-sync/types";

export const REVISION_CONFLICT_CODE = "revision_conflict";
const CANVAS_NOT_FOUND_CODE = "canvas_not_found";
const SNAPSHOT_TOO_LARGE_CODE = "canvas_snapshot_too_large";
const NETWORK_ERROR_CODE = "platform_network_error";

export class CanvasRequestTimeoutError extends Error {
    constructor() {
        super("canvas_request_timeout");
        this.name = "CanvasRequestTimeoutError";
    }
}

export function isRevisionConflictError(error: unknown) {
    return error instanceof PlatformApiError && error.code === REVISION_CONFLICT_CODE;
}

/** 读取只解除等待，不中止请求；真实拒绝原样抛出，404 与超时因此不会互相污染。 */
function withReadTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new CanvasRequestTimeoutError()), LOAD_REQUEST_TIMEOUT_MS);
        operation.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

async function saveWithTimeout(workspaceId: string, canvasId: string, input: CanvasSaveInput, external?: AbortSignal): Promise<CanvasLoadResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, SAVE_REQUEST_TIMEOUT_MS);
    const abortFromExternal = () => controller.abort();
    if (external?.aborted) controller.abort();
    else external?.addEventListener("abort", abortFromExternal, { once: true });
    try {
        return toResult(await saveCanvas(workspaceId, canvasId, input, controller.signal));
    } catch (error) {
        throw timedOut ? new CanvasRequestTimeoutError() : error;
    } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", abortFromExternal);
    }
}

/** revision_conflict 是唯一的冲突来源；canvas_revision_limit_reached 等 409 落在最后一条分支，按 server 处理。 */
export function classifyCanvasSaveError(error: unknown): CanvasSaveFailure {
    if (isRevisionConflictError(error)) return { kind: "conflict" };
    if (error instanceof CanvasRequestTimeoutError) return { kind: "timeout", messageKey: "canvas.save.failed" };
    if (error instanceof PlatformApiError && error.code === SNAPSHOT_TOO_LARGE_CODE) return { kind: "server", messageKey: "canvas.save.tooLarge" };
    if (error instanceof PlatformApiError && error.code === NETWORK_ERROR_CODE) return { kind: "network", messageKey: "canvas.save.failed" };
    return { kind: "server", messageKey: "canvas.save.failed" };
}

export function classifyCanvasOpenError(error: unknown): CanvasOpenFailure {
    if (error instanceof PlatformApiError && (error.code === CANVAS_NOT_FOUND_CODE || error.status === 404)) return { kind: "missing" };
    return { kind: "failed", messageKey: platformErrorTranslationKey(error, "canvas.openFailed") };
}

export const canvasRepository: CanvasSyncRepository = {
    list: async (workspaceId) => (await withReadTimeout(fetchCanvasList(workspaceId))).map(summaryToProjectSummary),
    load: async (workspaceId, canvasId) => toResult(await withReadTimeout(fetchCanvas(workspaceId, canvasId))),
    create: async (workspaceId, title) => toResult(await withReadTimeout(createCanvas(workspaceId, { title }))),
    importProject: async (workspaceId, body) => toResult(await withReadTimeout(createCanvas(workspaceId, body))),
    save: (workspaceId, canvasId, input, signal) => saveWithTimeout(workspaceId, canvasId, input, signal),
    remove: async (workspaceId, canvasId) => {
        await withReadTimeout(deleteCanvas(workspaceId, canvasId));
    },
};

/** 旧 store 仍在调用，Task 3 删除这些包装。 */
export const listCanvasSummaries = (workspaceId: string): Promise<CanvasProjectSummary[]> => canvasRepository.list(workspaceId);
export const loadCanvasProject = (workspaceId: string, canvasId: string) => canvasRepository.load(workspaceId, canvasId);
export const createCanvasProject = (workspaceId: string, title: string) => canvasRepository.create(workspaceId, title);
export const importCanvasProject = (workspaceId: string, body: { title: string; snapshot: CanvasSnapshot }) => canvasRepository.importProject(workspaceId, body);
export const saveCanvasProject = (workspaceId: string, canvasId: string, input: CanvasSaveInput) => canvasRepository.save(workspaceId, canvasId, input);
export const deleteCanvasProject = (workspaceId: string, canvasId: string) => canvasRepository.remove(workspaceId, canvasId);

function toResult(canvas: Canvas): CanvasLoadResult {
    return { project: canvasToProject(canvas), revision: canvas.revision };
}
```

Keep the legacy wrappers exactly as written: the old store still imports them at this commit, and Task 3 removes both them and their importer together.

- [ ] **Step 5: Create `web/src/services/canvas-local-recovery.ts`**

Keys follow spec §4.1: `canvas-draft:<userId>:<workspaceId>:<canvasId>:<draftId>` and `canvas-conflict:<userId>:<workspaceId>:<canvasId>`, every part `encodeURIComponent`-encoded. Revision lives in the record body, not in the key, so a session writes one key for its whole life and there is no handoff window.

```ts
import localforage from "localforage";

import {
    DRAFT_GC_MIN_AGE_MS,
    LOCAL_FLUSH_TIMEOUT_MS,
    LOCAL_READ_TIMEOUT_MS,
    MAX_CONFLICT_MARKER_ENTRIES,
    settleWithin,
    CanvasLocalRecoveryError,
    type CanvasConflictMarker,
    type CanvasConflictMarkerEntry,
    type CanvasDraftRecord,
    type CanvasDraftScope,
    type CanvasLocalRecovery,
} from "@/services/canvas-sync/types";

const recoveryStore = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_recovery" });
const DRAFT_PREFIX = "canvas-draft";
const CONFLICT_PREFIX = "canvas-conflict";

/** 项目尚未上线，不保留旧键兼容层：模块首次加载时丢弃一次旧 store，失败忽略。 */
void localforage.dropInstance({ name: "infinite-canvas", storeName: "canvas_drafts" }).catch(() => undefined);

export function canvasDraftKeyPrefix(scope: CanvasDraftScope) {
    return [DRAFT_PREFIX, encodeURIComponent(scope.userId), encodeURIComponent(scope.workspaceId), encodeURIComponent(scope.canvasId), ""].join(":");
}

export function canvasDraftKey(scope: CanvasDraftScope, draftId: string) {
    return canvasDraftKeyPrefix(scope) + encodeURIComponent(draftId);
}

export function canvasConflictMarkerKey(scope: CanvasDraftScope) {
    return [CONFLICT_PREFIX, encodeURIComponent(scope.userId), encodeURIComponent(scope.workspaceId), encodeURIComponent(scope.canvasId)].join(":");
}

/** 超时或抛错一律抛 CanvasLocalRecoveryError；「读不出来」绝不能降级成「没有草稿」。 */
async function bounded<T>(operation: string, work: Promise<T>, timeoutMs: number): Promise<T> {
    const result = await settleWithin(work, timeoutMs);
    if (result.status !== "ok") throw new CanvasLocalRecoveryError(operation);
    return result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asDraftRecord(value: unknown, key: string): CanvasDraftRecord | null {
    if (!isRecord(value)) return null;
    const { userId, workspaceId, canvasId, draftId, baseRevision, state, title, snapshot, savedAt } = value;
    if (typeof userId !== "string" || typeof workspaceId !== "string" || typeof canvasId !== "string" || typeof draftId !== "string") return null;
    if (!isRevision(baseRevision) || (state !== "pending" && state !== "synced") || typeof title !== "string" || typeof savedAt !== "string" || !isRecord(snapshot)) return null;
    /** 键里已经带完整作用域，键与记录不一致即视为无效，等价于逐字段比对请求作用域。 */
    if (canvasDraftKey({ userId, workspaceId, canvasId }, draftId) !== key) return null;
    return value as CanvasDraftRecord;
}

function asMarkerEntry(value: unknown): CanvasConflictMarkerEntry | null {
    if (!isRecord(value)) return null;
    const { draftKey, draftId, baseRevision, savedAt } = value;
    if (typeof draftKey !== "string" || typeof draftId !== "string" || !isRevision(baseRevision) || typeof savedAt !== "string") return null;
    return { draftKey, draftId, baseRevision, savedAt };
}

function asMarker(value: unknown, scope: CanvasDraftScope): CanvasConflictMarker | null {
    if (!isRecord(value)) return null;
    const { userId, workspaceId, canvasId, entries } = value;
    if (userId !== scope.userId || workspaceId !== scope.workspaceId || canvasId !== scope.canvasId) return null;
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_CONFLICT_MARKER_ENTRIES) return null;
    const parsed = entries.map(asMarkerEntry);
    if (parsed.some((entry) => entry === null)) return null;
    return { userId, workspaceId, canvasId, entries: parsed as CanvasConflictMarkerEntry[] };
}

export const canvasLocalRecovery: CanvasLocalRecovery = {
    readMarker: async (scope) => {
        const key = canvasConflictMarkerKey(scope);
        const value = await bounded("readMarker", recoveryStore.getItem<unknown>(key), LOCAL_READ_TIMEOUT_MS);
        if (value === null || value === undefined) return null;
        const marker = asMarker(value, scope);
        /** 结构性损坏的 marker 由存储层自行清理；「条目全部指向无效草稿」是语义判断，交给会话解析器。 */
        if (!marker) {
            await settleWithin(recoveryStore.removeItem(key), LOCAL_FLUSH_TIMEOUT_MS);
            return null;
        }
        return marker;
    },
    writeMarker: async (marker) => {
        await bounded("writeMarker", recoveryStore.setItem(canvasConflictMarkerKey(marker), marker), LOCAL_FLUSH_TIMEOUT_MS);
    },
    deleteMarker: async (scope) => {
        await bounded("deleteMarker", recoveryStore.removeItem(canvasConflictMarkerKey(scope)), LOCAL_FLUSH_TIMEOUT_MS);
    },
    readDraftByKey: async (key) => {
        const value = await bounded("readDraftByKey", recoveryStore.getItem<unknown>(key), LOCAL_READ_TIMEOUT_MS);
        return asDraftRecord(value, key);
    },
    writeDraft: async (record) => {
        await bounded("writeDraft", recoveryStore.setItem(canvasDraftKey(record, record.draftId), record), LOCAL_FLUSH_TIMEOUT_MS);
    },
    deleteDraftByKey: async (key) => {
        await bounded("deleteDraftByKey", recoveryStore.removeItem(key), LOCAL_FLUSH_TIMEOUT_MS);
    },
    listCanvasDrafts: async (scope) => {
        const prefix = canvasDraftKeyPrefix(scope);
        const records: CanvasDraftRecord[] = [];
        await bounded(
            "listCanvasDrafts",
            recoveryStore.iterate<unknown, void>((value, key) => {
                if (!key.startsWith(prefix)) return;
                const record = asDraftRecord(value, key);
                /** 校验失败只跳过，不删除；删除只发生在 collectGarbage。 */
                if (record) records.push(record);
            }),
            LOCAL_READ_TIMEOUT_MS,
        );
        return records.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    collectGarbage: async (scope, keepKeys) => {
        const prefix = canvasDraftKeyPrefix(scope);
        const keep = new Set(keepKeys);
        const now = Date.now();
        const stale: string[] = [];
        const scan = await settleWithin(
            recoveryStore.iterate<unknown, void>((value, key) => {
                if (!key.startsWith(prefix) || keep.has(key)) return;
                const record = asDraftRecord(value, key);
                const savedAt = record ? Date.parse(record.savedAt) : Number.NaN;
                /** 6 小时年龄阈值给同源其他标签页留出活草稿的安全边界。 */
                if (Number.isFinite(savedAt) && now - savedAt > DRAFT_GC_MIN_AGE_MS) stale.push(key);
            }),
            LOCAL_READ_TIMEOUT_MS,
        );
        if (scan.status !== "ok" || !stale.length) return;
        await settleWithin(Promise.allSettled(stale.map((key) => recoveryStore.removeItem(key))), LOCAL_FLUSH_TIMEOUT_MS);
    },
};
```

`collectGarbage` never throws: garbage collection failure must not affect canvas availability (spec §4.5).

- [ ] **Step 6: Add the four message keys that non-UI code references**

Insert into the existing `canvas` block of `web/src/i18n/locales/zh-CN.ts` and the matching block of `web/src/i18n/locales/en-US.ts`. Keep the existing keys untouched; Task 5 adds the remaining UI strings.

```ts
// zh-CN.ts, inside canvas: { ... }
openFailed: "打开画布失败，请稍后重试",
notFound: "画布不存在或已被删除",
// zh-CN.ts, inside canvas.save: { ... }
tooLarge: "画布内容过大，暂时无法保存到云端",
invariant: "同步状态异常，请重新载入画布",

// en-US.ts, inside canvas: { ... }
openFailed: "Could not open the canvas. Try again.",
notFound: "This canvas no longer exists.",
// en-US.ts, inside canvas.save: { ... }
tooLarge: "This canvas is too large to save to the cloud.",
invariant: "Sync state is inconsistent. Reload the canvas.",
```

- [ ] **Step 7: Hand the user the verification commands (do not run them)**

Run: `bun --cwd web run typecheck`
Expected: no errors. The moved `CanvasProject`/`CanvasScope` declarations and their five importers are the only type-surface change, and the two new files are not imported by anything yet.

Run: `bun --cwd web run build`
Expected: build succeeds. `canvas-sync/types.ts` and `canvas-local-recovery.ts` are currently unreferenced, so they may be tree-shaken out of the bundle; that is expected at this commit.

Manual check: open a canvas, edit it, confirm saving still behaves exactly as before this task. Nothing about runtime behavior changes yet — the old store still owns the algorithm, and `canvas_recovery` stays empty. The one-time `canvas_drafts` drop only executes once `canvas-local-recovery.ts` is actually imported, which happens in Task 3 where `canvas-drafts.ts` is deleted in the same commit.

- [ ] **Step 8: Commit**

```bash
git add web/src/types/canvas.ts web/src/types/canvas-export.ts web/src/stores/canvas/use-canvas-store.ts web/src/services/canvas-repository.ts web/src/services/canvas-local-recovery.ts web/src/services/canvas-sync/types.ts web/src/lib/canvas/canvas-snapshot.ts web/src/lib/canvas/canvas-export.ts web/src/pages/canvas/project.tsx web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
git commit -m "refactor: add canvas recovery store and sync types"
```

`CHANGELOG.md` is intentionally untouched here: this task changes no user-visible behavior, and Task 6 writes the single version-level entry for the whole refactor.

### Task 2: Canvas Sync Session State Machine And Dual Schedulers

**Files:**
- Create: `web/src/services/canvas-sync/canvas-sync-session.ts`
- Test: none (spec §2.2). The session takes `repository`, `recovery`, `now` and `createDraftId` as injected dependencies precisely so tests can be added later without changing this structure.

**Interfaces:**
- Consumes from Task 1: `@/services/canvas-sync/types` (all constants and types), `canvasDraftKey` and `canvasDraftKeyPrefix` from `@/services/canvas-local-recovery`, `classifyCanvasSaveError` from `@/services/canvas-repository`, `projectToSnapshot`, `snapshotToProjectContent`, `draftToProject`, `clampCanvasTitle` from `@/lib/canvas/canvas-snapshot`.
- Produces for Task 3:

```ts
export type CanvasSyncSessionDeps = {
    repository: CanvasSyncRepository;
    recovery: CanvasLocalRecovery;
    now: () => number;
    createDraftId: () => string;
    isDev: boolean;
};

export type CanvasRecoveryResolution = {
    phase: "clean" | "dirty" | "conflict" | "recovery-blocked";
    /** 冲突或 dirty 时是本地草稿叠加后的内容，其余是服务端内容。 */
    content: CanvasProject;
    revision: number;
    /** 复用被恢复草稿的 draftId，使会话继续写同一条记录；否则是新的 nanoid。 */
    draftId: string;
    conflict: CanvasSyncConflictView | null;
};

export function resolveCanvasOpenRecovery(deps: Pick<CanvasSyncSessionDeps, "recovery" | "createDraftId">, scope: CanvasScope, load: CanvasLoadResult): Promise<CanvasRecoveryResolution>;

export type CanvasSessionInit = {
    sessionId: number;
    scope: CanvasScope;
    scopeToken: number;
    openToken: number;
    canvasId: string;
    resolution: CanvasRecoveryResolution;
};

export function createCanvasSyncSession(init: CanvasSessionInit, deps: CanvasSyncSessionDeps): CanvasSyncSession;
```

- [ ] **Step 1: Implement `resolveCanvasOpenRecovery` exactly as spec §4.4's ordered table**

```ts
/** 本地存储偶发超时很常见：自动重试一次，真正读不出来才是 recovery-blocked。 */
async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch {
        return await read();
    }
}

function restoreContent(server: CanvasProject, draft: CanvasDraftRecord): CanvasProject {
    return { ...server, ...snapshotToProjectContent(draft.snapshot), title: draft.title || server.title };
}

export async function resolveCanvasOpenRecovery(
    deps: Pick<CanvasSyncSessionDeps, "recovery" | "createDraftId">,
    scope: CanvasScope,
    load: CanvasLoadResult,
): Promise<CanvasRecoveryResolution> {
    const canvasId = load.project.id;
    const draftScope: CanvasDraftScope = { userId: scope.userId, workspaceId: scope.workspaceId, canvasId };
    const server: CanvasRecoveryResolution = { phase: "clean", content: load.project, revision: load.revision, draftId: deps.createDraftId(), conflict: null };

    let marker: CanvasConflictMarker | null;
    let drafts: CanvasDraftRecord[];
    try {
        marker = await readWithRetry(() => deps.recovery.readMarker(draftScope));
        drafts = await readWithRetry(() => deps.recovery.listCanvasDrafts(draftScope));
    } catch {
        /** 读不出来是第三种状态，不是「没有冲突」：以服务端内容打开并阻断网络保存。 */
        return { ...server, phase: "recovery-blocked" };
    }

    const draftByKey = new Map(drafts.map((draft) => [canvasDraftKey(draftScope, draft.draftId), draft] as const));

    if (marker) {
        const valid = marker.entries.filter((entry) => draftByKey.has(entry.draftKey));
        if (valid.length) {
            /** entries[0] 无效时剔除无效条目并重写 marker，最新的一条永远排在最前。 */
            if (valid.length !== marker.entries.length) {
                await settleWithin(deps.recovery.writeMarker({ ...marker, entries: valid }), LOCAL_FLUSH_TIMEOUT_MS);
            }
            const draft = draftByKey.get(valid[0].draftKey) as CanvasDraftRecord;
            return {
                phase: "conflict",
                content: restoreContent(load.project, draft),
                revision: load.revision,
                draftId: draft.draftId,
                conflict: { baseRevision: draft.baseRevision, source: "restored", extraDraftCount: valid.length - 1 },
            };
        }
        /** 全部条目都指向已消失或校验失败的草稿，这条 marker 才算确认失效。 */
        await settleWithin(deps.recovery.deleteMarker(draftScope), LOCAL_FLUSH_TIMEOUT_MS);
    }

    const pending = drafts.find((draft) => draft.state === "pending");
    if (pending && pending.baseRevision === load.revision) {
        /** 同 revision 的未确认草稿：内容照常恢复，并立即安排一次保存。 */
        return { phase: "dirty", content: restoreContent(load.project, pending), revision: load.revision, draftId: pending.draftId, conflict: null };
    }
    if (pending) {
        /** 崩溃或离线路径产生的冲突：提升为 marker 后按冲突处理。 */
        const entry: CanvasConflictMarkerEntry = { draftKey: canvasDraftKey(draftScope, pending.draftId), draftId: pending.draftId, baseRevision: pending.baseRevision, savedAt: pending.savedAt };
        await settleWithin(deps.recovery.writeMarker({ ...draftScope, entries: [entry] }), LOCAL_FLUSH_TIMEOUT_MS);
        return {
            phase: "conflict",
            content: restoreContent(load.project, pending),
            revision: load.revision,
            draftId: pending.draftId,
            conflict: { baseRevision: pending.baseRevision, source: "restored", extraDraftCount: 0 },
        };
    }

    /** state === "synced" 表示服务端已确认过这份内容，打开时直接删除，绝不当作冲突。 */
    drafts
        .filter((draft) => draft.state === "synced")
        .forEach((draft) => void settleWithin(deps.recovery.deleteDraftByKey(canvasDraftKey(draftScope, draft.draftId)), LOCAL_FLUSH_TIMEOUT_MS));
    return server;
}
```

Every write in the resolver is best-effort and bounded: a failed marker rewrite or draft delete never changes the resolved phase, and a cancelled open leaves only idempotent local repairs behind.

- [ ] **Step 2: Implement the session shell: counters, single transition entry, view emission, `install`, `update`, `rename`**

```ts
const ACTIVE_PHASES: CanvasSyncPhase[] = ["clean", "dirty", "saving", "save-error", "conflict", "recovery-blocked"];
type SessionEvent = "install" | "update" | "localTick" | "networkTick" | "saveAck" | "saveConflict" | "saveFail" | "retrySave" | "retryRecovery" | "flush" | "dispose";

const ALLOWED_PHASES: Record<SessionEvent, CanvasSyncPhase[]> = {
    install: ["loading"],
    update: ACTIVE_PHASES,
    localTick: ACTIVE_PHASES,
    networkTick: ["dirty", "saving", "save-error"],
    saveAck: ["saving"],
    saveConflict: ["saving"],
    saveFail: ["saving"],
    retrySave: ["dirty", "save-error"],
    retryRecovery: ["recovery-blocked"],
    flush: ACTIVE_PHASES,
    dispose: [...ACTIVE_PHASES, "loading"],
};

export function createCanvasSyncSession(init: CanvasSessionInit, deps: CanvasSyncSessionDeps): CanvasSyncSession {
    const { sessionId, scope, scopeToken, openToken, canvasId, resolution } = init;
    const draftScope: CanvasDraftScope = { userId: scope.userId, workspaceId: scope.workspaceId, canvasId };
    const draftKey = canvasDraftKey(draftScope, resolution.draftId);

    let phase: CanvasSyncPhase = "loading";
    let content = resolution.content;
    let revision = resolution.revision;
    let editSeq = 0;
    let materializedSeq = 0;
    let persistedSeq = 0;
    let savedSeq = 0;
    let inflightSeq = -1;
    let savedOnce = false;
    let localPersist: CanvasLocalPersistState = "ok";
    let saveError: CanvasSyncSaveError | null = null;
    let conflict: CanvasSyncConflictView | null = resolution.conflict;
    /** 冲突草稿固定基于产生冲突时的 baseRevision，不随后续服务端 revision 变化。 */
    let conflictBaseRevision: number | null = resolution.conflict ? resolution.conflict.baseRevision : null;
    let lastEditAt = 0;
    let firstUnsavedEditAt = 0;
    let localTimer: ReturnType<typeof setTimeout> | null = null;
    let networkTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotCache: { seq: number; title: string; snapshot: CanvasSnapshot } | null = null;
    let pendingSlot: { record: CanvasDraftRecord; seq: number; deleteAfterWrite: boolean } | null = null;
    let drainPromise: Promise<void> | null = null;
    let inflightController: AbortController | null = null;
    let disposePromise: Promise<void> | null = null;
    let emitted: CanvasSyncView | null = null;
    const listeners = new Set<(view: CanvasSyncView) => void>();

    const invariantContext = (event: string): CanvasSyncInvariantContext => ({ sessionId, canvasId, phase, event, editSeq, savedSeq, inflightSeq, revision });

    function assertEvent(event: SessionEvent) {
        if (!ALLOWED_PHASES[event].includes(phase)) throw new CanvasSyncInvariantError(invariantContext(event));
    }

    /** 5.2 的序号不变量：任何一条被打破都按不变量事故处理，不静默继续。 */
    function assertCounters(event: string) {
        const ordered = savedSeq <= editSeq && materializedSeq <= editSeq && persistedSeq <= materializedSeq;
        const inflightOk = inflightSeq < 0 || (savedSeq <= inflightSeq && inflightSeq <= editSeq);
        const cleanOk = phase !== "clean" || (savedSeq === editSeq && inflightSeq < 0 && networkTimer === null);
        if (!ordered || !inflightOk || !cleanOk) throw new CanvasSyncInvariantError(invariantContext(event));
    }

    function canUseNetwork() {
        if (saveError?.kind === "invariant") return false;
        return phase === "clean" || phase === "dirty" || phase === "saving" || phase === "save-error";
    }

    function buildView(): CanvasSyncView {
        return { canvasId, scope, title: content.title, revision, phase, hasUnsavedEdits: editSeq > savedSeq, savedOnce, saveError, localPersist, conflict };
    }

    /** 拖动期间 editSeq 每帧自增，但视图字段不变，因此这里做一次逐字段比较，避免每帧唤醒 UI。 */
    function notify() {
        const next = buildView();
        if (
            emitted &&
            emitted.title === next.title &&
            emitted.revision === next.revision &&
            emitted.phase === next.phase &&
            emitted.hasUnsavedEdits === next.hasUnsavedEdits &&
            emitted.savedOnce === next.savedOnce &&
            emitted.saveError === next.saveError &&
            emitted.localPersist === next.localPersist &&
            emitted.conflict === next.conflict
        )
            return;
        emitted = next;
        listeners.forEach((listener) => listener(next));
    }

    /** 5.4：不变量事故永久阻断网络保存，保留本地写能力，UI 提示重新载入画布。 */
    function enterInvariant(error: CanvasSyncInvariantError) {
        if (deps.isDev) console.error("[canvas-sync] invariant violation", error.context);
        clearNetworkTimer();
        inflightController?.abort();
        inflightController = null;
        inflightSeq = -1;
        saveError = { kind: "invariant", messageKey: "canvas.save.invariant" };
        phase = "save-error";
        emitted = null;
        notify();
    }

    function guard<T>(run: () => T, fallback: T): T {
        try {
            return run();
        } catch (error) {
            if (error instanceof CanvasSyncInvariantError) {
                enterInvariant(error);
                return fallback;
            }
            throw error;
        }
    }
```

`guard` wraps every public entry point, so a violated transition never escapes into the manager, the store or React, and the session keeps accepting edits and local writes while its network side stays blocked.

`install`, `update` and `rename` complete the shell. `install` receives the hydrated content, so the page's first content effect after commit compares equal and produces no edit.

```ts
    function install(hydrated: CanvasProject) {
        assertEvent("install");
        if (hydrated.id !== canvasId) throw new CanvasSyncInvariantError(invariantContext("install"));
        content = hydrated;
        phase = resolution.phase;
        if (phase === "dirty" || phase === "conflict") {
            /** 恢复出来的本地内容本身就是一次未保存编辑：草稿已在盘上，所以物化与落盘序号同步推进。 */
            editSeq = 1;
            materializedSeq = 1;
            persistedSeq = 1;
            lastEditAt = deps.now();
            firstUnsavedEditAt = lastEditAt;
        }
        if (phase === "dirty") scheduleNetwork();
        assertCounters("install");
        notify();
    }

    function update(patch: CanvasProjectPatch): boolean {
        if (phase === "loading" || phase === "disposing" || phase === "disposed") return false;
        assertEvent("update");
        let changed = false;
        for (const field of CANVAS_PATCH_FIELDS) {
            const next = patch[field];
            if (next === undefined || Object.is(next, content[field])) continue;
            changed = true;
        }
        /** 引用全同说明这是补水或回流，不是编辑：不计 editSeq，不排程任何工作。 */
        if (!changed) return false;
        content = { ...content, ...patch };
        registerEdit();
        return true;
    }

    function registerEdit() {
        editSeq += 1;
        lastEditAt = deps.now();
        if (!firstUnsavedEditAt) firstUnsavedEditAt = lastEditAt;
        if (phase === "clean" || phase === "save-error") {
            phase = "dirty";
            saveError = null;
        }
        scheduleLocal();
        if (canUseNetwork() && phase !== "saving") scheduleNetwork();
        assertCounters("update");
        notify();
    }

    function rename(nextTitle: string): CanvasRenameOutcome {
        if (phase === "loading" || phase === "disposing" || phase === "disposed") return "local-only";
        if (nextTitle !== content.title) {
            content = { ...content, title: nextTitle };
            registerEdit();
        }
        /** 标题并入同一次防抖保存请求；冲突或恢复阻断时只落本地草稿。 */
        return canUseNetwork() ? "scheduled" : "local-only";
    }
```

- [ ] **Step 3: Implement the local draft scheduler (one timer, one slot, one drain)**

`update` never serialises. Serialisation happens at most once per `LOCAL_COALESCE_MS`, always into the same single slot, and the drain writes at most one record at a time.

```ts
    function scheduleLocal() {
        /** trailing 且不可饿死：已启动的合并计时器不重排，连续编辑下每 120 ms 落盘一次。 */
        if (localTimer) return;
        localTimer = setTimeout(() => {
            localTimer = null;
            guard(() => materialize(), undefined);
        }, LOCAL_COALESCE_MS);
    }

    function clearLocalTimer() {
        if (localTimer) clearTimeout(localTimer);
        localTimer = null;
    }

    function ensureSnapshot(): { seq: number; title: string; snapshot: CanvasSnapshot } {
        if (snapshotCache && snapshotCache.seq === editSeq) return snapshotCache;
        /** 唯一的全量序列化入口，本地草稿与网络请求共用同一份缓存。 */
        snapshotCache = { seq: editSeq, title: content.title, snapshot: projectToSnapshot(content) };
        return snapshotCache;
    }

    function buildDraftRecord(state: CanvasDraftState, payload: { title: string; snapshot: CanvasSnapshot }): CanvasDraftRecord {
        return {
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            canvasId,
            draftId: resolution.draftId,
            baseRevision: conflictBaseRevision ?? revision,
            state,
            title: payload.title,
            snapshot: payload.snapshot,
            savedAt: new Date(deps.now()).toISOString(),
        };
    }

    function materialize() {
        clearLocalTimer();
        if (materializedSeq >= editSeq) return;
        assertEvent("localTick");
        const payload = ensureSnapshot();
        materializedSeq = payload.seq;
        /** 单槽直接覆盖：慢速 IndexedDB 下内存里最多压着一份完整快照。 */
        pendingSlot = { record: buildDraftRecord("pending", payload), seq: payload.seq, deleteAfterWrite: false };
        assertCounters("localTick");
        void drainLocal();
    }

    function drainLocal(): Promise<void> {
        if (drainPromise) return drainPromise;
        drainPromise = (async () => {
            while (pendingSlot) {
                const entry = pendingSlot;
                pendingSlot = null;
                try {
                    await deps.recovery.writeDraft(entry.record);
                    persistedSeq = Math.max(persistedSeq, entry.seq);
                } catch {
                    /** 丢弃这一条即可：下一次 materialize 会带上更新的内容。 */
                    markDegraded();
                    continue;
                }
                /** 保存成功后的收尾固定「先改写、后删除」，中途崩溃留下的必须是一条 synced 记录。 */
                if (entry.deleteAfterWrite && !pendingSlot && phase === "clean" && editSeq === savedSeq) {
                    try {
                        await deps.recovery.deleteDraftByKey(draftKey);
                    } catch {
                        markDegraded();
                    }
                }
            }
        })().finally(() => {
            drainPromise = null;
        });
        return drainPromise;
    }

    /** degraded 在会话生命周期内是粘性的：一次失败就说明本地草稿不可信，UI 必须持续提示直到重新打开画布。 */
    function markDegraded() {
        if (localPersist === "degraded") return;
        localPersist = "degraded";
        notify();
    }

    async function flushLocal(timeoutMs: number) {
        materialize();
        const settled = await settleWithin(drainPromise ?? Promise.resolve(), timeoutMs);
        if (settled.status !== "ok") markDegraded();
    }
```

During a 3 s / 60 fps drag this produces at most 25 serialisations, one pending record, one in-flight write and one shared snapshot cache, which is exactly spec §12's per-session budget.

- [ ] **Step 4: Implement the network scheduler (single flight, 400 ms trailing, 5 s max wait)**

```ts
    function clearNetworkTimer() {
        if (networkTimer) clearTimeout(networkTimer);
        networkTimer = null;
    }

    /** 同时表达三件事：最后编辑后 400 ms、连续编辑 5 s 上界、saveAck 后按 max(0, 400 - (now - lastEditAt)) 重排。 */
    function scheduleNetwork() {
        if (!canUseNetwork() || editSeq <= savedSeq) return;
        const now = deps.now();
        const trailing = Math.max(0, NETWORK_DEBOUNCE_MS - (now - lastEditAt));
        const capped = firstUnsavedEditAt ? Math.max(0, NETWORK_MAX_WAIT_MS - (now - firstUnsavedEditAt)) : NETWORK_DEBOUNCE_MS;
        clearNetworkTimer();
        networkTimer = setTimeout(() => {
            networkTimer = null;
            guard(() => void onNetworkTick(), undefined);
        }, Math.min(trailing, capped));
    }

    async function onNetworkTick() {
        /** 已有请求在飞时只标记「请求后待发」，绝不排队第二个请求；重排交给 saveAck。 */
        if (inflightSeq >= 0) return;
        assertEvent("networkTick");
        await startSave();
    }

    async function startSave() {
        if (!canUseNetwork() || inflightSeq >= 0 || editSeq <= savedSeq) return;
        const payload = ensureSnapshot();
        const baseRevision = revision;
        const controller = new AbortController();
        inflightSeq = payload.seq;
        inflightController = controller;
        phase = "saving";
        clearNetworkTimer();
        assertCounters("startSave");
        notify();
        try {
            const result = await deps.repository.save(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot }, controller.signal);
            guard(() => onSaveAck(result), undefined);
        } catch (error) {
            const failure = classifyCanvasSaveError(error);
            if (failure.kind === "conflict") guard(() => onSaveConflict(baseRevision), undefined);
            else guard(() => onSaveFail(failure), undefined);
        }
    }

    function settleAfterRequest() {
        inflightSeq = -1;
        inflightController = null;
    }

    /** 会话被替换后返回的结果不再改写阶段：dispose 有自己的收尾路径。 */
    function requestOutdated() {
        if (phase !== "disposing" && phase !== "disposed") return false;
        settleAfterRequest();
        return true;
    }

    function onSaveAck(result: CanvasLoadResult) {
        if (requestOutdated()) return;
        assertEvent("saveAck");
        if (result.revision < revision) throw new CanvasSyncInvariantError(invariantContext("saveAck"));
        revision = result.revision;
        savedSeq = inflightSeq;
        savedOnce = true;
        saveError = null;
        settleAfterRequest();
        if (editSeq === savedSeq) {
            phase = "clean";
            firstUnsavedEditAt = 0;
            clearNetworkTimer();
            queueDraftSettlement("synced");
        } else {
            phase = "dirty";
            queueDraftSettlement("pending");
            scheduleNetwork();
        }
        assertCounters("saveAck");
        notify();
    }

    /** 保存成功后的草稿收尾走同一个单槽：写入新的 baseRevision，clean 时再删除，顺序不可颠倒。 */
    function queueDraftSettlement(state: CanvasDraftState) {
        const payload = ensureSnapshot();
        materializedSeq = Math.max(materializedSeq, payload.seq);
        pendingSlot = { record: buildDraftRecord(state, payload), seq: payload.seq, deleteAfterWrite: state === "synced" };
        void drainLocal();
    }

    function onSaveFail(failure: Extract<CanvasSaveFailure, { messageKey: string }>) {
        if (requestOutdated()) return;
        assertEvent("saveFail");
        settleAfterRequest();
        clearNetworkTimer();
        saveError = { kind: failure.kind, messageKey: failure.messageKey };
        phase = "save-error";
        assertCounters("saveFail");
        /** 不自动重试：下一次编辑或显式重试才再次发请求；pending 草稿保持在盘上。 */
        notify();
    }
```

`onSaveFail` covers network, timeout and every non-conflict server error, including `canvas_snapshot_too_large` and `canvas_revision_limit_reached`.

- [ ] **Step 5: Implement conflict entry, `flush` and `retrySave`**

The conflict phase is established synchronously so no frame can show "saving" after a 409 has already come back; marker and draft writes follow best-effort.

```ts
    function onSaveConflict(baseRevision: number) {
        if (requestOutdated()) return;
        assertEvent("saveConflict");
        settleAfterRequest();
        clearNetworkTimer();
        conflictBaseRevision = baseRevision;
        conflict = { baseRevision, source: "save", extraDraftCount: 0 };
        saveError = null;
        phase = "conflict";
        firstUnsavedEditAt = 0;
        assertCounters("saveConflict");
        notify();
        void persistConflictRecords(baseRevision);
    }

    async function persistConflictRecords(baseRevision: number) {
        const payload = ensureSnapshot();
        materializedSeq = Math.max(materializedSeq, payload.seq);
        pendingSlot = { record: buildDraftRecord("pending", payload), seq: payload.seq, deleteAfterWrite: false };
        const written = await settleWithin(drainLocal(), LOCAL_FLUSH_TIMEOUT_MS);
        if (written.status !== "ok") markDegraded();
        const entry: CanvasConflictMarkerEntry = { draftKey, draftId: resolution.draftId, baseRevision, savedAt: new Date(deps.now()).toISOString() };
        const existing = await settleWithin(deps.recovery.readMarker(draftScope), LOCAL_READ_TIMEOUT_MS);
        const older = existing.status === "ok" && existing.value ? existing.value.entries.filter((item) => item.draftKey !== draftKey) : [];
        /** 最新的本地内容永远排在 entries[0]，旧 marker 不能夺回入口。 */
        const entries = [entry, ...older].slice(0, MAX_CONFLICT_MARKER_ENTRIES);
        const marked = await settleWithin(deps.recovery.writeMarker({ ...draftScope, entries }), LOCAL_FLUSH_TIMEOUT_MS);
        if (marked.status !== "ok") markDegraded();
        if (conflict && conflict.extraDraftCount !== entries.length - 1) {
            conflict = { ...conflict, extraDraftCount: entries.length - 1 };
            notify();
        }
    }

    async function flush() {
        if (phase === "loading" || phase === "disposing" || phase === "disposed") return;
        assertEvent("flush");
        await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
        if (canUseNetwork() && editSeq > savedSeq && inflightSeq < 0) await startSave();
    }

    async function retrySave() {
        if (phase !== "save-error" && phase !== "dirty") return;
        if (saveError?.kind === "invariant" || inflightSeq >= 0) return;
        assertEvent("retrySave");
        saveError = null;
        if (editSeq <= savedSeq) {
            phase = "clean";
            clearNetworkTimer();
            assertCounters("retrySave");
            notify();
            return;
        }
        phase = "dirty";
        notify();
        /** 重新捕获当前内容并跳过 400 ms，不重放上一条已失败的候选。 */
        await startSave();
    }
```

- [ ] **Step 6: Implement `retryRecovery` with spec §8.3's entry-ownership rules**

```ts
    async function retryRecovery(): Promise<CanvasRetryRecoveryResult> {
        if (phase !== "recovery-blocked") return "failed";
        assertEvent("retryRecovery");
        let marker: CanvasConflictMarker | null;
        let drafts: CanvasDraftRecord[];
        try {
            marker = await readWithRetry(() => deps.recovery.readMarker(draftScope));
            drafts = await readWithRetry(() => deps.recovery.listCanvasDrafts(draftScope));
        } catch {
            return "failed";
        }
        if (phase !== "recovery-blocked") return "failed";
        const valid = marker ? marker.entries.filter((entry) => drafts.some((draft) => canvasDraftKey(draftScope, draft.draftId) === entry.draftKey)) : [];
        if (!valid.length) {
            if (marker) await settleWithin(deps.recovery.deleteMarker(draftScope), LOCAL_FLUSH_TIMEOUT_MS);
            if (editSeq > savedSeq) {
                phase = "dirty";
                notify();
                /** 恢复期间的编辑只落了本地草稿，解锁后立即补一次云端保存。 */
                await startSave();
                return "unlocked";
            }
            phase = "clean";
            notify();
            return "unlocked";
        }
        /** 恢复重试只修正 lineage，绝不替换画布内容：替换内容只允许走冲突条上的显式动作。 */
        const own: CanvasConflictMarkerEntry[] =
            editSeq > savedSeq ? [{ draftKey, draftId: resolution.draftId, baseRevision: revision, savedAt: new Date(deps.now()).toISOString() }] : [];
        const entries = [...own, ...valid.filter((entry) => entry.draftKey !== draftKey)].slice(0, MAX_CONFLICT_MARKER_ENTRIES);
        const marked = await settleWithin(deps.recovery.writeMarker({ ...draftScope, entries }), LOCAL_FLUSH_TIMEOUT_MS);
        if (marked.status !== "ok") markDegraded();
        conflictBaseRevision = own.length ? revision : valid[0].baseRevision;
        conflict = { baseRevision: conflictBaseRevision, source: "restored", extraDraftCount: entries.length - 1 };
        phase = "conflict";
        clearNetworkTimer();
        assertCounters("retryRecovery");
        notify();
        return "conflict";
    }
```

When the session edited during recovery, its own entry becomes `entries[0]` and the old draft stays on disk as the second entry; when it did not edit, the marker keeps only the old entry and the canvas content stays on the server copy.

- [ ] **Step 7: Implement conflict export, bounded dispose, and the returned session object**

Add `guardAsync` beside `guard` from Step 2 and use it for every async entry point. The `scheduleNetwork` timer body from Step 4 must read `void guardAsync(() => onNetworkTick(), undefined)` because `onNetworkTick` is async and a rejected promise would otherwise escape the sync `guard`.

```ts
    async function guardAsync<T>(run: () => Promise<T>, fallback: T): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (error instanceof CanvasSyncInvariantError) {
                enterInvariant(error);
                return fallback;
            }
            throw error;
        }
    }

    /** 8.4：第一份来自内存，保证本地存储完全不可用时冲突内容仍可导出；其余逐条有界读取，读失败跳过。 */
    async function exportConflictDrafts(): Promise<CanvasProject[]> {
        const projects: CanvasProject[] = [];
        if (editSeq > savedSeq) projects.push(content);
        const marker = await settleWithin(deps.recovery.readMarker(draftScope), LOCAL_READ_TIMEOUT_MS);
        const entries = marker.status === "ok" && marker.value ? marker.value.entries.filter((entry) => entry.draftKey !== draftKey) : [];
        for (const entry of entries) {
            if (projects.length >= MAX_CONFLICT_MARKER_ENTRIES) break;
            const read = await settleWithin(deps.recovery.readDraftByKey(entry.draftKey), LOCAL_READ_TIMEOUT_MS);
            if (read.status === "ok" && read.value) projects.push(draftToProject(read.value));
        }
        return projects;
    }

    function dispose(reason: CanvasDisposeReason): Promise<void> {
        if (disposePromise) return disposePromise;
        disposePromise = (async () => {
            const networkAllowed = canUseNetwork() && editSeq > savedSeq;
            phase = "disposing";
            clearLocalTimer();
            clearNetworkTimer();
            notify();
            if (reason === "forced") {
                /** 超出 detached 上限时的硬收尾：中止在飞请求、跳过所有等待。 */
                inflightController?.abort();
                settleAfterRequest();
                /** 不再新增任何本地写；只等已经在飞的那一次结束，避免它写在清理之后。 */
                pendingSlot = null;
                await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
            } else if (reason === "deleted") {
                /** 画布已被删除：不再新增任何本地写，只等已经在飞的那一次结束，避免写在清理之后。 */
                pendingSlot = null;
                await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
            } else {
                await flushLocal(DETACHED_LOCAL_MS);
                if (networkAllowed && inflightSeq < 0) await settleWithin(finalSave(), DETACHED_NETWORK_MS);
            }
            phase = "disposed";
            notify();
            listeners.clear();
        })();
        return disposePromise;
    }

    /** detached 会话最多再发一次保存；409 只写自己作用域的 marker 与冲突草稿，没有任何 UI。 */
    async function finalSave() {
        const payload = ensureSnapshot();
        const baseRevision = revision;
        const controller = new AbortController();
        inflightController = controller;
        try {
            const result = await deps.repository.save(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot }, controller.signal);
            revision = result.revision;
            savedSeq = payload.seq;
            savedOnce = true;
        } catch (error) {
            if (classifyCanvasSaveError(error).kind !== "conflict") return;
            conflictBaseRevision = baseRevision;
            await settleWithin(persistConflictRecords(baseRevision), DETACHED_LOCAL_MS);
        } finally {
            inflightController = null;
        }
    }

    const session: CanvasSyncSession = {
        sessionId,
        canvasId,
        scope,
        scopeToken,
        openToken,
        draftKey,
        get view() {
            return emitted ?? buildView();
        },
        get content() {
            return content;
        },
        install: (hydrated) => guard(() => install(hydrated), undefined),
        update: (patch) => guard(() => update(patch), false),
        rename: (title) => guard(() => rename(title), "local-only" as CanvasRenameOutcome),
        flush: () => guardAsync(() => flush(), undefined),
        retrySave: () => guardAsync(() => retrySave(), undefined),
        retryRecovery: () => guardAsync(() => retryRecovery(), "failed" as CanvasRetryRecoveryResult),
        exportConflictDrafts: () => guardAsync(() => exportConflictDrafts(), []),
        dispose: (reason) => guardAsync(() => dispose(reason), undefined),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    emitted = buildView();
    return session;
}
```

- [ ] **Step 8: Hand the user the verification commands (do not run them)**

Run: `bun --cwd web run typecheck`
Expected: no errors. The session is still unreferenced at this commit, so no runtime behavior changes yet.

Run: `bun --cwd web run build`
Expected: build succeeds.

Read-through check the reviewer performs instead of tests: every `phase` assignment is reachable only through an `assertEvent` call in the same function; `projectToSnapshot` is the only serialisation call site; `pendingSlot` is only ever assigned a fresh object or `null`; no `await` exists between `phase = "saving"` and the `repository.save` call.

- [ ] **Step 9: Commit**

```bash
git add web/src/services/canvas-sync/canvas-sync-session.ts
git commit -m "refactor: add canvas sync session state machine"
```

### Task 3: Canvas Sync Manager And Store Adapter

**Files:**
- Create: `web/src/services/canvas-sync/canvas-sync-manager.ts`
- Rewrite: `web/src/stores/canvas/use-canvas-store.ts`
- Modify: `web/src/stores/use-asset-store.ts`, `web/src/hooks/use-canvas-scope-sync.ts`, `web/src/services/canvas-repository.ts` (drop the legacy wrappers)
- Delete: `web/src/services/canvas-drafts.ts`
- Test: none (spec §2.2)

**Cutover note for the reviewer:** Tasks 3, 4 and 5 are one cutover chain. After this commit the old store API is gone, so `web/src/pages/canvas/project.tsx`, `web/src/pages/canvas/index.tsx`, `canvas-save-status.tsx`, `canvas-conflict-bar.tsx` and `canvas-project-card.tsx` still reference removed members and `bun --cwd web run typecheck` fails with exactly those references until Task 5 lands. That expected breakage set is listed in Step 7. Do not add shims or compatibility exports to make the intermediate commit green — spec §13.1 requires one-shot replacement.

**Interfaces:**
- Consumes from Tasks 1-2: `@/services/canvas-sync/types`, `createCanvasSyncSession`, `resolveCanvasOpenRecovery`, `CanvasSyncSessionDeps` from `@/services/canvas-sync/canvas-sync-session`, `canvasRepository`, `classifyCanvasOpenError`, `classifyCanvasSaveError` from `@/services/canvas-repository`, `canvasLocalRecovery` from `@/services/canvas-local-recovery`.
- Produces for Tasks 4-5: `canvasSyncManager` (singleton `CanvasSyncManager`) and `createCanvasSyncManager(deps)`; the store surface below.

```ts
type CanvasStore = {
    scope: CanvasScope | null;
    listStatus: "idle" | "loading" | "ready" | "error";
    listError: string | null;
    summaries: CanvasProjectSummary[];
    activeCanvasId: string | null;
    /** 由活动会话推送；无活动会话为 null。 */
    sync: CanvasSyncView | null;
    setScope: (scope: CanvasScope | null) => void;
    refreshList: () => Promise<void>;
    createProject: (title: string) => Promise<CanvasCreateResult>;
    importProject: (source: Partial<CanvasProject>, fallbackTitle: string) => Promise<CanvasCreateResult>;
    renameProject: (canvasId: string, title: string) => Promise<CanvasRenameResult>;
    deleteProjects: (canvasIds: string[]) => Promise<CanvasDeleteResult>;
    loadProjectsForExport: (canvasIds: string[]) => Promise<CanvasProject[]>;
    updateProject: (canvasId: string, patch: CanvasProjectPatch) => void;
    flushProject: (canvasId: string) => Promise<void>;
    retrySave: (canvasId: string) => Promise<void>;
    retryRecovery: (canvasId: string) => Promise<CanvasRetryRecoveryResult>;
    exportConflictDrafts: (canvasId: string) => Promise<CanvasProject[]>;
    /** 非响应式读取活动画布内容，供素材回收与导出使用；不进入 React 订阅。 */
    getActiveProject: () => CanvasProject | null;
};
```

- [ ] **Step 1: Implement scope, tokens, session installation and the bounded detached set**

```ts
export type CanvasSyncManagerDeps = CanvasSyncSessionDeps;

export function createCanvasSyncManager(deps: CanvasSyncManagerDeps): CanvasSyncManager {
    let scope: CanvasScope | null = null;
    let scopeToken = 0;
    let openToken = 0;
    let sessionSeq = 0;
    let active: CanvasSyncSession | null = null;
    let activeUnsubscribe: (() => void) | null = null;
    const detached = new Set<CanvasSyncSession>();
    const listeners = new Set<() => void>();

    const notify = () => listeners.forEach((listener) => listener());
    const isStale = (token: number, open: number) => token !== scopeToken || open !== openToken;
    const draftScopeOf = (session: CanvasSyncSession): CanvasDraftScope => ({ userId: session.scope.userId, workspaceId: session.scope.workspaceId, canvasId: session.canvasId });

    /** detached 上限为 2：超限时最老的一个立即硬收尾，打开新画布永远不等待任何收尾。 */
    function detach(session: CanvasSyncSession, reason: CanvasDisposeReason) {
        detached.add(session);
        if (detached.size > MAX_DETACHED_SESSIONS) {
            const oldest = detached.values().next().value;
            if (oldest && oldest !== session) {
                detached.delete(oldest);
                void oldest.dispose("forced");
            }
        }
        void session.dispose(reason).finally(() => detached.delete(session));
    }

    function installSession(session: CanvasSyncSession, content: CanvasProject, previousReason: CanvasDisposeReason) {
        const previous = active;
        activeUnsubscribe?.();
        active = session;
        activeUnsubscribe = session.subscribe(() => notify());
        session.install(content);
        if (previous) detach(previous, previousReason);
        notify();
    }

    function setScope(next: CanvasScope | null) {
        const unchanged = scopeToken > 0 && ((scope === null && next === null) || sameCanvasScope(scope, next));
        if (unchanged) return;
        scopeToken += 1;
        openToken += 1;
        scope = next;
        const previous = active;
        activeUnsubscribe?.();
        activeUnsubscribe = null;
        active = null;
        /** 旧会话继续按自己捕获的作用域收尾；它写出的 marker/草稿永远落在旧作用域下。 */
        if (previous) detach(previous, "scope-changed");
        notify();
    }
```

- [ ] **Step 2: Implement prepare/commit for open and server-copy reload plus the two local cleanup routines**

```ts
    async function prepare(canvasId: string, withRecovery: boolean): Promise<PreparedCanvasOpen> {
        const current = scope;
        if (!current) return { status: "cancelled" };
        const token = scopeToken;
        const open = ++openToken;
        let load: CanvasLoadResult;
        try {
            load = await deps.repository.load(current.workspaceId, canvasId);
        } catch (error) {
            if (isStale(token, open)) return { status: "cancelled" };
            const failure = classifyCanvasOpenError(error);
            return failure.kind === "missing" ? { status: "missing" } : { status: "failed", messageKey: failure.messageKey };
        }
        if (isStale(token, open)) return { status: "cancelled" };
        if (load.project.id !== canvasId) return { status: "missing" };
        const resolution = withRecovery
            ? await resolveCanvasOpenRecovery(deps, current, load)
            : ({ phase: "clean", content: load.project, revision: load.revision, draftId: deps.createDraftId(), conflict: null } satisfies CanvasRecoveryResolution);
        if (isStale(token, open)) return { status: "cancelled" };
        /** 全程不改 active：补水期间旧会话仍是权威，迟到编辑发不出属于新画布的保存。 */
        const session = createCanvasSyncSession({ sessionId: ++sessionSeq, scope: current, scopeToken: token, openToken: open, canvasId, resolution }, deps);
        return { status: "ready", canvasId, project: resolution.content, session };
    }

    function commitAllowed(prepared: Extract<PreparedCanvasOpen, { status: "ready" }>, content: CanvasProject) {
        const session = prepared.session;
        return session.scopeToken === scopeToken && session.openToken === openToken && sameCanvasScope(session.scope, scope) && content.id === session.canvasId;
    }

    function commitPrepared(prepared: PreparedCanvasOpen, content: CanvasProject) {
        if (prepared.status !== "ready" || !commitAllowed(prepared, content)) return false;
        installSession(prepared.session, content, "replaced");
        void collectDraftGarbage(prepared.session);
        return true;
    }

    function commitServerCopy(prepared: PreparedCanvasOpen, content: CanvasProject): CanvasCommitServerCopyResult {
        if (prepared.status === "cancelled") return "cancelled";
        if (prepared.status !== "ready") return "failed";
        if (!commitAllowed(prepared, content)) return "cancelled";
        const previous = active;
        /** 用户显式选择服务端版本：旧冲突会话的本地工作被丢弃，因此用 forced 收尾，不再写任何草稿。 */
        installSession(prepared.session, content, "forced");
        void (async () => {
            if (previous) await settleWithin(previous.dispose("forced"), DETACHED_LOCAL_MS);
            await clearConflictRecovery(draftScopeOf(prepared.session), previous ? [previous.draftKey] : []);
        })();
        return "committed";
    }

    /** 7.2：只清理该画布的 marker、marker 引用的草稿和被替换会话自己的草稿；同源其他标签页的活草稿不动。 */
    async function clearConflictRecovery(draftScope: CanvasDraftScope, extraKeys: string[]) {
        const marker = await settleWithin(deps.recovery.readMarker(draftScope), LOCAL_READ_TIMEOUT_MS);
        const keys = new Set(extraKeys);
        if (marker.status === "ok" && marker.value) marker.value.entries.forEach((entry) => keys.add(entry.draftKey));
        await settleWithin(
            Promise.allSettled([...[...keys].map((key) => deps.recovery.deleteDraftByKey(key)), deps.recovery.deleteMarker(draftScope)]),
            LOCAL_FLUSH_TIMEOUT_MS,
        );
    }

    /** 画布已被删除：该画布下的全部草稿与 marker 都没有价值，一次清干净。 */
    async function clearDeletedCanvasRecovery(draftScope: CanvasDraftScope) {
        const drafts = await settleWithin(deps.recovery.listCanvasDrafts(draftScope), LOCAL_READ_TIMEOUT_MS);
        const keys = drafts.status === "ok" ? drafts.value.map((draft) => canvasDraftKey(draftScope, draft.draftId)) : [];
        await settleWithin(Promise.allSettled([...keys.map((key) => deps.recovery.deleteDraftByKey(key)), deps.recovery.deleteMarker(draftScope)]), LOCAL_FLUSH_TIMEOUT_MS);
    }

    /** 4.5：打开成功后异步回收，保留当前会话草稿与 marker 引用的草稿，其余超过 6 小时才删。 */
    async function collectDraftGarbage(session: CanvasSyncSession) {
        const draftScope = draftScopeOf(session);
        const marker = await settleWithin(deps.recovery.readMarker(draftScope), LOCAL_READ_TIMEOUT_MS);
        const keep = [session.draftKey, ...(marker.status === "ok" && marker.value ? marker.value.entries.map((entry) => entry.draftKey) : [])];
        await deps.recovery.collectGarbage(draftScope, keep);
    }
```

`prepare(canvasId, true)` backs `prepareOpen` and `prepare(canvasId, false)` backs `prepareServerCopy`; both bump `openToken`, so a slower earlier open can never commit over a faster later one.

- [ ] **Step 3: Implement the list-level operations and export the singleton**

```ts
    const scopeChanged = (token: number, captured: CanvasScope) => token !== scopeToken || !sameCanvasScope(captured, scope);

    async function listCanvases(): Promise<CanvasListResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const summaries = await deps.repository.list(current.workspaceId);
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "ready", summaries };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.listFailed") };
        }
    }

    /** 新建不等待任何会话收尾；作用域已切换时返回 scope-changed 且不导航，已创建的空画布留在旧 Workspace。 */
    async function createCanvas(title: string): Promise<CanvasCreateResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const { project, revision } = await deps.repository.create(current.workspaceId, clampCanvasTitle(title));
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "created", canvasId: project.id, summary: projectToSummary(project, revision) };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.createFailed") };
        }
    }

    async function importCanvas(source: Partial<CanvasProject>, fallbackTitle: string): Promise<CanvasCreateResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const { project, revision } = await deps.repository.importProject(current.workspaceId, projectToImportBody(source, fallbackTitle));
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "created", canvasId: project.id, summary: projectToSummary(project, revision) };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.importFailed") };
        }
    }

    async function renameCanvas(canvasId: string, title: string): Promise<CanvasRenameResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const trimmed = clampCanvasTitle(title);
        if (!trimmed) return { status: "failed", messageKey: "canvas.renameFailed" };
        if (active && active.canvasId === canvasId && sameCanvasScope(active.scope, current)) {
            /** 活动画布走会话：标题并入同一次防抖保存，冲突或恢复阻断时只落本地草稿。 */
            return active.rename(trimmed) === "scheduled" ? { status: "scheduled" } : { status: "local-only" };
        }
        const token = scopeToken;
        try {
            const loaded = await deps.repository.load(current.workspaceId, canvasId);
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            const saved = await deps.repository.save(current.workspaceId, canvasId, { baseRevision: loaded.revision, title: trimmed, snapshot: projectToSnapshot(loaded.project) });
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "saved", summary: projectToSummary({ ...saved.project, title: trimmed }, saved.revision) };
        } catch (error) {
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            /** 列表项重命名遇到 409 不写任何 marker：让用户打开该画布处理冲突。 */
            return classifyCanvasSaveError(error).kind === "conflict" ? { status: "conflict" } : { status: "failed", messageKey: "canvas.renameFailed" };
        }
    }

    async function deleteCanvases(canvasIds: string[]): Promise<CanvasDeleteResult> {
        const current = scope;
        if (!current || !canvasIds.length) return { deleted: [], failed: [] };
        const target = active && canvasIds.includes(active.canvasId) ? active : null;
        if (target) {
            activeUnsubscribe?.();
            activeUnsubscribe = null;
            active = null;
            notify();
            /** 跳过网络收尾，并等已在飞的本地写结束，避免它写在清理之后。 */
            await target.dispose("deleted");
        }
        const outcomes = await Promise.allSettled(canvasIds.map((canvasId) => deps.repository.remove(current.workspaceId, canvasId)));
        const deleted = canvasIds.filter((_id, index) => outcomes[index].status === "fulfilled");
        const failed = canvasIds.filter((canvasId) => !deleted.includes(canvasId));
        deleted.forEach((canvasId) => void clearDeletedCanvasRecovery({ userId: current.userId, workspaceId: current.workspaceId, canvasId }));
        return { deleted, failed };
    }

    async function loadForExport(canvasIds: string[]): Promise<CanvasProject[]> {
        const current = scope;
        if (!current || !canvasIds.length) return [];
        const projects: CanvasProject[] = [];
        for (let index = 0; index < canvasIds.length; index += EXPORT_BATCH_SIZE) {
            /** 任一批失败直接抛出，由 UI 提示导出失败，绝不返回缺内容的空包。 */
            const batch = await Promise.all(
                canvasIds.slice(index, index + EXPORT_BATCH_SIZE).map(async (canvasId) => {
                    if (active && active.canvasId === canvasId && sameCanvasScope(active.scope, current)) return active.content;
                    return (await deps.repository.load(current.workspaceId, canvasId)).project;
                }),
            );
            projects.push(...batch);
        }
        return projects;
    }

    return {
        getScope: () => scope,
        setScope,
        getActiveSession: () => active,
        prepareOpen: (canvasId) => prepare(canvasId, true),
        commitPrepared,
        prepareServerCopy: (canvasId) => prepare(canvasId, false),
        commitServerCopy,
        listCanvases,
        createCanvas,
        importCanvas,
        renameCanvas,
        deleteCanvases,
        loadForExport,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export const canvasSyncManager = createCanvasSyncManager({
    repository: canvasRepository,
    recovery: canvasLocalRecovery,
    now: () => Date.now(),
    createDraftId: () => nanoid(),
    isDev: import.meta.env.DEV,
});
```

`loadForExport` deliberately does not abort on a scope change: the user selected those canvases in the scope they were looking at, and returning a partial archive would be worse than exporting what was asked for.

- [ ] **Step 4: Rewrite `web/src/stores/canvas/use-canvas-store.ts` as a pure view adapter**

Delete every module-level mutable (`saveTimer`, `pendingSave`, `localTimer`, `pendingEdit`, `saveChain`, `draftChains`, `pendingDraftRecords`, `activeGeneration`), every helper that implemented the algorithm, and `CANVAS_SCOPE_CHANGED_ERROR`/`isScopeChangedError`. The whole file becomes state plus forwarding.

```ts
import { create } from "zustand";

import type { CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import { clampCanvasTitle } from "@/lib/canvas/canvas-snapshot";
import { canvasSyncManager } from "@/services/canvas-sync/canvas-sync-manager";
import { sameCanvasScope, type CanvasCreateResult, type CanvasDeleteResult, type CanvasProjectPatch, type CanvasRenameResult, type CanvasRetryRecoveryResult, type CanvasSyncView } from "@/services/canvas-sync/types";
import type { CanvasProject, CanvasScope } from "@/types/canvas";

export const useCanvasStore = create<CanvasStore>()((set, get) => {
    /** 动作一律带 canvasId：切画布瞬间组件发出的调用不会打到别的画布上。 */
    const sessionFor = (canvasId: string) => {
        const session = canvasSyncManager.getActiveSession();
        return session && session.canvasId === canvasId && get().activeCanvasId === canvasId ? session : null;
    };

    return {
        scope: null,
        listStatus: "idle",
        listError: null,
        summaries: [],
        activeCanvasId: null,
        sync: null,

        setScope: (scope) => {
            const current = get().scope;
            if ((current === null && scope === null) || sameCanvasScope(current, scope)) return;
            canvasSyncManager.setScope(scope);
            set({ scope, summaries: [], listStatus: "idle", listError: null });
        },

        refreshList: async () => {
            if (!get().scope) return;
            set({ listStatus: "loading", listError: null });
            const result = await canvasSyncManager.listCanvases();
            /** 迟到结果按作用域丢弃：新的作用域已经把 listStatus 重置为 idle 并会自己拉一次。 */
            if (result.status === "scope-changed") return;
            if (result.status === "failed") {
                set({ listStatus: "error", listError: result.messageKey, summaries: [] });
                return;
            }
            set({ summaries: result.summaries, listStatus: "ready" });
        },

        createProject: async (title) => {
            const result = await canvasSyncManager.createCanvas(title);
            if (result.status === "created") set({ summaries: [result.summary, ...get().summaries] });
            return result;
        },

        importProject: async (source, fallbackTitle) => {
            const result = await canvasSyncManager.importCanvas(source, fallbackTitle);
            if (result.status === "created") set({ summaries: [result.summary, ...get().summaries] });
            return result;
        },

        renameProject: async (canvasId, title) => {
            const result = await canvasSyncManager.renameCanvas(canvasId, title);
            if (result.status === "saved") set({ summaries: get().summaries.map((item) => (item.id === canvasId ? result.summary : item)) });
            /** 活动画布改名尚未落库，列表标题先按截断后的输入乐观更新，revision 与时间戳等下一次列表刷新。 */
            if (result.status === "scheduled" || result.status === "local-only") {
                const trimmed = clampCanvasTitle(title);
                set({ summaries: get().summaries.map((item) => (item.id === canvasId ? { ...item, title: trimmed } : item)) });
            }
            return result;
        },

        deleteProjects: async (canvasIds) => {
            const scopeAtCall = get().scope;
            const result = await canvasSyncManager.deleteCanvases(canvasIds);
            /** 作用域已变时仍返回真实结果，只是不写 store。 */
            if (!sameCanvasScope(scopeAtCall, get().scope)) return result;
            if (result.deleted.length) set({ summaries: get().summaries.filter((item) => !result.deleted.includes(item.id)) });
            return result;
        },

        loadProjectsForExport: (canvasIds) => canvasSyncManager.loadForExport(canvasIds),
        updateProject: (canvasId, patch) => {
            sessionFor(canvasId)?.update(patch);
        },
        flushProject: async (canvasId) => {
            await sessionFor(canvasId)?.flush();
        },
        retrySave: async (canvasId) => {
            await sessionFor(canvasId)?.retrySave();
        },
        retryRecovery: async (canvasId) => (await sessionFor(canvasId)?.retryRecovery()) ?? "failed",
        exportConflictDrafts: async (canvasId) => (await sessionFor(canvasId)?.exportConflictDrafts()) ?? [],
        getActiveProject: () => canvasSyncManager.getActiveSession()?.content ?? null,
    };
});

/** 会话视图是唯一真相：manager 在会话安装、替换与视图变化时通知，这里只做一次浅比较后写入。 */
canvasSyncManager.subscribe(() => {
    const session = canvasSyncManager.getActiveSession();
    const activeCanvasId = session?.canvasId ?? null;
    const sync: CanvasSyncView | null = session?.view ?? null;
    const state = useCanvasStore.getState();
    if (state.activeCanvasId === activeCanvasId && state.sync === sync) return;
    useCanvasStore.setState({ activeCanvasId, sync });
});
```

- [ ] **Step 5: Update the two remaining store consumers and delete the legacy modules**

`web/src/hooks/use-canvas-scope-sync.ts` keeps its `useLayoutEffect` and `clearScopeState()` call and continues to call `setScope`; only confirm it compiles against the new store (no signature change). `web/src/stores/use-asset-store.ts` replaces its dynamic-import read:

```ts
// web/src/stores/use-asset-store.ts, inside cleanupImages
const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
const activeProject = useCanvasStore.getState().getActiveProject();
const retained = { assets: get().assets, extra, activeProject };
```

Then delete `web/src/services/canvas-drafts.ts` (its only importer was the old store) and remove the legacy wrapper exports `listCanvasSummaries`, `loadCanvasProject`, `createCanvasProject`, `importCanvasProject`, `saveCanvasProject` and `deleteCanvasProject` from `web/src/services/canvas-repository.ts`, keeping `canvasRepository`, `isRevisionConflictError`, `classifyCanvasSaveError`, `classifyCanvasOpenError`, `CanvasRequestTimeoutError` and `REVISION_CONFLICT_CODE`. Verify with `rg -n 'canvas-drafts|saveCanvasProject|loadCanvasProject' web/src` that nothing references them.

- [ ] **Step 6: Confirm `web/src/lib/agent/agent-site-tools.ts` needs no change**

Run `rg -n 'useCanvasStore' web/src/lib/agent/agent-site-tools.ts`. The three call sites read `scope`, `listStatus`, `listError`, `summaries` and call `refreshList()`, and `useCanvasStore.subscribe` still exists on the Zustand store. If that holds, leave the file untouched and record it in the commit message body. If any other member is referenced, adapt only that expression.

- [ ] **Step 7: Hand the user the verification commands and the expected breakage set (do not run them)**

Run: `bun --cwd web run typecheck`
Expected at this commit: failures only in the five files that still use the removed store API, namely `web/src/pages/canvas/project.tsx` (`openProject`, `fetchServerCopy`, `commitServerCopy`, `isScopeChangedError`, `state.active`, old `createProject`/`deleteProjects`/`renameProject` result shapes), `web/src/pages/canvas/index.tsx` (`isScopeChangedError`, old `createProject`/`importProject` results), `web/src/components/canvas/canvas-save-status.tsx` (`saveState`, `active`, `retryCanvasRecovery`), `web/src/components/canvas/canvas-conflict-bar.tsx` (`conflict`, `readConflictDraft`) and `web/src/components/canvas/canvas-project-card.tsx` (rename result). Any error outside that set is a real defect in this task.

Run: `rg -n 'canvas-drafts' web/src`
Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add web/src/services/canvas-sync/canvas-sync-manager.ts web/src/services/canvas-repository.ts web/src/stores/canvas/use-canvas-store.ts web/src/stores/use-asset-store.ts web/src/hooks/use-canvas-scope-sync.ts
git rm web/src/services/canvas-drafts.ts
git commit -m "refactor: drive canvas store by sync manager"
```

### Task 4: Canvas Page Prepare/Commit, Agent Gate, Container Ref And Viewport

**Files:**
- Create: `web/src/pages/canvas/hooks/use-canvas-project-sync.ts`
- Modify: `web/src/pages/canvas/project.tsx`, `web/src/pages/canvas/hooks/use-agent-bridge.ts`, `web/src/components/canvas/infinite-canvas.tsx`, `web/src/i18n/locales/zh-CN.ts`, `web/src/i18n/locales/en-US.ts` (one key, listed in Step 5)
- Test: none (spec §2.2)

**Interfaces:**
- Consumes from Task 3: `canvasSyncManager`, the new store surface (`sync`, `activeCanvasId`, `updateProject`, `flushProject`, `createProject`, `deleteProjects`, `renameProject`, `loadProjectsForExport`), `sameCanvasScope`.
- Produces for Task 5:

```ts
export type CanvasProjectSyncStatus = "loading" | "ready" | "error";

export type UseCanvasProjectSyncParams = {
    projectId: string;
    /** 只做媒体补水，不写 React 状态；返回的引用原样交给 commit 与 apply。 */
    hydrate: (project: CanvasProject) => Promise<CanvasProject>;
    /** 在 commit 之后同步写入页面 React 状态。 */
    applyToCanvas: (project: CanvasProject) => void;
};

export type UseCanvasProjectSyncResult = {
    /** 渲染闸门：ready 且活动会话的 canvasId 与作用域都与当前路由一致。 */
    ready: boolean;
    status: CanvasProjectSyncStatus;
    errorKey: string | null;
    title: string;
    /** 重新走一次标准 prepare/commit 打开流程，用于闸门错误重试与不变量事故恢复。 */
    reopen: () => void;
    reloadServerCopy: () => Promise<CanvasCommitServerCopyResult>;
};

export function useCanvasProjectSync(params: UseCanvasProjectSyncParams): UseCanvasProjectSyncResult;
```

- [ ] **Step 1: Implement `web/src/pages/canvas/hooks/use-canvas-project-sync.ts`**

```ts
export function useCanvasProjectSync({ projectId, hydrate, applyToCanvas }: UseCanvasProjectSyncParams): UseCanvasProjectSyncResult {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const { t } = useTranslation();
    const scope = useCanvasStore((state) => state.scope);
    const sync = useCanvasStore((state) => state.sync);
    const activeCanvasId = useCanvasStore((state) => state.activeCanvasId);
    const [status, setStatus] = useState<CanvasProjectSyncStatus>("loading");
    const [errorKey, setErrorKey] = useState<string | null>(null);
    const [applied, setApplied] = useState(false);
    const [openRun, setOpenRun] = useState(0);
    const runRef = useRef(0);
    const hydrateRef = useRef(hydrate);
    const applyRef = useRef(applyToCanvas);
    hydrateRef.current = hydrate;
    applyRef.current = applyToCanvas;
    const scopeKey = scope ? [scope.userId, scope.workspaceId].join(":") : "";

    useEffect(() => {
        if (!projectId || !scopeKey) return;
        /** 打开画布同时作废仍在进行的冲突重载：两者共用一个运行序号。 */
        const run = ++runRef.current;
        const superseded = () => run !== runRef.current;
        setApplied(false);
        setStatus("loading");
        setErrorKey(null);
        void (async () => {
            const prepared = await canvasSyncManager.prepareOpen(projectId);
            if (superseded() || prepared.status === "cancelled") return;
            if (prepared.status === "missing") {
                message.error(t("canvas.notFound"));
                navigate("/canvas", { replace: true });
                return;
            }
            if (prepared.status === "failed") {
                setStatus("error");
                setErrorKey(prepared.messageKey);
                return;
            }
            const hydrated = await hydrateRef.current(prepared.project);
            if (superseded()) return;
            /** commit 返回 false 一律按 cancelled 处理：不写 React、不导航、不提示。 */
            if (!canvasSyncManager.commitPrepared(prepared, hydrated)) return;
            applyRef.current(hydrated);
            setApplied(true);
            setStatus("ready");
        })();
    }, [message, navigate, openRun, projectId, scopeKey, t]);

    const reloadServerCopy = useCallback(async (): Promise<CanvasCommitServerCopyResult> => {
        const run = ++runRef.current;
        const superseded = () => run !== runRef.current;
        /** 闸门先关：补水期间画布容器不挂载，因此不可交互，也产生不了编辑。 */
        setApplied(false);
        const prepared = await canvasSyncManager.prepareServerCopy(projectId);
        if (superseded()) return "cancelled";
        if (prepared.status !== "ready") {
            setApplied(true);
            return prepared.status === "cancelled" ? "cancelled" : "failed";
        }
        const hydrated = await hydrateRef.current(prepared.project);
        if (superseded()) return "cancelled";
        const result = canvasSyncManager.commitServerCopy(prepared, hydrated);
        if (result !== "committed") {
            /** 失败时 store 完全没被改过：恢复原来的冲突会话与冲突条，不停在空壳上。 */
            setApplied(true);
            return result;
        }
        applyRef.current(hydrated);
        setApplied(true);
        return "committed";
    }, [projectId]);

    const reopen = useCallback(() => setOpenRun((value) => value + 1), []);
    const ready = status === "ready" && applied && activeCanvasId === projectId && sync?.canvasId === projectId && sameCanvasScope(sync.scope, scope);

    return { ready, status, errorKey, title: sync?.canvasId === projectId ? sync.title : "", reopen, reloadServerCopy };
}
```

`reopen` bumps `openRun`, which re-runs the same effect, so the invariant recovery action and the gate's retry both go through the standard prepare/commit path rather than a page reload.

- [ ] **Step 2: Split hydration from application in `project.tsx` and drive the page from the hook**

Delete `syncedContentRef`, `syncedViewportRef`, `reloadRunRef`, `viewportSaveTimerRef`, `didInitialCenterRef`, the `projectLoaded` state, the old open effect, the old `reloadServerCopy` callback and the `currentProject` selector. Replace the single async `applyProjectToCanvas` with the pair below.

```ts
    const shouldCenterRef = useRef(false);
    /** 初始居中产生的视口不算用户编辑：靠引用相等把它从保存路径里排除。 */
    const centeredViewportRef = useRef<ViewportTransform | null>(null);

    const hydrateProject = useCallback(async (project: CanvasProject): Promise<CanvasProject> => {
        const serverNodes = resetInterruptedGeneration(project.nodes);
        const serverSessions = project.chatSessions || [];
        const [nodes, chatSessions] = await Promise.all([
            hydrateWithFallback(hydrateCanvasImages(serverNodes), serverNodes),
            hydrateWithFallback(hydrateAssistantImages(serverSessions), serverSessions),
        ]);
        /** 补水失败或超时用未补水内容继续，绝不永远停在闸门上。 */
        return { ...project, nodes, chatSessions };
    }, []);

    const applyProjectToCanvas = useCallback((project: CanvasProject) => {
        historyPausedRef.current = true;
        setNodes(project.nodes);
        setConnections(project.connections);
        setChatSessions(project.chatSessions);
        setActiveChatId(project.activeChatId);
        setBackgroundMode(project.backgroundMode);
        setShowImageInfo(project.showImageInfo);
        setViewport(project.viewport);
        historyRef.current = { past: [], future: [] };
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        lastHistoryRef.current = {
            nodes: project.nodes,
            connections: project.connections,
            chatSessions: project.chatSessions,
            activeChatId: project.activeChatId,
            backgroundMode: project.backgroundMode,
            showImageInfo: project.showImageInfo,
        };
        setHistoryState({ canUndo: false, canRedo: false });
        historyPausedRef.current = false;
        /** 服务端视口是权威：只有恰为 {0,0,1} 才允许一次初始居中。 */
        shouldCenterRef.current = project.viewport.x === 0 && project.viewport.y === 0 && project.viewport.k === 1;
    }, []);

    const { ready, status: syncStatus, errorKey: syncErrorKey, title: projectTitle, reopen, reloadServerCopy } = useCanvasProjectSync({
        projectId,
        hydrate: hydrateProject,
        applyToCanvas: applyProjectToCanvas,
    });
```

Because `applyProjectToCanvas` writes exactly the object the hook passed to `commitPrepared`, the content effect's first run after a commit compares equal field-by-field inside `session.update` and produces no edit, so opening a canvas never advances its revision.

- [ ] **Step 3: Replace the content, viewport and lifecycle effects**

```ts
    useEffect(() => {
        if (!ready) return;
        /** 会话自己做引用比较，页面不再判断「这次变更要不要保存」。 */
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, nodes, projectId, ready, showImageInfo, updateProject]);

    useEffect(() => {
        if (!ready) return;
        /** 视口不再有页面级二级防抖，直接交给会话的 120 ms / 400 ms 合并。 */
        if (centeredViewportRef.current === viewport) {
            centeredViewportRef.current = null;
            return;
        }
        updateProject(projectId, { viewport });
    }, [projectId, ready, updateProject, viewport]);

    /** 离开或隐藏时只做 best-effort flush；耐久性来自 120 ms 内已排程的本地草稿。 */
    useEffect(() => {
        if (!ready) return;
        const flush = () => void flushProject(projectId);
        const flushWhenHidden = () => {
            if (document.visibilityState === "hidden") flush();
        };
        window.addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", flushWhenHidden);
        return () => {
            window.removeEventListener("pagehide", flush);
            document.removeEventListener("visibilitychange", flushWhenHidden);
            flush();
        };
    }, [flushProject, projectId, ready]);
```

Every remaining `flushProjectChanges()` call site (`createAndOpenProject` and any navigation path) becomes `await flushProject(projectId)`; the viewport merge that function used to perform is gone because the viewport now goes straight into the session.

- [ ] **Step 4: Install the ResizeObserver from a callback ref**

```ts
    const containerRef = useRef<HTMLDivElement | null>(null);

    /** 闸门先关后开，容器是后挂载的，空依赖 useEffect 会导致 observer 永不安装。 */
    const attachCanvasContainer = useCallback((node: HTMLDivElement | null) => {
        containerRef.current = node;
        if (!node) return;
        const measure = () => {
            const rect = node.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!shouldCenterRef.current) return;
            shouldCenterRef.current = false;
            const centered = { x: rect.width / 2, y: rect.height / 2, k: 1 };
            centeredViewportRef.current = centered;
            setViewport(centered);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => {
            observer.disconnect();
            containerRef.current = null;
        };
    }, []);
```

Delete the old `useEffect(() => { const el = containerRef.current; ... }, [])` block and pass `containerRef={attachCanvasContainer}` to `InfiniteCanvas`. Everything else in the page keeps reading `containerRef.current`.

In `web/src/components/canvas/infinite-canvas.tsx` change the prop type to `containerRef: React.RefCallback<HTMLDivElement>`, keep an internal ref for the component's own reads, and move the existing wheel listener into the same callback so nothing depends on mount ordering.

```ts
/** 覆盖层与弹窗内保留原生滚动，画布本身阻止滚动带动页面。 */
function preventWheelScroll(event: WheelEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
    event.preventDefault();
}

export function InfiniteCanvas({ containerRef, ... }: InfiniteCanvasProps) {
    const nodeRef = useRef<HTMLDivElement | null>(null);

    const attachContainer = useCallback(
        (node: HTMLDivElement | null) => {
            nodeRef.current = node;
            const detachParent = containerRef(node);
            node?.addEventListener("wheel", preventWheelScroll, { passive: false });
            return () => {
                node?.removeEventListener("wheel", preventWheelScroll);
                nodeRef.current = null;
                if (typeof detachParent === "function") detachParent();
            };
        },
        [containerRef],
    );
    // ...
    return <div ref={attachContainer} ...>
}
```

Replace the component's three internal `containerRef.current` reads with `nodeRef.current` and delete its old wheel `useEffect`. No other component passes `containerRef`, so this prop change is contained: `rg -n '<InfiniteCanvas' web/src` must show only `project.tsx`.

- [ ] **Step 5: Gate the Agent bridge**

`web/src/pages/canvas/hooks/use-agent-bridge.ts` takes one more parameter and refuses to act while the gate is closed.

```ts
type AgentBridgeParams = {
    /** 与渲染闸门条件完全一致：ready 且 scope/route/canvasId 三者一致。 */
    enabled: boolean;
    projectId: string;
    // ...unchanged members
};

export function useAgentBridge(params: AgentBridgeParams) {
    const { enabled, ... } = params;
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;

    const applyAgentOps = useCallback(
        (ops?: CanvasAgentOp[]) => {
            /** 未就绪时直接拒绝，不改任何 React 状态。 */
            if (!enabledRef.current) throw new Error(i18n.t("canvas.agent.notReady"));
            // ...unchanged body
        },
        [projectTitle, projectId],
    );

    useEffect(() => {
        if (!enabled) {
            /** 切画布或切作用域的瞬间不能把 A 的内容发布成 B 的上下文。 */
            setAgentCanvasContext(null);
            return;
        }
        setAgentCanvasContext({ snapshot: agentSnapshot, applyOps: applyAgentOps, undoOps: undoAgentOps, canUndo: Boolean(agentUndoSnapshot) });
        return () => setAgentCanvasContext(null);
    }, [agentSnapshot, applyAgentOps, agentUndoSnapshot, enabled, setAgentCanvasContext, undoAgentOps]);
```

In `project.tsx` pass `enabled: ready` and `title: projectTitle` to `useAgentBridge`. Add the one new key to both locale files:

```ts
// zh-CN.ts, inside canvas: { ... }
agent: { notReady: "画布尚未就绪，请稍后再试" },
// en-US.ts, inside canvas: { ... }
agent: { notReady: "The canvas is not ready yet. Try again shortly." },
```

- [ ] **Step 6: Adapt the page's remaining store call sites and the gate rendering**

```ts
    const createAndOpenProject = useCallback(async () => {
        /** 新建会替换 active，先把当前画布的最后一次编辑捕获掉。 */
        await flushProject(projectId);
        const result = await createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().summaries.length + 1 }));
        /** 账号或 Workspace 已切换时这条结果属于旧作用域：既不导航也不提示失败。 */
        if (result.status === "scope-changed") return;
        if (result.status === "failed") return message.error(t(result.messageKey));
        navigate(`/canvas/${result.canvasId}`);
    }, [createProject, flushProject, message, navigate, projectId, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        setTitleEditing(false);
        if (!nextTitle) return;
        void renameProject(projectId, nextTitle).then((result) => {
            /** 冲突或恢复阻断时标题只落本地草稿，必须说清楚，不能提示成功。 */
            if (result.status === "local-only") message.warning(t("canvas.rename.localOnly"));
            if (result.status === "failed") message.error(t(result.messageKey));
        });
    }, [message, projectId, renameProject, t, titleDraft]);

    if (syncStatus === "error")
        return (
            <main className="flex h-full flex-col items-center justify-center gap-3 text-sm" style={{ background: theme.canvas.background, color: theme.node.muted }}>
                <p>{t(syncErrorKey || "canvas.openFailed")}</p>
                <button type="button" onClick={reopen} className="rounded-md px-3 py-1 font-medium transition hover:bg-black/5 dark:hover:bg-white/10">
                    {t("canvas.retry")}
                </button>
            </main>
        );
    if (!ready) return <CanvasRefreshShell />;
```

`title` for `CanvasTopBar` becomes `projectTitle || t("canvas.projectPage.untitledCanvas")`, `startTitleEditing` seeds `titleDraft` from the same value, and `CanvasTopBar` receives the new `onReloadCanvas={reopen}` prop that Task 5 forwards to the save-status indicator. `CanvasConflictBar` keeps `projectId` and now takes `onReloadServerCopy={reloadServerCopy}` returning `CanvasCommitServerCopyResult`.

- [ ] **Step 7: Hand the user the verification commands (do not run them)**

Run: `bun --cwd web run typecheck`
Expected at this commit: failures only in `web/src/pages/canvas/index.tsx`, `canvas-save-status.tsx`, `canvas-conflict-bar.tsx` and `canvas-project-card.tsx`, which Task 5 rewrites. Errors anywhere else are defects in this task.

Run: `rg -n 'syncedContentRef|syncedViewportRef|reloadRunRef|projectLoaded|viewportSaveTimerRef' web/src`
Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/canvas/hooks/use-canvas-project-sync.ts web/src/pages/canvas/project.tsx web/src/pages/canvas/hooks/use-agent-bridge.ts web/src/components/canvas/infinite-canvas.tsx web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
git commit -m "refactor: drive canvas page by prepare/commit"
```

### Task 5: Sync UI, List Operations And Localisation

**Files:**
- Modify: `web/src/components/canvas/canvas-save-status.tsx`, `web/src/components/canvas/canvas-conflict-bar.tsx`, `web/src/components/canvas/canvas-top-bar.tsx`, `web/src/components/canvas/canvas-project-card.tsx`, `web/src/components/canvas/canvas-delete-projects-dialog.tsx`, `web/src/pages/canvas/index.tsx`, `web/src/i18n/locales/zh-CN.ts`, `web/src/i18n/locales/en-US.ts`
- Test: none (spec §2.2)

**Interfaces:**
- Consumes from Tasks 3-4: store members `sync`, `activeCanvasId`, `retrySave`, `retryRecovery`, `exportConflictDrafts`, `createProject`, `importProject`, `renameProject`, `deleteProjects`, `loadProjectsForExport`; `CanvasCommitServerCopyResult` from the page hook via props.
- Produces: no new module exports; this task closes the cutover so `bun --cwd web run typecheck` passes again.

- [ ] **Step 1: Map the session view onto the save status indicator (spec §9.5)**

```ts
export function CanvasSaveStatus({ onReloadCanvas }: { onReloadCanvas: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const sync = useCanvasStore((state) => state.sync);
    const retrySave = useCanvasStore((state) => state.retrySave);
    const retryRecovery = useCanvasStore((state) => state.retryRecovery);
    const [busy, setBusy] = useState(false);
    if (!sync) return null;

    const canvasId = sync.canvasId;
    const degraded = sync.localPersist === "degraded";
    const invariant = sync.saveError?.kind === "invariant";
    /** clean 且本会话从未保存过时不显示状态位；冲突由冲突条表达。 */
    const label =
        sync.phase === "saving"
            ? t("canvas.save.saving")
            : sync.phase === "dirty"
              ? t("canvas.save.unsaved")
              : sync.phase === "save-error"
                ? t(sync.saveError?.messageKey || "canvas.save.failed")
                : sync.phase === "recovery-blocked"
                  ? t("canvas.save.recoveryFailed")
                  : sync.phase === "clean" && sync.savedOnce
                    ? t("canvas.save.saved")
                    : "";
    if (!label && !degraded) return null;

    const action = invariant
        ? { label: t("canvas.save.reloadCanvas"), run: async () => onReloadCanvas() }
        : sync.phase === "save-error"
          ? { label: t("canvas.save.retry"), run: () => retrySave(canvasId) }
          : sync.phase === "recovery-blocked"
            ? {
                  label: t("canvas.save.recoveryRetry"),
                  run: async () => {
                      if ((await retryRecovery(canvasId)) === "failed") message.error(t("canvas.save.recoveryRetryFailed"));
                  },
              }
            : null;
```

Render the label, append `t("canvas.save.localDegraded")` when `degraded`, and render `action` as the same flat underlined button the file already uses, keeping `aria-label`, the `busy` guard and `theme.node.muted` versus `#dc2626` colouring. `CanvasTopBar` gains `onReloadCanvas: () => void` in its props and passes it straight to `<CanvasSaveStatus onReloadCanvas={onReloadCanvas} />`; its title input keeps the existing `maxLength={CANVAS_TITLE_MAX_LENGTH}`.

- [ ] **Step 2: Rebuild the conflict bar on the session view**

```ts
export function CanvasConflictBar({ projectId, onReloadServerCopy }: { projectId: string; onReloadServerCopy: () => Promise<CanvasCommitServerCopyResult> }) {
    const conflict = useCanvasStore((state) => (state.sync?.canvasId === projectId ? state.sync.conflict : null));
    const degraded = useCanvasStore((state) => (state.sync?.canvasId === projectId ? state.sync.localPersist === "degraded" : false));
    const exportConflictDrafts = useCanvasStore((state) => state.exportConflictDrafts);
    const [busy, setBusy] = useState<"reload" | "export" | null>(null);
    if (!conflict) return null;

    const reload = async () => {
        setBusy("reload");
        try {
            const result = await onReloadServerCopy();
            /** cancelled 表示被新的打开或重载取代，保持安静。 */
            if (result === "committed") message.success(t("canvas.conflict.reloaded"));
            if (result === "failed") message.error(t("canvas.conflict.reloadFailed"));
        } finally {
            setBusy(null);
        }
    };

    const exportDrafts = async () => {
        setBusy("export");
        try {
            const projects = await exportConflictDrafts(projectId);
            if (!projects.length) return message.error(t("canvas.conflict.draftMissing"));
            /** 最多两份，新→旧，一起打包进同一个 zip。 */
            await exportCanvasProjects(projects, t("canvas.conflict.draftName", { title: projects[0].title || t("canvas.project.untitled") }));
            message.success(t("canvas.conflict.exported"));
        } catch {
            message.error(t("canvas.conflict.exportFailed"));
        } finally {
            setBusy(null);
        }
    };

    const exportLabel = conflict.extraDraftCount > 0 ? t("canvas.conflict.exportDraftMultiple", { count: conflict.extraDraftCount + 1 }) : t("canvas.conflict.exportDraft");
```

Keep the existing markup, `canvasThemes` tokens, `role="status"` and both `aria-label`s; use `exportLabel` for the export button and, when `degraded` is true, render one extra line with `t("canvas.conflict.localDegraded")` inside the same bar.

- [ ] **Step 3: Adapt the list card and confirm the delete dialog**

```ts
    const saveTitle = async () => {
        const result = await renameProject(summary.id, editingTitle);
        if (result.status === "conflict") return message.error(t("canvas.rename.conflictHint"));
        if (result.status === "failed") return message.error(t(result.messageKey));
        if (result.status === "local-only") message.warning(t("canvas.rename.localOnly"));
        if (result.status === "saved") message.success(t("canvas.renamed"));
        /** saved / scheduled / local-only / scope-changed 都结束编辑态，只有真正失败才保留输入内容。 */
        stopEditing();
    };
```

The card's `Input` already has `maxLength={CANVAS_TITLE_MAX_LENGTH}`; verify it rather than adding it again. `canvas-delete-projects-dialog.tsx` already consumes `{ deleted, failed }` and needs no code change — confirm with `rg -n 'deleteProjects' web/src/components/canvas/canvas-delete-projects-dialog.tsx` and leave the file untouched if the shape matches.

- [ ] **Step 4: Adapt the canvas list page to the new result types**

```ts
    const createAndEnter = async () => {
        const result = await createProject(t("canvas.defaultTitle", { count: summaries.length + 1 }));
        if (result.status === "created") {
            enterProject(result.canvasId);
            return true;
        }
        /** 账号或 Workspace 已切换：既不导航也不提示失败，新作用域会自己再发起一次。 */
        if (result.status === "failed") message.error(t(result.messageKey));
        return false;
    };

    // inside importCanvas
    for (const item of data.projects) {
        const result = await importProject(item.project, t("canvas.project.imported"));
        /** 切换作用域后剩下的画布不再属于当前列表，直接停止，不计为失败。 */
        if (result.status === "scope-changed") break;
        if (result.status === "created") created += 1;
        else failed += 1;
    }
```

Remove the `isScopeChangedError` import and its `try/catch` wrappers; keep the existing `autoOpenRef` keyed by `autoOpenScopeKey` so a Workspace switch during `mode=new` lets the new scope start its own attempt instead of staying on "正在打开".

- [ ] **Step 5: Add the remaining localisation keys**

```ts
// zh-CN.ts, inside canvas: { ... }
renamed: "重命名成功",
rename: { localOnly: "标题仅保存在本地草稿", conflictHint: "该画布存在版本冲突，请打开画布后处理" },
// zh-CN.ts, inside canvas.save: { ... }
unsaved: "未保存",
reloadCanvas: "重新载入画布",
localDegraded: "本地草稿不可用",
// zh-CN.ts, inside canvas.conflict: { ... }
exportDraftMultiple: "导出本地草稿（{{count}} 份）",
localDegraded: "本地草稿不可用，请立即导出",

// en-US.ts, inside canvas: { ... }
renamed: "Canvas renamed",
rename: { localOnly: "The title is only stored in the local draft", conflictHint: "This canvas has a revision conflict. Open it to resolve." },
// en-US.ts, inside canvas.save: { ... }
unsaved: "Unsaved",
reloadCanvas: "Reload canvas",
localDegraded: "Local draft unavailable",
// en-US.ts, inside canvas.conflict: { ... }
exportDraftMultiple: "Export local drafts ({{count}})",
localDegraded: "Local drafts are unavailable. Export now.",
```

`canvas.rename.localOnly` is also referenced by `project.tsx` from Task 4; because Tasks 3-5 are one cutover chain, that intermediate commit is not runnable anyway, and the key exists from this commit on.

- [ ] **Step 6: Hand the user the full verification set (do not run any of it)**

Run first, in this order:

```bash
bun --cwd web run typecheck
bun --cwd web run build
```

Expected: both succeed. This is the commit where the cutover chain closes, so any remaining reference to `saveState`, `active`, `openProject`, `readConflictDraft`, `retryCanvasRecovery`, `isScopeChangedError` or `canvas-drafts` is a defect.

Then the interactive matrix from spec §14, run by the user in a browser (the agent runs none of it):

Stage A — baseline: (1) create, open, rename, delete, reload and confirm everything comes from the server; (2) open a canvas, wait 5 s without touching it, confirm `revision` and `updatedAt` do not change and no "已保存" appears; (3) drag nodes, connect, change background, pan and zoom, confirm one save lands about 400 ms after the last change with 未保存 → 保存中 → 已保存; (4) edit while a save is in flight and confirm "已保存" never appears early and the second request uses the revision the first one returned.

Stage B — concurrency: (5) throttle A's load, open A then immediately B, confirm B renders and A's late result changes nothing and shows no error; (6) edit A then immediately create B, confirm A's last edit still lands on A and creation is not blocked; (7) switch Workspace with a delayed in-flight request and confirm no frame of the old scope appears; (8) switch Workspace during Agent `mode=new` and confirm the new scope starts its own attempt instead of staying on "正在打开".

Stage C — conflict: (9) edit the same canvas in two tabs, confirm the loser stops autosaving, shows the conflict bar and keeps its own local content; (10) keep editing nodes, viewport and title after the conflict, export the local draft, confirm it is the newest content and no save request was sent; (11) refresh after a conflict, confirm the bar and local content return and autosave stays blocked; (12) create conflicts on A and B, switch back and forth, confirm they never overwrite each other; (13) press "载入服务端版本" and try to drag, pan and type while hydration runs, confirm the canvas stays non-interactive with no save request and ends on the server version with the bar gone; (14) force the reload request to fail and confirm the previous conflicted canvas returns without a "已载入" toast.

Stage D — local storage: (15) make IndexedDB writes reject and confirm "本地草稿不可用" appears while cloud saving still succeeds; (16) make local reads never settle, confirm the canvas still opens into "本地恢复失败" with network saving blocked, then a successful retry saves the accumulated edits; (17) edit during recovery blocking, then let the retry find an old marker, and confirm the exported first draft is the newest content; (18) inspect IndexedDB: `canvas_recovery` holds at most one session draft plus one marker per canvas and `canvas_drafts` is gone.

Stage E — failure and regression: (19) hold a save past 20 s, confirm "保存失败" with a working retry and that other canvases still open and create; (20) delete several canvases with one failure injected, confirm only successful ids leave the list and the failed one keeps its pending edits; (21) type a 250-character title and confirm it is capped at 200 and saves; (22) trigger `pagehide`, reopen, and confirm the last edit exists at least in the local draft; (23) inspect the saved snapshot and the local draft for `blob:` URLs and confirm text and plugin node content is unchanged; (24) drag a ~200-node canvas for 3 s and confirm no sustained long tasks and roughly 25 IndexedDB writes rather than one per frame; (25) switch between Chinese and English and confirm every new string and `aria-label` is present.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/canvas/canvas-save-status.tsx web/src/components/canvas/canvas-conflict-bar.tsx web/src/components/canvas/canvas-top-bar.tsx web/src/components/canvas/canvas-project-card.tsx web/src/pages/canvas/index.tsx web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
git commit -m "fix: align canvas sync ui with session view"
```

If `canvas-delete-projects-dialog.tsx` genuinely needed no edit, do not stage it.

### Task 6: Changelog, Progress Documents And SDD Ledger

**Files:**
- Modify: `CHANGELOG.md`, `docs/content/docs/progress/pending-test.mdx`, `docs/content/docs/progress/todo.mdx`, `.superpowers/sdd/2026-08-26-cloud-canvases-assets/progress.md`
- Do not modify: `docs/content/docs/overview/features.mdx` (spec §15 keeps it frozen until the user confirms acceptance)
- Test: none

**Interfaces:**
- Consumes: the behavior delivered in Tasks 1-5 and the acceptance matrix in Task 5 Step 6.
- Produces: no code surface.

- [ ] **Step 1: Add the version-level summary to `CHANGELOG.md` under `## Unreleased`**

```markdown
+ [调整] 画布同步改由单画布会话对象统一持有所有权、生命周期与状态，Zustand 退化为视图适配层，打开画布与载入服务端版本都改为两阶段提交。
+ [修复] 迟到的打开、保存与本地读取结果不再改写当前画布，「已保存」只在确实没有未保存编辑时出现，冲突、本地恢复失败与保存失败各自有明确状态和显式动作。
+ [新增] 本地草稿改用 canvas_recovery 存储，每个会话一条草稿、每个画布一条冲突标记，最多保留两份冲突草稿并可一次性导出。
+ [优化] 本地草稿与云端保存改为两套互不等待的有界调度，连续拖动期间最多只压一份待写快照，慢速或无响应的本地存储不再拖住云端保存。
```

Append these four lines to the existing `Unreleased` block without rewriting or removing the entries already there.

- [ ] **Step 2: Update `docs/content/docs/progress/pending-test.mdx`**

Rewrite the now-inaccurate draft-storage item (currently item 8 of "Cloud canvases as the authoritative store", which still names `canvas_drafts` and revision-scoped draft keys) to describe the new layout, then append the refactor's own verification group.

```markdown
  8. Confirm local recovery lives in `localforage` (`infinite-canvas` / `canvas_recovery`) with at most one session draft per canvas under `canvas-draft:<userId>:<workspaceId>:<canvasId>:<draftId>` and one `canvas-conflict:<userId>:<workspaceId>:<canvasId>` marker holding at most two entries, that the legacy `canvas_drafts` store is gone, that only the resolved or deleted canvas's records are cleared, and that no canvas list or draft is written to `localStorage`.
- Canvas sync session refactor:
  1. Baseline: create, open, rename, delete and reload from the server; open a canvas untouched for 5 seconds and confirm neither `revision` nor `updatedAt` moves and no "已保存" appears; edit and confirm one save about 400 ms after the last change with 未保存 → 保存中 → 已保存; keep editing during a save and confirm "已保存" never appears while edits are unsaved and the next request uses the returned revision.
  2. Ownership: throttle canvas A and open B immediately after; edit A then create B; switch Workspace with a delayed request in flight; start Agent `mode=new` and switch Workspace before it returns. No late open, save, draft read or hydration may change the current canvas, navigate, or show a failure, and the new scope must start its own attempt.
  3. Conflict: force a conflict in two tabs and confirm the loser stops autosaving, shows the conflict bar and keeps its own content; keep editing and export the local draft and confirm it is the newest content with no save request; refresh and confirm the conflict is restored; conflict two canvases and switch between them; use "载入服务端版本" and confirm the canvas is non-interactive with no save during hydration; make the reload fail and confirm the conflicted canvas returns without a success toast. A conflict produced in one tab is intentionally visible in another tab of the same origin, and "载入服务端版本" there clears that shared draft.
  4. Local storage: make IndexedDB writes reject and confirm "本地草稿不可用" appears while cloud saving continues; make reads never settle and confirm the canvas opens into "本地恢复失败" with cloud saving blocked, edits still reaching local drafts, and a successful retry saving the accumulated edits; edit during recovery blocking and confirm the newest content is exported first.
  5. Failure handling: hold a save past 20 seconds and confirm "保存失败" with a retry that captures the current content; delete several canvases with one failure injected; enter a 250-character title; trigger `pagehide`; confirm neither the server snapshot nor the local draft contains a `blob:` URL while text and plugin node content is preserved; confirm the sync-status indicator can show 未保存, 保存中, 已保存, 保存失败, 本地恢复失败 and 同步状态异常 with working actions in both languages.
  6. Performance: drag a canvas with roughly 200 nodes for 3 seconds and confirm no sustained main-thread long tasks, roughly 25 local draft writes instead of one per animation frame, at most one save request during the drag plus one about 400 ms after it, and that the canvas container still resizes correctly and only auto-centers a canvas whose stored viewport is exactly `{ x: 0, y: 0, k: 1 }`.
```

- [ ] **Step 3: Check `docs/content/docs/progress/todo.mdx` against spec §15**

Spec §15 requires two follow-ups: media is still local so devices see missing images until the Asset cutover, and canvas deletion does not reclaim local media so browser storage keeps growing. Both already exist in the file (the "Complete Task 5's server-side object-storage cutover" and "Add scoped cleanup and usage visibility for orphaned canvas media and obsolete local drafts" entries), as does the entry about correcting the Features page after acceptance. Verify all three are present and still accurate; if any is missing, add it. Extend the cleanup entry with the new fact:

```markdown
- Local canvas drafts are only garbage-collected when they are older than six hours and unreferenced, so a same-origin tab that is left open can retain one extra draft per canvas until the Asset lifecycle owns reference cleanup.
```

- [ ] **Step 4: Append the Task 3 ruling to `.superpowers/sdd/2026-08-26-cloud-canvases-assets/progress.md`**

```markdown
Task 3 Ruling: the sync algorithm's ownership, lifecycle and state are consolidated into one `CanvasSyncSession` per open canvas with a `CanvasSyncManager` owning scope tokens, the single installed session and bounded detached sessions; Zustand is a view adapter and the page only hydrates and renders. The authoritative design is `docs/superpowers/specs/2026-08-27-canvas-sync-session-design.md` and the executable plan is `docs/superpowers/plans/2026-08-27-canvas-sync-session-refactor.md`. Later reviews of Task 3 judge against that spec rather than the earlier round-by-round fixes: content replacement only happens through prepare/commit, "已保存" only when `savedSeq === editSeq` with nothing in flight, unreadable local recovery is a third state that blocks network saves, and local draft writes stay bounded to one slot and one drain. No frontend test framework is added in this round; acceptance is the manual matrix in spec §14, recorded in `docs/content/docs/progress/pending-test.mdx`.
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/content/docs/progress/pending-test.mdx docs/content/docs/progress/todo.mdx .superpowers/sdd/2026-08-26-cloud-canvases-assets/progress.md
git commit -m "docs: record canvas sync session refactor"
```

---

## Rollback Boundary

Spec §16 governs rollback and nothing in this plan changes it.

- The blast radius is `web/` only. Server, contracts, migrations and the database are untouched, so a rollback involves no data migration.
- If Stage A or Stage B acceptance fails and cannot be resolved the same day, `git revert` this plan's six commits back to the branch base `5f9767e`. The product returns to its previous known state, including the defects the three earlier reviews listed.
- Before rolling back, export any unexported conflict drafts through the conflict bar: they are local data and the revert removes the code that can read the new `canvas_recovery` store.
- After rolling back, delete the `canvas_recovery` store manually in the browser. `canvas_drafts` was dropped by the new code, and the old code recreates it empty, so no stale data is read.
- Stage C, D and E failures are fixed in place rather than rolled back: those paths were equally defective before this refactor, so reverting cannot improve them.

## Spec Section Coverage

| Spec section | Where it lands |
| --- | --- |
| §2 goals and non-goals | Global Constraints |
| §3 component boundaries and prohibitions | Global Constraints, File Boundary |
| §4.1-4.2 store, keys, records | Task 1 Steps 3 and 5 |
| §4.3-4.4 conflict definition and open decision table | Task 2 Step 1 |
| §4.5 draft garbage collection | Task 1 Step 5 (`collectGarbage`), Task 3 Step 2 (`collectDraftGarbage` after commit) |
| §5.1-5.3 phases, counters, transitions | Task 2 Steps 2-6 |
| §5.4 invariant handling | Task 2 Step 2 (`assertEvent`, `assertCounters`, `enterInvariant`), Task 5 Step 1 (UI action) |
| §6.1 local scheduler | Task 2 Step 3 |
| §6.2 network scheduler | Task 2 Steps 4-5 |
| §6.3 constants | Task 1 Step 3 |
| §7.1 open prepare/commit | Task 3 Step 2, Task 4 Step 1 |
| §7.2 conflict reload | Task 3 Step 2 (`commitServerCopy`), Task 4 Step 1, Task 5 Step 2 |
| §7.3 render gate and Agent bridge | Task 4 Steps 1, 5, 6 |
| §7.4 dispose and bounded detached flush | Task 2 Step 7, Task 3 Step 1 |
| §7.5 ResizeObserver and viewport | Task 4 Steps 3-4 |
| §8.1 per-canvas markers | Task 1 Step 5, Task 2 Step 1 |
| §8.2 same-origin tabs tradeoff | Task 1 Step 5 (6 h GC threshold), Task 6 Step 2 (documented, not a defect) |
| §8.3 recovery retry ownership | Task 2 Step 6 |
| §8.4 conflict export | Task 2 Step 7, Task 5 Step 2 |
| §9.1-9.3 shared types, session, manager | Task 1 Step 3, Task 2, Task 3 |
| §9.4 store surface and page hook | Task 3 Step 4, Task 4 Step 1 |
| §9.5 status and conflict-bar mapping | Task 5 Steps 1-2 |
| §9.6 local recovery repository | Task 1 Step 5 |
| §10 list-level operations | Task 3 Step 3, Task 5 Steps 3-4 |
| §11 concurrency and failure matrix | Coverage table above |
| §12 performance and memory invariants | Coverage table above |
| §13 migration and file plan | File Boundary, Task Map, Task 3 Step 5 (deletion) |
| §14 manual acceptance matrix | Task 5 Step 6 |
| §15 documentation strategy | Task 6 |
| §16 rollback boundary | Rollback Boundary above |
