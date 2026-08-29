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
        /** BigInt 字面量需要 ES2020，这里用构造函数表达同一个非法快照值。 */
        expect(asDraftRecord(withSnapshot({ nested: [BigInt(1)] }), scopeId)).toBeNull();
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
