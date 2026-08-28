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

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isIsoDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function asEpoch(value: unknown, scopeId: RecoveryScopeId): CanvasRecoveryEpoch | null {
    if (!isRecord(value) || value.scopeId !== scopeId) return null;
    const { coordinationRevision, deletionGeneration, tombstonedAt } = value;
    if (!isCount(coordinationRevision) || !isCount(deletionGeneration)) return null;
    if (tombstonedAt !== null && !isIsoDate(tombstonedAt)) return null;
    return { scopeId, coordinationRevision, deletionGeneration, tombstonedAt: tombstonedAt as string | null };
}

function asEnvelope(value: unknown): CanvasDraftEnvelope | null {
    if (!isRecord(value) || !isRecord(value.document) || !isRecord(value.localUi) || !isRecord(value.assets)) return null;
    const { title, baseRevision, snapshot } = value.document;
    if (typeof title !== "string" || !isCount(baseRevision) || !isRecord(snapshot)) return null;
    const viewport = (value.localUi as { viewport?: unknown }).viewport;
    if (!isRecord(viewport) || typeof viewport.x !== "number" || typeof viewport.y !== "number" || typeof viewport.k !== "number") return null;
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
    const valid = entries.every((entry) => isRecord(entry) && typeof entry.draftId === "string" && Boolean(entry.draftId) && isCount(entry.baseRevision) && isIsoDate(entry.savedAt));
    return valid ? (value as CanvasConflictMarkerRecord) : null;
}
