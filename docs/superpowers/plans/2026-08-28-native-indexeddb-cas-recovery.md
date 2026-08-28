# Native IndexedDB Transaction/CAS Recovery Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the localforage canvas draft recovery layer with an independent native IndexedDB database whose every bounded operation is one transaction with in-transaction compare-and-swap, so an unsynced canvas draft can never be silently lost, silently resurrected after a confirmed deletion, or read across identities.

**Architecture:** One dedicated database `infinite-canvas-recovery` (version 1) with fixed `drafts`, `markers` and `epochs` stores, all keyed by one opaque `RecoveryScopeId`. A connection factory takes an injected `IDBFactory` and performs open/upgrade explicitly, so importing a module never mutates storage. Every operation runs inside exactly one `IDBTransaction` that re-reads the scope epoch and the affected records before writing, and aborts the transaction when its deadline expires instead of letting a timed-out promise leave a late commit behind. Private draft writes advance a per-draft `writeSeq` only; marker changes, repairs, foreign draft deletes and GC advance `coordinationRevision` under an expected-value check; a confirmed canvas deletion is the only operation that advances `deletionGeneration` and writes a tombstone. `CanvasSyncSession` / `CanvasSyncManager` ownership, prepare/commit and the bounded single slot survive unchanged in shape; their local-write contract becomes CAS outcomes and the uncancellable-late-write compensation path (`settled` / `whenLocalSettled`) is deleted.

**Tech Stack:** TypeScript 5.9 (strict), React 19.2.5, Zustand 5, Vite 7.3, Vitest 4.1.11 (pinned to the version already in `bun.lock`), fake-indexeddb 6.2.5, nanoid 5, @infinite-canvas/contracts (TypeBox). No DOM/React test framework, no Yjs, no localforage in the recovery path.

**Spec:** `docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md` (sections 11, 16, 17 Gate 0). This is the authoritative spec. `docs/superpowers/specs/2026-08-27-canvas-sync-session-design.md` and `docs/superpowers/plans/2026-08-27-canvas-sync-session-refactor.md` are superseded for local persistence, testing and viewport decisions by their own header notes; use them only to understand why Session/Manager exist, never as a competing specification.

## Global Constraints

- Scope is the `web/` canvas recovery and sync boundary. `server/**`, `packages/contracts/**` schemas, database migrations and HTTP route shapes are not changed by any task. `CanvasDeletionReceiptSchema` already exists in `packages/contracts/src/canvases.ts` and is consumed as-is.
- Database identity is fixed: name `infinite-canvas-recovery`, version `1`, stores `drafts` / `markers` / `epochs`. The recovery layer is never a localforage instance and never shares a version, store or transaction with the `infinite-canvas` database.
- `drafts` keyPath `["scopeId", "draftId"]`, `markers` keyPath `["scopeId", "markerId"]`, `epochs` keyPath `"scopeId"`. `drafts` and `markers` each carry exactly one index `by_scope` on `"scopeId"`, used for scope-limited enumeration. No other index, store or key is added.
- Every read, CAS and GC is limited to one `RecoveryScopeId`. No operation enumerates, reads or deletes across scopes; there is no "all scopes" code path to accidentally call.
- The authoritative spec says a local scope is sufficient for Gate 0. This branch already has Identity/Workspace and cloud Canvas delivery at BASE `af37bfa`, so the current production wiring deliberately derives the active cloud canvas as `account:<userId>:workspace:<workspaceId>:canvas:<canvasId>`. The `local:<installationId>:<localCanvasId>` constructor and tests ship in the same version 1 schema but stay unconnected until a real local-only canvas entrypoint exists; no local record is silently claimed by an account.
- The recovery layer receives an `IDBFactory` through a factory function and performs open/upgrade only when called. Module import performs no open, no upgrade, no delete, no legacy drop.
- Recovery code may use only the injected factory and objects obtained from that factory, database, transaction or request. It never assumes ambient `indexedDB`, `IDBKeyRange` or another IndexedDB constructor exists. Exact scope enumeration passes `scopeId` directly to `index.getAll(scopeId)` / `getAllKeys(scopeId)`; any future operation that truly needs a range must receive the matching factory's key-range constructor explicitly.
- `versionchange` closes the owning connection immediately. `blocked` resolves as the named bounded failure reason `blocked`, which the recovery-blocked UI maps to its retry path; it never becomes an unbounded wait.
- Each bounded operation owns exactly one `IDBTransaction`. When the deadline expires the runner calls `transaction.abort()`; a timed-out promise alone is never accepted, because it would allow a late commit. Inside a transaction only IndexedDB requests are awaited. IndexedDB auto-commits once its request queue is empty and control returns to the event loop, so awaiting a timer, network request, never-settling promise or any other non-IDB promise can commit the transaction before the deadline callback has a chance to abort it. The transaction callback must derive all decisions from data already available synchronously or from `txn.req(...)` results.
- No delete is ever issued from a read taken outside the transaction that performs it. Deletion targets are re-read and re-validated in the deleting transaction.
- `epochs` separates `coordinationRevision`, `deletionGeneration` and a durable `tombstonedAt`. Ordinary `upsertDraft` (both `pending` and `synced` acks) reads the scope epoch and its own draft in the same transaction, rejects a tombstone or a mismatched `deletionGeneration`, then rejects `stored.writeSeq >= incoming.writeSeq`, and neither compares nor advances `coordinationRevision`.
- Marker changes, foreign draft deletes, repair commits and GC carry the `expectedCoordinationRevision` and `expectedDeletionGeneration` read at open, verify both in one `readwrite` transaction, and advance `coordinationRevision` by exactly 1 on commit.
- Opening a canvas reads epoch, marker and drafts for the scope in one `readonly` transaction so the three are one consistent snapshot. A repair whose expected epoch no longer matches is never forced: the open state is re-read and the resolution is recomputed.
- Corruption rules are fixed: a present-invalid epoch or marker makes the scope `unavailable/corrupt`; a corrupt draft row is omitted from recovery content but preserved, cannot be overwritten by a guessed `writeSeq`, and is ignored by ordinary GC. Only confirmed deletion may clear corrupt draft/marker rows, using the scope index/key inside its transaction. Missing epoch/marker rows alone mean initial epoch/no marker.
- Only a confirmed canvas deletion advances `deletionGeneration`, and it does so in the same transaction that writes `tombstonedAt` and deletes the scope's drafts and markers. Accepting the server version, resolving a conflict, closing a session, ordinary draft cleanup and GC advance `coordinationRevision` only and must never write a tombstone or touch `deletionGeneration`.
- A cloud canvas deletion is confirmed only by a positive `CanvasDeletionReceipt` from this client's own DELETE whose `canvasId` equals the scope's canvas. `404 canvas_not_found` from a GET/LIST, `workspace_forbidden`, a non-active Workspace, a removed member, network failure, timeout and any unknown or indeterminate response are never deletion proof: drafts are kept and the canvas is shown as controlled-unavailable. A local (not yet uploaded) canvas is confirmed by an explicit local deletion.
- Tombstones are retained long term. The first version does not restore a tombstoned canvas ID; recovering that content requires a new canvas ID and therefore a new scope.
- The legacy localforage store `{ name: "infinite-canvas", storeName: "canvas_recovery" }` is not a valid data source. It is deleted only by an explicit bootstrap upgrade action: no dual read, no automatic upload, no drop at module import. The project is unreleased, so no legacy data compatibility or field migration is written.
- `CanvasLocalWrite`, its `settled` channel, `CanvasSyncSession.whenLocalSettled`, `CanvasLocalRecovery.deleteMarkerIfOwned` and the two-phase late-write cleanup in the manager are deleted, not deprecated. A transaction that aborts leaves nothing behind, so there is nothing left to compensate for.
- `CanvasSyncSession` / `CanvasSyncManager` ownership, scope and open tokens, prepare/commit content replacement, the bounded single write slot and bounded detached sessions are preserved. Only their local persistence contract changes, from fire-and-forget writes to CAS outcomes.
- The draft envelope separates three parts: `document` (canonical title / baseRevision / snapshot, the only part a cloud serializer reads), `localUi` (viewport), and `assets` (`storageKey -> assetId/uploadState`). Pan and zoom advance an independent local-UI sequence, write only `localUi`, never participate in `savedSeq`/clean document state and never schedule a cloud save. The session freezes `documentDefaultViewport` from the opened canonical document; every local document draft and cloud save serializes that frozen value even after live pan/zoom. On open, the local viewport wins for rendering and the shared canonical viewport is the fallback. Only a future explicit "set as default view" document action may replace `documentDefaultViewport` and increase the document revision; that action and real Asset ID conversion belong to Gate 2 and are not implemented here.
- Yjs / collaborative document engines are not implemented and not prepared for beyond leaving the existing boundary untouched.
- Constants have one owner: sync scheduling constants stay in `web/src/services/canvas-sync/types.ts`; marker ownership `MAX_CONFLICT_MARKER_ENTRIES = 2` moves to `canvas-recovery/types.ts` in Task 2 and is re-exported by sync types at the Task 6 switch. Recovery transactions use their own `RECOVERY_TRANSACTION_TIMEOUT_MS = 2000` rather than importing sync policy. `CANVAS_TITLE_MAX_LENGTH` stays in `web/src/lib/canvas/canvas-snapshot.ts`. The other new constants are `RECOVERY_OPEN_TIMEOUT_MS = 2000` and the shared stale-CAS bound `MAX_COORDINATION_ATTEMPTS = 2`.
- Automated tests are Vitest + fake-indexeddb under a Node environment only. Real `Chrome / Firefox / Safari` verification stays manual and is never simulated, stubbed or claimed by an automated test. fake-indexeddb proves single-process API semantics only.
- Implementation agents run only the scoped Vitest commands written in each task. They do not run `web` build, `web` typecheck, dev server, or browser automation; the user owns those. No agent closes or reuses a browser window the user already has open.
- Every task is verified test-first: write the focused failing test, run it and observe the expected failure for the expected reason, implement the minimum, rerun until green, then commit.
- UI copy stays Simplified Chinese first with an English peer in `web/src/i18n/locales/en-US.ts`. Canvas surfaces use `canvasThemes` tokens and the existing flat, borderless, shadowless style.
- Existing uncommitted user edits in the worktree are preserved: no revert, no reformat, no refactor outside each task's file list.

## Replaced And Deleted Interfaces

No dual protocol survives any task. Each row is a hard replacement.

| Removed | Replacement | Removed in |
|---|---|---|
| `web/src/services/canvas-local-recovery.ts` (whole module, localforage instance, `canvasDraftKey` / `canvasDraftKeyPrefix` / `canvasConflictMarkerKey`) | `web/src/services/canvas-recovery/store.ts` keyed by `[scopeId, draftId]` | Task 7 |
| `CanvasLocalRecovery` interface | `CanvasRecoveryStore` interface | Task 6 (consumers switch), Task 7 (legacy module deleted) |
| `CanvasLocalWrite`, its `result` / `settled` pair | CAS outcome unions (`CanvasDraftWriteOutcome`, `CanvasCoordinationOutcome`, `CanvasDeletionOutcome`) | Task 6 |
| `CanvasSyncSession.whenLocalSettled` | nothing; an aborted transaction leaves no residue | Task 6 |
| `CanvasLocalRecovery.deleteMarkerIfOwned` | `commitCoordination` with `expectedCoordinationRevision` | Task 6 |
| `CanvasDraftScope` (`{ userId, workspaceId, canvasId }`) | `RecoveryScopeId` (opaque branded string) | Task 6 |
| `CanvasDraftRecord.baseRevision/title/snapshot` flat fields | `CanvasDraftRecord.envelope` (`document` / `localUi` / `assets`) | Task 2 |
| `CanvasConflictMarkerEntry.draftKey` | `draftId` only; scope comes from the record key | Task 2 |
| `CanvasSyncRepository.remove(): Promise<void>` | `remove(): Promise<CanvasDeleteOutcome>` | Task 5 |
| `web/src/services/api/canvases.ts` `deleteCanvas(): Promise<void>` | `deleteCanvas(): Promise<CanvasDeletionReceipt>` | Task 5 |
| manager `runServerCopyCleanup` / `runDeletedCanvasCleanup` two-phase late cleanup | single coordination CAS commit, single deletion CAS commit | Task 6 |
| `CANVAS_PATCH_FIELDS` as one flat list including `viewport` | `CANVAS_DOCUMENT_PATCH_FIELDS` + `CANVAS_LOCAL_PATCH_FIELDS` | Task 6 |

---

## File Responsibility Map

| Area | Files | Responsibility |
|---|---|---|
| Test harness | `web/vitest.config.ts`, `web/test/setup-indexeddb.ts`, `web/package.json`, `bun.lock` | Node-environment Vitest limited to `src/services/**`, one fresh fake-indexeddb factory per test file, pinned dependencies and `test` script. No DOM/React harness. |
| Scope identity | `web/src/services/canvas-recovery/scope.ts` | Build and validate `RecoveryScopeId` from trusted sources only; read/create the installation ID. No IndexedDB access. |
| Connection + transactions | `web/src/services/canvas-recovery/database.ts` | Injected `IDBFactory`, explicit open/upgrade, fixed schema, `blocked` / `versionchange` handling, and the single bounded one-transaction runner that aborts on deadline. Knows nothing about drafts or canvases. |
| Records and outcomes | `web/src/services/canvas-recovery/types.ts` | Record shapes (`epoch` / `draft` / `marker`), the envelope, validators, and every CAS outcome union. No IndexedDB access, no scheduling. |
| CAS operations | `web/src/services/canvas-recovery/store.ts` | The only place that composes transactions into semantic operations: open snapshot read, draft CAS, coordination CAS, deletion CAS, GC, plus a Node-safe lazy browser singleton. No React, no Zustand store, no manager import. |
| Legacy upgrade | `web/src/services/canvas-recovery/bootstrap.ts` | One explicit, idempotent, once-per-installation upgrade action that deletes the legacy localforage store. Never called at import. |
| Sync types | `web/src/services/canvas-sync/types.ts` | Session/manager contracts, patch field split, deletion outcome types, constants. |
| Session | `web/src/services/canvas-sync/canvas-sync-session.ts` | Per-canvas state machine, unified recovery-resolution constructor, per-draft `writeSeq`, CAS outcome handling. |
| Manager | `web/src/services/canvas-sync/canvas-sync-manager.ts` | Scope/open tokens, session lifecycle, list-level operations, deletion receipt handling, GC triggering. |
| Repository / HTTP | `web/src/services/canvas-repository.ts`, `web/src/services/api/canvases.ts` | Map DELETE to a receipt / denied / indeterminate outcome; classify save and open errors. |
| Consumers | `web/src/stores/canvas/use-canvas-store.ts`, `web/src/pages/canvas/project.tsx`, `web/src/pages/canvas/hooks/use-canvas-project-sync.ts`, `web/src/components/canvas/canvas-save-status.tsx`, `web/src/components/canvas/canvas-conflict-bar.tsx`, `web/src/i18n/locales/zh-CN.ts`, `web/src/i18n/locales/en-US.ts` | View adapter, viewport-as-local-UI wiring, controlled-unavailable copy. |
| Docs / records | `AGENTS.md` (verification only), `CHANGELOG.md`, `docs/content/docs/progress/todo.mdx` (+ `.zh-CN`), `docs/content/docs/progress/pending-test.mdx` (+ `.zh-CN`), `docs/superpowers/plans/2026-08-28-native-indexeddb-cas-recovery.md` | Verify the existing Native-IDB exception; record the version-level summary, remaining work, testable changes, and manual browser matrix. |

## Dependency Graph

```text
scope.ts ──────────────┐
                       ├──► store.ts ──► canvas-sync-session.ts ──► canvas-sync-manager.ts ──► use-canvas-store.ts ──► pages / components
database.ts ───────────┤                         ▲                          ▲
                       │                         │                          │
types.ts (records) ────┘        canvas-sync/types.ts (contracts)   canvas-repository.ts ──► api/canvases.ts ──► contracts (CanvasDeletionReceipt)

bootstrap.ts ──► (explicit upgrade action only; imported by main.tsx, never by store.ts)
```

Rules the graph encodes, enforced by review of each task's import list: `scope.ts` and `types.ts` import nothing from the project except contracts and canvas types; `database.ts` imports no canvas domain type; `store.ts` never imports the session, manager, store or React; the session and manager never import React or components; components reach sync state only through `use-canvas-store.ts`.

## Task Sizing

Every task below ends at a state that type-checks, has its own green focused tests, and is safe to ship. Tasks 1-4 add storage capability that no production code calls yet. Task 5 changes only the DELETE contract and is shippable on its own. Task 6 switches the session and manager onto the new store in one commit. Task 7 removes the legacy module and wires consumers and docs. No task commits a partial rewrite where the session compiles against a half-replaced recovery interface, and no task leaves two persistence protocols live at once: `canvas-local-recovery.ts` keeps working untouched until Task 6 replaces its only consumers in one commit, and is deleted in Task 7 once nothing imports it.

---

## Task 1: Scoped Vitest Harness And The Bounded One-Transaction Runner

**Files:**
- Create: `web/vitest.config.ts`, `web/test/setup-indexeddb.ts`
- Create: `web/src/services/canvas-recovery/database.ts`, `web/src/services/canvas-recovery/database.test.ts`
- Modify: `web/package.json` (two devDependencies, one script)
- Modify: `bun.lock` (generated by the dependency installation step)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:

```ts
export const RECOVERY_DB_NAME = "infinite-canvas-recovery";
export const RECOVERY_DB_VERSION = 1;
export const DRAFTS_STORE = "drafts";
export const MARKERS_STORE = "markers";
export const EPOCHS_STORE = "epochs";
export const SCOPE_INDEX = "by_scope";
export const RECOVERY_OPEN_TIMEOUT_MS = 2_000;
export const RECOVERY_TRANSACTION_TIMEOUT_MS = 2_000;

export type RecoveryFailureReason = "blocked" | "timeout" | "aborted" | "corrupt" | "unsupported" | "error";
export type RecoveryRun<T> = { status: "ok"; value: T } | { status: "failed"; reason: RecoveryFailureReason };
export type RecoveryStoreName = typeof DRAFTS_STORE | typeof MARKERS_STORE | typeof EPOCHS_STORE;

/** Resolves IndexedDB requests inside the owning transaction. Awaiting anything else inside `work` is forbidden. */
export type RecoveryTxn = { store(name: RecoveryStoreName): IDBObjectStore; req<T>(request: IDBRequest<T>): Promise<T> };

export type RecoveryDatabase = {
    run<T>(mode: IDBTransactionMode, stores: RecoveryStoreName[], timeoutMs: number, work: (txn: RecoveryTxn) => Promise<T>, signal?: AbortSignal): Promise<RecoveryRun<T>>;
    close(): void;
};

export function createRecoveryDatabase(factory: IDBFactory): RecoveryDatabase;
```

- [ ] **Step 1: Add the pinned dev dependencies and the test script**

In `web/package.json` add to `devDependencies` (`vitest` is pinned to the version already in `bun.lock` so the repo keeps exactly one Vitest version):

```json
"fake-indexeddb": "6.2.5",
"vitest": "4.1.11"
```

and to `scripts`: `"test": "vitest run"`.

- [ ] **Step 2: Install the pinned dependencies**

Run from the repository root: `bun install`

Expected: exit 0; `bun.lock` records `fake-indexeddb@6.2.5` and keeps the existing single `vitest@4.1.11` resolution. Do not continue to the RED test until `web/node_modules/.bin/vitest` exists; otherwise a command-not-found result would masquerade as the intended test failure.

- [ ] **Step 3: Create the Node-only, service-scoped Vitest config**

Create `web/vitest.config.ts`. The `include` glob is what enforces "no DOM/React test framework": only service tests can run, so a component test cannot appear without editing this file.

```ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const webDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: { alias: { "@": resolve(webDir, "src") } },
    test: {
        environment: "node",
        include: ["src/services/**/*.test.ts"],
        setupFiles: ["./test/setup-indexeddb.ts"],
        isolate: true,
    },
});
```

- [ ] **Step 4: Create the per-test factory helper**

Create `web/test/setup-indexeddb.ts`. Core database/store tests inject a factory; only the explicit lazy-singleton negative tests inspect the absent global. No setup polyfill can hide an ambient factory dependency.

```ts
import { IDBFactory } from "fake-indexeddb";

/**
 * A brand-new empty IDBFactory per call. Two factories model two independent browsers;
 * two connections from ONE factory model two tabs of the same browser.
 */
export function freshIndexedDB(): IDBFactory {
    return new IDBFactory();
}
```

- [ ] **Step 5: Write the failing tests**

Create `web/src/services/canvas-recovery/database.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { createRecoveryDatabase, DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE, RECOVERY_DB_NAME, RECOVERY_DB_VERSION, RECOVERY_OPEN_TIMEOUT_MS, SCOPE_INDEX } from "./database";

describe("recovery database", () => {
    /**
     * fake-indexeddb 6.2.5 drained 100,000 sequential gets in about 225 ms in the
     * final-review probe. Keep this bound well above the requests drainable inside
     * either the 50 ms deadline or the 20 ms owner-cancel window; do not reduce it
     * without first measuring that both aborts still happen while the queue is live.
     */
    const TRANSACTION_HOLD_REQUESTS = 100_000;

    it("creates exactly the fixed version 1 schema", async () => {
        const factory = freshIndexedDB();
        const db = createRecoveryDatabase(factory);
        const result = await db.run("readonly", [EPOCHS_STORE], 2_000, async (txn) => txn.store(EPOCHS_STORE).name);
        expect(result).toEqual({ status: "ok", value: EPOCHS_STORE });

        const opened = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect(opened.version).toBe(1);
        expect([...opened.objectStoreNames].sort()).toEqual([DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE].sort());
        const tx = opened.transaction([DRAFTS_STORE, MARKERS_STORE, EPOCHS_STORE], "readonly");
        expect(tx.objectStore(DRAFTS_STORE).keyPath).toEqual(["scopeId", "draftId"]);
        expect(tx.objectStore(MARKERS_STORE).keyPath).toEqual(["scopeId", "markerId"]);
        expect(tx.objectStore(EPOCHS_STORE).keyPath).toBe("scopeId");
        expect([...tx.objectStore(DRAFTS_STORE).indexNames]).toEqual([SCOPE_INDEX]);
        expect([...tx.objectStore(MARKERS_STORE).indexNames]).toEqual([SCOPE_INDEX]);
        opened.close();
        db.close();
    });

    it("opens nothing until run is called", async () => {
        const factory = freshIndexedDB();
        createRecoveryDatabase(factory);
        expect(await factory.databases()).toEqual([]);
    });

    it("returns a controlled bounded failure when open reports blocked", async () => {
        const request = {} as IDBOpenDBRequest;
        const factory = {
            open: () => {
                queueMicrotask(() => request.onblocked?.({} as IDBVersionChangeEvent));
                return request;
            },
        } as IDBFactory;
        const startedAt = performance.now();
        const result = await createRecoveryDatabase(factory).run("readonly", [EPOCHS_STORE], 2_000, async () => 0);
        expect(result).toEqual({ status: "failed", reason: "blocked" });
        expect(performance.now() - startedAt).toBeLessThan(RECOVERY_OPEN_TIMEOUT_MS);
    });

    it("aborts the transaction when the deadline expires instead of allowing a late commit", async () => {
        const factory = freshIndexedDB();
        const db = createRecoveryDatabase(factory);
        const scopeId = "local:i:c";
        const stalled = await db.run("readwrite", [EPOCHS_STORE], 50, async (txn) => {
            await txn.req(txn.store(EPOCHS_STORE).put({ scopeId, coordinationRevision: 1, deletionGeneration: 0, tombstonedAt: null }));
            /**
             * Keep the transaction alive only with legal IndexedDB requests. The loop is
             * deliberately finite: with abort removed it eventually drains and commits,
             * which makes the rollback assertion below turn red instead of hanging.
             */
            for (let index = 0; index < TRANSACTION_HOLD_REQUESTS; index += 1) {
                await txn.req(txn.store(EPOCHS_STORE).get(scopeId));
            }
            return "drained";
        });
        expect(stalled).toEqual({ status: "failed", reason: "timeout" });

        const readBack = await db.run("readonly", [EPOCHS_STORE], 30_000, (txn) => txn.req(txn.store(EPOCHS_STORE).get(scopeId)));
        // The initial put and every queued read belonged to the aborted transaction.
        expect(readBack).toEqual({ status: "ok", value: undefined });
        db.close();
    });

    it("rolls back every write when the work function throws midway", async () => {
        const factory = freshIndexedDB();
        const db = createRecoveryDatabase(factory);
        const failed = await db.run("readwrite", [EPOCHS_STORE, MARKERS_STORE], 2_000, async (txn) => {
            txn.store(EPOCHS_STORE).put({ scopeId: "local:i:c", coordinationRevision: 1, deletionGeneration: 0, tombstonedAt: null });
            txn.store(MARKERS_STORE).put({ scopeId: "local:i:c", markerId: "conflict", entries: [] });
            throw new Error("midway");
        });
        expect(failed.status).toBe("failed");
        expect(await db.run("readonly", [EPOCHS_STORE], 2_000, (txn) => txn.req(txn.store(EPOCHS_STORE).get("local:i:c")))).toEqual({ status: "ok", value: undefined });
        expect(await db.run("readonly", [MARKERS_STORE], 2_000, (txn) => txn.req(txn.store(MARKERS_STORE).get(["local:i:c", "conflict"])))).toEqual({ status: "ok", value: undefined });
        db.close();
    });

    it("aborts and rolls back when the operation owner cancels its signal", async () => {
        const factory = freshIndexedDB();
        const db = createRecoveryDatabase(factory);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const result = await db.run(
            "readwrite",
            [EPOCHS_STORE],
            2_000,
            async (txn) => {
                await txn.req(txn.store(EPOCHS_STORE).put({ scopeId: "local:i:cancelled", coordinationRevision: 1, deletionGeneration: 0, tombstonedAt: null }));
                for (let index = 0; index < TRANSACTION_HOLD_REQUESTS; index += 1) await txn.req(txn.store(EPOCHS_STORE).get("local:i:cancelled"));
                return "drained";
            },
            controller.signal,
        );
        expect(result).toEqual({ status: "failed", reason: "aborted" });
        expect(await db.run("readonly", [EPOCHS_STORE], 2_000, (txn) => txn.req(txn.store(EPOCHS_STORE).get("local:i:cancelled")))).toEqual({ status: "ok", value: undefined });
        db.close();
    });

    it("closes on versionchange so a newer tab is never blocked, and reports a bounded failure afterwards", async () => {
        const factory = freshIndexedDB();
        const first = createRecoveryDatabase(factory);
        await first.run("readonly", [EPOCHS_STORE], 2_000, async () => 0);

        const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION + 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("blocked: versionchange did not close the old connection"));
        });
        upgraded.close();

        const afterUpgrade = await createRecoveryDatabase(factory).run("readonly", [EPOCHS_STORE], 2_000, async () => 0);
        expect(afterUpgrade.status).toBe("failed");
        first.close();
    });
});
```

- [ ] **Step 6: Run and confirm the failure reason**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/database.test.ts`
Expected: all 7 fail at import resolution of `./database`. A pass here means the harness is not picking up the file; fix the harness before writing any implementation.

- [ ] **Step 7: Implement the connection factory and bounded runner**

Create `web/src/services/canvas-recovery/database.ts`:

```ts
export const RECOVERY_DB_NAME = "infinite-canvas-recovery";
export const RECOVERY_DB_VERSION = 1;
export const DRAFTS_STORE = "drafts";
export const MARKERS_STORE = "markers";
export const EPOCHS_STORE = "epochs";
export const SCOPE_INDEX = "by_scope";
export const RECOVERY_OPEN_TIMEOUT_MS = 2_000;
export const RECOVERY_TRANSACTION_TIMEOUT_MS = 2_000;

export type RecoveryFailureReason = "blocked" | "timeout" | "aborted" | "corrupt" | "unsupported" | "error";
export type RecoveryRun<T> = { status: "ok"; value: T } | { status: "failed"; reason: RecoveryFailureReason };
export type RecoveryStoreName = typeof DRAFTS_STORE | typeof MARKERS_STORE | typeof EPOCHS_STORE;
export type RecoveryTxn = { store(name: RecoveryStoreName): IDBObjectStore; req<T>(request: IDBRequest<T>): Promise<T> };

