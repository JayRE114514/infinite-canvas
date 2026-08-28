import { describe, expect, it } from "vitest";

import { buildRecoveryScopeId } from "./scope";
import { asDraftRecord, asEpoch, asMarkerRecord, CONFLICT_MARKER_ID, initialEpoch } from "./types";

const scopeId = buildRecoveryScopeId({ kind: "local", installationId: "inst1", localCanvasId: "c1" })!;
const other = buildRecoveryScopeId({ kind: "local", installationId: "inst1", localCanvasId: "c2" })!;
const envelope = { document: { title: "T", baseRevision: 3, snapshot: { nodes: [], connections: [] } }, localUi: { viewport: { x: 0, y: 0, k: 1 } }, assets: {} };
const draft = { scopeId, draftId: "d1", writeSeq: 5, deletionGeneration: 0, state: "pending", envelope, savedAt: "2020-01-01T00:00:00.000Z" };

describe("recovery record validators", () => {
    it("starts a scope at generation zero with no tombstone", () => {
        expect(initialEpoch(scopeId)).toEqual({ scopeId, coordinationRevision: 0, deletionGeneration: 0, tombstonedAt: null });
    });

    it("accepts well-formed records", () => {
        expect(asEpoch({ scopeId, coordinationRevision: 2, deletionGeneration: 1, tombstonedAt: null }, scopeId)).not.toBeNull();
        expect(asDraftRecord(draft, scopeId)).not.toBeNull();
        expect(asMarkerRecord({ scopeId, markerId: CONFLICT_MARKER_ID, entries: [{ draftId: "d1", baseRevision: 3, savedAt: "2020-01-01T00:00:00.000Z" }] }, scopeId)).not.toBeNull();
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
        expect(asMarkerRecord({ scopeId, markerId: "other", entries: [] }, scopeId)).toBeNull();
        expect(asMarkerRecord({ scopeId, markerId: CONFLICT_MARKER_ID, entries: [{ draftId: "d1" }] }, scopeId)).toBeNull();
    });

    it("caps marker entries at the shared conflict limit", () => {
        const entry = { draftId: "d1", baseRevision: 1, savedAt: "2020-01-01T00:00:00.000Z" };
        expect(asMarkerRecord({ scopeId, markerId: CONFLICT_MARKER_ID, entries: [entry, entry, entry] }, scopeId)).toBeNull();
    });
});
