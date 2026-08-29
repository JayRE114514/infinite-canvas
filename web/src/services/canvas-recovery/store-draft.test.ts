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
        expect(await store.upsertDraft({ scopeId: scopeA, draftId: "d3", writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope: envelope("newest"), savedAt: farFuture })).toEqual({
            status: "written",
            writeSeq: 1,
        });
        const tiedSavedAt = new Date(5_000).toISOString();
        for (const draftId of ["A", "a"]) {
            expect(await store.upsertDraft({ scopeId: scopeA, draftId, writeSeq: 1, expectedDeletionGeneration: 0, state: "pending", envelope: envelope(draftId), savedAt: tiedSavedAt })).toEqual({
                status: "written",
                writeSeq: 1,
            });
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
            const input: CanvasDraftUpsertInput = {
                scopeId: scopeA,
                draftId: "placeholder",
                writeSeq: 1,
                expectedDeletionGeneration: 0,
                state: "pending",
                envelope: envelope("valid"),
                savedAt: new Date(1_000).toISOString(),
                ...override,
            };
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