export type RecoveryDatabase = {
    run<T>(mode: IDBTransactionMode, stores: RecoveryStoreName[], timeoutMs: number, work: (txn: RecoveryTxn) => Promise<T>, signal?: AbortSignal): Promise<RecoveryRun<T>>;
    close(): void;
};

/** version 1 layout is fixed: three stores, one scope index each on drafts/markers, nothing else. */
function upgrade(db: IDBDatabase) {
    db.createObjectStore(DRAFTS_STORE, { keyPath: ["scopeId", "draftId"] }).createIndex(SCOPE_INDEX, "scopeId");
    db.createObjectStore(MARKERS_STORE, { keyPath: ["scopeId", "markerId"] }).createIndex(SCOPE_INDEX, "scopeId");
    db.createObjectStore(EPOCHS_STORE, { keyPath: "scopeId" });
}

/** The factory is injected and opening happens on first run() only: importing this module never touches storage. */
export function createRecoveryDatabase(factory: IDBFactory): RecoveryDatabase {
    let connection: IDBDatabase | null = null;
    let opening: Promise<RecoveryRun<IDBDatabase>> | null = null;

    function open(): Promise<RecoveryRun<IDBDatabase>> {
        if (connection) return Promise.resolve({ status: "ok", value: connection });
        if (opening) return opening;
        opening = new Promise<RecoveryRun<IDBDatabase>>((resolve) => {
            let settled = false;
            const finish = (result: RecoveryRun<IDBDatabase>) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                opening = null;
                resolve(result);
            };
            /** An open blocked by another tab must never wait without bound. */
            const timer = setTimeout(() => finish({ status: "failed", reason: "blocked" }), RECOVERY_OPEN_TIMEOUT_MS);
            let request: IDBOpenDBRequest;
            try {
                request = factory.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
            } catch {
                finish({ status: "failed", reason: "error" });
                return;
            }
            request.onupgradeneeded = () => {
                /** A timed-out/blocked open must not perform a late schema upgrade when later unblocked. */
                if (settled) return request.transaction?.abort();
                upgrade(request.result);
            };
            request.onblocked = () => finish({ status: "failed", reason: "blocked" });
            request.onerror = () => finish({ status: "failed", reason: "error" });
            request.onsuccess = () => {
                const db = request.result;
                /** IDBOpenDBRequest is not cancellable; close a late connection instead of publishing it. */
                if (settled) {
                    db.close();
                    return;
                }
                /** A newer tab is upgrading: release at once so this connection is never the blocker. */
                db.onversionchange = () => {
                    db.close();
                    if (connection === db) connection = null;
                };
                db.onclose = () => {
                    if (connection === db) connection = null;
                };
                connection = db;
                finish({ status: "ok", value: db });
            };
        });
        return opening;
    }

    async function run<T>(mode: IDBTransactionMode, stores: RecoveryStoreName[], timeoutMs: number, work: (txn: RecoveryTxn) => Promise<T>, signal?: AbortSignal): Promise<RecoveryRun<T>> {
        if (signal?.aborted) return { status: "failed", reason: "aborted" };
        const opened = await open();
        if (opened.status !== "ok") return opened;
        if (signal?.aborted) return { status: "failed", reason: "aborted" };
        return new Promise<RecoveryRun<T>>((resolve) => {
            let settled = false;
            let produced = false;
            let value: T;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let abortFromSignal: (() => void) | null = null;
            const finish = (result: RecoveryRun<T>) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (abortFromSignal) signal?.removeEventListener("abort", abortFromSignal);
                resolve(result);
            };
            let transaction: IDBTransaction;
            try {
                transaction = opened.value.transaction(stores, mode);
            } catch {
                return finish({ status: "failed", reason: "error" });
            }
            /**
             * The deadline ABORTS. A timed-out promise alone would let this transaction commit
             * afterwards, which is exactly the late write this layer exists to prevent.
             * `work` may await only txn.req(...): if it awaits an external promise after the
             * request queue drains, IndexedDB auto-commits before this timer can roll it back.
             */
            timer = setTimeout(() => {
                try {
                    transaction.abort();
                } catch {
                    /** Already finished; onabort/oncomplete decides. */
                }
                finish({ status: "failed", reason: "timeout" });
            }, timeoutMs);
            transaction.onabort = () => finish({ status: "failed", reason: "aborted" });
            transaction.onerror = () => finish({ status: "failed", reason: "error" });
            transaction.oncomplete = () => finish(produced ? { status: "ok", value } : { status: "failed", reason: "error" });
            abortFromSignal = () => {
                try {
                    transaction.abort();
                } catch {
                    /** Already finished; finish still returns the controlled owner-aborted result. */
                }
                finish({ status: "failed", reason: "aborted" });
            };
            signal?.addEventListener("abort", abortFromSignal, { once: true });
            if (signal?.aborted) return abortFromSignal();

            const txn: RecoveryTxn = {
                store: (name) => transaction.objectStore(name),
                req: <R,>(request: IDBRequest<R>) =>
                    new Promise<R>((resolveReq, rejectReq) => {
                        request.onsuccess = () => resolveReq(request.result);
                        request.onerror = () => rejectReq(request.error ?? new Error("request_failed"));
                    }),
            };

            void work(txn).then(
                (result) => {
                    value = result;
                    produced = true;
                },
                () => {
                    try {
                        transaction.abort();
                    } catch {
                        /** Already finished; the abort/error handler resolves. */
                    }
                },
            );
        });
    }

    return {
        run,
        close: () => {
            connection?.close();
            connection = null;
        },
    };
}
```

- [ ] **Step 8: Run until green, then run the fake-green check**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/database.test.ts` — expected: 7 passed.

Fake-green check: temporarily remove only the `transaction.abort()` call from the deadline handler and rerun. The finite request loop must then drain and commit the epoch; the test still observes the bounded `timeout` result first, but the subsequent readonly transaction waits behind the writer and `readBack` becomes the stored epoch, so the `undefined` rollback assertion turns red. Restore `transaction.abort()`, rerun, and commit only the restored aborting version. Never replace the request loop with `await new Promise(() => {})`: once the IDB queue drains, that illegal external await permits auto-commit and does not test deadline rollback.

Then temporarily remove `db.close()` from `onversionchange`. The version-upgrade test must reject from its `onblocked` branch. Restore the close and rerun all 7 tests; this distinguishes testing a handler's existence from proving that the old connection actually releases the upgrade.

- [ ] **Step 9: Commit**

```bash
git add web/package.json bun.lock web/vitest.config.ts web/test/setup-indexeddb.ts web/src/services/canvas-recovery/database.ts web/src/services/canvas-recovery/database.test.ts
git commit -m "test: add scoped web vitest harness and bounded IndexedDB transaction runner"
```

---

## Task 2: Scope Identity, Envelope Records And CAS Outcome Types

**Files:**
- Create: `web/src/services/canvas-recovery/scope.ts`, `web/src/services/canvas-recovery/scope.test.ts`
- Create: `web/src/services/canvas-recovery/types.ts`, `web/src/services/canvas-recovery/types.test.ts`

**Interfaces:**
- Consumes: `RecoveryFailureReason` from Task 1 (type only).
- Produces:

```ts
// scope.ts
export type RecoveryScopeId = string & { readonly __recoveryScope: unique symbol };
export type RecoveryScopeSource =
    | { kind: "local"; installationId: string; localCanvasId: string }
    | { kind: "account"; userId: string; workspaceId: string; canvasId: string };
export function buildRecoveryScopeId(source: RecoveryScopeSource): RecoveryScopeId | null;
export function readInstallationId(storage: Pick<Storage, "getItem" | "setItem">, createId: () => string): string | null;

// types.ts
export const CONFLICT_MARKER_ID = "conflict";
export const MAX_CONFLICT_MARKER_ENTRIES = 2;
export type CanvasDraftDocument = { title: string; baseRevision: number; snapshot: CanvasSnapshot };
export type CanvasDraftLocalUi = { viewport: ViewportTransform };
export type CanvasAssetMapping = Record<string, { assetId: string | null; uploadState: "local-only" | "uploading" | "ready" | "failed" }>;
export type CanvasDraftEnvelope = { document: CanvasDraftDocument; localUi: CanvasDraftLocalUi; assets: CanvasAssetMapping };
export type CanvasDraftState = "pending" | "synced";
export type CanvasRecoveryEpoch = { scopeId: RecoveryScopeId; coordinationRevision: number; deletionGeneration: number; tombstonedAt: string | null };
export type CanvasDraftRecord = { scopeId: RecoveryScopeId; draftId: string; writeSeq: number; deletionGeneration: number; state: CanvasDraftState; envelope: CanvasDraftEnvelope; savedAt: string };
export type CanvasConflictMarkerEntry = { draftId: string; baseRevision: number; savedAt: string };
export type CanvasConflictMarkerRecord = { scopeId: RecoveryScopeId; markerId: typeof CONFLICT_MARKER_ID; entries: CanvasConflictMarkerEntry[] };
export function initialEpoch(scopeId: RecoveryScopeId): CanvasRecoveryEpoch;
export function asEpoch(value: unknown, scopeId: RecoveryScopeId): CanvasRecoveryEpoch | null;
export function asDraftRecord(value: unknown, scopeId: RecoveryScopeId): CanvasDraftRecord | null;
export function asMarkerRecord(value: unknown, scopeId: RecoveryScopeId): CanvasConflictMarkerRecord | null;
export type CanvasDraftWriteOutcome =
    | { status: "written"; writeSeq: number }
    | { status: "superseded"; storedWriteSeq: number }
    | { status: "tombstoned" }
    | { status: "generation-changed"; deletionGeneration: number }
    | { status: "unavailable"; reason: RecoveryFailureReason };
export type CanvasCoordinationOutcome =
    | { status: "committed"; coordinationRevision: number }
    | { status: "stale"; coordinationRevision: number; deletionGeneration: number }
    | { status: "tombstoned" }
    | { status: "unavailable"; reason: RecoveryFailureReason };
export type CanvasDeletionOutcome =
    | { status: "tombstoned"; deletionGeneration: number }
    | { status: "already-tombstoned" }
    | { status: "unavailable"; reason: RecoveryFailureReason };
```

- [ ] **Step 1: Write the failing scope tests**

Create `web/src/services/canvas-recovery/scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildRecoveryScopeId, readInstallationId } from "./scope";

describe("recovery scope id", () => {
    it("builds the two approved shapes", () => {
        expect(buildRecoveryScopeId({ kind: "local", installationId: "inst1", localCanvasId: "c1" })).toBe("local:inst1:c1");
        expect(buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })).toBe("account:u1:workspace:w1:canvas:c1");
    });

    it("refuses untrusted ids instead of encoding them", () => {
        expect(buildRecoveryScopeId({ kind: "local", installationId: "inst:1", localCanvasId: "c1" })).toBeNull();
        expect(buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w:1", canvasId: "c1" })).toBeNull();
        expect(buildRecoveryScopeId({ kind: "account", userId: "", workspaceId: "w1", canvasId: "c1" })).toBeNull();
        expect(buildRecoveryScopeId({ kind: "local", installationId: "inst1", localCanvasId: "c".repeat(129) })).toBeNull();
        expect(buildRecoveryScopeId({ kind: "unknown", userId: "u1", workspaceId: "w1", canvasId: "c1" } as never)).toBeNull();
    });

    it("keeps identities distinct so one scope can never address another", () => {
        expect(buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })).not.toBe(buildRecoveryScopeId({ kind: "account", userId: "u2", workspaceId: "w1", canvasId: "c1" }));
    });

    it("persists one installation id and reuses it", () => {
        const bag = new Map<string, string>();
        const storage = { getItem: (k: string) => bag.get(k) ?? null, setItem: (k: string, v: string) => void bag.set(k, v) };
        let calls = 0;
        expect(readInstallationId(storage, () => "generated" + ++calls)).toBe("generated1");
        expect(readInstallationId(storage, () => "generated" + ++calls)).toBe("generated1");
        expect(calls).toBe(1);
    });

    it("replaces a corrupted id and contains generation or storage failures", () => {
        const bag = new Map<string, string>([["canvas-recovery-installation", "bad:id"]]);
        const storage = { getItem: (k: string) => bag.get(k) ?? null, setItem: (k: string, v: string) => void bag.set(k, v) };
        expect(readInstallationId(storage, () => "fresh")).toBe("fresh");

        let writes = 0;
        expect(readInstallationId({ getItem: () => null, setItem: () => void writes++ }, () => "bad:id")).toBeNull();
        expect(writes).toBe(0);

        let creates = 0;
        expect(
            readInstallationId(
                {
                    getItem: () => {
                        throw new Error("get failed");
                    },
                    setItem: () => undefined,
                },
                () => "generated" + ++creates,
            ),
        ).toBeNull();
        expect(creates).toBe(0);
        expect(
            readInstallationId(
                {
                    getItem: () => null,
                    setItem: () => {
                        throw new Error("set failed");
                    },
                },
                () => "fresh2",
            ),
        ).toBeNull();
    });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/scope.test.ts`
Expected: FAIL, cannot resolve `./scope`.

- [ ] **Step 3: Implement scope.ts**

```ts
export type RecoveryScopeId = string & { readonly __recoveryScope: unique symbol };

export type RecoveryScopeSource =
    | { kind: "local"; installationId: string; localCanvasId: string }
    | { kind: "account"; userId: string; workspaceId: string; canvasId: string };

const INSTALLATION_KEY = "canvas-recovery-installation";
/** Trusted ids only: no separator, no whitespace, bounded length. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const safe = (id: unknown): id is string => typeof id === "string" && SAFE_ID.test(id);

/**
 * The scope id is opaque and always derived here, never accepted from page input.
 * Returning null instead of a sanitised string keeps a malformed identity from
 * silently addressing a neighbouring scope's drafts.
 */
export function buildRecoveryScopeId(source: RecoveryScopeSource): RecoveryScopeId | null {
    if (source.kind === "local") {
        if (!safe(source.installationId) || !safe(source.localCanvasId)) return null;
        return ("local:" + source.installationId + ":" + source.localCanvasId) as RecoveryScopeId;
    }
    if (source.kind !== "account") return null;
    if (!safe(source.userId) || !safe(source.workspaceId) || !safe(source.canvasId)) return null;
    return ("account:" + source.userId + ":workspace:" + source.workspaceId + ":canvas:" + source.canvasId) as RecoveryScopeId;
}

/** The installation id is a tiny local value, so localStorage is the correct home for it. */
export function readInstallationId(storage: Pick<Storage, "getItem" | "setItem">, createId: () => string): string | null {
    let existing: string | null;
    try {
        existing = storage.getItem(INSTALLATION_KEY);
    } catch {
        return null;
    }
    if (safe(existing)) return existing;
    const created = createId();
    if (!safe(created)) return null;
    try {
        storage.setItem(INSTALLATION_KEY, created);
    } catch {
        return null;
    }
    return created;
}
```

- [ ] **Step 4: Run scope tests until green**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/scope.test.ts` — expected: 5 passed.

- [ ] **Step 5: Write the failing record-validator tests**

Create `web/src/services/canvas-recovery/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildRecoveryScopeId } from "./scope";
import { asDraftRecord, asEpoch, asMarkerRecord, CONFLICT_MARKER_ID, initialEpoch } from "./types";

const scopeId = buildRecoveryScopeId({ kind: "local", installationId: "inst1", localCanvasId: "c1" })!;
const other = buildRecoveryScopeId({ kind: "local", installationId: "inst1", localCanvasId: "c2" })!;
const envelope = {
    document: { title: "T", baseRevision: 3, snapshot: { nodes: [], connections: [] } },
    localUi: { viewport: { x: 0, y: 0, k: 1 } },
    assets: {
        local: { assetId: null, uploadState: "local-only" },
        uploading: { assetId: "a1", uploadState: "uploading" },
        ready: { assetId: "a2", uploadState: "ready" },
        failed: { assetId: "a3", uploadState: "failed" },
    },
};
const draft = { scopeId, draftId: "d1", writeSeq: 5, deletionGeneration: 0, state: "pending", envelope, savedAt: "2020-01-01T00:00:00.000Z" };

const withSnapshot = (snapshot: unknown) => ({ ...draft, envelope: { ...envelope, document: { ...envelope.document, snapshot } } });
const withViewport = (viewport: unknown) => ({ ...draft, envelope: { ...envelope, localUi: { viewport } } });
const withAssets = (assets: unknown) => ({ ...draft, envelope: { ...envelope, assets } });

describe("recovery record validators", () => {
    it("starts a scope at generation zero with no tombstone", () => {
        expect(initialEpoch(scopeId)).toEqual({ scopeId, coordinationRevision: 0, deletionGeneration: 0, tombstonedAt: null });
    });

    it("accepts well-formed records", () => {
        expect(asEpoch({ scopeId, coordinationRevision: 2, deletionGeneration: 1, tombstonedAt: null }, scopeId)).not.toBeNull();
        expect(asDraftRecord(draft, scopeId)).not.toBeNull();
        const extra = { ...draft, unknown: "preserved" };
        expect(asDraftRecord(extra, scopeId)).toBe(extra);
        const shared = { value: 1 };
        expect(asDraftRecord(withSnapshot({ first: shared, second: shared }), scopeId)).not.toBeNull();
        expect(asDraftRecord({ ...draft, draftId: "internal:opaque" }, scopeId)).not.toBeNull();
        expect(
            asMarkerRecord(
                {
                    scopeId,
                    markerId: CONFLICT_MARKER_ID,
                    entries: [
                        { draftId: "d1", baseRevision: 3, savedAt: "2020-01-01T00:00:00.000Z" },
                        { draftId: "d2", baseRevision: 4, savedAt: "2020-01-01T00:00:01.000Z" },
                    ],
                },
                scopeId,
            ),
        ).not.toBeNull();
    });

    it("rejects a record whose stored scope differs from the requesting scope", () => {
        expect(asDraftRecord({ ...draft, scopeId: other }, scopeId)).toBeNull();
        expect(asEpoch({ scopeId: other, coordinationRevision: 0, deletionGeneration: 0, tombstonedAt: null }, scopeId)).toBeNull();
        expect(asMarkerRecord({ scopeId: other, markerId: CONFLICT_MARKER_ID, entries: [] }, scopeId)).toBeNull();
    });

    it("rejects corrupt shapes rather than repairing them", () => {
        expect(asDraftRecord({ ...draft, writeSeq: -1 }, scopeId)).toBeNull();
        expect(asDraftRecord({ ...draft, writeSeq: 1.5 }, scopeId)).toBeNull();
        expect(asDraftRecord({ ...draft, state: "unknown" }, scopeId)).toBeNull();
        expect(asDraftRecord({ ...draft, envelope: { ...envelope, document: { title: "T", baseRevision: -2, snapshot: {} } } }, scopeId)).toBeNull();
        expect(asDraftRecord({ ...draft, envelope: { document: envelope.document } }, scopeId)).toBeNull();
        expect(asDraftRecord(null, scopeId)).toBeNull();
        expect(asEpoch({ scopeId, coordinationRevision: "1", deletionGeneration: 0, tombstonedAt: null }, scopeId)).toBeNull();
        expect(asEpoch({ scopeId, coordinationRevision: 1, deletionGeneration: 0, tombstonedAt: "2020" }, scopeId)).toBeNull();
        expect(asDraftRecord({ ...draft, savedAt: "2020-01-01T00:00:00Z" }, scopeId)).toBeNull();
        expect(asDraftRecord({ ...draft, savedAt: "2020-01-01T01:00:00.000+01:00" }, scopeId)).toBeNull();

        expect(asDraftRecord(withViewport({ x: Number.NaN, y: 0, k: 1 }), scopeId)).toBeNull();
        expect(asDraftRecord(withViewport({ x: 0, y: Number.POSITIVE_INFINITY, k: 1 }), scopeId)).toBeNull();
        expect(asDraftRecord(withViewport({ x: 0, y: 0, k: Number.NaN }), scopeId)).toBeNull();
        expect(asDraftRecord(withViewport({ x: 0, y: 0, k: Number.POSITIVE_INFINITY }), scopeId)).toBeNull();
        expect(asDraftRecord(withViewport({ x: 0, y: 0, k: 0 }), scopeId)).toBeNull();
        expect(asDraftRecord(withViewport({ x: 0, y: 0, k: -1 }), scopeId)).toBeNull();

        expect(asDraftRecord(withAssets({ bad: 42 }), scopeId)).toBeNull();
        expect(asDraftRecord(withAssets({ bad: { assetId: 7, uploadState: "ready" } }), scopeId)).toBeNull();
        expect(asDraftRecord(withAssets({ bad: { assetId: null, uploadState: "unknown" } }), scopeId)).toBeNull();
        expect(asDraftRecord(withAssets(new Date()), scopeId)).toBeNull();

        class SnapshotClass {
            value = 1;
        }
        expect(asDraftRecord(withSnapshot(new Date()), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: new Date() }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: new Map() }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: new SnapshotClass() }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: [undefined] }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: [1n] }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: [Symbol("bad")] }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: [() => undefined] }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: [Number.NaN] }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: [Number.POSITIVE_INFINITY] }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: [Number.NEGATIVE_INFINITY] }), scopeId)).toBeNull();
        expect(asDraftRecord(withSnapshot({ nested: new Array(1) }), scopeId)).toBeNull();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(asDraftRecord(withSnapshot(cyclic), scopeId)).toBeNull();

        expect(asMarkerRecord({ scopeId, markerId: "other", entries: [] }, scopeId)).toBeNull();
        expect(asMarkerRecord({ scopeId, markerId: CONFLICT_MARKER_ID, entries: [{ draftId: "d1" }] }, scopeId)).toBeNull();
        expect(asMarkerRecord({ scopeId, markerId: CONFLICT_MARKER_ID, entries: [{ draftId: "d1", baseRevision: 1, savedAt: "Jan 1 2020" }] }, scopeId)).toBeNull();
    });

    it("caps marker entries and rejects holes or duplicate drafts", () => {
        const entry = { draftId: "d1", baseRevision: 1, savedAt: "2020-01-01T00:00:00.000Z" };
        expect(asMarkerRecord({ scopeId, markerId: CONFLICT_MARKER_ID, entries: [entry, entry, entry] }, scopeId)).toBeNull();
        expect(asMarkerRecord({ scopeId, markerId: CONFLICT_MARKER_ID, entries: [entry, { ...entry, savedAt: "2020-01-01T00:00:01.000Z" }] }, scopeId)).toBeNull();
        const entries = new Array(2);
        entries[1] = entry;
        expect(asMarkerRecord({ scopeId, markerId: CONFLICT_MARKER_ID, entries }, scopeId)).toBeNull();
    });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/types.test.ts`
Expected: FAIL, cannot resolve `./types`.

- [ ] **Step 7: Implement types.ts**

```ts
import type { CanvasSnapshot } from "@infinite-canvas/contracts";

import type { ViewportTransform } from "@/types/canvas";

import type { RecoveryFailureReason } from "./database";
import type { RecoveryScopeId } from "./scope";

export const CONFLICT_MARKER_ID = "conflict";
export const MAX_CONFLICT_MARKER_ENTRIES = 2;

/** Canonical document: the ONLY part a cloud serializer may read. */
export type CanvasDraftDocument = { title: string; baseRevision: number; snapshot: CanvasSnapshot };
/** Local UI preference: pan/zoom lives here so it can never reach a cloud snapshot save. */
export type CanvasDraftLocalUi = { viewport: ViewportTransform };
export type CanvasAssetMapping = Record<string, { assetId: string | null; uploadState: "local-only" | "uploading" | "ready" | "failed" }>;
export type CanvasDraftEnvelope = { document: CanvasDraftDocument; localUi: CanvasDraftLocalUi; assets: CanvasAssetMapping };

export type CanvasDraftState = "pending" | "synced";

export type CanvasRecoveryEpoch = {
    scopeId: RecoveryScopeId;
    /** Advanced by marker / repair / foreign-delete / GC only. */
    coordinationRevision: number;
    /** Advanced by a confirmed canvas deletion only. */
    deletionGeneration: number;
    tombstonedAt: string | null;
};

export type CanvasDraftRecord = {
    scopeId: RecoveryScopeId;
    draftId: string;
    /** Monotonic within one [scopeId, draftId] write session. */
    writeSeq: number;
    /** The generation this draft belongs to; a mismatch means the canvas was deleted under it. */
    deletionGeneration: number;
    state: CanvasDraftState;
    envelope: CanvasDraftEnvelope;
    savedAt: string;
};

export type CanvasConflictMarkerEntry = { draftId: string; baseRevision: number; savedAt: string };
/** One marker per scope; the scope lives in the key, so entries carry no key material. */
export type CanvasConflictMarkerRecord = { scopeId: RecoveryScopeId; markerId: typeof CONFLICT_MARKER_ID; entries: CanvasConflictMarkerEntry[] };

export type CanvasDraftWriteOutcome =
    | { status: "written"; writeSeq: number }
    | { status: "superseded"; storedWriteSeq: number }
    | { status: "tombstoned" }
    | { status: "generation-changed"; deletionGeneration: number }
    | { status: "unavailable"; reason: RecoveryFailureReason };

export type CanvasCoordinationOutcome =
    | { status: "committed"; coordinationRevision: number }
    | { status: "stale"; coordinationRevision: number; deletionGeneration: number }
    | { status: "tombstoned" }
    | { status: "unavailable"; reason: RecoveryFailureReason };

export type CanvasDeletionOutcome = { status: "tombstoned"; deletionGeneration: number } | { status: "already-tombstoned" } | { status: "unavailable"; reason: RecoveryFailureReason };

