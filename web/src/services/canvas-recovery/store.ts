import { createRecoveryDatabase, DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE, RECOVERY_TRANSACTION_TIMEOUT_MS, SCOPE_INDEX, type RecoveryDatabase, type RecoveryFailureReason, type RecoveryTxn } from "./database";
import type { RecoveryScopeId } from "./scope";
import {
    asDraftRecord,
    asEpoch,
    asMarkerRecord,
    CONFLICT_MARKER_ID,
    initialEpoch,
    isRecoveryCount,
    MAX_CONFLICT_MARKER_ENTRIES,
    type CanvasConflictMarkerEntry,
    type CanvasConflictMarkerRecord,
    type CanvasCoordinationOutcome,
    type CanvasDeletionOutcome,
    type CanvasDraftEnvelope,
    type CanvasDraftRecord,
    type CanvasDraftState,
    type CanvasDraftWriteOutcome,
    type CanvasRecoveryEpoch,
} from "./types";

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

export type CanvasRecoveryStore = {
    readOpenSnapshot(scopeId: RecoveryScopeId, signal?: AbortSignal): Promise<CanvasRecoveryOpenResult>;
    upsertDraft(input: CanvasDraftUpsertInput, signal?: AbortSignal): Promise<CanvasDraftWriteOutcome>;
    commitCoordination(input: CanvasCoordinationInput, signal?: AbortSignal): Promise<CanvasCoordinationOutcome>;
    confirmDeletion(scopeId: RecoveryScopeId, expectedDeletionGeneration: number, now: number, signal?: AbortSignal): Promise<CanvasDeletionOutcome>;
    collectGarbage(input: CanvasGarbageInput, signal?: AbortSignal): Promise<CanvasCoordinationOutcome>;
    close(): void;
};

type EpochReadResult = { status: "ok"; epoch: CanvasRecoveryEpoch } | { status: "corrupt" };

const CORRUPT = { status: "unavailable", reason: "corrupt" } as const;
/** The widest instant Date can represent; anything beyond it has no canonical ISO form. */
const MAX_TIME_VALUE_MS = 8.64e15;

/**
 * Caller-owned data is detached HERE, synchronously, before the first await. A caller that keeps
 * a reference and mutates it while an open or epoch request is still pending therefore cannot
 * change what this transaction validates or stores. An uncloneable value is a controlled corrupt
 * outcome, never an escaping DataCloneError.
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
 * Every epoch this store writes passes the SAME validator that rejects epochs on read, so an
 * increment at the safe-integer ceiling is refused instead of persisting a row a later open
 * would treat as corrupt. Callers must run this before their first write to stay all-or-nothing.
 */
