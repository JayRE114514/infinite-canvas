### Task 6: Snapshot `document_mode` Contract and Locked Save Ordering

**Files:**
- Create: `server/migrations/0006_canvas_document_mode.sql`
- Modify: `server/migrations/meta/_journal.json`
- Generate: `server/migrations/meta/0006_snapshot.json`
- Modify: `server/src/modules/canvases/schema.ts`
- Modify: `server/src/modules/canvases/service.ts`
- Modify: `server/src/modules/canvases/routes.ts`
- Modify: `packages/contracts/src/canvases.ts`
- Modify: `server/test/canvases/schema.test.ts`
- Modify: `server/test/canvases/routes.test.ts`
- Modify: `server/test/database/migration-upgrade.test.ts`
- Modify: `server/test/database/tenant-isolation.test.ts`

**Interfaces:**
- Produces: `type CanvasDocumentMode = "snapshot" | "collaborative"` and read-only `documentMode` in Canvas/summary responses.
- Produces: `CanvasDeletionReceipt = { canvasId, deletionReceipt, deletedAt }`; first soft-delete and authorized idempotent replay return the same durable receipt.
- Produces: internal `CanvasSaveInvariantError` carrying Canvas ID, Workspace ID, and expected revision for route-level structured logging; it is never serialized verbatim.
- Produces: `canvas_document_mode_mismatch` with HTTP 409.
- Preserves: `canvas_not_found` before mode checks and `revision_conflict` after mode checks.
- Consumes: Task 4 `AppTransaction` service boundary and Canvas RLS.

- [ ] **Step 1: Write mode and error-order tests**

```ts
it("returns read-only snapshot mode and rejects client mode input", async () => {
    const created = await createCanvasAsOwnerRaw();
    expect(created.json().canvas.documentMode).toBe("snapshot");
    const response = await rawCreate({ title: "x", snapshot: {}, documentMode: "collaborative" });
    expect(response.statusCode).toBe(400);
});

it("returns a durable deletion receipt instead of generic success", async () => {
    const response = await deleteCanvasRaw(canvasId);
    expect(response.json()).toEqual({ canvasId, deletionReceipt: expect.any(String), deletedAt: expect.any(String) });
});
```

These first tests use only existing routes and raw JSON, so they compile and reach assertion failures: `documentMode`/receipt are absent today. Retain the existing concurrent same-base save test and require exactly one winner.

After Step 3 creates the columns, add deletion tests proving the first DELETE sets `deleted_at` and `deletion_receipt_id` atomically, replay through the same active Workspace authorization returns byte-for-byte the same receipt without another state change, ordinary GET/LIST 404 responses contain no receipt, and cross-Workspace, removed-member, suspended/deactivated-Workspace, network/error fixtures never produce a receipt. Direct schema tests reject rows where only one of `deleted_at` and `deletion_receipt_id` is set and reject duplicate receipts.

Because Canvas is `FORCE ROW LEVEL SECURITY` and `schema_owner` has no bypass, arrangement-only mode/deletion fixtures use the isolated Testcontainers administrator and assert the affected row count. Every behavior assertion still runs through production-equivalent `app_api`; no schema-owner policy, BYPASSRLS attribute, or persistent `NO FORCE` escape is added.

- [ ] **Step 2: Run Canvas tests and verify RED**

Run: `bun --cwd server run test -- test/canvases/schema.test.ts test/canvases/routes.test.ts`

Expected: FAIL at the public JSON assertions because response fields do not exist; no SQL setup references future columns.

- [ ] **Step 3: Add the column and read-only contract**

Migration:

```sql
ALTER TABLE public.canvases
    ADD COLUMN document_mode text NOT NULL DEFAULT 'snapshot',
    ADD COLUMN deletion_receipt_id uuid;

ALTER TABLE public.canvases NO FORCE ROW LEVEL SECURITY;
DO $backfill$
DECLARE expected_count bigint; affected_count bigint;
BEGIN
    SELECT count(*) INTO expected_count
    FROM public.canvases WHERE deleted_at IS NOT NULL AND deletion_receipt_id IS NULL;
    UPDATE public.canvases SET deletion_receipt_id = gen_random_uuid()
    WHERE deleted_at IS NOT NULL AND deletion_receipt_id IS NULL;
    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count <> expected_count THEN RAISE EXCEPTION 'canvas receipt backfill count mismatch'; END IF;
END
$backfill$;
ALTER TABLE public.canvases FORCE ROW LEVEL SECURITY;

ALTER TABLE public.canvases
    ADD CONSTRAINT canvases_document_mode_check
        CHECK (document_mode IN ('snapshot', 'collaborative')),
    ADD CONSTRAINT canvases_deletion_state_check
        CHECK ((deleted_at IS NULL) = (deletion_receipt_id IS NULL)),
    ADD CONSTRAINT canvases_deletion_receipt_unique UNIQUE (deletion_receipt_id);
```