export function initialEpoch(scopeId: RecoveryScopeId): CanvasRecoveryEpoch {
    return { scopeId, coordinationRevision: 0, deletionGeneration: 0, tombstonedAt: null };
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isIsoDate = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** CanvasSnapshot is a JSON object, not merely an object-shaped structured-clone value. */
function isJsonObject(value: unknown): value is CanvasSnapshot {
    if (!isRecord(value)) return false;
    const active = new Set<object>();
    const stack: Array<{ value: unknown; leaving?: boolean }> = [{ value }];

    while (stack.length) {
        const frame = stack.pop()!;
        const current = frame.value;
        if (frame.leaving) {
            active.delete(current as object);
            continue;
        }
        if (current === null || typeof current === "string" || typeof current === "boolean") continue;
        if (typeof current === "number") {
            if (!Number.isFinite(current)) return false;
            continue;
        }
        if (typeof current !== "object") return false;
        if (active.has(current)) return false;

        let children: unknown[];
        if (Array.isArray(current)) {
            if (Object.getPrototypeOf(current) !== Array.prototype) return false;
            const keys = Reflect.ownKeys(current);
            if (keys.length !== current.length + 1) return false;
            for (let index = 0; index < current.length; index++) {
                if (!Object.hasOwn(current, index)) return false;
            }
            children = current;
        } else {
            if (!isRecord(current)) return false;
            const keys = Reflect.ownKeys(current);
            if (keys.some((key) => typeof key === "symbol")) return false;
            children = [];
            for (const key of keys) {
                const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
                if (!("value" in descriptor)) return false;
                children.push(descriptor.value);
            }
        }

        active.add(current);
        stack.push({ value: current, leaving: true });
        for (const child of children) stack.push({ value: child });
    }
    return true;
}

const isUploadState = (value: unknown): value is CanvasAssetMapping[string]["uploadState"] => value === "local-only" || value === "uploading" || value === "ready" || value === "failed";

function isAssetMapping(value: unknown): value is CanvasAssetMapping {
    if (!isRecord(value)) return false;
    return Object.getOwnPropertyNames(value).every((key) => {
        const entry = value[key];
        return isRecord(entry) && (entry.assetId === null || typeof entry.assetId === "string") && isUploadState(entry.uploadState);
    });
}

export function asEpoch(value: unknown, scopeId: RecoveryScopeId): CanvasRecoveryEpoch | null {
    if (!isRecord(value) || value.scopeId !== scopeId) return null;
    const { coordinationRevision, deletionGeneration, tombstonedAt } = value;
    if (!isCount(coordinationRevision) || !isCount(deletionGeneration)) return null;
    if (tombstonedAt !== null && !isIsoDate(tombstonedAt)) return null;
    return { scopeId, coordinationRevision, deletionGeneration, tombstonedAt: tombstonedAt as string | null };
}

function asEnvelope(value: unknown): CanvasDraftEnvelope | null {
    if (!isRecord(value) || !isRecord(value.document) || !isRecord(value.localUi) || !isAssetMapping(value.assets)) return null;
    const { title, baseRevision, snapshot } = value.document;
    if (typeof title !== "string" || !isCount(baseRevision) || !isJsonObject(snapshot)) return null;
    const viewport = (value.localUi as { viewport?: unknown }).viewport;
    if (!isRecord(viewport) || !isFiniteNumber(viewport.x) || !isFiniteNumber(viewport.y) || !isFiniteNumber(viewport.k) || viewport.k <= 0) return null;
    return value as CanvasDraftEnvelope;
}

export function asDraftRecord(value: unknown, scopeId: RecoveryScopeId): CanvasDraftRecord | null {
    if (!isRecord(value) || value.scopeId !== scopeId) return null;
    const { draftId, writeSeq, deletionGeneration, state, savedAt } = value;
    if (typeof draftId !== "string" || !draftId || !isCount(writeSeq) || !isCount(deletionGeneration)) return null;
    if ((state !== "pending" && state !== "synced") || !isIsoDate(savedAt) || !asEnvelope(value.envelope)) return null;
    return value as CanvasDraftRecord;
}

export function asMarkerRecord(value: unknown, scopeId: RecoveryScopeId): CanvasConflictMarkerRecord | null {
    if (!isRecord(value) || value.scopeId !== scopeId || value.markerId !== CONFLICT_MARKER_ID) return null;
    const { entries } = value;
    if (!Array.isArray(entries) || entries.length > MAX_CONFLICT_MARKER_ENTRIES) return null;
    const materialized = Array.from(entries);
    const valid = materialized.every((entry) => isRecord(entry) && typeof entry.draftId === "string" && Boolean(entry.draftId) && isCount(entry.baseRevision) && isIsoDate(entry.savedAt));
    if (!valid) return null;
    if (new Set(materialized.map((entry) => (entry as CanvasConflictMarkerEntry).draftId)).size !== entries.length) return null;
    return value as CanvasConflictMarkerRecord;
}
```

- [ ] **Step 8: Run all recovery tests until green, then the fake-green check**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery` — expected: 17 passed across three files (database 7, scope 5, types 5).

Fake-green check: temporarily drop the `value.scopeId !== scopeId` comparison from `asDraftRecord` and rerun. "rejects a record whose stored scope differs" must fail; that comparison is the scope-isolation guarantee, so a suite that stays green without it proves nothing. Restore it.

Full-JSON fake-green check: temporarily replace `isJsonObject(snapshot)` with `isRecord(snapshot)` in `asEnvelope` and rerun. The nested non-JSON snapshot assertion must fail. Restore it.

Storage-containment fake-green check: temporarily remove the `getItem` catch from `readInstallationId` and rerun. The storage-failure assertion must fail with the injected `get failed` error. Restore it, then rerun the same scoped suite to 17/17.

- [ ] **Step 9: Commit**

```bash
git add web/src/services/canvas-recovery/scope.ts web/src/services/canvas-recovery/scope.test.ts web/src/services/canvas-recovery/types.ts web/src/services/canvas-recovery/types.test.ts
git commit -m "feat: add recovery scope identity, draft envelope records and CAS outcome types"
```

---

## Task 3: Consistent Open Snapshot And Per-Draft writeSeq CAS

**Files:**
- Create: `web/src/services/canvas-recovery/store.ts`
- Create: `web/src/services/canvas-recovery/store-draft.test.ts`

**Interfaces:**
- Consumes: `createRecoveryDatabase`, `RecoveryDatabase`, `RecoveryFailureReason`, the store-name constants (Task 1); `RecoveryScopeId` (Task 2); all record types, validators and outcome unions (Task 2).
- Produces:

```ts
export type CanvasRecoveryOpenSnapshot = { epoch: CanvasRecoveryEpoch; marker: CanvasConflictMarkerRecord | null; drafts: CanvasDraftRecord[] };
export type CanvasRecoveryOpenResult =
    | { status: "ok"; snapshot: CanvasRecoveryOpenSnapshot }
    | { status: "tombstoned"; deletionGeneration: number }
    | { status: "unavailable"; reason: RecoveryFailureReason };

export type CanvasDraftUpsertInput = {
    scopeId: RecoveryScopeId;
    draftId: string;
    /** Must be strictly greater than the stored writeSeq for this exact [scopeId, draftId]. */
    writeSeq: number;
    expectedDeletionGeneration: number;
    state: CanvasDraftState;
    envelope: CanvasDraftEnvelope;
    savedAt: string;
};

export type CanvasRecoveryStore = {
    readOpenSnapshot(scopeId: RecoveryScopeId, signal?: AbortSignal): Promise<CanvasRecoveryOpenResult>;
    upsertDraft(input: CanvasDraftUpsertInput, signal?: AbortSignal): Promise<CanvasDraftWriteOutcome>;
    close(): void;
};

export function createCanvasRecoveryStore(database: RecoveryDatabase): CanvasRecoveryStore;
```

- [ ] **Step 1: Write the failing tests**

Create `web/src/services/canvas-recovery/store-draft.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { createRecoveryDatabase, DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE, SCOPE_INDEX } from "./database";
import { buildRecoveryScopeId } from "./scope";
import { createCanvasRecoveryStore, type CanvasDraftUpsertInput, type CanvasRecoveryStore } from "./store";
import type { CanvasDraftEnvelope, CanvasDraftState } from "./types";

const scopeA = buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })!;
const scopeB = buildRecoveryScopeId({ kind: "account", userId: "u2", workspaceId: "w1", canvasId: "c1" })!;

const envelope = (title: string): CanvasDraftEnvelope => ({
    document: { title, baseRevision: 4, snapshot: { nodes: [], connections: [] } as never },
    localUi: { viewport: { x: 0, y: 0, k: 1 } },
    assets: {},
});

const upsert = (store: CanvasRecoveryStore, scopeId: typeof scopeA, draftId: string, writeSeq: number, title = "T", expectedDeletionGeneration = 0) =>
    store.upsertDraft({ scopeId, draftId, writeSeq, expectedDeletionGeneration, state: "pending", envelope: envelope(title), savedAt: new Date(writeSeq * 1_000).toISOString() });

describe("draft writeSeq CAS", () => {
    let factory: IDBFactory;
    let store: CanvasRecoveryStore;

    beforeEach(() => {
        factory = freshIndexedDB();
        store = createCanvasRecoveryStore(createRecoveryDatabase(factory));
    });

    it("returns an empty consistent snapshot for a brand-new scope", async () => {
        const result = await store.readOpenSnapshot(scopeA);
        expect(result).toEqual({ status: "ok", snapshot: { epoch: { scopeId: scopeA, coordinationRevision: 0, deletionGeneration: 0, tombstonedAt: null }, marker: null, drafts: [] } });
    });

    it("accepts an increasing writeSeq and rejects equal or older ones", async () => {
        expect(await upsert(store, scopeA, "d1", 1, "first")).toEqual({ status: "written", writeSeq: 1 });
        expect(await upsert(store, scopeA, "d1", 2, "second")).toEqual({ status: "written", writeSeq: 2 });
        expect(await upsert(store, scopeA, "d1", 2, "equal")).toEqual({ status: "superseded", storedWriteSeq: 2 });
        expect(await upsert(store, scopeA, "d1", 1, "older")).toEqual({ status: "superseded", storedWriteSeq: 2 });

        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        // The rejected writes must not have changed the content.
        expect(snapshot.snapshot.drafts[0].envelope.document.title).toBe("second");
        expect(snapshot.snapshot.drafts[0].writeSeq).toBe(2);
    });

    it("keeps writeSeq per draft, so one draft cannot supersede another", async () => {
        expect(await upsert(store, scopeA, "d1", 7)).toEqual({ status: "written", writeSeq: 7 });
        // d2 starts at 1 and must be accepted even though d1 is already at 7.
        expect(await upsert(store, scopeA, "d2", 1)).toEqual({ status: "written", writeSeq: 1 });
        /**
         * The strict canonical-timestamp validator accepts toISOString's expanded-year form.
         * "+275760-09-13T00:00:00.000Z" is chronologically the newest savedAt here, yet it sorts
         * before "1970-..." lexicographically, so snapshot order must compare instants.
         */
        const farFuture = new Date(8.64e15).toISOString();
        expect(await store.upsertDraft({ scopeId: scopeA, draftId: "d3", writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope: envelope("newest"), savedAt: farFuture })).toEqual({ status: "written", writeSeq: 1 });
        const tiedSavedAt = new Date(5_000).toISOString();
        for (const draftId of ["A", "a"]) {
            expect(await store.upsertDraft({ scopeId: scopeA, draftId, writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope: envelope(draftId), savedAt: tiedSavedAt })).toEqual({ status: "written", writeSeq: 1 });
        }
        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        // Equal instants use locale-independent UTF-16 code-unit order: "A" precedes "a".
        expect(snapshot.snapshot.drafts.map((draft) => draft.draftId)).toEqual(["d3", "d1", "A", "a", "d2"]);
    });

    it("never advances coordinationRevision on an ordinary draft write", async () => {
        await upsert(store, scopeA, "d1", 1);
        await upsert(store, scopeA, "d1", 2);
        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        // A private draft write must not starve or race another tab's coordination work.
        expect(snapshot.snapshot.epoch.coordinationRevision).toBe(0);
    });

    it("rejects a write whose expected deletionGeneration does not match", async () => {
        await upsert(store, scopeA, "d1", 1);
        expect(await upsert(store, scopeA, "d1", 2, "T", 1)).toEqual({ status: "generation-changed", deletionGeneration: 0 });
    });

    it("enumerates and isolates one scope without ambient IndexedDB globals", async () => {
        expect(globalThis.indexedDB).toBeUndefined();
        expect(globalThis.IDBKeyRange).toBeUndefined();
        await upsert(store, scopeA, "d1", 1, "belongs-to-a");
        await upsert(store, scopeB, "d1", 1, "belongs-to-b");

        const a = await store.readOpenSnapshot(scopeA);
        const b = await store.readOpenSnapshot(scopeB);
        if (a.status !== "ok" || b.status !== "ok") throw new Error("expected ok");
        expect(a.snapshot.drafts).toHaveLength(1);
        expect(a.snapshot.drafts[0].envelope.document.title).toBe("belongs-to-a");
        expect(b.snapshot.drafts[0].envelope.document.title).toBe("belongs-to-b");
        // Same draftId in both scopes: writeSeq must not be shared.
        expect(await upsert(store, scopeB, "d1", 2, "b-advances")).toEqual({ status: "written", writeSeq: 2 });
        const aAgain = await store.readOpenSnapshot(scopeA);
        if (aAgain.status !== "ok") throw new Error("expected ok");
        expect(aAgain.snapshot.drafts[0].writeSeq).toBe(1);
    });

    it("serialises two connections writing the same key, so no interleaved write is lost or double-applied", async () => {
        // Two connections from ONE factory model two tabs of the same browser.
        const tabA = createCanvasRecoveryStore(createRecoveryDatabase(factory));
        const tabB = createCanvasRecoveryStore(createRecoveryDatabase(factory));
        const [first, second] = await Promise.all([upsert(tabA, scopeA, "d1", 1, "tab-a"), upsert(tabB, scopeA, "d1", 1, "tab-b")]);
        const outcomes = [first.status, second.status].sort();
        // Exactly one wins; the loser is told it was superseded rather than silently overwriting.
        expect(outcomes).toEqual(["superseded", "written"]);
        tabA.close();
        tabB.close();
    });

    it("refuses to read or write once the scope is tombstoned", async () => {
        const database = createRecoveryDatabase(factory);
        const tombstoned = createCanvasRecoveryStore(database);
        await upsert(tombstoned, scopeA, "d1", 1);
        // Simulate a confirmed deletion having been committed by Task 4's operation.
        await database.run("readwrite", [EPOCHS_STORE], 2_000, async (txn) => {
            txn.store(EPOCHS_STORE).put({ scopeId: scopeA, coordinationRevision: 1, deletionGeneration: 1, tombstonedAt: new Date(0).toISOString() });
            return 0;
        });
        expect(await tombstoned.readOpenSnapshot(scopeA)).toEqual({ status: "tombstoned", deletionGeneration: 1 });
        // A late write from a session that started before the deletion must not resurrect the canvas.
        expect(await upsert(tombstoned, scopeA, "d1", 99)).toEqual({ status: "tombstoned" });
        const rows = await database.run("readonly", [DRAFTS_STORE], 2_000, (txn) => txn.req(txn.store(DRAFTS_STORE).getAll()));
        if (rows.status !== "ok") throw new Error("expected ok");
        expect(rows.value.filter((row: { scopeId: string; writeSeq: number }) => row.scopeId === scopeA && row.writeSeq === 99)).toEqual([]);
        tombstoned.close();
    });

    it("skips corrupt draft rows instead of failing the whole open", async () => {
        const database = createRecoveryDatabase(factory);
        const mixed = createCanvasRecoveryStore(database);
        await upsert(mixed, scopeA, "good", 1);
        await database.run("readwrite", [DRAFTS_STORE], 2_000, async (txn) => {
            txn.store(DRAFTS_STORE).put({ scopeId: scopeA, draftId: "bad", writeSeq: -3, deletionGeneration: 0, state: "pending", envelope: {}, savedAt: "not-a-date" });
            return 0;
        });
        const snapshot = await mixed.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        // Fail closed on the bad row only: the good draft is still recoverable.
        expect(snapshot.snapshot.drafts.map((draft) => draft.draftId)).toEqual(["good"]);
        mixed.close();
    });

    it("never overwrites a corrupt existing draft with a guessed writeSeq", async () => {
        const database = createRecoveryDatabase(factory);
        const guarded = createCanvasRecoveryStore(database);
        await database.run("readwrite", [DRAFTS_STORE], 2_000, async (txn) => {
            await txn.req(txn.store(DRAFTS_STORE).put({ scopeId: scopeA, draftId: "bad", writeSeq: "unknown", deletionGeneration: 0, state: "pending", envelope: {}, savedAt: "broken" }));
            return 0;
        });
        expect(await upsert(guarded, scopeA, "bad", 1, "replacement")).toEqual({ status: "unavailable", reason: "corrupt" });
        const raw = await database.run("readonly", [DRAFTS_STORE], 2_000, (txn) => txn.req(txn.store(DRAFTS_STORE).get([scopeA, "bad"])));
        if (raw.status !== "ok") throw new Error("expected ok");
        expect((raw.value as { writeSeq: unknown }).writeSeq).toBe("unknown");

        /**
         * Typed-at-runtime input must be refused by the SAME record boundary that Task 2's
         * validators enforce on read, so the store can never persist a row it would later skip.
         */
        const invalidInputs: Array<Partial<CanvasDraftUpsertInput>> = [
            { draftId: "fractional-seq", writeSeq: 1.5 },
            { draftId: "negative-seq", writeSeq: -1 },
            { draftId: "nan-seq", writeSeq: Number.NaN },
            { draftId: "unparsable-saved-at", savedAt: "not-a-date" },
            { draftId: "noncanonical-saved-at", savedAt: "2020-01-01T00:00:00Z" },
            { draftId: "empty-envelope", envelope: {} as CanvasDraftEnvelope },
            { draftId: "unusable-viewport", envelope: { ...envelope("bad-viewport"), localUi: { viewport: { x: 0, y: 0, k: 0 } } } },
            { draftId: "unknown-state", state: "archived" as CanvasDraftState },
            { draftId: "" },
        ];
        for (const override of invalidInputs) {
            const input: CanvasDraftUpsertInput = { scopeId: scopeA, draftId: "placeholder", writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope: envelope("valid"), savedAt: new Date(1_000).toISOString(), ...override };
            expect(await guarded.upsertDraft(input)).toEqual({ status: "unavailable", reason: "corrupt" });
        }
        const rows = await database.run("readonly", [DRAFTS_STORE], 2_000, (txn) => txn.req(txn.store(DRAFTS_STORE).index(SCOPE_INDEX).getAll(scopeA)));
        if (rows.status !== "ok") throw new Error("expected ok");
        // Only the pre-existing corrupt row remains: not one invalid input reached storage.
        expect((rows.value as Array<{ draftId: string }>).map((row) => row.draftId)).toEqual(["bad"]);
        guarded.close();
    });

    it("fails closed when an epoch row exists but is corrupt", async () => {
        const database = createRecoveryDatabase(factory);
        const guarded = createCanvasRecoveryStore(database);
        await database.run("readwrite", [EPOCHS_STORE], 2_000, async (txn) => {
            await txn.req(txn.store(EPOCHS_STORE).put({ scopeId: scopeA, coordinationRevision: "broken", deletionGeneration: 1, tombstonedAt: new Date(0).toISOString() }));
            return 0;
        });
        // A malformed tombstoned epoch must never collapse to generation zero and revive the scope.
        expect(await guarded.readOpenSnapshot(scopeA)).toEqual({ status: "unavailable", reason: "corrupt" });
        expect(await upsert(guarded, scopeA, "late", 99)).toEqual({ status: "unavailable", reason: "corrupt" });
        guarded.close();
    });

    it("fails closed when a marker row exists but is corrupt", async () => {
        const database = createRecoveryDatabase(factory);
        const guarded = createCanvasRecoveryStore(database);
        await database.run("readwrite", [MARKERS_STORE], 2_000, async (txn) => {
            await txn.req(txn.store(MARKERS_STORE).put({ scopeId: scopeA, markerId: "conflict", entries: [{ draftId: "d1" }] }));
            return 0;
        });
        // Unknown marker ownership is not equivalent to no marker; open and later GC must stop.
        expect(await guarded.readOpenSnapshot(scopeA)).toEqual({ status: "unavailable", reason: "corrupt" });
        guarded.close();
    });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-draft.test.ts`
Expected: FAIL, cannot resolve `./store`.

- [ ] **Step 3: Implement the open snapshot read and the draft CAS**

Create `web/src/services/canvas-recovery/store.ts`:

```ts
import { DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE, RECOVERY_TRANSACTION_TIMEOUT_MS, SCOPE_INDEX, type RecoveryDatabase, type RecoveryFailureReason, type RecoveryTxn } from "./database";
import type { RecoveryScopeId } from "./scope";
import { asDraftRecord, asEpoch, asMarkerRecord, CONFLICT_MARKER_ID, initialEpoch, type CanvasConflictMarkerRecord, type CanvasDraftEnvelope, type CanvasDraftRecord, type CanvasDraftState, type CanvasDraftWriteOutcome, type CanvasRecoveryEpoch } from "./types";

export type CanvasRecoveryOpenSnapshot = { epoch: CanvasRecoveryEpoch; marker: CanvasConflictMarkerRecord | null; drafts: CanvasDraftRecord[] };
export type CanvasRecoveryOpenResult =
    | { status: "ok"; snapshot: CanvasRecoveryOpenSnapshot }
    | { status: "tombstoned"; deletionGeneration: number }
    | { status: "unavailable"; reason: RecoveryFailureReason };

export type CanvasDraftUpsertInput = {
    scopeId: RecoveryScopeId;
    draftId: string;
    writeSeq: number;
    expectedDeletionGeneration: number;
    state: CanvasDraftState;
    envelope: CanvasDraftEnvelope;
    savedAt: string;
};

export type CanvasRecoveryStore = {
    readOpenSnapshot(scopeId: RecoveryScopeId, signal?: AbortSignal): Promise<CanvasRecoveryOpenResult>;
    upsertDraft(input: CanvasDraftUpsertInput, signal?: AbortSignal): Promise<CanvasDraftWriteOutcome>;
    close(): void;
};

type EpochReadResult = { status: "ok"; epoch: CanvasRecoveryEpoch } | { status: "corrupt" };

/**
 * Missing is the only case that creates generation zero. A present but invalid epoch is
 * fail-closed: it may contain a tombstone that this client must never erase or bypass.
 */
async function readEpoch(txn: RecoveryTxn, scopeId: RecoveryScopeId): Promise<EpochReadResult> {
    const raw = await txn.req(txn.store(EPOCHS_STORE).get(scopeId));
    if (raw === undefined) return { status: "ok", epoch: initialEpoch(scopeId) };
    const epoch = asEpoch(raw, scopeId);
    return epoch ? { status: "ok", epoch } : { status: "corrupt" };
}

/**
 * Scope-limited enumeration. Exact equality accepts the scopeId key directly, so this
 * path does not depend on an ambient IDBKeyRange constructor in Node or the browser.
 */
async function readScopeDrafts(txn: RecoveryTxn, scopeId: RecoveryScopeId): Promise<CanvasDraftRecord[]> {
    const rows = await txn.req(txn.store(DRAFTS_STORE).index(SCOPE_INDEX).getAll(scopeId));
    /** Corrupt rows are skipped, never repaired and never allowed to hide a valid draft. */
    const drafts = (rows as unknown[]).map((row) => asDraftRecord(row, scopeId)).filter((row): row is CanvasDraftRecord => row !== null);
    /**
     * Newest first by INSTANT, not by string order: the canonical-timestamp boundary accepts
     * toISOString's expanded-year form, whose "+275760-" prefix sorts below "1970-".
     * UTF-16 code-unit draftId order breaks ties identically across runtimes and locales.
     */
    return drafts.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt) || (a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0));
}

export function createCanvasRecoveryStore(database: RecoveryDatabase): CanvasRecoveryStore {
    return {
        /** One readonly transaction gives epoch + marker + drafts as ONE consistent snapshot. */
        readOpenSnapshot: async (scopeId, signal) => {
            const run = await database.run("readonly", [EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE], RECOVERY_TRANSACTION_TIMEOUT_MS, async (txn): Promise<CanvasRecoveryOpenResult> => {
                const epochRead = await readEpoch(txn, scopeId);
                if (epochRead.status === "corrupt") return { status: "unavailable", reason: "corrupt" };
                const epoch = epochRead.epoch;
                if (epoch.tombstonedAt) return { status: "tombstoned", deletionGeneration: epoch.deletionGeneration };
                const markerRaw = await txn.req(txn.store(MARKERS_STORE).get([scopeId, CONFLICT_MARKER_ID]));
                const marker = asMarkerRecord(markerRaw, scopeId);
                /** A present but invalid marker has unknown ownership; fail closed instead of treating it as absent. */
                if (markerRaw !== undefined && !marker) return { status: "unavailable", reason: "corrupt" };
                return { status: "ok", snapshot: { epoch, marker, drafts: await readScopeDrafts(txn, scopeId) } };
            }, signal);
            if (run.status !== "ok") return { status: "unavailable", reason: run.reason };
            return run.value;
        },

        /**
         * Ordinary draft write. In one transaction: read epoch, refuse a tombstone or a
         * generation mismatch, then refuse stored.writeSeq >= incoming.writeSeq.
         * coordinationRevision is deliberately neither read for comparison nor advanced, so
         * another tab's marker activity can never starve this draft.
         */
        upsertDraft: async (input, signal) => {
            /**
             * The record is validated by the SAME boundary that rejects rows on read, before any
             * transaction opens. Typed-at-runtime input can therefore never persist a row that a
             * later open would skip, and the object put below is the validated object itself.
             */
            const record = asDraftRecord({ scopeId: input.scopeId, draftId: input.draftId, writeSeq: input.writeSeq, deletionGeneration: input.expectedDeletionGeneration, state: input.state, envelope: input.envelope, savedAt: input.savedAt }, input.scopeId);
            if (!record) return { status: "unavailable", reason: "corrupt" };
            const run = await database.run("readwrite", [EPOCHS_STORE, DRAFTS_STORE], RECOVERY_TRANSACTION_TIMEOUT_MS, async (txn): Promise<CanvasDraftWriteOutcome> => {
                const epochRead = await readEpoch(txn, input.scopeId);
                if (epochRead.status === "corrupt") return { status: "unavailable", reason: "corrupt" };
                const epoch = epochRead.epoch;
                if (epoch.tombstonedAt) return { status: "tombstoned" };
                if (epoch.deletionGeneration !== record.deletionGeneration) return { status: "generation-changed", deletionGeneration: epoch.deletionGeneration };
                const storedRaw = await txn.req(txn.store(DRAFTS_STORE).get([input.scopeId, record.draftId]));
                const stored = asDraftRecord(storedRaw, input.scopeId);
                /** Unknown sequence/shape cannot be compared safely. Preserve it until explicit confirmed deletion. */
                if (storedRaw !== undefined && !stored) return { status: "unavailable", reason: "corrupt" };
                if (stored && stored.writeSeq >= record.writeSeq) return { status: "superseded", storedWriteSeq: stored.writeSeq };
                /** The validated record is stored as-is; a validated record is never mutated in place. */
                await txn.req(txn.store(DRAFTS_STORE).put(record));
                return { status: "written", writeSeq: record.writeSeq };
            }, signal);
            return run.status === "ok" ? run.value : { status: "unavailable", reason: run.reason };
        },

        close: () => database.close(),
    };
}
```

- [ ] **Step 4: Run until green, then the fake-green check**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-draft.test.ts` — expected: 12 passed.

Fake-green check: temporarily change the `stored.writeSeq >= record.writeSeq` guard to `>` and rerun. The "accepts an increasing writeSeq" test must fail on the equal-seq case; if it still passes, the test is not exercising the CAS boundary. Restore `>=`.

- [ ] **Step 5: Commit**

```bash
git add web/src/services/canvas-recovery/store.ts web/src/services/canvas-recovery/store-draft.test.ts
git commit -m "feat: add consistent recovery open snapshot and per-draft writeSeq CAS"
```

---

## Task 4: Coordination CAS, Deletion CAS, GC And The Explicit Legacy Upgrade

**Files:**
- Modify: `web/src/services/canvas-recovery/store.ts` (add three operations to the returned object and extend `CanvasRecoveryStore`)
- Create: `web/src/services/canvas-recovery/store-coordination.test.ts`
- Create: `web/src/services/canvas-recovery/bootstrap.ts`
- Create: `web/src/services/canvas-recovery/bootstrap.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces:

```ts
/** One coordination step: optionally rewrite/remove the marker and delete drafts, under an expected-epoch check. */
export type CanvasCoordinationInput = {
    scopeId: RecoveryScopeId;
    expectedCoordinationRevision: number;
    expectedDeletionGeneration: number;
    /** entries -> write the marker; null -> delete it; undefined -> leave it untouched. */
    marker?: CanvasConflictMarkerEntry[] | null;
    /** Draft ids to delete, re-validated inside the same transaction. */
    deleteDraftIds?: string[];
};

export type CanvasGarbageInput = {
    scopeId: RecoveryScopeId;
    expectedCoordinationRevision: number;
    expectedDeletionGeneration: number;
    /** Never collected regardless of age: the live session draft and everything the marker references. */
    keepDraftIds: string[];
    now: number;
    minAgeMs: number;
};

// added to CanvasRecoveryStore
commitCoordination(input: CanvasCoordinationInput, signal?: AbortSignal): Promise<CanvasCoordinationOutcome>;
confirmDeletion(scopeId: RecoveryScopeId, expectedDeletionGeneration: number, now: number, signal?: AbortSignal): Promise<CanvasDeletionOutcome>;
collectGarbage(input: CanvasGarbageInput, signal?: AbortSignal): Promise<CanvasCoordinationOutcome>;

// bootstrap.ts
export type LegacyUpgradeOutcome = "upgraded" | "already-upgraded" | "failed";
export function upgradeRecoveryStorage(deps: { storage: Pick<Storage, "getItem" | "setItem">; dropLegacy: () => Promise<void> }): Promise<LegacyUpgradeOutcome>;
```

- [ ] **Step 1: Write the failing coordination, deletion and GC tests**

Create `web/src/services/canvas-recovery/store-coordination.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { createRecoveryDatabase, DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE, SCOPE_INDEX } from "./database";
import { buildRecoveryScopeId } from "./scope";
import { createCanvasRecoveryStore, createLazyBrowserRecoveryStore, type CanvasRecoveryStore } from "./store";
import { CONFLICT_MARKER_ID, type CanvasConflictMarkerEntry, type CanvasDraftEnvelope } from "./types";

const scopeA = buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })!;
const scopeB = buildRecoveryScopeId({ kind: "account", userId: "u2", workspaceId: "w1", canvasId: "c1" })!;
const DAY = 24 * 60 * 60 * 1_000;
const SIX_HOURS = 6 * 60 * 60 * 1_000;

const makeEnvelope = (title = "T"): CanvasDraftEnvelope => ({
    document: { title, baseRevision: 1, snapshot: { nodes: [], connections: [] } as never },
    localUi: { viewport: { x: 0, y: 0, k: 1 } },
    assets: {},
});
const envelope: CanvasDraftEnvelope = makeEnvelope();
const write = (store: CanvasRecoveryStore, scopeId: typeof scopeA, draftId: string, writeSeq: number, savedAtMs: number) =>
    store.upsertDraft({ scopeId, draftId, writeSeq, expectedDeletionGeneration: 0, state: "pending", envelope, savedAt: new Date(savedAtMs).toISOString() });
const entry = (draftId: string): CanvasConflictMarkerEntry => ({ draftId, baseRevision: 1, savedAt: new Date(0).toISOString() });
const corrupt = { status: "unavailable", reason: "corrupt" } as const;

describe("coordination, deletion and gc CAS", () => {
    let factory: IDBFactory;
    let store: CanvasRecoveryStore;

    beforeEach(() => {
        factory = freshIndexedDB();
        store = createCanvasRecoveryStore(createRecoveryDatabase(factory));
    });

    it("writes the marker and deletes drafts atomically, advancing coordinationRevision by one", async () => {
        await write(store, scopeA, "d1", 1, 0);
        await write(store, scopeA, "d2", 1, 0);
        /**
         * The caller keeps references to both arrays. Everything is detached synchronously before
         * the first await, so these post-call mutations cannot reach storage while the open and
         * epoch requests are still pending.
         */
        const markerInput = [entry("d1")];
        const deleteInput = ["d2"];
        const pending = store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: markerInput, deleteDraftIds: deleteInput });
        markerInput.push(entry("hijack"));
        markerInput[0].draftId = "hijacked";
        markerInput[0].baseRevision = 999;
        deleteInput.push("d1");
        await Promise.resolve();
        markerInput[0].savedAt = "not-a-date";
        deleteInput.push("d1");
        expect(await pending).toEqual({ status: "committed", coordinationRevision: 1 });

        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        expect(snapshot.snapshot.marker?.entries).toEqual([entry("d1")]);
        expect(snapshot.snapshot.drafts.map((draft) => draft.draftId)).toEqual(["d1"]);
        expect(snapshot.snapshot.epoch.coordinationRevision).toBe(1);
        // Coordination must never write a tombstone or touch the deletion generation.
        expect(snapshot.snapshot.epoch.deletionGeneration).toBe(0);
        expect(snapshot.snapshot.epoch.tombstonedAt).toBeNull();
    });

    it("rejects a stale coordination attempt and changes nothing", async () => {
        await write(store, scopeA, "d1", 1, 0);
        await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [entry("d1")] });
        // A repair computed against revision 0 arrives after another tab already advanced to 1.
        const stale = await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: null, deleteDraftIds: ["d1"] });
        expect(stale).toEqual({ status: "stale", coordinationRevision: 1, deletionGeneration: 0 });

        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        // The stale attempt must not have deleted the draft or removed the marker.
        expect(snapshot.snapshot.marker?.entries).toHaveLength(1);
        expect(snapshot.snapshot.drafts).toHaveLength(1);
    });

    it("fails a coordination delete atomically when any requested draft row is corrupt", async () => {
        await write(store, scopeA, "d1", 1, 0);
        await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [entry("d1")] });
        const database = createRecoveryDatabase(factory);
        await database.run("readwrite", [DRAFTS_STORE], 2_000, async (txn) => {
            await txn.req(txn.store(DRAFTS_STORE).put({ scopeId: scopeA, draftId: "bad", writeSeq: "unknown", deletionGeneration: 0, state: "pending", envelope: {}, savedAt: "broken" }));
            return 0;
        });

        expect(await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 1, expectedDeletionGeneration: 0, marker: null, deleteDraftIds: ["d1", "bad"] })).toEqual(corrupt);
        // Unusable delete targets are refused before the transaction opens, so no write happens either.
        expect(await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 1, expectedDeletionGeneration: 0, marker: null, deleteDraftIds: [""] })).toEqual(corrupt);
        expect(await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 1, expectedDeletionGeneration: 0, marker: null, deleteDraftIds: [7 as never] })).toEqual(corrupt);

        const after = await store.readOpenSnapshot(scopeA);
        if (after.status !== "ok") throw new Error("expected ok");
        expect(after.snapshot.marker?.entries[0].draftId).toBe("d1");
        expect(after.snapshot.drafts.map((draft) => draft.draftId)).toEqual(["d1"]);
        expect(after.snapshot.epoch.coordinationRevision).toBe(1);
        const raw = await database.run("readonly", [DRAFTS_STORE], 2_000, (txn) => txn.req(txn.store(DRAFTS_STORE).get([scopeA, "bad"])));
        if (raw.status !== "ok") throw new Error("expected ok");
        // The corrupt row is preserved: only confirmed deletion may clear it.
        expect((raw.value as { writeSeq: unknown }).writeSeq).toBe("unknown");
        database.close();
    });

    it("lets a private draft keep advancing while another tab churns coordinationRevision", async () => {
        await write(store, scopeA, "mine", 1, 0);
        for (let revision = 0; revision < 3; revision += 1) {
            await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: revision, expectedDeletionGeneration: 0, marker: [entry("mine")] });
        }
        // The private write carries no coordination expectation, so it is not starved.
        expect(await write(store, scopeA, "mine", 2, 1_000)).toEqual({ status: "written", writeSeq: 2 });

        /**
         * The envelope is detached and validated synchronously before the first await, so a caller
         * mutating it while the write is in flight cannot persist a row a later open would skip.
         */
        const mutable = makeEnvelope("original");
        const pending = store.upsertDraft({ scopeId: scopeA, draftId: "mine", writeSeq: 3, expectedDeletionGeneration: 0, state: "pending", envelope: mutable, savedAt: new Date(2_000).toISOString() });
        mutable.document.title = "MUTATED";
        mutable.document.baseRevision = -5;
        mutable.assets = "not-an-asset-map" as never;
        await Promise.resolve();
        mutable.localUi.viewport.k = 0;
        expect(await pending).toEqual({ status: "written", writeSeq: 3 });

        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        const stored = snapshot.snapshot.drafts.find((draft) => draft.draftId === "mine");
        expect(stored?.envelope).toEqual(makeEnvelope("original"));
        // An uncloneable envelope is a controlled corrupt outcome, never a thrown DataCloneError.
        expect(await store.upsertDraft({ scopeId: scopeA, draftId: "mine", writeSeq: 4, expectedDeletionGeneration: 0, state: "pending", envelope: { ...makeEnvelope(), onSave: () => undefined } as never, savedAt: new Date(3_000).toISOString() })).toEqual(corrupt);
    });

    it("confirms deletion in one transaction: generation bump, tombstone, drafts and markers gone", async () => {
        await write(store, scopeA, "d1", 1, 0);
        await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [entry("d1")] });
        const database = createRecoveryDatabase(factory);
        await database.run("readwrite", [DRAFTS_STORE, MARKERS_STORE], 2_000, async (txn) => {
            await txn.req(txn.store(DRAFTS_STORE).put({ scopeId: scopeA, draftId: "corrupt", writeSeq: "unknown", deletionGeneration: 0, state: "pending", envelope: {}, savedAt: "broken" }));
            await txn.req(txn.store(MARKERS_STORE).put({ scopeId: scopeA, markerId: CONFLICT_MARKER_ID, entries: [{ draftId: "missing-fields" }] }));
            /** A corrupt row under a noncanonical marker id must not survive a confirmed deletion. */
            await txn.req(txn.store(MARKERS_STORE).put({ scopeId: scopeA, markerId: "legacy-residue", entries: "broken" }));
            return 0;
        });
        expect(await store.confirmDeletion(scopeA, 0, 1_000)).toEqual({ status: "tombstoned", deletionGeneration: 1 });

        const drafts = await database.run("readonly", [DRAFTS_STORE], 2_000, (txn) => txn.req(txn.store(DRAFTS_STORE).getAll()));
        const markers = await database.run("readonly", [MARKERS_STORE], 2_000, (txn) => txn.req(txn.store(MARKERS_STORE).getAll()));
        if (drafts.status !== "ok" || markers.status !== "ok") throw new Error("expected ok");
        expect(drafts.value.filter((row: { scopeId: string }) => row.scopeId === scopeA)).toEqual([]);
        expect(markers.value.filter((row: { scopeId: string }) => row.scopeId === scopeA)).toEqual([]);
        expect(await store.readOpenSnapshot(scopeA)).toEqual({ status: "tombstoned", deletionGeneration: 1 });
        database.close();
    });

    it("keeps the tombstone idempotent and blocks a late write from resurrecting the canvas", async () => {
        await write(store, scopeA, "d1", 1, 0);
        /**
         * A generation mismatch on a NON-tombstoned epoch cannot happen under valid state, because
         * only this operation advances the generation and it always writes the tombstone with it.
         * It is therefore corrupt state and must not delete anything.
         */
        expect(await store.confirmDeletion(scopeA, 1, 500)).toEqual(corrupt);
        const intact = await store.readOpenSnapshot(scopeA);
        if (intact.status !== "ok") throw new Error("expected ok");
        expect(intact.snapshot.drafts).toHaveLength(1);
        expect(intact.snapshot.epoch).toEqual({ scopeId: scopeA, coordinationRevision: 0, deletionGeneration: 0, tombstonedAt: null });

        expect(await store.confirmDeletion(scopeA, 0, 1_000)).toEqual({ status: "tombstoned", deletionGeneration: 1 });
        // A present tombstone alone means already-tombstoned, whatever generation the caller expected.
        expect(await store.confirmDeletion(scopeA, 0, 2_000)).toEqual({ status: "already-tombstoned" });
        expect(await store.confirmDeletion(scopeA, 1, 2_000)).toEqual({ status: "already-tombstoned" });
        // A session that captured generation 0 before the delete must be refused.
        expect(await write(store, scopeA, "d1", 50, 5_000)).toEqual({ status: "tombstoned" });
        expect(await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 1, expectedDeletionGeneration: 0, marker: [entry("d1")] })).toEqual({ status: "tombstoned" });
    });

    it("deletes only aged, unreferenced drafts and re-validates inside the deleting transaction", async () => {
        const now = 10 * DAY;
        await write(store, scopeA, "live", 1, now);
        await write(store, scopeA, "referenced", 1, now - 2 * DAY);
        await write(store, scopeA, "stale", 1, now - 2 * DAY);
        await write(store, scopeA, "recent", 1, now - 60_000);
        await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [entry("referenced")] });

        /** The keep list is snapshotted before the first await, so a later mutation cannot widen GC. */
        const keepInput = ["live"];
        const pending = store.collectGarbage({ scopeId: scopeA, expectedCoordinationRevision: 1, expectedDeletionGeneration: 0, keepDraftIds: keepInput, now, minAgeMs: SIX_HOURS });
        keepInput.length = 0;
        await Promise.resolve();
        keepInput.push("stale");
        expect(await pending).toEqual({ status: "committed", coordinationRevision: 2 });

        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        expect(snapshot.snapshot.drafts.map((draft) => draft.draftId).sort()).toEqual(["live", "recent", "referenced"]);
    });

    it("refuses GC on a stale epoch so it cannot delete a draft another tab just published", async () => {
        const now = 10 * DAY;
        await write(store, scopeA, "stale", 1, now - 2 * DAY);
        await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [entry("stale")] });
        const result = await store.collectGarbage({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, keepDraftIds: [], now, minAgeMs: SIX_HOURS });
        expect(result).toEqual({ status: "stale", coordinationRevision: 1, deletionGeneration: 0 });
        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        expect(snapshot.snapshot.drafts).toHaveLength(1);
    });

    it("never touches another scope during coordination, deletion or GC", async () => {
        const now = 10 * DAY;
        await write(store, scopeA, "d1", 1, now - 2 * DAY);
        await write(store, scopeB, "d1", 1, now - 2 * DAY);
        await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: null, deleteDraftIds: ["d1"] });
        await store.collectGarbage({ scopeId: scopeA, expectedCoordinationRevision: 1, expectedDeletionGeneration: 0, keepDraftIds: [], now, minAgeMs: SIX_HOURS });
        await store.confirmDeletion(scopeA, 0, now);

        const otherIdentity = await store.readOpenSnapshot(scopeB);
        if (otherIdentity.status !== "ok") throw new Error("expected ok");
        // The other identity is untouched: not read, not GC'd, not tombstoned.
        expect(otherIdentity.snapshot.drafts).toHaveLength(1);
        expect(otherIdentity.snapshot.epoch).toEqual({ scopeId: scopeB, coordinationRevision: 0, deletionGeneration: 0, tombstonedAt: null });
    });

    it("refuses marker overflow, unsafe epoch increments and invalid primitive input without any write", async () => {
        await write(store, scopeA, "d1", 1, 0);
        const capped = await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [entry("d1"), entry("d2"), entry("d3")] });
        expect(capped).toEqual(corrupt);
        // An uncloneable marker entry is contained as corrupt, never thrown.
        expect(await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [{ ...entry("d1"), onWrite: () => undefined } as never] })).toEqual(corrupt);
        const snapshot = await store.readOpenSnapshot(scopeA);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        expect(snapshot.snapshot.marker).toBeNull();
        expect(snapshot.snapshot.epoch.coordinationRevision).toBe(0);

        /** An epoch parked at the safe-integer ceiling must never be advanced past what asEpoch accepts. */
        const database = createRecoveryDatabase(factory);
        const ceiling = { scopeId: scopeA, coordinationRevision: Number.MAX_SAFE_INTEGER, deletionGeneration: Number.MAX_SAFE_INTEGER, tombstonedAt: null };
        await database.run("readwrite", [EPOCHS_STORE], 2_000, async (txn) => txn.req(txn.store(EPOCHS_STORE).put(ceiling)));
        const atCeiling = { scopeId: scopeA, expectedCoordinationRevision: Number.MAX_SAFE_INTEGER, expectedDeletionGeneration: Number.MAX_SAFE_INTEGER } as const;
        expect(await store.commitCoordination({ ...atCeiling, marker: [entry("d1")] })).toEqual(corrupt);
        expect(await store.collectGarbage({ ...atCeiling, keepDraftIds: [], now: 10 * DAY, minAgeMs: SIX_HOURS })).toEqual(corrupt);
        expect(await store.confirmDeletion(scopeA, Number.MAX_SAFE_INTEGER, 1_000)).toEqual(corrupt);

        /** Primitive inputs that steer destructive behaviour are refused before any transaction opens. */
        for (const revision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
            expect(await store.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: revision, expectedDeletionGeneration: 0, marker: null })).toEqual(corrupt);
            expect(await store.collectGarbage({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: revision, keepDraftIds: [], now: 0, minAgeMs: 0 })).toEqual(corrupt);
            expect(await store.confirmDeletion(scopeA, revision, 1_000)).toEqual(corrupt);
        }
        for (const bad of [{ now: -1, minAgeMs: 0 }, { now: Number.NaN, minAgeMs: 0 }, { now: 0, minAgeMs: Number.NaN }, { now: 0, minAgeMs: -1 }, { now: Number.POSITIVE_INFINITY, minAgeMs: 0 }]) {
            expect(await store.collectGarbage({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, keepDraftIds: [], ...bad })).toEqual(corrupt);
        }
        for (const now of [Number.NaN, 9e15, -9e15, Number.POSITIVE_INFINITY]) expect(await store.confirmDeletion(scopeA, 0, now)).toEqual(corrupt);
        expect(await store.collectGarbage({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, keepDraftIds: ["" as string], now: 0, minAgeMs: 0 })).toEqual(corrupt);

        const epochRow = await database.run("readonly", [EPOCHS_STORE], 2_000, (txn) => txn.req(txn.store(EPOCHS_STORE).get(scopeA)));
        const rows = await database.run("readonly", [DRAFTS_STORE], 2_000, (txn) => txn.req(txn.store(DRAFTS_STORE).index(SCOPE_INDEX).getAll(scopeA)));
        if (epochRow.status !== "ok" || rows.status !== "ok") throw new Error("expected ok");
        // No partial write anywhere: the epoch and the draft are exactly as they were.
        expect(epochRow.value).toEqual(ceiling);
        expect((rows.value as Array<{ draftId: string }>).map((row) => row.draftId)).toEqual(["d1"]);
        database.close();
    });

    it("imports safely without ambient IndexedDB and fails only when the lazy browser store is called", async () => {
        expect(globalThis.indexedDB).toBeUndefined();
        const lazy = createLazyBrowserRecoveryStore();
        const unsupported = { status: "unavailable", reason: "unsupported" } as const;
        expect(await lazy.readOpenSnapshot(scopeA)).toEqual(unsupported);
        expect(await lazy.upsertDraft({ scopeId: scopeA, draftId: "d1", writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope, savedAt: new Date(0).toISOString() })).toEqual(unsupported);
        expect(await lazy.commitCoordination({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: null })).toEqual(unsupported);
        expect(await lazy.confirmDeletion(scopeA, 0, 0)).toEqual(unsupported);
        expect(await lazy.collectGarbage({ scopeId: scopeA, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, keepDraftIds: [], now: 0, minAgeMs: 0 })).toEqual(unsupported);
        // Construction and import are side-effect free; close is safe even when no database was created.
        expect(() => lazy.close()).not.toThrow();
        // An injected factory makes the same lazy store fully functional.
        const injected = createLazyBrowserRecoveryStore(() => factory);
        expect(await injected.upsertDraft({ scopeId: scopeA, draftId: "d1", writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope, savedAt: new Date(0).toISOString() })).toEqual({ status: "written", writeSeq: 1 });
        injected.close();
    });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-coordination.test.ts`
Expected: FAIL with "commitCoordination is not a function" (and the same for `confirmDeletion` / `collectGarbage`).

- [ ] **Step 3: Add the three operations to store.ts**

Extend the imports at the top of `web/src/services/canvas-recovery/store.ts`: `DRAFT_GC_MIN_AGE_MS` is *not* needed here because the caller passes `minAgeMs`; import `MAX_CONFLICT_MARKER_ENTRIES`, the shared `isRecoveryCount` count predicate and the `CanvasConflictMarkerEntry` / `CanvasCoordinationOutcome` / `CanvasDeletionOutcome` types from `./types`, plus `createRecoveryDatabase` and `SCOPE_INDEX` from `./database`. Do not import marker limits from canvas-sync, and do not redefine a local count/date validator: Task 2's boundary is the single source.

First add the shared destructive-write guards. `detach` is what makes every operation caller-race-proof, and `nextEpoch` is what makes every increment overflow-proof:

```ts
const CORRUPT = { status: "unavailable", reason: "corrupt" } as const;
/** The widest instant Date can represent; anything beyond it has no canonical ISO form. */
const MAX_TIME_VALUE_MS = 8.64e15;

/**
 * Caller-owned data is detached HERE, synchronously, before the first await. A caller that keeps a
 * reference and mutates it while an open or epoch request is still pending therefore cannot change
 * what this transaction validates or stores. An uncloneable value is a controlled corrupt outcome,
 * never an escaping DataCloneError.
 */
function detach<T>(value: T): T | null {
    try {
        return structuredClone(value);
    } catch {
        return null;
    }
}

const isDraftId = (value: unknown): value is string => typeof value === "string" && value.length > 0;
/** Milliseconds that steer destructive age comparisons must be real, nonnegative and usable. */
const isElapsedMs = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Every epoch this store writes passes the SAME validator that rejects epochs on read, so an
 * increment at the safe-integer ceiling is refused instead of persisting a row a later open would
 * treat as corrupt. Callers must run this before their first write to stay all-or-nothing.
 */
function nextEpoch(epoch: CanvasRecoveryEpoch, changes: Partial<CanvasRecoveryEpoch>): CanvasRecoveryEpoch | null {
    return asEpoch({ ...epoch, ...changes }, epoch.scopeId);
}
```

Task 3's `upsertDraft` must also detach: wrap its candidate object in `detach(...)` and validate that clone (`const record = candidate && asDraftRecord(candidate, input.scopeId)`), so a caller mutating the envelope while the epoch read is pending cannot persist a row a later open would skip. Then add these types and the three members:

```ts
export type CanvasCoordinationInput = {
    scopeId: RecoveryScopeId;
    expectedCoordinationRevision: number;
    expectedDeletionGeneration: number;
    /** entries -> write the marker; null -> delete it; undefined -> leave it untouched. */
    marker?: CanvasConflictMarkerEntry[] | null;
    deleteDraftIds?: string[];
};

export type CanvasGarbageInput = {
    scopeId: RecoveryScopeId;
    expectedCoordinationRevision: number;
    expectedDeletionGeneration: number;
    keepDraftIds: string[];
    now: number;
    minAgeMs: number;
};
```

Add to the object returned by `createCanvasRecoveryStore`:

```ts
/**
 * Every non-private mutation: marker changes, foreign/own draft deletes and repair commits.
 * Verifies BOTH expected epoch values in the same transaction, then advances coordinationRevision by 1.
 * It never writes a tombstone and never touches deletionGeneration.
 */
commitCoordination: async (input, signal) => {
    if (!isRecoveryCount(input.expectedCoordinationRevision) || !isRecoveryCount(input.expectedDeletionGeneration)) return CORRUPT;
    /** Detached and validated BEFORE the first await: the caller cannot mutate what gets stored. */
    let marker: CanvasConflictMarkerRecord | null = null;
    if (input.marker) {
        const cloned = detach(input.marker);
        const candidate = cloned && asMarkerRecord({ scopeId: input.scopeId, markerId: CONFLICT_MARKER_ID, entries: cloned }, input.scopeId);
        if (!candidate || candidate.entries.length > MAX_CONFLICT_MARKER_ENTRIES) return CORRUPT;
        marker = candidate;
    }
    const deleteDraftIds = detach(input.deleteDraftIds ?? []);
    if (!deleteDraftIds || !deleteDraftIds.every(isDraftId)) return CORRUPT;
    const run = await database.run("readwrite", [EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE], RECOVERY_TRANSACTION_TIMEOUT_MS, async (txn): Promise<CanvasCoordinationOutcome> => {
        const epochRead = await readEpoch(txn, input.scopeId);
        if (epochRead.status === "corrupt") return { status: "unavailable", reason: "corrupt" };
        const epoch = epochRead.epoch;
        if (epoch.tombstonedAt) return { status: "tombstoned" };
        if (epoch.coordinationRevision !== input.expectedCoordinationRevision || epoch.deletionGeneration !== input.expectedDeletionGeneration) {
            return { status: "stale", coordinationRevision: epoch.coordinationRevision, deletionGeneration: epoch.deletionGeneration };
        }
        /** Refuse an unrepresentable increment BEFORE any write, so overflow cannot leave a partial commit. */
        const next = nextEpoch(epoch, { coordinationRevision: epoch.coordinationRevision + 1 });
        if (!next) return CORRUPT;
        const draftIdsToDelete: string[] = [];
        for (const draftId of deleteDraftIds) {
            /** Re-read and validate every target before the first write, preserving all-or-nothing semantics. */
            const storedRaw = await txn.req(txn.store(DRAFTS_STORE).get([input.scopeId, draftId]));
            const stored = asDraftRecord(storedRaw, input.scopeId);
            /** Coordination cannot prove a corrupt row's lineage; only confirmed deletion may clear it. */
            if (storedRaw !== undefined && !stored) return { status: "unavailable", reason: "corrupt" };
            if (stored) draftIdsToDelete.push(draftId);
        }
        if (input.marker !== undefined) {
            if (marker === null) await txn.req(txn.store(MARKERS_STORE).delete([input.scopeId, CONFLICT_MARKER_ID]));
            /** The detached validated candidate is stored, never the caller's live array. */
            else await txn.req(txn.store(MARKERS_STORE).put(marker));
        }
        for (const draftId of draftIdsToDelete) await txn.req(txn.store(DRAFTS_STORE).delete([input.scopeId, draftId]));
        await txn.req(txn.store(EPOCHS_STORE).put(next));
        return { status: "committed", coordinationRevision: next.coordinationRevision };
    }, signal);
    return run.status === "ok" ? run.value : { status: "unavailable", reason: run.reason };
},

/**
 * The ONLY operation that advances deletionGeneration. The caller must already hold proof:
 * a positive DELETE receipt whose canvasId matches, or an explicit local canvas deletion.
 * Generation bump, tombstone and the removal of all scope drafts/markers share one transaction,
 * so a late write from an older session can never resurrect the canvas.
 */
confirmDeletion: async (scopeId, expectedDeletionGeneration, now, signal) => {
    /** A tombstone timestamp must be canonical, so refuse an instant Date cannot represent. */
    if (!isRecoveryCount(expectedDeletionGeneration) || !Number.isFinite(now) || Math.abs(now) > MAX_TIME_VALUE_MS) return CORRUPT;
    const run = await database.run("readwrite", [EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE], RECOVERY_TRANSACTION_TIMEOUT_MS, async (txn): Promise<CanvasDeletionOutcome> => {
        const epochRead = await readEpoch(txn, scopeId);
        if (epochRead.status === "corrupt") return { status: "unavailable", reason: "corrupt" };
        const epoch = epochRead.epoch;
        /** A present tombstone alone is proof the deletion already happened, whatever the caller expected. */
        if (epoch.tombstonedAt) return { status: "already-tombstoned" };
        /**
         * Only this operation advances the generation, and it always writes the tombstone in the same
         * transaction, so a mismatch WITHOUT a tombstone is impossible under valid state. Fail closed
         * instead of deleting data on an unexplained generation.
         */
        if (epoch.deletionGeneration !== expectedDeletionGeneration) return CORRUPT;
        const next = nextEpoch(epoch, {
            coordinationRevision: epoch.coordinationRevision + 1,
            deletionGeneration: epoch.deletionGeneration + 1,
            /** Retained long term: this canvas id is never restored in the first version. */
            tombstonedAt: new Date(now).toISOString(),
        });
        if (!next) return CORRUPT;
        /**
         * Enumerate BOTH stores by SCOPE_INDEX and delete every key, including corrupt rows and a
         * marker parked under a noncanonical markerId, so no durable residue outlives the confirmed
         * deletion. Exact equality needs no ambient IDBKeyRange constructor.
         */
        for (const name of [DRAFTS_STORE, MARKERS_STORE] as const) {
            const keys = await txn.req(txn.store(name).index(SCOPE_INDEX).getAllKeys(scopeId));
            for (const key of keys) await txn.req(txn.store(name).delete(key));
        }
        await txn.req(txn.store(EPOCHS_STORE).put(next));
        return { status: "tombstoned", deletionGeneration: next.deletionGeneration };
    }, signal);
    return run.status === "ok" ? run.value : { status: "unavailable", reason: run.reason };
},

/** GC is a coordination step: it re-verifies age, marker references and epoch inside the deleting transaction. */
collectGarbage: async (input, signal) => {
    if (!isRecoveryCount(input.expectedCoordinationRevision) || !isRecoveryCount(input.expectedDeletionGeneration)) return CORRUPT;
    /** Age arithmetic decides what is destroyed, so both operands must be real and nonnegative. */
    if (!isElapsedMs(input.now) || !isElapsedMs(input.minAgeMs)) return CORRUPT;
    /** Snapshotted before the first await: a later mutation of the caller's array cannot widen GC. */
    const keepDraftIds = detach(input.keepDraftIds);
    if (!keepDraftIds || !keepDraftIds.every(isDraftId)) return CORRUPT;
    const run = await database.run("readwrite", [EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE], RECOVERY_TRANSACTION_TIMEOUT_MS, async (txn): Promise<CanvasCoordinationOutcome> => {
        const epochRead = await readEpoch(txn, input.scopeId);
        if (epochRead.status === "corrupt") return { status: "unavailable", reason: "corrupt" };
        const epoch = epochRead.epoch;
        if (epoch.tombstonedAt) return { status: "tombstoned" };
        if (epoch.coordinationRevision !== input.expectedCoordinationRevision || epoch.deletionGeneration !== input.expectedDeletionGeneration) {
            return { status: "stale", coordinationRevision: epoch.coordinationRevision, deletionGeneration: epoch.deletionGeneration };
        }
        const next = nextEpoch(epoch, { coordinationRevision: epoch.coordinationRevision + 1 });
        if (!next) return CORRUPT;
        const markerRaw = await txn.req(txn.store(MARKERS_STORE).get([input.scopeId, CONFLICT_MARKER_ID]));
        const marker = asMarkerRecord(markerRaw, input.scopeId);
        if (markerRaw !== undefined && !marker) return { status: "unavailable", reason: "corrupt" };
        /** Re-read marker references here: a draft another tab just published must not be collected. */
        const keep = new Set([...keepDraftIds, ...(marker ? marker.entries.map((entry) => entry.draftId) : [])]);
        for (const draft of await readScopeDrafts(txn, input.scopeId)) {
            if (keep.has(draft.draftId)) continue;
            const savedAt = Date.parse(draft.savedAt);
            if (!Number.isFinite(savedAt) || input.now - savedAt <= input.minAgeMs) continue;
            await txn.req(txn.store(DRAFTS_STORE).delete([input.scopeId, draft.draftId]));
        }
        await txn.req(txn.store(EPOCHS_STORE).put(next));
        return { status: "committed", coordinationRevision: next.coordinationRevision };
    }, signal);
    return run.status === "ok" ? run.value : { status: "unavailable", reason: run.reason };
},
```

Also add the three members to the `CanvasRecoveryStore` type:

```ts
export type CanvasRecoveryStore = {
    readOpenSnapshot(scopeId: RecoveryScopeId, signal?: AbortSignal): Promise<CanvasRecoveryOpenResult>;
    upsertDraft(input: CanvasDraftUpsertInput, signal?: AbortSignal): Promise<CanvasDraftWriteOutcome>;
    commitCoordination(input: CanvasCoordinationInput, signal?: AbortSignal): Promise<CanvasCoordinationOutcome>;
    confirmDeletion(scopeId: RecoveryScopeId, expectedDeletionGeneration: number, now: number, signal?: AbortSignal): Promise<CanvasDeletionOutcome>;
    collectGarbage(input: CanvasGarbageInput, signal?: AbortSignal): Promise<CanvasCoordinationOutcome>;
    close(): void;
};
```

Add the lazy browser adapter after `createCanvasRecoveryStore`. The default parameter is a function, so `globalThis.indexedDB` is not read during module evaluation:

```ts
/**
 * Safe to construct and import in Node. The ambient factory is read only on the first real
 * operation. Missing IndexedDB is a controlled unavailable outcome, never a ReferenceError.
 */
export function createLazyBrowserRecoveryStore(getFactory: () => IDBFactory | undefined = () => globalThis.indexedDB): CanvasRecoveryStore {
    let store: CanvasRecoveryStore | null = null;
    const get = () => {
        if (store) return store;
        const factory = getFactory();
        if (!factory) return null;
        store = createCanvasRecoveryStore(createRecoveryDatabase(factory));
        return store;
    };
    const unsupported = () => Promise.resolve({ status: "unavailable", reason: "unsupported" } as const);
    return {
        readOpenSnapshot: (scopeId, signal) => get()?.readOpenSnapshot(scopeId, signal) ?? unsupported(),
        upsertDraft: (input, signal) => get()?.upsertDraft(input, signal) ?? unsupported(),
        commitCoordination: (input, signal) => get()?.commitCoordination(input, signal) ?? unsupported(),
        confirmDeletion: (scopeId, generation, now, signal) => get()?.confirmDeletion(scopeId, generation, now, signal) ?? unsupported(),
        collectGarbage: (input, signal) => get()?.collectGarbage(input, signal) ?? unsupported(),
        close: () => store?.close(),
    };
}

/** Exporting this value remains side-effect free; only calling one operation consults the browser global. */
export const browserCanvasRecoveryStore = createLazyBrowserRecoveryStore();
```

- [ ] **Step 4: Run until green**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/store-coordination.test.ts` — expected: 11 passed.

Fake-green check: temporarily make `confirmDeletion` write the tombstone but skip the draft deletion loop, and rerun. "confirms deletion in one transaction" must fail on the empty-drafts assertion. Restore the loop.

Then temporarily move the marker write before corrupt delete-target validation. "fails a coordination delete atomically" must fail because the marker disappears despite an unavailable outcome. Restore the validate-all-before-first-write order.

- [ ] **Step 5: Write the failing legacy-upgrade tests**

Create `web/src/services/canvas-recovery/bootstrap.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { upgradeRecoveryStorage } from "./bootstrap";

const makeStorage = (initial: [string, string][] = []) => {
    const bag = new Map<string, string>(initial);
    return { getItem: (k: string) => bag.get(k) ?? null, setItem: (k: string, v: string) => void bag.set(k, v), bag };
};

describe("explicit legacy recovery upgrade", () => {
    it("drops the legacy store once and records that it ran", async () => {
        const storage = makeStorage();
        const dropLegacy = vi.fn(async () => undefined);
        expect(await upgradeRecoveryStorage({ storage, dropLegacy })).toBe("upgraded");
        expect(dropLegacy).toHaveBeenCalledTimes(1);
        expect(await upgradeRecoveryStorage({ storage, dropLegacy })).toBe("already-upgraded");
        // Never a second drop: the upgrade is an explicit one-time action.
        expect(dropLegacy).toHaveBeenCalledTimes(1);

        /**
         * A storage that refuses reads (disabled cookies, private mode, quota policy) is contained in
         * the declared union. Nothing is dropped, because an unreadable flag cannot prove the state.
         */
        const unreadable = {
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => undefined,
        };
        const untouched = vi.fn(async () => undefined);
        expect(await upgradeRecoveryStorage({ storage: unreadable, dropLegacy: untouched })).toBe("failed");
        expect(untouched).not.toHaveBeenCalled();
    });

    it("does not record success when the drop fails, so it can be retried", async () => {
        const storage = makeStorage();
        const dropLegacy = vi.fn(async () => {
            throw new Error("blocked");
        });
        expect(await upgradeRecoveryStorage({ storage, dropLegacy })).toBe("failed");
        expect(storage.getItem("canvas-recovery-upgrade")).toBeNull();

        /**
         * A successful drop whose receipt cannot be persisted is still "failed" and still retryable,
         * so the next explicit run drops again. dropLegacy MUST therefore be idempotent: dropping an
         * already-absent legacy store has to succeed rather than throw.
         */
        const unwritable = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
        const dropped = vi.fn(async () => undefined);
        expect(await upgradeRecoveryStorage({ storage: unwritable, dropLegacy: dropped })).toBe("failed");
        expect(dropped).toHaveBeenCalledTimes(1);
        expect(await upgradeRecoveryStorage({ storage: unwritable, dropLegacy: dropped })).toBe("failed");
        expect(dropped).toHaveBeenCalledTimes(2);
    });

    it("never reads legacy data: the upgrade only drops", async () => {
        const storage = makeStorage();
        const dropLegacy = vi.fn(async () => undefined);
        await upgradeRecoveryStorage({ storage, dropLegacy });
        // The module exposes no legacy read path at all.
        const moduleExports = await import("./bootstrap");
        expect(Object.keys(moduleExports).sort()).toEqual(["upgradeRecoveryStorage"]);
    });
});
```

- [ ] **Step 6: Run and confirm failure**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery/bootstrap.test.ts`
Expected: FAIL, cannot resolve `./bootstrap`.

- [ ] **Step 7: Implement bootstrap.ts**

```ts
const UPGRADE_KEY = "canvas-recovery-upgrade";
const UPGRADE_VALUE = "native-idb-v1";

export type LegacyUpgradeOutcome = "upgraded" | "already-upgraded" | "failed";

/**
 * The one explicit upgrade action. It only DROPS the legacy localforage store; it never reads it,
 * never uploads it and never runs at module import. The project is unreleased, so no legacy data
 * is migrated: a user who wants old test drafts must export them before upgrading.
 * Called once from the app entry point, never from the recovery store.
 *
 * Every failure mode stays inside the declared union, including a storage that throws on read or
 * write. Because a dropped store whose receipt could not be persisted reports "failed" and will be
 * retried, `dropLegacy` MUST be idempotent: dropping an absent legacy store has to resolve, not throw.
 */
export async function upgradeRecoveryStorage(deps: { storage: Pick<Storage, "getItem" | "setItem">; dropLegacy: () => Promise<void> }): Promise<LegacyUpgradeOutcome> {
    let recorded: string | null;
    try {
        recorded = deps.storage.getItem(UPGRADE_KEY);
    } catch {
        /** An unreadable flag cannot prove the upgrade state, so nothing is dropped. */
        return "failed";
    }
    if (recorded === UPGRADE_VALUE) return "already-upgraded";
    try {
        await deps.dropLegacy();
    } catch {
        /** Not recorded: a failed drop must remain retryable on the next explicit run. */
        return "failed";
    }
    try {
        deps.storage.setItem(UPGRADE_KEY, UPGRADE_VALUE);
    } catch {
        /** The drop succeeded but is unproven; report failure so the idempotent drop runs again. */
        return "failed";
    }
    return "upgraded";
}
```

- [ ] **Step 8: Run the whole recovery suite until green**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-recovery`
Expected: 6 files, 43 passed (database 7, scope 5, types 5, store-draft 12, store-coordination 11, bootstrap 3).

- [ ] **Step 9: Commit**

```bash
git add web/src/services/canvas-recovery/store.ts web/src/services/canvas-recovery/store-coordination.test.ts web/src/services/canvas-recovery/bootstrap.ts web/src/services/canvas-recovery/bootstrap.test.ts
git commit -m "feat: add coordination CAS, deletion tombstone CAS, scoped GC and explicit legacy upgrade"
```

---

## Task 5: Deletion Receipt Contract And The Negative Proof Matrix

**Files:**
- Modify: `web/src/services/api/canvases.ts` (`deleteCanvas` returns the receipt)
- Modify: `web/src/services/canvas-repository.ts` (classify the DELETE result)
- Modify: `web/src/services/canvas-sync/types.ts` (add `CanvasDeleteOutcome`, change `CanvasSyncRepository.remove`)
- Modify: `web/src/services/canvas-sync/canvas-sync-manager.ts` (consume the outcome in `deleteCanvases`)
- Create: `web/src/services/canvas-repository.test.ts`
- Create: `web/src/services/canvas-sync/canvas-sync-manager.test.ts` (one proof-gate test; Task 6 replaces it with the full CAS manager suite)

**Interfaces:**
- Consumes: `CanvasDeletionReceipt` from `@infinite-canvas/contracts` (already defined server-side; not modified here).
- Produces:

```ts
// canvas-sync/types.ts
export type CanvasDeleteIndeterminateReason = "network" | "timeout" | "invalid-response" | "mismatched-receipt" | "unknown";
/**
 * The ONLY positive proof of deletion is `deleted`, and only when receipt.canvasId matches the requested id.
 * `denied` and `indeterminate` must never be treated as proof.
 */
export type CanvasDeleteOutcome =
    | { status: "deleted"; receipt: CanvasDeletionReceipt }
    | { status: "denied"; code: string; messageKey: string }
    | { status: "indeterminate"; reason: CanvasDeleteIndeterminateReason; messageKey: string };

// CanvasSyncRepository (changed member)
remove(workspaceId: string, canvasId: string): Promise<CanvasDeleteOutcome>;

// canvas-repository.ts
export function classifyCanvasDeleteError(error: unknown): Extract<CanvasDeleteOutcome, { status: "denied" | "indeterminate" }>;

// api/canvases.ts (changed signature)
export async function deleteCanvas(workspaceId: string, canvasId: string): Promise<CanvasDeletionReceipt>;
```

- [ ] **Step 1: Write the failing negative-matrix tests**

Create `web/src/services/canvas-repository.test.ts`. Every row of the matrix is asserted, because "we accidentally treated a 404 as proof" is exactly how a user's unsynced draft gets destroyed.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { canvasRepository } from "./canvas-repository";

const RECEIPT = { canvasId: "canvas-1", deletionReceipt: "11111111-1111-4111-8111-111111111111", deletedAt: "2020-01-01T00:00:00.000Z" };

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const errorResponse = (code: string, status: number) => jsonResponse({ error: { code, message: "", retryable: false, requestId: "r" } }, status);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("canvas delete receipt classification", () => {
    it("accepts a matching receipt as the only positive proof", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(RECEIPT)));
        expect(await canvasRepository.remove("w1", "canvas-1")).toEqual({ status: "deleted", receipt: RECEIPT });
    });

    it("accepts an idempotent replay of the same receipt", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(RECEIPT)));
        expect(await canvasRepository.remove("w1", "canvas-1")).toEqual({ status: "deleted", receipt: RECEIPT });
        expect(await canvasRepository.remove("w1", "canvas-1")).toEqual({ status: "deleted", receipt: RECEIPT });
    });

    it("refuses a receipt for a different canvas", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...RECEIPT, canvasId: "canvas-2" })));
        const result = await canvasRepository.remove("w1", "canvas-1");
        expect(result).toEqual({ status: "indeterminate", reason: "mismatched-receipt", messageKey: "canvas.delete.unconfirmed" });
    });

    it("refuses a success body that is missing the receipt fields", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: true })));
        expect(await canvasRepository.remove("w1", "canvas-1")).toEqual({ status: "indeterminate", reason: "invalid-response", messageKey: "canvas.delete.unconfirmed" });
    });

    it("never treats a plain 404 as deletion proof", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => errorResponse("canvas_not_found", 404)));
        expect(await canvasRepository.remove("w1", "canvas-1")).toEqual({ status: "denied", code: "canvas_not_found", messageKey: "canvas.delete.unavailable" });
    });

    it("never treats forbidden, non-active workspace or removed membership as proof", async () => {
        for (const [code, status] of [
            ["workspace_forbidden", 403],
            ["platform_forbidden", 403],
            ["workspace_not_active", 409],
            ["platform_unauthorized", 401],
        ] as const) {
            vi.stubGlobal("fetch", vi.fn(async () => errorResponse(code, status)));
            expect(await canvasRepository.remove("w1", "canvas-1")).toEqual({ status: "denied", code, messageKey: "canvas.delete.unavailable" });
        }
    });

    it("never treats a network failure as proof", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new TypeError("offline");
        }));
        expect(await canvasRepository.remove("w1", "canvas-1")).toEqual({ status: "indeterminate", reason: "network", messageKey: "canvas.delete.unconfirmed" });
    });

    it("never treats a timeout as proof", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
        const pending = canvasRepository.remove("w1", "canvas-1");
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await pending).toEqual({ status: "indeterminate", reason: "timeout", messageKey: "canvas.delete.unconfirmed" });
    });

    it("never treats a server error or unknown failure as proof", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => errorResponse("internal_error", 500)));
        expect(await canvasRepository.remove("w1", "canvas-1")).toEqual({ status: "indeterminate", reason: "unknown", messageKey: "canvas.delete.unconfirmed" });
    });
});
```

- [ ] **Step 2: Write the failing manager proof-gate test**

Create `web/src/services/canvas-sync/canvas-sync-manager.test.ts` with the smallest test that exercises Task 5's manager change while the legacy recovery interface is still active:

```ts
import { describe, expect, it, vi } from "vitest";

import { createCanvasSyncManager } from "./canvas-sync-manager";

describe("manager deletion proof gate", () => {
    it("does not classify a fulfilled denied outcome as deletion", async () => {
        const remove = vi.fn(async () => ({ status: "denied", code: "canvas_not_found", messageKey: "canvas.delete.unavailable" }) as const);
        const settled = Promise.resolve();
        const manager = createCanvasSyncManager({
            repository: { remove } as never,
            recovery: {
                listCanvasDrafts: async () => [],
                deleteMarker: () => ({ result: Promise.resolve(), settled }),
            } as never,
            now: () => 1_000,
            createDraftId: () => "draft-1",
            isDev: false,
        });
        manager.setScope({ userId: "u1", workspaceId: "w1" });

        expect(await manager.deleteCanvases(["c1"])).toEqual({ deleted: [], failed: ["c1"] });
        expect(remove).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-repository.test.ts src/services/canvas-sync/canvas-sync-manager.test.ts`
Expected RED: repository assertions receive `undefined` from `remove`, and the manager reports the fulfilled denied outcome in `deleted` because it still uses `Promise.allSettled` fulfillment as proof.

- [ ] **Step 4: Return the receipt from the HTTP layer**

In `web/src/services/api/canvases.ts` replace the `deleteCanvas` function and drop the now-unused `SuccessResponse` import:

```ts
/** DELETE responds with the existing durable receipt itself, not a success envelope. */
export async function deleteCanvas(workspaceId: string, canvasId: string): Promise<CanvasDeletionReceipt> {
    return platformRequest<CanvasDeletionReceipt>(canvasPath(workspaceId, canvasId), { method: "DELETE" });
}
```

Add `CanvasDeletionReceipt` to the type import from `@infinite-canvas/contracts`.

- [ ] **Step 5: Add the outcome type and change the repository interface**

In `web/src/services/canvas-sync/types.ts` add the import `import type { CanvasDeletionReceipt, CanvasSnapshot } from "@infinite-canvas/contracts";` and add:

```ts
export type CanvasDeleteIndeterminateReason = "network" | "timeout" | "invalid-response" | "mismatched-receipt" | "unknown";

/**
 * The only positive proof of deletion is `deleted` with a receipt whose canvasId matches the request.
 * `denied` (404 / forbidden / non-active workspace / removed member) and `indeterminate`
 * (network, timeout, malformed body, mismatched receipt, unknown) are NEVER proof:
 * local drafts are kept and the canvas is shown as controlled-unavailable.
 */
export type CanvasDeleteOutcome =
    | { status: "deleted"; receipt: CanvasDeletionReceipt }
    | { status: "denied"; code: string; messageKey: string }
    | { status: "indeterminate"; reason: CanvasDeleteIndeterminateReason; messageKey: string };
```

and change the `CanvasSyncRepository` member from `remove(workspaceId: string, canvasId: string): Promise<void>;` to:

```ts
    /** Never throws for a denied or indeterminate result: the caller must be forced to read the status. */
    remove(workspaceId: string, canvasId: string): Promise<CanvasDeleteOutcome>;
```

- [ ] **Step 6: Classify the DELETE result in the repository**

In `web/src/services/canvas-repository.ts` add the classifier and replace `remove`:

```ts
const DELETE_UNAVAILABLE_KEY = "canvas.delete.unavailable";
const DELETE_UNCONFIRMED_KEY = "canvas.delete.unconfirmed";

function isReceipt(value: unknown, canvasId: string): value is CanvasDeletionReceipt {
    if (!value || typeof value !== "object") return false;
    const { canvasId: id, deletionReceipt, deletedAt } = value as Record<string, unknown>;
    if (typeof deletionReceipt !== "string" || !deletionReceipt || typeof deletedAt !== "string" || !deletedAt) return false;
    /** A receipt for another canvas is not proof for this one. */
    return id === canvasId;
}

/**
 * A denied response means the server refused to tell us anything about this canvas;
 * an indeterminate response means we do not know whether the delete happened.
 * Neither may be upgraded to proof, so neither is thrown away as a generic failure.
 */
export function classifyCanvasDeleteError(error: unknown): Extract<CanvasDeleteOutcome, { status: "denied" | "indeterminate" }> {
    if (error instanceof CanvasRequestTimeoutError) return { status: "indeterminate", reason: "timeout", messageKey: DELETE_UNCONFIRMED_KEY };
    if (error instanceof PlatformApiError) {
        if (error.code === NETWORK_ERROR_CODE) return { status: "indeterminate", reason: "network", messageKey: DELETE_UNCONFIRMED_KEY };
        /** 401/403/404/409 are authoritative refusals to act, not confirmations of deletion. */
        if (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409) return { status: "denied", code: error.code, messageKey: DELETE_UNAVAILABLE_KEY };
    }
    return { status: "indeterminate", reason: "unknown", messageKey: DELETE_UNCONFIRMED_KEY };
}

// inside canvasRepository:
    remove: async (workspaceId, canvasId) => {
        try {
            const receipt = await withReadTimeout(deleteCanvas(workspaceId, canvasId));
            if (!isReceipt(receipt, canvasId)) {
                const reason = receipt && typeof receipt === "object" && "canvasId" in receipt ? "mismatched-receipt" : "invalid-response";
                return { status: "indeterminate", reason, messageKey: DELETE_UNCONFIRMED_KEY };
            }
            return { status: "deleted", receipt };
        } catch (error) {
            return classifyCanvasDeleteError(error);
        }
    },
```

Add `type CanvasDeleteOutcome` to the `@/services/canvas-sync/types` import and `type CanvasDeletionReceipt` to the `@infinite-canvas/contracts` import.

- [ ] **Step 7: Make the manager act only on proof**

In `web/src/services/canvas-sync/canvas-sync-manager.ts`, inside `deleteCanvases`, replace the `Promise.allSettled` block that treated any fulfilled promise as a deletion:

```ts
        const outcomes = await Promise.all(canvasIds.map((canvasId) => deps.repository.remove(current.workspaceId, canvasId)));
        /** Only a matching positive receipt counts. Denied and indeterminate keep their local drafts. */
        const deleted = canvasIds.filter((_id, index) => outcomes[index].status === "deleted");
        const failed = canvasIds.filter((canvasId) => !deleted.includes(canvasId));
```

This intermediate commit changes no other manager branch: an active target is held before DELETE; a `deleted` result clears the active owner, disposes it with `"deleted"`, and schedules the legacy `runDeletedCanvasCleanup`; every non-`deleted` result calls `releaseHold` and preserves the session. Native tombstoning begins only in Task 6. Thus Task 5 strictly narrows deletion belief while remaining deployable on the legacy persistence implementation.

- [ ] **Step 8: Run until green**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-repository.test.ts src/services/canvas-sync/canvas-sync-manager.test.ts` — expected: repository 9 passed, manager 1 passed.

Fake-green checks: temporarily make `isReceipt` ignore the `id === canvasId` comparison; "refuses a receipt for a different canvas" must fail. Then restore it and temporarily change the manager back to fulfilled-means-deleted; the manager proof-gate test must fail. Restore both proof gates before committing.

- [ ] **Step 9: Commit**

```bash
git add web/src/services/api/canvases.ts web/src/services/canvas-repository.ts web/src/services/canvas-repository.test.ts web/src/services/canvas-sync/types.ts web/src/services/canvas-sync/canvas-sync-manager.ts web/src/services/canvas-sync/canvas-sync-manager.test.ts
git commit -m "feat: require a matching canvas deletion receipt before believing a delete"
```

---

## Task 6: Switch Session And Manager Onto Transactional CAS

This is the one commit where the production persistence protocol changes. It removes the late-write compensation path entirely, because an aborted transaction leaves nothing to compensate for.

**Files:**
- Modify: `web/src/services/canvas-sync/types.ts` (delete `CanvasLocalWrite`, `CanvasLocalRecovery`, `CanvasDraftScope`, `whenLocalSettled`; split patch fields; add recovery view fields)
- Modify: `web/src/services/canvas-sync/canvas-sync-session.ts` (resolution constructor, `writeSeq`, CAS outcomes, no `settled` tracking)
- Modify: `web/src/services/canvas-sync/canvas-sync-manager.ts` (scope ids, coordination commits, deletion CAS, GC)
- Create: `web/src/services/canvas-sync/canvas-sync-session.test.ts`
- Modify: `web/src/services/canvas-sync/canvas-sync-manager.test.ts` (replace Task 5's one legacy proof-gate test with the full CAS manager suite, retaining its denied-outcome assertion in the negative matrix)

**Interfaces:**
- Consumes: the full `CanvasRecoveryStore` (Tasks 3-4), `buildRecoveryScopeId` / `readInstallationId` (Task 2), `CanvasDeleteOutcome` (Task 5).
- Produces:

```ts
// canvas-sync/types.ts — replacements
export { MAX_CONFLICT_MARKER_ENTRIES } from "@/services/canvas-recovery/types";
/** Document edits: these advance editSeq and schedule a cloud save. */
export const CANVAS_DOCUMENT_PATCH_FIELDS = ["nodes", "connections", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo"] as const;
/** Local UI only: pan/zoom. Persisted in the draft envelope, never sent to the cloud, never edits. */
export const CANVAS_LOCAL_PATCH_FIELDS = ["viewport"] as const;
export const MAX_COORDINATION_ATTEMPTS = 2;
export type CanvasProjectPatch = Partial<Pick<CanvasProject, (typeof CANVAS_DOCUMENT_PATCH_FIELDS)[number] | (typeof CANVAS_LOCAL_PATCH_FIELDS)[number]>>;

export type CanvasLocalPersistState = "ok" | "degraded" | "tombstoned";
/** Added to CanvasSyncView so the page can render controlled-unavailable without inferring it. */
export type CanvasSyncView = {
    canvasId: string;
    scope: CanvasScope;
    title: string;
    revision: number;
    phase: CanvasSyncPhase;
    hasUnsavedEdits: boolean;
    savedOnce: boolean;
    saveError: CanvasSyncSaveError | null;
    localPersist: CanvasLocalPersistState;
    conflict: CanvasSyncConflictView | null;
    unavailableKey: string | null;
};

export type CanvasRecoveryRepair =
    | { kind: "write-marker"; entries: CanvasConflictMarkerEntry[] }
    | { kind: "delete-marker" }
    | { kind: "delete-drafts"; draftIds: string[] };

export type CanvasSessionDeps = {
    repository: CanvasSyncRepository;
    recovery: CanvasRecoveryStore;
    now: () => number;
    createDraftId: () => string;
    isDev: boolean;
};

// canvas-sync-session.ts
export type CanvasRecoveryResolution = {
    phase: "clean" | "dirty" | "conflict" | "recovery-blocked" | "tombstoned";
    content: CanvasProject;
    revision: number;
    draftId: string;
    conflict: CanvasSyncConflictView | null;
    /** Always present, produced only by the constructors below. */
    repairs: CanvasRecoveryRepair[];
    /** The epoch values this resolution was computed against; every repair commits with them. */
    expectedCoordinationRevision: number;
    expectedDeletionGeneration: number;
    /** Highest writeSeq already stored for draftId, so this session continues the sequence. */
    baseWriteSeq: number;
    /**
     * Canonical shared/default viewport. Live pan/zoom never mutates it; document serialization
     * always substitutes this value until a future explicit set-default document action exists.
     */
    documentDefaultViewport: ViewportTransform;
};
export type CanvasSessionInit = {
    sessionId: number;
    scope: CanvasScope;
    scopeToken: number;
    openToken: number;
    canvasId: string;
    /** Trusted and constructed by the manager; every session operation remains inside it. */
    scopeId: RecoveryScopeId;
    resolution: CanvasRecoveryResolution;
};
export function cleanResolution(load: CanvasLoadResult, draftId: string, epoch: { coordinationRevision: number; deletionGeneration: number }): CanvasRecoveryResolution;
export function serverCopyResolution(load: CanvasLoadResult, draftId: string, epoch: { coordinationRevision: number; deletionGeneration: number }): CanvasRecoveryResolution;
export function resolveCanvasOpenRecovery(deps: Pick<CanvasSessionDeps, "recovery" | "createDraftId">, scopeId: RecoveryScopeId, load: CanvasLoadResult): Promise<CanvasRecoveryResolution>;
```

- [ ] **Step 1: Write the failing session tests**

Create `web/src/services/canvas-sync/canvas-sync-session.test.ts`. The fake repository is deliberately explicit so each test controls acks, conflicts and failures.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { PlatformApiError } from "../api/platform-client";
import { createRecoveryDatabase } from "../canvas-recovery/database";
import { buildRecoveryScopeId } from "../canvas-recovery/scope";
import { createCanvasRecoveryStore, type CanvasRecoveryStore } from "../canvas-recovery/store";
import { cleanResolution, createCanvasSyncSession, resolveCanvasOpenRecovery, serverCopyResolution } from "./canvas-sync-session";
import { LOCAL_COALESCE_MS, type CanvasLoadResult, type CanvasSyncRepository } from "./types";
import type { CanvasProject } from "@/types/canvas";

const scopeId = buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })!;
const scope = { userId: "u1", workspaceId: "w1" };

const project = (revision: number): CanvasProject => ({
    id: "c1",
    title: "T" + revision,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "dots",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
}) as unknown as CanvasProject;

const load = (revision: number): CanvasLoadResult => ({ project: project(revision), revision });

function fakeRepository(overrides: Partial<CanvasSyncRepository> = {}): CanvasSyncRepository {
    return {
        list: async () => [],
        load: async () => load(1),
        create: async () => load(1),
        importProject: async () => load(1),
        save: async (_w, _c, input) => ({ project: { ...project(input.baseRevision + 1), title: input.title }, revision: input.baseRevision + 1 }),
        remove: async () => ({ status: "deleted", receipt: { canvasId: "c1", deletionReceipt: "r", deletedAt: "2020-01-01T00:00:00.000Z" } }),
        ...overrides,
    };
}

describe("session on transactional recovery", () => {
    let store: CanvasRecoveryStore;
    let deps: { repository: CanvasSyncRepository; recovery: CanvasRecoveryStore; now: () => number; createDraftId: () => string; isDev: boolean };

    beforeEach(() => {
        store = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
        deps = { repository: fakeRepository(), recovery: store, now: () => 1_000, createDraftId: () => "draft-1", isDev: false };
    });

    it("always carries repairs, including on the clean and server-copy paths", () => {
        const epoch = { coordinationRevision: 0, deletionGeneration: 0 };
        expect(cleanResolution(load(1), "draft-1", epoch).repairs).toEqual([]);
        // The historic server-copy bug was a missing repairs field; the constructor makes that impossible.
        expect(serverCopyResolution(load(1), "draft-1", epoch).repairs).toEqual([]);
        expect(serverCopyResolution(load(1), "draft-1", epoch)).toHaveProperty("expectedCoordinationRevision", 0);
    });

    it("advances writeSeq per draft across coalesced local writes", async () => {
        const resolution = cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 });
        const session = createCanvasSyncSession({ sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution }, deps);
        session.install(project(1));
        session.update({ nodes: [{ id: "n1" }] as never });
        await session.flush();
        session.update({ nodes: [{ id: "n2" }] as never });
        await session.flush();

        const snapshot = await store.readOpenSnapshot(scopeId);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        expect(snapshot.snapshot.drafts).toHaveLength(1);
        expect(snapshot.snapshot.drafts[0].writeSeq).toBeGreaterThan(1);
        // Private writes must not consume coordination revisions.
        expect(snapshot.snapshot.epoch.coordinationRevision).toBe(0);
        await session.dispose("replaced");
    });

    it("treats pan and zoom as local UI: no edit, no cloud save, but persisted in the envelope", async () => {
        const save = vi.fn(async (_w: string, _c: string, input: { baseRevision: number; title: string }) => ({ project: project(input.baseRevision + 1), revision: input.baseRevision + 1 }));
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }) },
            { ...deps, repository: fakeRepository({ save: save as never }) },
        );
        session.install(project(1));
        expect(session.update({ viewport: { x: 120, y: -40, k: 2 } })).toBe(false);
        expect(session.update({ viewport: { x: 240, y: -80, k: 3 } })).toBe(false);
        await session.flush();
        expect(save).not.toHaveBeenCalled();
        expect(session.view.hasUnsavedEdits).toBe(false);

        const snapshot = await store.readOpenSnapshot(scopeId);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        expect(snapshot.snapshot.drafts[0].envelope.localUi.viewport).toEqual({ x: 240, y: -80, k: 3 });
        expect(snapshot.snapshot.drafts[0].state).toBe("synced");
        await session.dispose("replaced");
    });

    it("keeps the opened document default viewport in a cloud save after live panning", async () => {
        const save = vi.fn(async (_w: string, _c: string, input: { baseRevision: number; title: string; snapshot: { viewport: unknown } }) => ({ project: project(input.baseRevision + 1), revision: input.baseRevision + 1 }));
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }) },
            { ...deps, repository: fakeRepository({ save: save as never }) },
        );
        session.install(project(1));
        expect(session.update({ viewport: { x: 90, y: 45, k: 2 } })).toBe(false);
        expect(session.update({ nodes: [{ id: "edited" }] as never })).toBe(true);
        await session.flush();

        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][2].snapshot.viewport).toEqual({ x: 0, y: 0, k: 1 });
        const opened = await store.readOpenSnapshot(scopeId);
        if (opened.status !== "ok") throw new Error("expected ok");
        expect(opened.snapshot.drafts[0].envelope.document.snapshot.viewport).toEqual({ x: 0, y: 0, k: 1 });
        expect(opened.snapshot.drafts[0].envelope.localUi.viewport).toEqual({ x: 90, y: 45, k: 2 });
        await session.dispose("replaced");
    });

    it("re-resolves instead of forcing a repair whose epoch went stale", async () => {
        // Another tab publishes a conflicting draft and advances coordinationRevision.
        await store.upsertDraft({
            scopeId,
            draftId: "foreign",
            writeSeq: 1,
            expectedDeletionGeneration: 0,
            state: "pending",
            envelope: { document: { title: "foreign", baseRevision: 1, snapshot: { nodes: [], connections: [] } as never }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} },
            savedAt: new Date(0).toISOString(),
        });
        const first = await resolveCanvasOpenRecovery(deps, scopeId, load(2));
        // Someone else commits coordination between resolve and install.
        await store.commitCoordination({ scopeId, expectedCoordinationRevision: first.expectedCoordinationRevision, expectedDeletionGeneration: 0, marker: [{ draftId: "foreign", baseRevision: 1, savedAt: new Date(0).toISOString() }] });

        const session = createCanvasSyncSession({ sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: first }, deps);
        session.install(first.content);
        await session.flush();
        // The stale repair must not have clobbered the newer marker.
        const snapshot = await store.readOpenSnapshot(scopeId);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        expect(snapshot.snapshot.marker?.entries.some((entry) => entry.draftId === "foreign")).toBe(true);
        await session.dispose("replaced");
    });

    it("stops writing and reports tombstoned when the scope was deleted under it", async () => {
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }) },
            deps,
        );
        session.install(project(1));
        await store.confirmDeletion(scopeId, 0, 1_000);
        session.update({ nodes: [{ id: "late" }] as never });
        await session.flush();

        expect(session.view.localPersist).toBe("tombstoned");
        expect(await store.readOpenSnapshot(scopeId)).toEqual({ status: "tombstoned", deletionGeneration: 1 });
        await session.dispose("replaced");
    });

    it("merges two live-409 markers by stale re-read and exports one consistent two-draft snapshot without mutation", async () => {
        const save = vi.fn(async () => {
            throw new PlatformApiError("revision_conflict", 409);
        });
        const conflictDeps = { ...deps, repository: fakeRepository({ save }) };
        const first = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(1), "draft-a", { coordinationRevision: 0, deletionGeneration: 0 }) },
            conflictDeps,
        );
        first.install(project(1));
        first.update({ nodes: [{ id: "a" }] as never });
        await first.flush();

        let injected = false;
        const racing = {
            ...store,
            commitCoordination: vi.fn(async (input, signal) => {
                if (!injected && input.marker?.some((entry) => entry.draftId === "draft-b")) {
                    injected = true;
                    const current = await store.readOpenSnapshot(scopeId);
                    if (current.status !== "ok") throw new Error("expected ok");
                    await store.commitCoordination({
                        scopeId,
                        expectedCoordinationRevision: current.snapshot.epoch.coordinationRevision,
                        expectedDeletionGeneration: current.snapshot.epoch.deletionGeneration,
                        marker: current.snapshot.marker?.entries ?? null,
                    });
                }
                return store.commitCoordination(input, signal);
            }),
        } satisfies CanvasRecoveryStore;
        const second = createCanvasSyncSession(
            { sessionId: 2, scope, scopeToken: 1, openToken: 2, canvasId: "c1", scopeId, resolution: cleanResolution(load(1), "draft-b", { coordinationRevision: 0, deletionGeneration: 0 }) },
            { ...conflictDeps, recovery: racing },
        );
        second.install(project(1));
        second.update({ nodes: [{ id: "b" }] as never });
        await second.flush();

        const before = await store.readOpenSnapshot(scopeId);
        if (before.status !== "ok") throw new Error("expected ok");
        expect(before.snapshot.marker?.entries.map((entry) => entry.draftId).sort()).toEqual(["draft-a", "draft-b"]);
        const exported = await second.exportConflictDrafts();
        expect(exported.map((item) => item.nodes[0]?.id).sort()).toEqual(["a", "b"]);
        expect(await store.readOpenSnapshot(scopeId)).toEqual(before);
        expect(racing.commitCoordination).toHaveBeenCalledTimes(2);
        await first.dispose("forced");
        await second.dispose("forced");
    });

    it("keeps recovery blocked when retry cannot read a fresh snapshot and never saves", async () => {
        const save = vi.fn();
        const unavailable = { ...store, readOpenSnapshot: vi.fn(async () => ({ status: "unavailable", reason: "timeout" }) as const) };
        const resolution = { ...cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }), phase: "recovery-blocked" as const };
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution },
            { ...deps, repository: fakeRepository({ save }), recovery: unavailable },
        );
        session.install(project(1));
        expect(await session.retryRecovery()).toBe("failed");
        expect(session.view.phase).toBe("recovery-blocked");
        expect(save).not.toHaveBeenCalled();
        await session.dispose("forced");
    });

    it("re-parses a fresh snapshot when retryRecovery repair CAS goes stale", async () => {
        await store.commitCoordination({
            scopeId,
            expectedCoordinationRevision: 0,
            expectedDeletionGeneration: 0,
            marker: [{ draftId: "missing", baseRevision: 0, savedAt: new Date(0).toISOString() }],
        });
        let injected = false;
        const racing = {
            ...store,
            commitCoordination: vi.fn(async (input, signal) => {
                if (!injected && input.marker === null) {
                    injected = true;
                    await store.upsertDraft({
                        scopeId,
                        draftId: "foreign",
                        writeSeq: 1,
                        expectedDeletionGeneration: 0,
                        state: "pending",
                        envelope: { document: { title: "foreign", baseRevision: 1, snapshot: { nodes: [], connections: [] } as never }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} },
                        savedAt: new Date(1).toISOString(),
                    });
                    const current = await store.readOpenSnapshot(scopeId);
                    if (current.status !== "ok") throw new Error("expected ok");
                    await store.commitCoordination({
                        scopeId,
                        expectedCoordinationRevision: current.snapshot.epoch.coordinationRevision,
                        expectedDeletionGeneration: current.snapshot.epoch.deletionGeneration,
                        marker: null,
                    });
                }
                return store.commitCoordination(input, signal);
            }),
        } satisfies CanvasRecoveryStore;
        const save = vi.fn();
        const resolution = { ...cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }), phase: "recovery-blocked" as const };
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution },
            { ...deps, repository: fakeRepository({ save }), recovery: racing },
        );
        session.install(project(1));

        expect(await session.retryRecovery()).toBe("conflict");
        expect(session.view.phase).toBe("conflict");
        expect(save).not.toHaveBeenCalled();
        const after = await store.readOpenSnapshot(scopeId);
        if (after.status !== "ok") throw new Error("expected ok");
        expect(after.snapshot.marker?.entries[0].draftId).toBe("foreign");
        expect(racing.commitCoordination).toHaveBeenCalledTimes(2);
        await session.dispose("forced");
    });

    it("treats an initially tombstoned resolution as a complete unavailable state", async () => {
        vi.useFakeTimers();
        const upsertDraft = vi.spyOn(store, "upsertDraft");
        const resolution = { ...cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 4 }), phase: "tombstoned" as const };
        const session = createCanvasSyncSession({ sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution }, deps);
        try {
            session.install(project(1));
            expect(session.update({ nodes: [{ id: "forbidden" }] as never })).toBe(false);
            expect(session.rename("forbidden-title")).toBe("local-only");
            await vi.advanceTimersByTimeAsync(LOCAL_COALESCE_MS + 1);
            /** rename returned before mutation/registerEdit: no timer write and no invariant/save-error transition. */
            expect(upsertDraft).not.toHaveBeenCalled();
            expect(session.view).toMatchObject({ title: "T1", phase: "tombstoned", saveError: null, localPersist: "tombstoned", unavailableKey: "canvas.recovery.tombstoned" });
            await expect(session.flush()).resolves.toBeUndefined();
            await expect(session.holdForDelete()).resolves.toBeUndefined();
            await session.dispose("replaced");
            expect(session.view.phase).toBe("disposed");
        } finally {
            vi.useRealTimers();
        }
    });

    it("has no whenLocalSettled and no settled channel left to await", () => {
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }) },
            deps,
        );
        expect("whenLocalSettled" in session).toBe(false);
    });

    it("aborts the session-owned local operation on forced dispose without a late commit", async () => {
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const controlled = {
            ...store,
            upsertDraft: vi.fn(async (_input, signal?: AbortSignal) => {
                entered();
                return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ status: "unavailable", reason: "aborted" }), { once: true }));
            }),
        };
        const session = createCanvasSyncSession(
            { sessionId: 1, scope, scopeToken: 1, openToken: 1, canvasId: "c1", scopeId, resolution: cleanResolution(load(1), "draft-1", { coordinationRevision: 0, deletionGeneration: 0 }) },
            { ...deps, recovery: controlled },
        );
        session.install(project(1));
        session.update({ nodes: [{ id: "n1" }] as never });
        const flushing = session.flush();
        await started;
        await session.dispose("forced");
        await flushing;
        expect(controlled.upsertDraft.mock.calls[0][1]?.aborted).toBe(true);
        const after = await store.readOpenSnapshot(scopeId);
        if (after.status !== "ok") throw new Error("expected ok");
        expect(after.snapshot.drafts).toEqual([]);
    });
});
```

- [ ] **Step 2: Write the failing manager tests**

Replace `web/src/services/canvas-sync/canvas-sync-manager.test.ts` with the full transactional suite below. The Task 5 proof-gate case is subsumed by "keeps drafts and writes no tombstone for denied, indeterminate and mismatched deletes"; do not keep a second legacy-recovery fixture.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { createRecoveryDatabase } from "../canvas-recovery/database";
import { buildRecoveryScopeId } from "../canvas-recovery/scope";
import { browserCanvasRecoveryStore, createCanvasRecoveryStore, type CanvasRecoveryStore } from "../canvas-recovery/store";
import { createCanvasSyncManager } from "./canvas-sync-manager";
import type { CanvasSyncRepository } from "./types";
import type { CanvasProject } from "@/types/canvas";

const scope = { userId: "u1", workspaceId: "w1" };
const scopeId = buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })!;