function nextEpoch(epoch: CanvasRecoveryEpoch, changes: Partial<CanvasRecoveryEpoch>): CanvasRecoveryEpoch | null {
    return asEpoch({ ...epoch, ...changes }, epoch.scopeId);
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
            const run = await database.run(
                "readonly",
                [EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE],
                RECOVERY_TRANSACTION_TIMEOUT_MS,
                async (txn): Promise<CanvasRecoveryOpenResult> => {
                    const epochRead = await readEpoch(txn, scopeId);
                    if (epochRead.status === "corrupt") return { status: "unavailable", reason: "corrupt" };
                    const epoch = epochRead.epoch;
                    if (epoch.tombstonedAt) return { status: "tombstoned", deletionGeneration: epoch.deletionGeneration };
                    const markerRaw = await txn.req(txn.store(MARKERS_STORE).get([scopeId, CONFLICT_MARKER_ID]));
                    const marker = asMarkerRecord(markerRaw, scopeId);
                    /** A present but invalid marker has unknown ownership; fail closed instead of treating it as absent. */
                    if (markerRaw !== undefined && !marker) return { status: "unavailable", reason: "corrupt" };
                    return { status: "ok", snapshot: { epoch, marker, drafts: await readScopeDrafts(txn, scopeId) } };
                },
                signal,
            );
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
             * deletionGeneration is the expected one; the write only proceeds when the stored
             * epoch still agrees with it, so the validated candidate is exactly what is stored.
             */
            const candidate = detach({
                scopeId: input.scopeId,
                draftId: input.draftId,
                writeSeq: input.writeSeq,
                deletionGeneration: input.expectedDeletionGeneration,
                state: input.state,
                envelope: input.envelope,
                savedAt: input.savedAt,
            });
            const record = candidate && asDraftRecord(candidate, input.scopeId);
            if (!record) return CORRUPT;

            const run = await database.run(
                "readwrite",
                [EPOCHS_STORE, DRAFTS_STORE],
                RECOVERY_TRANSACTION_TIMEOUT_MS,
                async (txn): Promise<CanvasDraftWriteOutcome> => {
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
                    await txn.req(txn.store(DRAFTS_STORE).put(record));
                    return { status: "written", writeSeq: record.writeSeq };
                },
                signal,
            );
            return run.status === "ok" ? run.value : { status: "unavailable", reason: run.reason };
        },

        /**
         * Every non-private mutation: marker changes, foreign/own draft deletes and repair commits.
         * Verifies BOTH expected epoch values in the same transaction, then advances coordinationRevision by 1.
         * It never writes a tombstone and never touches deletionGeneration.
         */
        commitCoordination: async (input, signal) => {
            if (!isRecoveryCount(input.expectedCoordinationRevision) || !isRecoveryCount(input.expectedDeletionGeneration)) return CORRUPT;
            /** Detached and validated before the first await: the caller cannot mutate what gets stored. */
            let marker: CanvasConflictMarkerRecord | null = null;
            if (input.marker) {
                const cloned = detach(input.marker);
                const candidate = cloned && asMarkerRecord({ scopeId: input.scopeId, markerId: CONFLICT_MARKER_ID, entries: cloned }, input.scopeId);
                if (!candidate || candidate.entries.length > MAX_CONFLICT_MARKER_ENTRIES) return CORRUPT;
                marker = candidate;
            }
            const deleteDraftIds = detach(input.deleteDraftIds ?? []);
            if (!deleteDraftIds || !deleteDraftIds.every(isDraftId)) return CORRUPT;

            const run = await database.run(
                "readwrite",
                [EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE],
                RECOVERY_TRANSACTION_TIMEOUT_MS,
                async (txn): Promise<CanvasCoordinationOutcome> => {
                    const epochRead = await readEpoch(txn, input.scopeId);
                    if (epochRead.status === "corrupt") return CORRUPT;
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
                        if (storedRaw !== undefined && !stored) return CORRUPT;
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
                },
                signal,
            );
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
            const run = await database.run(
                "readwrite",
                [EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE],
                RECOVERY_TRANSACTION_TIMEOUT_MS,
                async (txn): Promise<CanvasDeletionOutcome> => {
                    const epochRead = await readEpoch(txn, scopeId);
                    if (epochRead.status === "corrupt") return CORRUPT;
                    const epoch = epochRead.epoch;
                    /** A present tombstone alone is proof the deletion already happened, whatever the caller expected. */
                    if (epoch.tombstonedAt) return { status: "already-tombstoned" };
                    /**
                     * Only this operation advances the generation, and it always writes the tombstone in the
                     * same transaction. A mismatch without a tombstone is therefore impossible under valid
                     * state: fail closed rather than deleting data on an unexplained generation.
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
                     * Enumerate BOTH stores by scope and delete every key, including corrupt rows and a
                     * marker parked under a noncanonical markerId, so no durable residue outlives the
                     * confirmed deletion. Exact equality needs no ambient IDBKeyRange constructor.
                     */
                    for (const name of [DRAFTS_STORE, MARKERS_STORE] as const) {
                        const keys = await txn.req(txn.store(name).index(SCOPE_INDEX).getAllKeys(scopeId));
                        for (const key of keys) await txn.req(txn.store(name).delete(key));
                    }
                    await txn.req(txn.store(EPOCHS_STORE).put(next));
                    return { status: "tombstoned", deletionGeneration: next.deletionGeneration };
                },
                signal,
            );
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

            const run = await database.run(
                "readwrite",
                [EPOCHS_STORE, MARKERS_STORE, DRAFTS_STORE],
                RECOVERY_TRANSACTION_TIMEOUT_MS,
                async (txn): Promise<CanvasCoordinationOutcome> => {
                    const epochRead = await readEpoch(txn, input.scopeId);
                    if (epochRead.status === "corrupt") return CORRUPT;
                    const epoch = epochRead.epoch;
                    if (epoch.tombstonedAt) return { status: "tombstoned" };
                    if (epoch.coordinationRevision !== input.expectedCoordinationRevision || epoch.deletionGeneration !== input.expectedDeletionGeneration) {
                        return { status: "stale", coordinationRevision: epoch.coordinationRevision, deletionGeneration: epoch.deletionGeneration };
                    }
                    const next = nextEpoch(epoch, { coordinationRevision: epoch.coordinationRevision + 1 });
                    if (!next) return CORRUPT;
                    const markerRaw = await txn.req(txn.store(MARKERS_STORE).get([input.scopeId, CONFLICT_MARKER_ID]));
                    const marker = asMarkerRecord(markerRaw, input.scopeId);
                    if (markerRaw !== undefined && !marker) return CORRUPT;
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
                },
                signal,
            );
            return run.status === "ok" ? run.value : { status: "unavailable", reason: run.reason };
        },

        close: () => database.close(),
    };
}

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
