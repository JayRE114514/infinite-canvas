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
/** The single safe-count boundary: epochs, revisions, generations and writeSeq all use it. */
export const isRecoveryCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
    if (!isRecoveryCount(coordinationRevision) || !isRecoveryCount(deletionGeneration)) return null;
    if (tombstonedAt !== null && !isIsoDate(tombstonedAt)) return null;
    return { scopeId, coordinationRevision, deletionGeneration, tombstonedAt: tombstonedAt as string | null };
}

function asEnvelope(value: unknown): CanvasDraftEnvelope | null {
    if (!isRecord(value) || !isRecord(value.document) || !isRecord(value.localUi) || !isAssetMapping(value.assets)) return null;
    const { title, baseRevision, snapshot } = value.document;
    if (typeof title !== "string" || !isRecoveryCount(baseRevision) || !isJsonObject(snapshot)) return null;
    const viewport = (value.localUi as { viewport?: unknown }).viewport;
    if (!isRecord(viewport) || !isFiniteNumber(viewport.x) || !isFiniteNumber(viewport.y) || !isFiniteNumber(viewport.k) || viewport.k <= 0) return null;
    return value as CanvasDraftEnvelope;
}

export function asDraftRecord(value: unknown, scopeId: RecoveryScopeId): CanvasDraftRecord | null {
    if (!isRecord(value) || value.scopeId !== scopeId) return null;
    const { draftId, writeSeq, deletionGeneration, state, savedAt } = value;
    if (typeof draftId !== "string" || !draftId || !isRecoveryCount(writeSeq) || !isRecoveryCount(deletionGeneration)) return null;
    if ((state !== "pending" && state !== "synced") || !isIsoDate(savedAt) || !asEnvelope(value.envelope)) return null;
    return value as CanvasDraftRecord;
}

export function asMarkerRecord(value: unknown, scopeId: RecoveryScopeId): CanvasConflictMarkerRecord | null {
    if (!isRecord(value) || value.scopeId !== scopeId || value.markerId !== CONFLICT_MARKER_ID) return null;
    const { entries } = value;
    if (!Array.isArray(entries) || entries.length > MAX_CONFLICT_MARKER_ENTRIES) return null;
    const materialized = Array.from(entries);
    const valid = materialized.every((entry) => isRecord(entry) && typeof entry.draftId === "string" && Boolean(entry.draftId) && isRecoveryCount(entry.baseRevision) && isIsoDate(entry.savedAt));
    if (!valid) return null;
    if (new Set(materialized.map((entry) => (entry as CanvasConflictMarkerEntry).draftId)).size !== entries.length) return null;
    return value as CanvasConflictMarkerRecord;
}