const project = (id: string): CanvasProject => ({
    id,
    title: "T",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "dots",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
}) as unknown as CanvasProject;

function repository(overrides: Partial<CanvasSyncRepository> = {}): CanvasSyncRepository {
    return {
        list: async () => [],
        load: async (_w, canvasId) => ({ project: project(canvasId), revision: 1 }),
        create: async () => ({ project: project("c1"), revision: 1 }),
        importProject: async () => ({ project: project("c1"), revision: 1 }),
        save: async (_w, _c, input) => ({ project: project("c1"), revision: input.baseRevision + 1 }),
        remove: async () => ({ status: "deleted", receipt: { canvasId: "c1", deletionReceipt: "r", deletedAt: "2020-01-01T00:00:00.000Z" } }),
        ...overrides,
    };
}

describe("manager on transactional recovery", () => {
    let store: CanvasRecoveryStore;
    const make = (repo: CanvasSyncRepository) => createCanvasSyncManager({ repository: repo, recovery: store, now: () => 1_000, createDraftId: () => "draft-1", isDev: false });

    beforeEach(() => {
        store = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
    });

    it("imports the manager singleton safely without ambient IndexedDB and fails only on use", async () => {
        /** The static manager import above has already evaluated the singleton without throwing. */
        expect(globalThis.indexedDB).toBeUndefined();
        expect(await browserCanvasRecoveryStore.readOpenSnapshot(scopeId)).toEqual({ status: "unavailable", reason: "unsupported" });
    });

    it("writes nothing when a prepared open is cancelled", async () => {
        const manager = make(repository());
        manager.setScope(scope);
        const prepared = await manager.prepareOpen("c1");
        // Scope change invalidates the prepare; commit must be refused and nothing may be written.
        manager.setScope({ userId: "u2", workspaceId: "w1" });
        expect(manager.commitPrepared(prepared, project("c1"))).toBe(false);
        const snapshot = await store.readOpenSnapshot(scopeId);
        if (snapshot.status !== "ok") throw new Error("expected ok");
        expect(snapshot.snapshot.drafts).toEqual([]);
        expect(snapshot.snapshot.epoch.coordinationRevision).toBe(0);
    });

    it("writes a tombstone only after a matching receipt", async () => {
        const manager = make(repository());
        manager.setScope(scope);
        const prepared = await manager.prepareOpen("c1");
        manager.commitPrepared(prepared, project("c1"));
        expect(await manager.deleteCanvases(["c1"])).toEqual({ deleted: ["c1"], failed: [] });
        expect(await store.readOpenSnapshot(scopeId)).toEqual({ status: "tombstoned", deletionGeneration: 1 });
    });

    it("keeps drafts and writes no tombstone for denied, indeterminate and mismatched deletes", async () => {
        for (const remove of [
            async () => ({ status: "denied", code: "canvas_not_found", messageKey: "canvas.delete.unavailable" }) as never,
            async () => ({ status: "denied", code: "workspace_not_active", messageKey: "canvas.delete.unavailable" }) as never,
            async () => ({ status: "indeterminate", reason: "network", messageKey: "canvas.delete.unconfirmed" }) as never,
            async () => ({ status: "indeterminate", reason: "timeout", messageKey: "canvas.delete.unconfirmed" }) as never,
            async () => ({ status: "indeterminate", reason: "mismatched-receipt", messageKey: "canvas.delete.unconfirmed" }) as never,
        ]) {
            store = createCanvasRecoveryStore(createRecoveryDatabase(freshIndexedDB()));
            const manager = make(repository({ remove }));
            manager.setScope(scope);
            const prepared = await manager.prepareOpen("c1");
            manager.commitPrepared(prepared, project("c1"));
            const session = manager.getActiveSession()!;
            session.update({ nodes: [{ id: "n1" }] as never });
            await session.flush();

            expect(await manager.deleteCanvases(["c1"])).toEqual({ deleted: [], failed: ["c1"] });
            const snapshot = await store.readOpenSnapshot(scopeId);
            if (snapshot.status !== "ok") throw new Error("expected a usable scope, not a tombstone");
            // The draft survives and the session is usable again.
            expect(snapshot.snapshot.drafts.length).toBeGreaterThan(0);
            expect(manager.getActiveSession()).toBe(session);
        }
    });

    it("clears conflict drafts on accept-server-version and still allows a new session to write", async () => {
        const manager = make(repository());
        manager.setScope(scope);
        await store.upsertDraft({
            scopeId,
            draftId: "foreign",
            writeSeq: 1,
            expectedDeletionGeneration: 0,
            state: "pending",
            envelope: { document: { title: "foreign", baseRevision: 1, snapshot: { nodes: [], connections: [] } as never }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} },
            savedAt: new Date(0).toISOString(),
        });
        const opened = await manager.prepareOpen("c1");
        manager.commitPrepared(opened, project("c1"));
        const serverCopy = await manager.prepareServerCopy("c1");
        expect(manager.commitServerCopy(serverCopy, project("c1"))).toBe("committed");

        await vi.waitFor(async () => {
            const afterAccept = await store.readOpenSnapshot(scopeId);
            if (afterAccept.status !== "ok") throw new Error("accepting the server version must not tombstone the scope");
            expect(afterAccept.snapshot.marker).toBeNull();
            expect(afterAccept.snapshot.drafts.some((draft) => draft.draftId === "foreign")).toBe(false);
            expect(afterAccept.snapshot.epoch.tombstonedAt).toBeNull();
            expect(afterAccept.snapshot.epoch.deletionGeneration).toBe(0);
        });

        const session = manager.getActiveSession()!;
        session.update({ nodes: [{ id: "fresh" }] as never });
        await session.flush();
        const afterWrite = await store.readOpenSnapshot(scopeId);
        if (afterWrite.status !== "ok") throw new Error("expected ok");
        expect(afterWrite.snapshot.drafts.length).toBeGreaterThan(0);
    });

    it("re-reads and retries accept-server cleanup when another tab advances coordination", async () => {
        const base = store;
        await base.upsertDraft({
            scopeId,
            draftId: "foreign",
            writeSeq: 1,
            expectedDeletionGeneration: 0,
            state: "pending",
            envelope: { document: { title: "foreign", baseRevision: 1, snapshot: { nodes: [], connections: [] } as never }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} },
            savedAt: new Date(0).toISOString(),
        });
        await base.commitCoordination({
            scopeId,
            expectedCoordinationRevision: 0,
            expectedDeletionGeneration: 0,
            marker: [{ draftId: "foreign", baseRevision: 1, savedAt: new Date(0).toISOString() }],
        });
        let injected = false;
        const racing = {
            ...base,
            collectGarbage: vi.fn(async () => ({ status: "committed", coordinationRevision: 1 }) as const),
            commitCoordination: vi.fn(async (input, signal) => {
                if (!injected && input.marker === null) {
                    injected = true;
                    const current = await base.readOpenSnapshot(scopeId);
                    if (current.status !== "ok") throw new Error("expected ok");
                    await base.commitCoordination({
                        scopeId,
                        expectedCoordinationRevision: current.snapshot.epoch.coordinationRevision,
                        expectedDeletionGeneration: current.snapshot.epoch.deletionGeneration,
                        marker: current.snapshot.marker?.entries ?? null,
                    });
                }
                return base.commitCoordination(input, signal);
            }),
        } satisfies CanvasRecoveryStore;
        store = racing;
        const manager = make(repository());
        manager.setScope(scope);
        const opened = await manager.prepareOpen("c1");
        manager.commitPrepared(opened, project("c1"));
        const serverCopy = await manager.prepareServerCopy("c1");
        expect(manager.commitServerCopy(serverCopy, project("c1"))).toBe("committed");

        await vi.waitFor(async () => {
            const after = await base.readOpenSnapshot(scopeId);
            if (after.status !== "ok") throw new Error("expected ok");
            expect(after.snapshot.marker).toBeNull();
            expect(after.snapshot.drafts.map((draft) => draft.draftId)).not.toContain("foreign");
        });
        expect(racing.commitCoordination).toHaveBeenCalledTimes(2);
    });

    it("retains conflict records and reports degraded after two stale accept-server cleanup attempts", async () => {
        const base = store;
        await base.upsertDraft({
            scopeId,
            draftId: "foreign",
            writeSeq: 1,
            expectedDeletionGeneration: 0,
            state: "pending",
            envelope: { document: { title: "foreign", baseRevision: 1, snapshot: { nodes: [], connections: [] } as never }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} },
            savedAt: new Date(0).toISOString(),
        });
        await base.commitCoordination({ scopeId, expectedCoordinationRevision: 0, expectedDeletionGeneration: 0, marker: [{ draftId: "foreign", baseRevision: 1, savedAt: new Date(0).toISOString() }] });
        const racing = {
            ...base,
            collectGarbage: vi.fn(async () => ({ status: "committed", coordinationRevision: 1 }) as const),
            commitCoordination: vi.fn(async (input, signal) => {
                if (input.marker === null) {
                    const current = await base.readOpenSnapshot(scopeId);
                    if (current.status !== "ok") throw new Error("expected ok");
                    await base.commitCoordination({
                        scopeId,
                        expectedCoordinationRevision: current.snapshot.epoch.coordinationRevision,
                        expectedDeletionGeneration: current.snapshot.epoch.deletionGeneration,
                        marker: current.snapshot.marker?.entries ?? null,
                    });
                }
                return base.commitCoordination(input, signal);
            }),
        } satisfies CanvasRecoveryStore;
        store = racing;
        const manager = make(repository());
        manager.setScope(scope);
        const opened = await manager.prepareOpen("c1");
        manager.commitPrepared(opened, project("c1"));
        const serverCopy = await manager.prepareServerCopy("c1");
        expect(manager.commitServerCopy(serverCopy, project("c1"))).toBe("committed");

        await vi.waitFor(() => expect(manager.getActiveSession()?.view.localPersist).toBe("degraded"));
        const retained = await base.readOpenSnapshot(scopeId);
        if (retained.status !== "ok") throw new Error("expected ok");
        expect(retained.snapshot.marker?.entries[0].draftId).toBe("foreign");
        expect(retained.snapshot.drafts.some((draft) => draft.draftId === "foreign")).toBe(true);
        expect(racing.commitCoordination).toHaveBeenCalledTimes(2);
    });

    it("returns a named failure before loading when a trusted account scope cannot be constructed", async () => {
        const loadCanvas = vi.fn(async () => ({ project: project("c1"), revision: 1 }));
        const manager = make(repository({ load: loadCanvas }));
        manager.setScope({ userId: "", workspaceId: "w1" });
        expect(await manager.prepareOpen("c1")).toEqual({ status: "failed", messageKey: "canvas.recovery.invalidScope" });
        expect(loadCanvas).not.toHaveBeenCalled();
    });

    it("skips GC when marker ownership cannot be read", async () => {
        const unavailable = { ...store, readOpenSnapshot: async () => ({ status: "unavailable", reason: "timeout" }) as never, collectGarbage: vi.fn(async () => ({ status: "committed", coordinationRevision: 1 }) as never) };
        const manager = createCanvasSyncManager({ repository: repository(), recovery: unavailable as never, now: () => 1_000, createDraftId: () => "draft-1", isDev: false });
        manager.setScope(scope);
        const prepared = await manager.prepareOpen("c1");
        manager.commitPrepared(prepared, project("c1"));
        await new Promise((resolve) => setTimeout(resolve, 10));
        // "Cannot read" must never degrade into "there is no marker".
        expect(unavailable.collectGarbage).not.toHaveBeenCalled();
    });

    it("does not read or collect another identity's scope after switching accounts", async () => {
        const otherScopeId = buildRecoveryScopeId({ kind: "account", userId: "u2", workspaceId: "w1", canvasId: "c1" })!;
        const manager = make(repository());
        manager.setScope(scope);
        const first = await manager.prepareOpen("c1");
        manager.commitPrepared(first, project("c1"));
        const firstSession = manager.getActiveSession()!;
        firstSession.update({ nodes: [{ id: "u1-work" }] as never });
        await firstSession.flush();

        manager.setScope({ userId: "u2", workspaceId: "w1" });
        const second = await manager.prepareOpen("c1");
        manager.commitPrepared(second, project("c1"));
        const secondSession = manager.getActiveSession()!;
        secondSession.update({ nodes: [{ id: "u2-work" }] as never });
        await secondSession.flush();

        const mine = await store.readOpenSnapshot(scopeId);
        const theirs = await store.readOpenSnapshot(otherScopeId);
        if (mine.status !== "ok" || theirs.status !== "ok") throw new Error("expected ok");
        expect(mine.snapshot.drafts.length).toBeGreaterThan(0);
        expect(theirs.snapshot.drafts.length).toBeGreaterThan(0);
        // Neither identity's drafts leaked into the other's scope.
        expect(mine.snapshot.drafts[0].scopeId).toBe(scopeId);
        expect(theirs.snapshot.drafts[0].scopeId).toBe(otherScopeId);
    });
});
```

- [ ] **Step 3: Run both and confirm failure**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-sync`
Expected: FAIL. `cleanResolution` / `serverCopyResolution` do not exist, `createCanvasSyncSession` does not accept `scopeId`, and `createCanvasSyncManager` still expects the old `CanvasLocalRecovery`.

