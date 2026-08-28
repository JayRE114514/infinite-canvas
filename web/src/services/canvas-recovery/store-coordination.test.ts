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