Update the Drizzle schema and run `bun --cwd server run db:generate -- --name canvas_document_mode` after the committed 0005 journal entry so Drizzle generates `0006_canvas_document_mode.sql`, `0006_snapshot.json`, and the index-6 journal entry together. Never rename, overwrite, or regenerate committed 0005. Review the generated order: add the columns first; in the same migration transaction temporarily set Canvas `NO FORCE ROW LEVEL SECURITY`, backfill `gen_random_uuid()` only for pre-release rows already having `deleted_at`, assert the affected count equals the pre-count and no deletion-state mismatch remains, then restore `FORCE ROW LEVEL SECURITY` before adding the coherence/unique constraints. Transaction rollback restores the original FORCE state on any failure. The final schema has `document_mode`, nullable unique `deletion_receipt_id uuid`, and a CHECK requiring `deleted_at` and the receipt to be either both null or both non-null.

Extend `migration-upgrade.test.ts` with the exact index-6 journal entry and assert `snapshot6.prevId === snapshot5.id`. Retain the existing `snapshot5.prevId === snapshot4.id` and normalized 0004/0005 schema-equivalence assertions. Assert `document_mode`, `deletion_receipt_id`, `canvases_document_mode_check`, `canvases_deletion_state_check`, and `canvases_deletion_receipt_unique` are absent from 0005 and present with their final definitions only in 0006. Fresh-install and legacy-owner upgrade paths must both apply through 0006 without changing any earlier SQL, snapshot ID, journal timestamp, or tag.

Maintenance receives no Canvas privilege in Gate 0, so `document_mode` does not expand its allowlist. Contracts include `documentMode` in `CanvasSchema` and `CanvasSummarySchema`, but neither `CreateCanvasBodySchema` nor `SaveCanvasRequestSchema` contains it; `additionalProperties: false` rejects attempts to mutate it. The DELETE response alone exposes `deletionReceipt`; normal Canvas summaries/details never do.

- [ ] **Step 4: Write post-migration ordering RED tests, then lock and validate save state**

With columns now present, write and run the behavior test before changing save/delete services:

```ts
it("checks visibility, mode, then revision under one row lock", async () => {
    await setModeAsContainerAdmin(canvasId, "collaborative");
    await expect(save({ canvasId, baseRevision: 999 })).rejects.toMatchObject({ code: "canvas_document_mode_mismatch" });
    await softDeleteAsContainerAdmin(canvasId);
    await expect(save({ canvasId, baseRevision: 999 })).rejects.toMatchObject({ code: "canvas_not_found" });
});
```

Expected RED: current save returns the wrong application error after all fixture SQL succeeds. Then implement the fixed order below.

`saveCanvas(tx, access, canvasId, input)` first selects the visible row with `workspace_id`, `deleted_at`, `document_mode`, and `revision` `FOR UPDATE`. It throws:

1. `404 canvas_not_found` when invisible, missing, or deleted;
2. `409 canvas_document_mode_mismatch` when mode is not `snapshot`;
3. `409 revision_conflict` when `revision !== baseRevision`, including input `Number.MAX_SAFE_INTEGER` against a lower stored revision;
4. `409 canvas_revision_limit_reached` only when stored revision and `baseRevision` are both `Number.MAX_SAFE_INTEGER`.

Only then update with an explicit `WHERE id = ? AND workspace_id = ? AND document_mode = 'snapshot' AND revision = ? AND deleted_at IS NULL`, increment revision, and return the row. If that update returns zero rows after the locked checks succeeded, throw internal `CanvasSaveInvariantError` carrying Canvas/Workspace/revision diagnostics. The route catches that type, calls `request.log.error({ requestId: request.id, canvasId, workspaceId, expectedRevision, err }, "canvas save invariant failed")`, and rethrows the stable `canvas_save_invariant_failed` 500 so the transaction rolls back; it never re-queries and guesses a user-facing 409. A logger-spy route test forces the zero-row condition and asserts every structured field plus the sanitized HTTP response. Create always writes `document_mode = 'snapshot'` explicitly.

`deleteCanvas` runs under the same tenant authorization, locks by `id + workspace_id` even when already soft-deleted, and maps an invisible row to ordinary `canvas_not_found`. For an active row it generates one UUID and writes `deleted_at` plus `deletion_receipt_id` in one conditional update; for an already deleted row it returns the stored values. A zero-row update after the lock is an internal invariant failure, not a guessed 404. No GET/LIST path can serialize `deletionReceipt`.

- [ ] **Step 5: Run Canvas and tenant-isolation tests to verify GREEN**

Run:

```bash
bun --cwd server run test -- test/canvases/schema.test.ts test/canvases/routes.test.ts test/database/tenant-isolation.test.ts
```

Expected: PASS; mode is immutable through normal APIs, stable error ordering holds, safe-integer precedence is exact, concurrent revision behavior remains linearizable, and DELETE receipt replay is durable and cannot be inferred from a normal 404.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/canvases.ts server
git commit -m "feat: lock Canvas snapshot mode and deletion receipt"
```

---