- [ ] **Step 4: Replace the contracts in canvas-sync/types.ts**

Delete these declarations entirely: `CanvasLocalWrite`, `CanvasLocalRecovery`, `CanvasDraftScope`, `CanvasDraftState` (now imported from the recovery module), `CanvasDraftRecord`, `CanvasConflictMarker`, `CanvasLocalRecoveryError`, the local declaration of `MAX_CONFLICT_MARKER_ENTRIES`, and the `whenLocalSettled` member of `CanvasSyncSession`. Replace the patch-field list and repair union; re-export the marker cap from its recovery owner so existing sync imports keep one source:

```ts
/** Document edits advance editSeq and schedule a cloud save. */
export { MAX_CONFLICT_MARKER_ENTRIES } from "@/services/canvas-recovery/types";
export const CANVAS_DOCUMENT_PATCH_FIELDS = ["nodes", "connections", "chatSessions", "activeChatId", "backgroundMode", "showImageInfo"] as const;
/** Local UI only: persisted in the draft envelope, never serialized to the cloud, never an edit. */
export const CANVAS_LOCAL_PATCH_FIELDS = ["viewport"] as const;
export const MAX_COORDINATION_ATTEMPTS = 2;
export type CanvasProjectPatch = Partial<Pick<CanvasProject, (typeof CANVAS_DOCUMENT_PATCH_FIELDS)[number] | (typeof CANVAS_LOCAL_PATCH_FIELDS)[number]>>;

/** Repairs describe intent only; the installed session commits them under one coordination CAS. */
export type CanvasRecoveryRepair = { kind: "write-marker"; entries: CanvasConflictMarkerEntry[] } | { kind: "delete-marker" } | { kind: "delete-drafts"; draftIds: string[] };

export type CanvasLocalPersistState = "ok" | "degraded" | "tombstoned";
```

