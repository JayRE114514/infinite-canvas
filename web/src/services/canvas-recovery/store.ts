import { DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE, RECOVERY_TRANSACTION_TIMEOUT_MS, SCOPE_INDEX, type RecoveryDatabase, type RecoveryFailureReason, type RecoveryTxn } from "./database";
import type { RecoveryScopeId } from "./scope";
import {
    asDraftRecord,
    asEpoch,
    asMarkerRecord,
    CONFLICT_MARKER_ID,
    initialEpoch,
    type CanvasConflictMarkerRecord,
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
            const record = asDraftRecord(
                {
                    scopeId: input.scopeId,
                    draftId: input.draftId,
                    writeSeq: input.writeSeq,
                    deletionGeneration: input.expectedDeletionGeneration,
                    state: input.state,
                    envelope: input.envelope,
                    savedAt: input.savedAt,
                },
                input.scopeId,
            );
            if (!record) return { status: "unavailable", reason: "corrupt" };

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

        close: () => database.close(),
    };
}