Add `unavailableKey: string | null` to `CanvasSyncView`, add `"tombstoned"` to `CanvasSyncPhase`, and rename `CanvasSyncSessionDeps` usage to the new `CanvasSessionDeps` shape whose `recovery` is `CanvasRecoveryStore`. Import `CanvasConflictMarkerEntry` and `CanvasRecoveryStore` from `@/services/canvas-recovery/...`. Add one manager-only notification method to `CanvasSyncSession`:

```ts
/** Manager reports a bounded CAS cleanup that retained records after exhaustion. Never changes document dirty/clean state. */
reportRecoveryCleanupFailure(): void;
```

Its implementation is `if (!tombstoned && phase !== "disposed") markDegraded();`; the returned session wraps it with the existing synchronous invariant guard. It does not expose a second persistence protocol or perform storage itself.

Extend `CanvasSyncInvariantContext` with `localUiSeq`, `materializedLocalUiSeq` and `persistedLocalUiSeq`; `invariantContext(event)` must populate all three so a local-UI ordering failure is diagnosable rather than reported as a document-counter failure.

- [ ] **Step 5: Rewrite the session's local persistence**

In `web/src/services/canvas-sync/canvas-sync-session.ts`:

1. Delete `trackLocal`, `trackWrite`, `inFlightLocal`, `localSettlementWatcher`, `whenLocalSettled` and every `.settled` reference. An aborted transaction leaves no residue, so there is nothing to observe.
2. Add the three resolution constructors so no call site can omit `repairs`:

```ts
type ResolutionEpoch = { coordinationRevision: number; deletionGeneration: number };

function baseResolution(load: CanvasLoadResult, draftId: string, epoch: ResolutionEpoch): CanvasRecoveryResolution {
    return {
        phase: "clean",
        content: load.project,
        revision: load.revision,
        draftId,
        conflict: null,
        /** Always present by construction: the historic server-copy path omitted this field. */
        repairs: [],
        expectedCoordinationRevision: epoch.coordinationRevision,
        expectedDeletionGeneration: epoch.deletionGeneration,
        baseWriteSeq: 0,
        documentDefaultViewport: { ...load.project.viewport },
    };
}

export function cleanResolution(load: CanvasLoadResult, draftId: string, epoch: ResolutionEpoch): CanvasRecoveryResolution {
    return baseResolution(load, draftId, epoch);
}

/** Accepting the server version discards local work on purpose: no repairs, no marker rewrite. */
export function serverCopyResolution(load: CanvasLoadResult, draftId: string, epoch: ResolutionEpoch): CanvasRecoveryResolution {
    return baseResolution(load, draftId, epoch);
}
```

3. Rewrite `resolveCanvasOpenRecovery` to read the one consistent snapshot and derive everything from it:

```ts
export async function resolveCanvasOpenRecovery(deps: Pick<CanvasSessionDeps, "recovery" | "createDraftId">, scopeId: RecoveryScopeId, load: CanvasLoadResult): Promise<CanvasRecoveryResolution> {
    const opened = await deps.recovery.readOpenSnapshot(scopeId);
    /** A tombstoned scope is not "no drafts": the canvas is gone and must not be revived. */
    if (opened.status === "tombstoned") return { ...cleanResolution(load, deps.createDraftId(), { coordinationRevision: 0, deletionGeneration: opened.deletionGeneration }), phase: "tombstoned" };
    /** "Cannot read" is a third state, never "no conflict": open the server copy and block cloud saves. */
    if (opened.status === "unavailable") return { ...cleanResolution(load, deps.createDraftId(), { coordinationRevision: 0, deletionGeneration: 0 }), phase: "recovery-blocked" };
    /** Initial open and every stale retry share this one deterministic parser. */
    return parseRecoverySnapshot(load, opened.snapshot, deps.createDraftId);
}

/** The document part is authoritative for content; the stored local viewport wins over the shared default. */
function restoreContent(server: CanvasProject, draft: CanvasDraftRecord): CanvasProject {
    return {
        ...server,
        ...snapshotToProjectContent(draft.envelope.document.snapshot),
        title: draft.envelope.document.title || server.title,
        viewport: draft.envelope.localUi.viewport,
    };
}
```

4. Track document and local-UI progress independently. Replace the old `pendingSlot` declaration, `ensureSnapshot`, `materialize`, `assertCounters`, `flushLocal` and `drainLocal` with the following invariants and code:

```ts
let coordinationRevision = resolution.expectedCoordinationRevision;
let deletionGeneration = resolution.expectedDeletionGeneration;
/** Monotonic for this [scopeId, draftId] only; continues the stored sequence. */
let writeSeq = resolution.baseWriteSeq;
/** Document counters only. savedSeq/clean never depend on local-UI movement. */
let editSeq = 0;
let materializedSeq = 0;
let persistedSeq = 0;
let savedSeq = 0;
/** Independent local-UI counters. They never participate in cloud-save or clean-state decisions. */
let localUiSeq = 0;
let materializedLocalUiSeq = 0;
let persistedLocalUiSeq = 0;
let localViewport = resolution.content.viewport;
/** Frozen canonical viewport used by every document draft and every cloud save. */
const documentDefaultViewport = { ...resolution.documentDefaultViewport };
let tombstoned = resolution.phase === "tombstoned";
let localPersist: CanvasLocalPersistState = tombstoned ? "tombstoned" : "ok";
const localAbortController = new AbortController();

type PendingLocalSlot = {
    state: CanvasDraftState;
    title: string;
    snapshot: CanvasSnapshot;
    documentSeq: number;
    localUiSeq: number;
    viewport: ViewportTransform;
};

/** One latest-value slot bounds full-snapshot memory regardless of document/UI edit rate. */
let pendingSlot: PendingLocalSlot | null = null;

function assertCounters(event: string) {
    const documentOrdered = savedSeq <= editSeq && persistedSeq <= materializedSeq && materializedSeq <= editSeq;
    const localUiOrdered = persistedLocalUiSeq <= materializedLocalUiSeq && materializedLocalUiSeq <= localUiSeq;
    const inflightOk = inflightSeq < 0 || (savedSeq <= inflightSeq && inflightSeq <= editSeq);
    /** clean describes canonical document state only; unflushed local UI does not make it dirty. */
    const cleanOk = phase !== "clean" || (savedSeq === editSeq && inflightSeq < 0 && networkTimer === null);
    if (!documentOrdered || !localUiOrdered || !inflightOk || !cleanOk) throw new CanvasSyncInvariantError(invariantContext(event));
}

function enterTombstoned() {
    tombstoned = true;
    phase = "tombstoned";
    pendingSlot = null;
    clearLocalTimer();
    clearNetworkTimer();
    inflightController?.abort();
    localAbortController.abort();
    localPersist = "tombstoned";
    notify();
}

function ensureDocumentSnapshot(): { seq: number; title: string; snapshot: CanvasSnapshot } {
    if (snapshotCache && snapshotCache.seq === editSeq && snapshotCache.title === content.title) return snapshotCache;
    /**
     * content.viewport is live local UI. It must never leak into the canonical document:
     * substitute the viewport frozen when this canonical document was opened/restored.
     */
    snapshotCache = { seq: editSeq, title: content.title, snapshot: projectToSnapshot({ ...content, viewport: documentDefaultViewport }) };
    return snapshotCache;
}

function materialize() {
    clearLocalTimer();
    const documentChanged = materializedSeq < editSeq;
    const localUiChanged = materializedLocalUiSeq < localUiSeq;
    /** Pure viewport movement reaches this branch even when editSeq/materializedSeq are both zero. */
    if (!documentChanged && !localUiChanged) return;
    assertEvent("localTick");
    const payload = ensureDocumentSnapshot();
    if (documentChanged) materializedSeq = editSeq;
    if (localUiChanged) materializedLocalUiSeq = localUiSeq;
    pendingSlot = {
        /** A local-UI-only record is synced: its canonical document still equals the server. */
        state: editSeq > savedSeq ? "pending" : "synced",
        title: payload.title,
        snapshot: payload.snapshot,
        documentSeq: materializedSeq,
        localUiSeq: materializedLocalUiSeq,
        viewport: localViewport,
    };
    assertCounters("localTick");
    void drainLocal();
}

/** The bounded single slot survives; only the write itself becomes a CAS. */
async function drainLocal(): Promise<void> {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
        while (pendingSlot && !aborted && !tombstoned) {
            const entry = pendingSlot;
            pendingSlot = null;
            writeSeq += 1;
            const outcome = await deps.recovery.upsertDraft(
                {
                    scopeId,
                    draftId: resolution.draftId,
                    writeSeq,
                    expectedDeletionGeneration: deletionGeneration,
                    state: entry.state,
                    envelope: {
                        document: { title: entry.title, baseRevision: conflictBaseRevision ?? revision, snapshot: entry.snapshot },
                        localUi: { viewport: entry.viewport },
                        assets: {},
                    },
                    savedAt: new Date(deps.now()).toISOString(),
                },
                localAbortController.signal,
            );
            if (outcome.status === "written") {
                persistedSeq = Math.max(persistedSeq, entry.documentSeq);
                persistedLocalUiSeq = Math.max(persistedLocalUiSeq, entry.localUiSeq);
                assertCounters("localPersisted");
                continue;
            }
            if (outcome.status === "tombstoned" || outcome.status === "generation-changed") {
                enterTombstoned();
                return;
            }
            /** superseded means another writer is ahead; adopt its sequence and rematerialize the latest slot once. */
            if (outcome.status === "superseded") {
                writeSeq = outcome.storedWriteSeq;
                materializedSeq = Math.min(materializedSeq, persistedSeq);
                materializedLocalUiSeq = Math.min(materializedLocalUiSeq, persistedLocalUiSeq);
                materialize();
            } else if (outcome.reason !== "aborted" || !aborted) {
                markDegraded();
            }
        }
    })().finally(() => {
        drainPromise = null;
        if ((materializedSeq < editSeq || materializedLocalUiSeq < localUiSeq) && !aborted && !tombstoned) materialize();
    });
    return drainPromise;
}

async function flushLocal(timeoutMs: number) {
    clearLocalTimer();
    materialize();
    const settled = await settleWithin(drainPromise ?? Promise.resolve(), timeoutMs);
    if (settled.status !== "ok") markDegraded();
    /**
     * A slot may have been overwritten while the previous transaction was in flight.
     * Materialize/drain one final time so both independent sequences reach their latest values.
     */
    if (!aborted && !tombstoned && (persistedSeq < editSeq || persistedLocalUiSeq < localUiSeq)) {
        materialize();
        const final = await settleWithin(drainPromise ?? Promise.resolve(), timeoutMs);
        if (final.status !== "ok") markDegraded();
    }
}
```

Delete the old `ensureSnapshot`. In both `startSave` and `finalSave`, capture the canonical payload only through `ensureDocumentSnapshot()` and pass that exact payload to the repository:

```ts
const payload = ensureDocumentSnapshot();
const result = await deps.repository.save(
    scope.workspaceId,
    canvasId,
    { baseRevision, title: payload.title, snapshot: payload.snapshot },
    controller.signal,
);
```

There is no network serializer that receives `content` directly. This is what makes the sequence "pan, then edit a node, then save" retain the viewport opened from the canonical document instead of accidentally promoting the live viewport into the cloud snapshot.

5. Split `update` so pan/zoom never becomes an edit:

```ts
function update(patch: CanvasProjectPatch): boolean {
    if (held || tombstoned || phase === "loading" || phase === "disposing" || phase === "disposed") return false;
    assertEvent("update");
    let documentChanged = false;
    for (const field of CANVAS_DOCUMENT_PATCH_FIELDS) {
        const next = patch[field];
        if (next === undefined || Object.is(next, content[field])) continue;
        documentChanged = true;
    }
    const nextViewport = patch.viewport;
    const viewportChanged = nextViewport !== undefined && !Object.is(nextViewport, localViewport);
    if (viewportChanged) {
        /** Independent local-UI sequence: persisted even when the document sequence is unchanged. */
        localViewport = nextViewport;
        content = { ...content, viewport: nextViewport };
        localUiSeq += 1;
        scheduleLocal();
    }
    if (!documentChanged) return false;
    /** Never spread viewport into canonical-document state; it was handled only as local UI above. */
    const { viewport: _localViewport, ...documentPatch } = patch;
    content = { ...content, ...documentPatch };
    registerEdit();
    return true;
}
```

Keep the existing 120 ms single local timer, but make it serve both sequences: the first document edit or local-UI change starts it; later changes coalesce into the one latest-value slot. Replace `flush`, `holdForDelete`, clean save settlement and disposal details with these rules:

```ts
async function flush() {
    if (phase === "loading" || phase === "disposing" || phase === "disposed" || phase === "tombstoned") return;
    assertEvent("flush");
    /** Flushes document and local UI independently. */
    await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
    /** Local UI never satisfies this predicate and therefore never causes a cloud save. */
    if (canUseNetwork() && editSeq > savedSeq && inflightSeq < 0) {
        await startSave();
        /** Ack/409 may enqueue a synced/pending draft or marker tail; flush owns that bounded tail too. */
        await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
    }
}

async function holdForDelete() {
    if (held || phase === "loading" || phase === "disposing" || phase === "disposed" || phase === "tombstoned") return;
    assertEvent("hold");
    held = true;
    clearNetworkTimer();
    notify();
    /** The reversible hold persists both latest document and latest local UI. */
    await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
}

function queueDraftSettlement(state: CanvasDraftState) {
    const payload = ensureDocumentSnapshot();
    materializedSeq = Math.max(materializedSeq, payload.seq);
    materializedLocalUiSeq = Math.max(materializedLocalUiSeq, localUiSeq);
    pendingSlot = {
        state,
        title: payload.title,
        snapshot: payload.snapshot,
        documentSeq: materializedSeq,
        localUiSeq: materializedLocalUiSeq,
        viewport: localViewport,
    };
    /**
     * Do not delete the synced row after an ack: its document is confirmed and its localUi
     * is the durable per-scope viewport preference used by the next open.
     */
    void drainLocal();
}

function escalateToForced() {
    aborted = true;
    disposeReason = "forced";
    pendingSlot = null;
    clearLocalTimer();
    clearNetworkTimer();
    inflightController?.abort();
    /** Cancels every transaction owned by this session; runner abort proves rollback. */
    localAbortController.abort();
    settleAfterRequest();
}

async function disposeBody(reason: CanvasDisposeReason) {
    if (reason === "forced" || reason === "deleted") {
        aborted = true;
        pendingSlot = null;
        localAbortController.abort();
        inflightController?.abort();
        await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
        return;
    }
    /** replaced/scope-changed flush both independent sequences before bounded teardown. */
    await flushLocal(DETACHED_LOCAL_MS);
    if (canUseNetwork()) await settleWithin(finishNetwork(), DETACHED_NETWORK_MS);
    /** Any local lag after the bound is cancelled too; disposed must not leave a producer tail. */
    if (drainPromise || pendingSlot || persistedSeq < editSeq || persistedLocalUiSeq < localUiSeq || inflightSeq >= 0 || inflightRequest) escalateToForced();
}
```

The document state machine remains independent: a pure local-UI change leaves `phase === "clean"` and `hasUnsavedEdits === false` while the local scheduler still persists it. A replaced/scope-changed dispose flushes both sequences; forced/deleted dispose aborts the shared local owner signal and returns only after the active bounded operation has observed cancellation. No `settled` or unbounded observer is retained.

For stale repair and recovery retry, derive the parser's server input through the frozen default as well:

```ts
const recoveryLoad = (): CanvasLoadResult => ({ project: { ...content, viewport: documentDefaultViewport }, revision });
```

Every installed-session call below uses `parseRecoverySnapshot(recoveryLoad(), opened.snapshot, deps.createDraftId)`, never `{ project: content, revision }`; otherwise a live pan performed while recovery was blocked could become the canonical default during retry.

6. Commit repairs through coordination CAS and re-parse a fresh consistent snapshot when stale. Add the exact deterministic parser below; `resolveCanvasOpenRecovery`, `runRecoveryRepairs` and `retryRecovery` are its only callers, so initial and stale decisions cannot diverge:

```ts
function parseRecoverySnapshot(load: CanvasLoadResult, snapshot: CanvasRecoveryOpenSnapshot, createDraftId: () => string): CanvasRecoveryResolution {
    const { epoch, marker, drafts } = snapshot;
    const epochValues = { coordinationRevision: epoch.coordinationRevision, deletionGeneration: epoch.deletionGeneration };
    const byId = new Map(drafts.map((draft) => [draft.draftId, draft] as const));
    const valid = (marker?.entries ?? []).filter((entry) => {
        const draft = byId.get(entry.draftId);
        return Boolean(draft) && draft!.state === "pending" && draft!.envelope.document.baseRevision === entry.baseRevision;
    });
    if (valid.length) {
        const draft = byId.get(valid[0].draftId)!;
        return {
            ...cleanResolution(load, draft.draftId, epochValues),
            phase: "conflict",
            content: restoreContent(load.project, draft),
            conflict: { baseRevision: draft.envelope.document.baseRevision, source: "restored", extraDraftCount: valid.length - 1 },
            repairs: valid.length === (marker?.entries.length ?? 0) ? [] : [{ kind: "write-marker", entries: valid }],
            baseWriteSeq: draft.writeSeq,
            documentDefaultViewport: snapshotToProjectContent(draft.envelope.document.snapshot).viewport,
        };
    }
    const repairs: CanvasRecoveryRepair[] = marker ? [{ kind: "delete-marker" }] : [];
    const pending = drafts.find((draft) => draft.state === "pending");
    if (pending) {
        const pendingResolution = {
            ...cleanResolution(load, pending.draftId, epochValues),
            content: restoreContent(load.project, pending),
            baseWriteSeq: pending.writeSeq,
            documentDefaultViewport: snapshotToProjectContent(pending.envelope.document.snapshot).viewport,
        };
        if (pending.envelope.document.baseRevision === load.revision) return { ...pendingResolution, phase: "dirty", repairs };
        return {
            ...pendingResolution,
            phase: "conflict",
            conflict: { baseRevision: pending.envelope.document.baseRevision, source: "restored", extraDraftCount: 0 },
            repairs: [{ kind: "write-marker", entries: [{ draftId: pending.draftId, baseRevision: pending.envelope.document.baseRevision, savedAt: pending.savedAt }] }],
        };
    }
    const synced = drafts.find((draft) => draft.state === "synced");
    if (synced) {
        return {
            ...cleanResolution(load, synced.draftId, epochValues),
            content: { ...load.project, viewport: synced.envelope.localUi.viewport },
            repairs,
            baseWriteSeq: synced.writeSeq,
        };
    }
    return { ...cleanResolution(load, createDraftId(), epochValues), repairs };
}
```

Then use this bounded repair loop:

```ts
/** Repairs are committed atomically; stale means re-read + re-parse, never force old intent. */
async function runRecoveryRepairs() {
    if (!resolution.repairs.length || tombstoned) return;
    let repairs = resolution.repairs;
    for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
        const marker = repairs.find((repair) => repair.kind === "write-marker");
        const deleteMarker = repairs.some((repair) => repair.kind === "delete-marker");
        const deleteDraftIds = repairs.flatMap((repair) => (repair.kind === "delete-drafts" ? repair.draftIds : []));
        const outcome = await deps.recovery.commitCoordination(
            {
                scopeId,
                expectedCoordinationRevision: coordinationRevision,
                expectedDeletionGeneration: deletionGeneration,
                marker: marker ? marker.entries : deleteMarker ? null : undefined,
                deleteDraftIds,
            },
            localAbortController.signal,
        );
        if (outcome.status === "committed") {
            coordinationRevision = outcome.coordinationRevision;
            return;
        }
        if (outcome.status === "tombstoned") {
            enterTombstoned();
            return;
        }
        if (outcome.status === "unavailable") {
            if (outcome.reason !== "aborted" || !aborted) markDegraded();
            return;
        }

        const opened = await deps.recovery.readOpenSnapshot(scopeId, localAbortController.signal);
        if (opened.status === "tombstoned") {
            enterTombstoned();
            return;
        }
        if (opened.status === "unavailable") {
            if (opened.reason !== "aborted" || !aborted) markDegraded();
            return;
        }
        const fresh = parseRecoverySnapshot(recoveryLoad(), opened.snapshot, deps.createDraftId);
        coordinationRevision = fresh.expectedCoordinationRevision;
        deletionGeneration = fresh.expectedDeletionGeneration;
        repairs = fresh.repairs;
        /**
         * Never replace installed content in a stale-repair callback. A fresh conflict blocks
         * network saving and updates only the conflict view; content replacement stays behind
         * the user's explicit prepare/commit action.
         */
        if (fresh.phase === "conflict") {
            phase = "conflict";
            conflict = fresh.conflict;
            clearNetworkTimer();
            notify();
        }
        if (!repairs.length) return;
    }
    /** Two stale attempts: preserve every record, report degraded local recovery, never force-delete. */
    markDegraded();
}
```

7. Make tombstone a complete state-machine state and add the view field:

```ts
const ACTIVE_PHASES: CanvasSyncPhase[] = ["clean", "dirty", "saving", "save-error", "conflict", "recovery-blocked"];
type SessionEvent = "install" | "update" | "rename" | "localTick" | "networkTick" | "saveAck" | "saveConflict" | "saveFail" | "retrySave" | "retryRecovery" | "flush" | "hold" | "dispose";
const ALLOWED_PHASES: Record<SessionEvent, CanvasSyncPhase[]> = {
    install: ["loading"],
    update: ACTIVE_PHASES,
    /** rename is an edit event in active phases only; tombstoned returns before this assertion. */
    rename: ACTIVE_PHASES,
    localTick: [...ACTIVE_PHASES, "disposing"],
    networkTick: ["dirty", "saving", "save-error"],
    saveAck: ["saving", "disposing"],
    saveConflict: ["saving", "disposing"],
    saveFail: ["saving", "disposing"],
    retrySave: ["dirty", "save-error"],
    retryRecovery: ["recovery-blocked"],
    /** flush/hold return before assert in tombstoned, but whitelist it as an explicit legal no-op. */
    flush: [...ACTIVE_PHASES, "tombstoned"],
    hold: [...ACTIVE_PHASES, "tombstoned"],
    dispose: [...ACTIVE_PHASES, "loading", "tombstoned"],
};
```

Gate both public edit entrypoints before any mutation or scheduling. In particular, `rename` must not reuse the old guard that omitted tombstoned:

```ts
function rename(nextTitle: string): CanvasRenameOutcome {
    if (held || tombstoned || phase === "loading" || phase === "disposing" || phase === "disposed") return "local-only";
    assertEvent("rename");
    if (nextTitle !== content.title) {
        content = { ...content, title: nextTitle };
        registerEdit();
    }
    return canUseNetwork() ? "scheduled" : "local-only";
}
```

Also make late network completions harmless after an external tombstone:

```ts
function requestOutdated() {
    if (!aborted && phase !== "disposed" && !tombstoned) return false;
    settleAfterRequest();
    return true;
}
```

Every storage outcome/read that reports tombstoned calls the single `enterTombstoned()` helper defined with the counters; that helper clears both schedulers, cancels the network request and session-owned local transactions, empties the slot and publishes `localPersist: "tombstoned"`. In `buildView` add `unavailableKey: tombstoned ? "canvas.recovery.tombstoned" : null` and include `unavailableKey` in the `notify()` field comparison. `update` returns `false` and `rename` returns `local-only` before mutation, `registerEdit` or timer scheduling when tombstoned; `flush` and `holdForDelete` are bounded no-ops; `dispose` is legal and reaches `disposed` without entering invariant failure.

8. Replace `onSaveConflict` / `persistConflictRecords`, `retryRecovery` and `exportConflictDrafts`. These are not adapters around the deleted localforage API; they are first-class CAS paths:

```ts
function validMarkerEntries(snapshot: CanvasRecoveryOpenSnapshot, ownDraftId: string): CanvasConflictMarkerEntry[] {
    const byId = new Map(snapshot.drafts.map((draft) => [draft.draftId, draft] as const));
    return (snapshot.marker?.entries ?? []).filter((entry) => {
        if (entry.draftId === ownDraftId) return false;
        const draft = byId.get(entry.draftId);
        return Boolean(draft) && draft!.state === "pending" && draft!.envelope.document.baseRevision === entry.baseRevision;
    });
}

/**
 * A live 409 first makes its own pending draft durable, then publishes a marker built from
 * one consistent epoch+marker+drafts snapshot. Stale means bounded re-read/retry. After two
 * stale attempts the own pending draft remains recoverable and localPersist becomes degraded.
 */
async function persistConflictRecords(baseRevision: number): Promise<boolean> {
    materialize();
    await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
    for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
        const opened = await deps.recovery.readOpenSnapshot(scopeId, localAbortController.signal);
        if (opened.status === "tombstoned") {
            enterTombstoned();
            return false;
        }
        if (opened.status === "unavailable") {
            if (opened.reason !== "aborted" || !aborted) markDegraded();
            return false;
        }
        const own = opened.snapshot.drafts.find((draft) => draft.draftId === resolution.draftId && draft.state === "pending");
        if (!own) {
            markDegraded();
            return false;
        }
        const ownEntry = { draftId: own.draftId, baseRevision, savedAt: own.savedAt };
        const entries = [ownEntry, ...validMarkerEntries(opened.snapshot, own.draftId)].slice(0, MAX_CONFLICT_MARKER_ENTRIES);
        const outcome = await deps.recovery.commitCoordination(
            {
                scopeId,
                expectedCoordinationRevision: opened.snapshot.epoch.coordinationRevision,
                expectedDeletionGeneration: opened.snapshot.epoch.deletionGeneration,
                marker: entries,
            },
            localAbortController.signal,
        );
        if (outcome.status === "committed") {
            coordinationRevision = outcome.coordinationRevision;
            deletionGeneration = opened.snapshot.epoch.deletionGeneration;
            conflict = conflict ? { ...conflict, extraDraftCount: entries.length - 1 } : conflict;
            notify();
            return true;
        }
        if (outcome.status === "tombstoned") {
            enterTombstoned();
            return false;
        }
        if (outcome.status === "unavailable") {
            if (outcome.reason !== "aborted" || !aborted) markDegraded();
            return false;
        }
        /** stale: loop performs a fresh consistent read and preserves any valid foreign entry. */
    }
    markDegraded();
    return false;
}

async function onSaveConflict(baseRevision: number) {
    if (requestOutdated()) return;
    assertEvent("saveConflict");
    settleAfterRequest();
    clearNetworkTimer();
    conflictBaseRevision = baseRevision;
    conflict = { baseRevision, source: "save", extraDraftCount: 0 };
    if (!tearingDown()) {
        phase = "conflict";
        firstUnsavedEditAt = 0;
        notify();
    }
    await persistConflictRecords(baseRevision);
}
```

Change both network catch sites (normal `startSave` and detached `finalSave`) to await the complete conflict tail:

```ts
const failure = classifyCanvasSaveError(error);
if (failure.kind === "conflict") await guardAsync(() => onSaveConflict(baseRevision), undefined);
else guard(() => onSaveFail(failure), undefined);
```

Recovery retry does not unlock until a fresh parse and every required repair have committed:

```ts
async function retryRecovery(): Promise<CanvasRetryRecoveryResult> {
    if (phase !== "recovery-blocked") return "failed";
    assertEvent("retryRecovery");
    for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
        const opened = await deps.recovery.readOpenSnapshot(scopeId, localAbortController.signal);
        if (opened.status === "unavailable") return "failed"; // phase deliberately remains recovery-blocked
        if (opened.status === "tombstoned") {
            enterTombstoned();
            return "failed";
        }
        const fresh = parseRecoverySnapshot(recoveryLoad(), opened.snapshot, deps.createDraftId);
        let repairs = fresh.repairs;
        let nextConflict = fresh.phase === "conflict" ? fresh.conflict : null;
        /**
         * A same-revision pending draft is safe to restore only before install. During retry the
         * server copy is already installed, so content replacement still requires explicit user
         * choice: promote that draft to a marker and stay in conflict instead of silently unlocking.
         */
        if (fresh.phase === "dirty") {
            const pending = opened.snapshot.drafts.find((draft) => draft.draftId === fresh.draftId && draft.state === "pending");
            if (!pending) return "failed";
            repairs = [{ kind: "write-marker", entries: [{ draftId: pending.draftId, baseRevision: pending.envelope.document.baseRevision, savedAt: pending.savedAt }] }];
            nextConflict = { baseRevision: pending.envelope.document.baseRevision, source: "restored", extraDraftCount: 0 };
        }
        if (repairs.length) {
            const marker = repairs.find((repair) => repair.kind === "write-marker");
            const deleteMarker = repairs.some((repair) => repair.kind === "delete-marker");
            const deleteDraftIds = repairs.flatMap((repair) => (repair.kind === "delete-drafts" ? repair.draftIds : []));
            const outcome = await deps.recovery.commitCoordination(
                {
                    scopeId,
                    expectedCoordinationRevision: fresh.expectedCoordinationRevision,
                    expectedDeletionGeneration: fresh.expectedDeletionGeneration,
                    marker: marker ? marker.entries : deleteMarker ? null : undefined,
                    deleteDraftIds,
                },
                localAbortController.signal,
            );
            if (outcome.status === "stale") continue;
            if (outcome.status === "tombstoned") {
                enterTombstoned();
                return "failed";
            }
            if (outcome.status === "unavailable") return "failed"; // phase deliberately remains recovery-blocked
            coordinationRevision = outcome.coordinationRevision;
        } else {
            coordinationRevision = fresh.expectedCoordinationRevision;
        }
        deletionGeneration = fresh.expectedDeletionGeneration;
        if (nextConflict) {
            phase = "conflict";
            conflict = nextConflict;
            clearNetworkTimer();
            notify();
            return "conflict";
        }
        if (editSeq > savedSeq) {
            phase = "dirty";
            notify();
            await startSave();
        } else {
            phase = "clean";
            notify();
        }
        return "unlocked";
    }
    /** Two stale CAS outcomes: remain blocked; no save and no destructive repair was issued. */
    return "failed";
}
```

Conflict export performs one read and no mutation:

```ts
async function exportConflictDrafts(): Promise<CanvasProject[]> {
    const opened = await deps.recovery.readOpenSnapshot(scopeId, localAbortController.signal);
    /** In-memory own content is only a fallback when the consistent storage snapshot is unavailable. */
    if (opened.status !== "ok") return phase === "conflict" || editSeq > savedSeq ? [content] : [];
    const byId = new Map(opened.snapshot.drafts.map((draft) => [draft.draftId, draft] as const));
    /** Own draft first, then marker order; every exported stored project comes from this one snapshot. */
    const ids = [resolution.draftId, ...(opened.snapshot.marker?.entries.map((entry) => entry.draftId) ?? [])];
    const projects: CanvasProject[] = [];
    for (const draftId of new Set(ids)) {
        if (projects.length >= MAX_CONFLICT_MARKER_ENTRIES) break;
        const draft = byId.get(draftId);
        if (!draft || draft.state !== "pending") continue;
        const markerEntry = opened.snapshot.marker?.entries.find((entry) => entry.draftId === draftId);
        if (markerEntry && markerEntry.baseRevision !== draft.envelope.document.baseRevision) continue;
        projects.push(
            {
                ...draftToProject({ canvasId, title: draft.envelope.document.title, snapshot: draft.envelope.document.snapshot, savedAt: draft.savedAt }),
                viewport: draft.envelope.localUi.viewport,
            },
        );
    }
    /** No marker write, draft delete, GC or coordination revision change occurs here. */
    return projects;
}
```

- [ ] **Step 6: Rewrite the manager's local coordination**

In `web/src/services/canvas-sync/canvas-sync-manager.ts`:

1. Delete `runServerCopyCleanup`, `clearConflictRecovery`, `clearDeletedCanvasRecovery`, `runDeletedCanvasCleanup`, `draftScopeOf` and every `whenLocalSettled` call. Two-phase cleanup existed only because a timed-out localforage write could still land.
   Import `browserCanvasRecoveryStore` and recovery CAS types from `@/services/canvas-recovery/store` / `types`, and import the shared `MAX_COORDINATION_ATTEMPTS` from `canvas-sync/types`; do not redeclare either the retry bound or an ambient factory.
2. Derive the scope id before network load and return a named failure when trusted identity input cannot form a scope:

```ts
type ScopeIdResult =
    | { status: "ready"; scopeId: RecoveryScopeId }
    | { status: "invalid-scope"; messageKey: "canvas.recovery.invalidScope" };

/** Current cloud canvases use account scope; local scope stays reserved for a future local-only entrypoint. */
function scopeIdFor(current: CanvasScope, canvasId: string): ScopeIdResult {
    const scopeId = buildRecoveryScopeId({ kind: "account", userId: current.userId, workspaceId: current.workspaceId, canvasId });
    return scopeId ? { status: "ready", scopeId } : { status: "invalid-scope", messageKey: "canvas.recovery.invalidScope" };
}
```

At the start of `prepare`, after confirming `scope` is non-null and before calling `repository.load`, evaluate `scopeIdFor(current, canvasId)` only to validate the shape. Return `{ status: "failed", messageKey: scopeResult.messageKey }` for `invalid-scope`. The `userId/workspaceId` source is the authenticated manager scope; do not touch recovery until `repository.load` has also returned `load.project.id === canvasId`, which makes the route id server-confirmed. Then pass `scopeResult.scopeId` to both `resolveCanvasOpenRecovery` and `createCanvasSyncSession`. Every delete/GC helper receives the already-derived id; none reconstructs or parses one from a draft key.

3. Replace server-copy cleanup with a bounded re-read/CAS loop that removes superseded conflict drafts, keeps the new session's draft, and never tombstones:

```ts
type ConflictCleanupOutcome = "cleared" | "nothing-to-clear" | "tombstoned" | "retained-stale" | "retained-unavailable";

/**
 * Accepting the server version deletes the conflicting local drafts, which is coordination,
 * not deletion of the canvas: coordinationRevision advances, deletionGeneration and the
 * tombstone are untouched, so a new session can immediately write in the same scope again.
 */
async function clearConflictDrafts(scopeId: RecoveryScopeId, keepDraftId: string, session: CanvasSyncSession): Promise<ConflictCleanupOutcome> {
    for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
        const opened = await deps.recovery.readOpenSnapshot(scopeId);
        if (opened.status === "tombstoned") return "tombstoned";
        if (opened.status === "unavailable") {
            session.reportRecoveryCleanupFailure();
            return "retained-unavailable";
        }
        const draftIds = opened.snapshot.drafts.map((draft) => draft.draftId).filter((draftId) => draftId !== keepDraftId);
        if (!draftIds.length && !opened.snapshot.marker) return "nothing-to-clear";
        const outcome = await deps.recovery.commitCoordination({
            scopeId,
            expectedCoordinationRevision: opened.snapshot.epoch.coordinationRevision,
            expectedDeletionGeneration: opened.snapshot.epoch.deletionGeneration,
            marker: null,
            deleteDraftIds: draftIds,
        });
        if (outcome.status === "committed") return "cleared";
        if (outcome.status === "tombstoned") return "tombstoned";
        if (outcome.status === "unavailable") {
            session.reportRecoveryCleanupFailure();
            return "retained-unavailable";
        }
        /** stale: the next iteration re-reads epoch, marker and drafts together and recalculates every delete target. */
    }
    /** Exactly two stale outcomes: preserve marker/drafts and make the failure visible; never force old delete intent. */
    session.reportRecoveryCleanupFailure();
    return "retained-stale";
}
```

`commitServerCopy` remains synchronous and non-blocking; after installing the server-copy session it starts exactly `void clearConflictDrafts(scopeId, session.draftId, session)`. The helper has two total CAS attempts. A stale first attempt can succeed after re-reading; two stale attempts or any unavailable outcome retain all records and set `localPersist: "degraded"` on the installed session.

4. Replace deleted-canvas cleanup with the deletion CAS, driven only by proof:

```ts
/**
 * Called only after a matching DELETE receipt (or an explicit local-only delete). Generation zero
 * is the only live v1 generation; confirmDeletion re-reads the epoch in its own transaction, so an
 * existing tombstone, nonzero generation or corrupt epoch is rejected rather than overwritten.
 */
async function confirmLocalDeletion(scopeId: RecoveryScopeId): Promise<CanvasDeletionOutcome> {
    return deps.recovery.confirmDeletion(scopeId, 0, deps.now());
}
```

5. In `deleteCanvases`, keep `holdForDelete` / `releaseHold` exactly as they are. After disposing a proven-deleted active session, await `Promise.all` of `confirmLocalDeletion` only for ids whose outcome was `deleted`; derive each account scope through `scopeIdFor` and skip an invalid result rather than inventing a key. The method does not report an id in `deleted` until the bounded local tombstone attempt has returned. For `denied` and `indeterminate`, release the hold and leave every local record in place; they never enter this array.
6. Replace `collectDraftGarbage` with a GC that carries the epoch it read and skips entirely when the snapshot is unreadable:

```ts
async function collectDraftGarbage(session: CanvasSyncSession, scopeId: RecoveryScopeId) {
    const opened = await deps.recovery.readOpenSnapshot(scopeId);
    /** Unknown marker ownership must never degrade into "no marker": skip GC entirely. */
    if (opened.status !== "ok") return;
    await deps.recovery.collectGarbage({
        scopeId,
        expectedCoordinationRevision: opened.snapshot.epoch.coordinationRevision,
        expectedDeletionGeneration: opened.snapshot.epoch.deletionGeneration,
        keepDraftIds: [session.draftId, ...(opened.snapshot.marker?.entries.map((entry) => entry.draftId) ?? [])],
        now: deps.now(),
        minAgeMs: DRAFT_GC_MIN_AGE_MS,
    });
}
```

7. Change `CanvasSyncSession.draftKey` to `draftId` (the scope now lives in the record key) and update the module-level singleton to use the lazy browser adapter. Importing the manager in Node must neither evaluate an unbound identifier nor consult the ambient factory:

```ts
export const canvasSyncManager = createCanvasSyncManager({
    repository: canvasRepository,
    /** Safe at module import; its first real operation lazily reads globalThis.indexedDB. */
    recovery: browserCanvasRecoveryStore,
    now: () => Date.now(),
    createDraftId: () => nanoid(),
    isDev: import.meta.env.DEV,
});
```

- [ ] **Step 7: Run the sync suite until green**

Run: `cd web && ./node_modules/.bin/vitest run src/services/canvas-sync`
Expected: session 12 passed, manager 10 passed.

Then run everything: `cd web && ./node_modules/.bin/vitest run` — expected: 9 files and 74 passed (recovery 43, repository 9, sync 22).

Fake-green checks, each reverted before continuing:

- Remove `localUiSeq += 1`: the pure pan/zoom persistence test must fail while the cloud-save assertion remains zero.
- Serialize `content.viewport` in `startSave`: the pan-then-node-edit test must fail on `snapshot.viewport`.
- Remove `tombstoned` from the early `rename` guard: the tombstoned-session test must fail on unchanged title/no-upsert and must expose the forbidden phase or save-error transition after the local timer advances.
- Reduce `MAX_COORDINATION_ATTEMPTS` to 1: the live-409 marker race, `retryRecovery` stale re-parse, and accept-server cleanup race must fail.
- Change failed `retryRecovery` to set `phase = "clean"`: the blocked-state test must fail and the save spy must remain untouched.
- Replace `browserCanvasRecoveryStore` in the singleton with `createCanvasRecoveryStore(createRecoveryDatabase(indexedDB))`: importing the manager suite in Node must fail before any test body, proving the lazy global access is required.
- Make `confirmLocalDeletion` run for every delete outcome: the denied/indeterminate matrix must fail on its first row.

Restore each mutation and rerun the sync suite to 22 passed.

- [ ] **Step 8: Commit**

```bash
git add web/src/services/canvas-sync/types.ts web/src/services/canvas-sync/canvas-sync-session.ts web/src/services/canvas-sync/canvas-sync-manager.ts web/src/services/canvas-sync/canvas-sync-session.test.ts web/src/services/canvas-sync/canvas-sync-manager.test.ts
git commit -m "feat: move canvas sync onto transactional recovery CAS and drop late-write compensation"
```

---

## Task 7: Remove The Legacy Module, Wire Consumers, Record The Manual Matrix

**Files:**
- Verify: `AGENTS.md` (retain the explicit native-IndexedDB exception for canvas recovery)
- Delete: `web/src/services/canvas-local-recovery.ts`
- Modify: `web/src/main.tsx` (call the explicit upgrade once)
- Modify: `web/src/stores/canvas/use-canvas-store.ts`, `web/src/pages/canvas/project.tsx`, `web/src/components/canvas/canvas-save-status.tsx`, `web/src/components/canvas/canvas-delete-projects-dialog.tsx`
- Modify: `web/src/i18n/locales/zh-CN.ts`, `web/src/i18n/locales/en-US.ts`
- Modify: `CHANGELOG.md`, `docs/content/docs/progress/todo.mdx` (+ `.zh-CN.mdx`), `docs/content/docs/progress/pending-test.mdx` (+ `.zh-CN.mdx`)

**Interfaces:**
- Consumes: `upgradeRecoveryStorage` (Task 4), the new view fields and patch split (Task 6).
- Produces: no new module interface. After this task `rg "canvas-local-recovery|whenLocalSettled|CanvasLocalWrite|deleteMarkerIfOwned" web/src` returns nothing.

- [ ] **Step 1: Preserve the project-level native IndexedDB exception**

Verify only—do not edit `AGENTS.md`. The repository already contains this exact exception to the general localforage preference:

```markdown
- 画布未同步草稿恢复是 `localforage` 默认规则的明确例外：必须使用独立原生 IndexedDB 数据库和同一事务内的 CAS，不得与普通缓存共用数据库版本、对象仓库或事务语义。
```

Run: ``rg -n -F '画布未同步草稿恢复是 `localforage` 默认规则的明确例外：必须使用独立原生 IndexedDB 数据库和同一事务内的 CAS' AGENTS.md`` — expected: exactly one match. A zero or duplicate match stops Task 7 for a plan/repository reconciliation; it does not authorize adding a second rule.

- [ ] **Step 2: Prove the legacy module is unreferenced, then delete it**

Run: `cd web && rg -n "canvas-local-recovery|CanvasLocalRecovery|CanvasLocalWrite|whenLocalSettled|deleteMarkerIfOwned|canvasDraftKey" src`

Expected RED: only `src/services/canvas-local-recovery.ts` itself matches, so the final zero-match removal invariant is not green yet. If anything else matches, Task 6 is incomplete — fix that first; do not add a shim.

Then: `git rm web/src/services/canvas-local-recovery.ts`

- [ ] **Step 3: Call the explicit upgrade once at the app entry point**

In `web/src/main.tsx`, next to the existing `initAnalytics()` call:

```tsx
import localforage from "localforage";

import { upgradeRecoveryStorage } from "@/services/canvas-recovery/bootstrap";

/**
 * One explicit, idempotent upgrade action. It only drops the legacy localforage recovery store;
 * it never reads or uploads legacy drafts. The project is unreleased, so nothing is migrated.
 * Deliberately not awaited and deliberately not inside the recovery store: importing the
 * recovery layer must never mutate storage.
 */
void upgradeRecoveryStorage({
    storage: window.localStorage,
    /** An isolated instance is required: the default instance is already configured for app_state. */
    dropLegacy: () => localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_recovery" }).dropInstance({ name: "infinite-canvas", storeName: "canvas_recovery" }),
});
```

- [ ] **Step 4: Add the copy keys**

In `web/src/i18n/locales/zh-CN.ts`, inside the existing `canvas` object, add a `delete` group and a `recovery` group next to the existing `save` group:

```ts
        delete: {
            unavailable: "服务端拒绝了删除请求，本地草稿已保留",
            unconfirmed: "无法确认删除是否完成，本地草稿已保留",
        },
        recovery: {
            invalidScope: "无法建立可信的画布恢复作用域，本地草稿功能不可用",
            tombstoned: "该画布已删除，本地草稿不再保留；如需找回内容请新建画布",
        },
```

In `web/src/i18n/locales/en-US.ts` add the English peers at the same path:

```ts
        delete: {
            unavailable: "The server refused the delete request. Your local draft is kept.",
            unconfirmed: "We could not confirm the delete completed. Your local draft is kept.",
        },
        recovery: {
            invalidScope: "A trusted canvas recovery scope could not be created. Local draft recovery is unavailable.",
            tombstoned: "This canvas was deleted, so its local draft is gone. Create a new canvas to keep working.",
        },
```

- [ ] **Step 5: Keep viewport out of the document save path in the page**

In `web/src/pages/canvas/project.tsx` the effect at roughly line 531 already calls `updateProject(projectId, { viewport })`. Leave that call exactly as it is: after Task 6 the session routes `viewport` into the local-UI channel, so panning persists locally and does not schedule a cloud save. Add the clarifying comment so a later reader does not "optimise" it back into the document patch:

```tsx
        /** Viewport is a local UI preference: the session stores it in the draft envelope and never sends it to the cloud. */
        updateProject(projectId, { viewport });
```

- [ ] **Step 6: Surface controlled-unavailable instead of a silent failure**

In `web/src/components/canvas/canvas-save-status.tsx`, render the tombstoned state from the view field rather than inferring it:

```tsx
    /** The session reports this directly; the component never guesses whether the canvas still exists. */
    if (sync.unavailableKey) return <span className="text-xs opacity-70">{t(sync.unavailableKey)}</span>;
```

In `web/src/components/canvas/canvas-delete-projects-dialog.tsx`, the existing `failed` branch already keeps failed ids selected. Change only its message so a refused or unconfirmed delete does not read as a generic error:

```tsx
                message.error(t("canvas.delete.unconfirmed"));
```

- [ ] **Step 7: Run the full scoped suite**

Run: `cd web && ./node_modules/.bin/vitest run`
Expected: 9 files, 74 passed (database 7, scope 5, types 5, store-draft 12, store-coordination 11, bootstrap 3, repository 9, session 12, manager 10).

Then run the Task 7 static GREEN checks:

```bash
cd web
! rg -n "canvas-local-recovery|CanvasLocalRecovery|CanvasLocalWrite|whenLocalSettled|deleteMarkerIfOwned|canvasDraftKey" src
rg -n "void upgradeRecoveryStorage" src/main.tsx
rg -n 'storeName: "canvas_recovery"' src/main.tsx
cd ..
rg -n -F '画布未同步草稿恢复是 `localforage` 默认规则的明确例外：必须使用独立原生 IndexedDB 数据库和同一事务内的 CAS' AGENTS.md
```

Expected: the negative search has zero matches; each positive search has exactly one match. Fake-green checks: temporarily remove the `void upgradeRecoveryStorage(...)` invocation and confirm its positive search has zero matches, then restore it. Temporarily restore one legacy import and confirm the negative search exits nonzero, then remove it again. For the verify-only AGENTS check, run the same fixed-string command with `CAS-not-present` in its needle and require zero matches; do not edit AGENTS. Only the restored implementation state may be committed.

- [ ] **Step 8: Record the change and the remaining work**

In `CHANGELOG.md` under `Unreleased` append exactly one line:

```markdown
- [调整] 画布未同步草稿恢复改用独立原生 IndexedDB 数据库与同事务 CAS，删除本地草稿前必须先拿到匹配的云端删除回执，平移缩放不再触发云端保存。
```

In both `docs/content/docs/progress/pending-test.mdx` and `pending-test.zh-CN.mdx` add the testable changes: the independent recovery database, per-draft CAS, deletion-receipt gating, coordination-only cleanup on accept-server-version, viewport as local preference, and the explicit legacy drop.

In both `docs/content/docs/progress/todo.mdx` and `todo.zh-CN.mdx`: move the "native IndexedDB CAS" item out of todo into pending-test, and leave the three-browser matrix and user typecheck as still-open items. Do not claim Gate 0 is closed and do not describe local drafts as cloud-synced.

- [ ] **Step 9: Commit**

```bash
git add web/src CHANGELOG.md docs/content/docs/progress
git commit -m "refactor: remove legacy localforage canvas recovery and wire transactional recovery consumers"
```

---

## Manual Browser Verification Matrix (Human Only)

fake-indexeddb proves single-process API semantics and nothing more. It cannot prove real `versionchange` / `blocked` behaviour, real durability across a process kill, real cross-tab scheduling, real quota limits or real background throttling. No automated test in this plan may be described as covering the rows below, and no agent may mark them done.

The user runs each row in Chrome, Firefox and Safari from a standalone test page opened in a new tab. Never close or reuse a tab the user already has open.

| Row | Scenario | Pass condition |
|---|---|---|
| 1 | Two tabs of the same canvas, both editing | Both drafts survive; the conflict entry point appears; no draft is silently overwritten |
| 2 | Second tab triggers a version upgrade | The first connection closes on `versionchange`; the upgrade is never stuck on `blocked` |
| 3 | Kill the tab process mid-edit | On reopen the last committed draft is present and no partially written record exists |
| 4 | Hard refresh during a save | Draft state is either the old or the new committed value, never a mixture |
| 5 | Cross-tab race on the same draft | One writer wins; the loser observes `superseded` and retries; no lost update |
| 6 | Private/incognito mode and a quota failure | The canvas still opens, cloud saving still works, and the UI shows the degraded local state honestly |
| 7 | Background-throttled tab left for several minutes | No unbounded wait; deadlines still abort; no late write appears after returning |
| 8 | Confirmed delete, then an old tab tries to save | No draft reappears for the tombstoned canvas |
| 9 | Delete with the network disconnected | No tombstone, drafts intact, controlled-unavailable message shown |
| 10 | Log out and log in as another account | The other identity's drafts are invisible and are not garbage collected |

Gate 0 cannot close until all three browsers have actually been run, results and failure screenshots are archived, and the user's own `web` typecheck result is recorded.

---

## Self-Review

**1. Spec coverage.** Every §11 and §16 requirement maps to a task:

| Spec requirement | Task |
|---|---|
| Independent `infinite-canvas-recovery` v1, three fixed stores, not a localforage instance | 1 |
| Fixed keyPaths and scope-limited enumeration | 1 (schema), 3-4 (exact-key index reads) |
| Injected `IDBFactory`, no ambient `indexedDB` / `IDBKeyRange`, no import-time side effects, bounded `blocked`, `versionchange` closes | 1, 3-4 |
| `RecoveryScopeId` local/account shapes from trusted sources; no cross-scope access | 2 (construction), 3-4 (every operation scope-bound), 6 (manager derives it) |
| Gate 1/2 add account scope without changing stores or keys | 2 (both shapes exist in v1) |
| Epoch separates `coordinationRevision` / `deletionGeneration` / `tombstonedAt` | 2 (record), 3-4 (semantics) |
| Per-draft monotonic `writeSeq`; upsert/ack does not touch coordination | 3, 6 |
| Marker/repair/foreign-delete/GC use expected coordination + generation CAS | 4, 6 |
| One transaction per bounded operation; deadline aborts; no non-IDB await inside | 1 |
| Legal finite request-loop proof that deadline/owner abort rolls back and cannot late-commit | 1 |
| No delete from an outside read | 4 (re-read in the deleting transaction) |
| Open reads epoch + marker + drafts in one readonly transaction | 3 |
| Results always carry `repairs` via constructors; stale repairs re-resolve | 6 |
| Live-409 marker merge, recovery retry and accept-server cleanup all re-read/retry stale CAS twice | 6 |
| GC re-verifies age, marker references and epoch | 4 |
| Corrupt data fails closed with explicit rules | 2 (validators), 3 (skip bad rows), 4 (delete corrupt rows at owned keys) |
| DELETE returns a receipt; only a matching positive receipt permits a tombstone | 5, 6 |
| 404 / non-active / removed / network / timeout / unknown never clean up | 5 (matrix), 6 (manager) |
| Single transaction: bump generation + tombstone + delete drafts/markers; late writes cannot resurrect | 4, 6 |
| Legacy store dropped only by explicit upgrade; no dual read, no auto-upload, no import-time drop | 4, 7 |
| `CanvasLocalWrite` / `whenLocalSettled` / two-phase cleanup deleted; Session/Manager/prepare/commit/bounded slot kept | 6 |
| Envelope splits document / local UI / assets; local-UI counters persist pan/zoom independently | 2 (shape), 6 (scheduler/counters), 7 (page wiring) |
| Frozen canonical default viewport survives pan-then-document-save; no Yjs | 6 |
| Browser singleton is Node-import-safe and consults `globalThis.indexedDB` only on first operation | 4, 6 |
| Current cloud wiring uses account scope; local scope remains a same-schema unconnected reservation | Global constraints, 2, 6 |
| Scoped Vitest + fake-indexeddb covering the full concurrency list | 1-6 |
| Three-browser matrix stays human | Manual matrix section |

**2. Completeness scan.** The plan contains no unresolved markers or deferred shorthand. Every code step carries real code; every error path names its outcome (`superseded`, `tombstoned`, `generation-changed`, `stale`, `denied`, `indeterminate`, `unavailable` + `RecoveryFailureReason`) rather than a generic error instruction.

**3. Type consistency.** Checked across tasks: `RecoveryScopeId` is the only scope type after Task 2 and is used unchanged in 3-7. `readOpenSnapshot` / `upsertDraft` / `commitCoordination` / `confirmDeletion` / `collectGarbage` keep the same optional owner signal and outcome signatures everywhere. `RecoveryFailureReason` includes `unsupported` in every declaration. `CanvasDeleteOutcome` is produced in Task 5 and consumed in Tasks 5-6 with the same three statuses; the distinct storage `CanvasDeletionOutcome` cannot be mistaken for HTTP proof. `draftKey` becomes `draftId` in exactly one place (Task 6) and every later reference uses `draftId`. `CANVAS_PATCH_FIELDS` is fully replaced by the two split constants; no task references the old name after Task 6. Marker entries lose `draftKey` in Task 2 and no later task reintroduces it. Recovery owns `RECOVERY_TRANSACTION_TIMEOUT_MS` and `MAX_CONFLICT_MARKER_ENTRIES`; sync types only re-export the marker cap at switch time. `MAX_COORDINATION_ATTEMPTS` is defined once in sync types and imported by session and manager.

**4. Upgrade and rollback.** Forward: the legacy store is dropped once by an explicit action recorded under `canvas-recovery-upgrade`; a failed drop is not recorded, so it retries. The new database starts empty, which is correct because the project is unreleased and no legacy data is migrated. Rollback: reverting Tasks 6-7 restores the localforage module from git, but any drafts written into `infinite-canvas-recovery` afterwards are not visible to it, and the legacy store may already be dropped. So rollback is code-only and loses local drafts created after the switch; it is acceptable pre-release and is stated here rather than assumed. Tombstones are intentionally durable: a rolled-back client will not resurrect a deleted canvas.

**5. Cross-task deployability.** Tasks 1-4 add files no production entrypoint imports, so each is shippable and reviewable alone. Task 5 changes the HTTP/repository DELETE contract and the manager proof gate together; it narrows what the still-active legacy cleanup may believe, so it is deployable without a tombstone store. Task 6 is the single protocol switch: session, manager and their shared types change together, the lazy singleton is safe in browser and Node, and the legacy module becomes unreferenced in that same commit. Task 7 then deletes that unreferenced module, runs only the explicit legacy drop at bootstrap, and finishes copy and docs. No task compiles against half an interface or leaves two active persistence protocols.

**6. Test inventory.** The final scoped suite has exactly 9 files and 74 tests: database 7, scope 5, record types 5, draft store 12, coordination store 11, bootstrap 3, repository 9, session 12 and manager 10. Task 5's one-case legacy manager file is replaced by Task 6's 10-case transactional manager file, not added to it. fake-indexeddb assertions cover API-level races only; none is credited to the three-browser matrix.
