import { draftToProject, snapshotToProjectContent } from "@/lib/canvas/canvas-snapshot";
import type { RecoveryScopeId } from "@/services/canvas-recovery/scope";
import type { CanvasRecoveryOpenSnapshot, CanvasRecoveryStore } from "@/services/canvas-recovery/store";
import type { CanvasConflictMarkerEntry, CanvasDraftRecord } from "@/services/canvas-recovery/types";
import {
    MAX_CONFLICT_MARKER_ENTRIES,
    MAX_COORDINATION_ATTEMPTS,
    type CanvasLoadResult,
    type CanvasRecoveryRepair,
    type CanvasRecoveryResolution,
    type CanvasSessionRecoveryCoordinator,
    type CanvasSyncConflictView,
} from "@/services/canvas-sync/types";
import type { CanvasProject } from "@/types/canvas";

type ResolutionEpoch = { coordinationRevision: number; deletionGeneration: number };
export type OpenCoordinationResult = { status: "settled" } | { status: "conflict"; conflict: CanvasSyncConflictView } | { status: "tombstoned" } | { status: "unavailable" };

function baseResolution(load: CanvasLoadResult, draftId: string, epoch: ResolutionEpoch): CanvasRecoveryResolution {
    return {
        phase: "clean",
        content: load.project,
        revision: load.revision,
        draftId,
        conflict: null,
        repairs: [],
        expectedCoordinationRevision: epoch.coordinationRevision,
        expectedDeletionGeneration: epoch.deletionGeneration,
        supersededDrafts: [],
        documentDefaultViewport: { ...load.project.viewport },
    };
}

export function cleanResolution(load: CanvasLoadResult, draftId: string, epoch: ResolutionEpoch): CanvasRecoveryResolution {
    return baseResolution(load, draftId, epoch);
}

export function serverCopyResolution(load: CanvasLoadResult, draftId: string, epoch: ResolutionEpoch): CanvasRecoveryResolution {
    return baseResolution(load, draftId, epoch);
}

function restoreContent(server: CanvasProject, draft: CanvasDraftRecord): CanvasProject {
    return {
        ...server,
        ...snapshotToProjectContent(draft.envelope.document.snapshot),
        title: draft.envelope.document.title || server.title,
        viewport: draft.envelope.localUi.viewport,
    };
}

export function parseRecoverySnapshot(load: CanvasLoadResult, snapshot: CanvasRecoveryOpenSnapshot, createDraftId: () => string): CanvasRecoveryResolution {
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
            /** This session owns a NEW row: restored content is copied forward, never written back over another tab's draft. */
            ...cleanResolution(load, createDraftId(), epochValues),
            phase: "conflict",
            content: restoreContent(load.project, draft),
            conflict: { baseRevision: draft.envelope.document.baseRevision, source: "restored", extraDraftCount: valid.length - 1 },
            repairs: valid.length === (marker?.entries.length ?? 0) ? [] : [{ kind: "write-marker", entries: valid }],
            documentDefaultViewport: snapshotToProjectContent(draft.envelope.document.snapshot).viewport,
        };
    }

    const repairs: CanvasRecoveryRepair[] = marker ? [{ kind: "delete-marker" }] : [];
    const pending = drafts.find((draft) => draft.state === "pending");
    if (pending) {
        const resolved = {
            ...cleanResolution(load, createDraftId(), epochValues),
            content: restoreContent(load.project, pending),
            repairs,
            documentDefaultViewport: snapshotToProjectContent(pending.envelope.document.snapshot).viewport,
        };
        /** 内容已复制进本会话新行，旧行等新行落盘后回收；GC 不回收未同步行，留着会让干净画布误判冲突。 */
        if (pending.envelope.document.baseRevision === load.revision) {
            return { ...resolved, phase: "dirty", supersededDrafts: [{ draftId: pending.draftId, expectedWriteSeq: pending.writeSeq }] };
        }
        /** 冲突分支必须保留旧行：marker 仍引用它，用户还要能导出它。 */
        return {
            ...resolved,
            phase: "conflict",
            conflict: { baseRevision: pending.envelope.document.baseRevision, source: "restored", extraDraftCount: 0 },
            repairs: [{ kind: "write-marker", entries: [{ draftId: pending.draftId, baseRevision: pending.envelope.document.baseRevision, savedAt: pending.savedAt }] }],
        };
    }

    const synced = drafts.find((draft) => draft.state === "synced");
    if (synced) {
        return {
            ...cleanResolution(load, createDraftId(), epochValues),
            content: { ...load.project, viewport: synced.envelope.localUi.viewport },
            repairs,
            supersededDrafts: [{ draftId: synced.draftId, expectedWriteSeq: synced.writeSeq }],
        };
    }
    return { ...cleanResolution(load, createDraftId(), epochValues), repairs };
}

export async function resolveCanvasOpenRecovery(store: CanvasRecoveryStore, scopeId: RecoveryScopeId, load: CanvasLoadResult, createDraftId: () => string): Promise<CanvasRecoveryResolution> {
    const opened = await store.readOpenSnapshot(scopeId);
    if (opened.status === "tombstoned") {
        return { ...cleanResolution(load, createDraftId(), { coordinationRevision: 0, deletionGeneration: opened.deletionGeneration }), phase: "tombstoned" };
    }
    if (opened.status === "unavailable") return { ...cleanResolution(load, createDraftId(), { coordinationRevision: 0, deletionGeneration: 0 }), phase: "recovery-blocked" };
    return parseRecoverySnapshot(load, opened.snapshot, createDraftId);
}

function repairInput(scopeId: RecoveryScopeId, resolution: CanvasRecoveryResolution) {
    const marker = resolution.repairs.find((repair) => repair.kind === "write-marker");
    const deleteMarker = resolution.repairs.some((repair) => repair.kind === "delete-marker");
    return {
        scopeId,
        expectedCoordinationRevision: resolution.expectedCoordinationRevision,
        expectedDeletionGeneration: resolution.expectedDeletionGeneration,
        marker: marker?.kind === "write-marker" ? marker.entries : deleteMarker ? null : undefined,
        deleteDraftIds: resolution.repairs.flatMap((repair) => (repair.kind === "delete-drafts" ? repair.draftIds : [])),
    };
}

/** Manager commits prepare-time repair intent only after the prepared session has been installed. */
export async function coordinateOpenRepairs(
    store: CanvasRecoveryStore,
    scopeId: RecoveryScopeId,
    load: CanvasLoadResult,
    initial: CanvasRecoveryResolution,
    createDraftId: () => string,
): Promise<OpenCoordinationResult> {
    let resolution = initial;
    for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
        if (resolution.phase === "tombstoned") return { status: "tombstoned" };
        if (resolution.phase === "recovery-blocked") return { status: "unavailable" };
        if (!resolution.repairs.length) return resolution.phase === "conflict" && resolution.conflict ? { status: "conflict", conflict: resolution.conflict } : { status: "settled" };
        const outcome = await store.commitCoordination(repairInput(scopeId, resolution));
        if (outcome.status === "committed") return resolution.phase === "conflict" && resolution.conflict ? { status: "conflict", conflict: resolution.conflict } : { status: "settled" };
        if (outcome.status === "tombstoned") return { status: "tombstoned" };
        if (outcome.status === "unavailable") return { status: "unavailable" };

        const opened = await store.readOpenSnapshot(scopeId);
        if (opened.status === "tombstoned") return { status: "tombstoned" };
        if (opened.status === "unavailable") return { status: "unavailable" };
        resolution = parseRecoverySnapshot(load, opened.snapshot, createDraftId);
    }
    return { status: "unavailable" };
}

function validForeignEntries(snapshot: CanvasRecoveryOpenSnapshot, ownDraftId: string): CanvasConflictMarkerEntry[] {
    const byId = new Map(snapshot.drafts.map((draft) => [draft.draftId, draft] as const));
    return (snapshot.marker?.entries ?? []).filter((entry) => {
        if (entry.draftId === ownDraftId) return false;
        const draft = byId.get(entry.draftId);
        return Boolean(draft) && draft!.state === "pending" && draft!.envelope.document.baseRevision === entry.baseRevision;
    });
}

export function createSessionRecoveryCoordinator(store: CanvasRecoveryStore, scopeId: RecoveryScopeId, createDraftId: () => string): CanvasSessionRecoveryCoordinator {
    return {
        publishConflict: async (draftId, baseRevision, signal) => {
            for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
                const opened = await store.readOpenSnapshot(scopeId, signal);
                if (opened.status === "tombstoned") return { status: "tombstoned" };
                if (opened.status === "unavailable") return { status: "unavailable" };
                const own = opened.snapshot.drafts.find(
                    (draft) => draft.draftId === draftId && draft.state === "pending" && draft.envelope.document.baseRevision === baseRevision,
                );
                if (!own) return { status: "unavailable" };
                const entries = [{ draftId, baseRevision, savedAt: own.savedAt }, ...validForeignEntries(opened.snapshot, draftId)].slice(0, MAX_CONFLICT_MARKER_ENTRIES);
                const outcome = await store.commitCoordination(
                    {
                        scopeId,
                        expectedCoordinationRevision: opened.snapshot.epoch.coordinationRevision,
                        expectedDeletionGeneration: opened.snapshot.epoch.deletionGeneration,
                        marker: entries,
                    },
                    signal,
                );
                if (outcome.status === "committed") return { status: "published", extraDraftCount: entries.length - 1 };
                if (outcome.status === "tombstoned") return { status: "tombstoned" };
                if (outcome.status === "unavailable") return { status: "unavailable" };
            }
            return { status: "unavailable" };
        },

        retryRecovery: async (load, ownDraftId, hasUnsavedEdits, signal) => {
            for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
                const opened = await store.readOpenSnapshot(scopeId, signal);
                if (opened.status === "unavailable") return { status: "failed" };
                if (opened.status === "tombstoned") return { status: "tombstoned" };
                const fresh = parseRecoverySnapshot(load, opened.snapshot, createDraftId);
                let repairs = fresh.repairs;
                let nextConflict = fresh.phase === "conflict" ? fresh.conflict : null;
                /**
                 * 盘上存在别人的 pending 草稿：它和本会话内存里的编辑是两份独立未保存内容，
                 * 必须都保住。发布 marker 让双方成为显式冲突，而不是丢弃任何一边。
                 * 注意这里引用的是盘上那一行，不是本会话新铸的行——新行此刻还没写入。
                 */
                if (fresh.phase === "dirty") {
                    const pending = fresh.supersededDrafts[0];
                    const row = pending && opened.snapshot.drafts.find((draft) => draft.draftId === pending.draftId && draft.state === "pending");
                    if (!row) return { status: "failed" };
                    /** 本会话没有未保存编辑时，恢复出来的内容就是唯一真相，不需要制造冲突。 */
                    if (hasUnsavedEdits) {
                        repairs = [{ kind: "write-marker", entries: [{ draftId: row.draftId, baseRevision: row.envelope.document.baseRevision, savedAt: row.savedAt }] }];
                        nextConflict = { baseRevision: row.envelope.document.baseRevision, source: "restored", extraDraftCount: 0 };
                    }
                }
                /** 有未保存编辑时绝不回收别人的行：它可能是另一个编辑者仅存的副本。 */
                const supersededDrafts = hasUnsavedEdits ? [] : fresh.supersededDrafts;
                if (repairs.length) {
                    const candidate = { ...fresh, repairs };
                    const outcome = await store.commitCoordination(repairInput(scopeId, candidate), signal);
                    if (outcome.status === "stale") continue;
                    if (outcome.status === "tombstoned") return { status: "tombstoned" };
                    if (outcome.status === "unavailable") return { status: "failed" };
                }
                /**
                 * 提交 marker 会把 coordinationRevision 推进 1，本会话之后的 CAS 必须基于推进后的值。
                 * 这些事实一并交回 Session，避免它继续用 prepare 期的旧值写盘。
                 */
                const ownership = {
                    draftId: fresh.draftId,
                    expectedCoordinationRevision: fresh.expectedCoordinationRevision + (repairs.length ? 1 : 0),
                    expectedDeletionGeneration: fresh.expectedDeletionGeneration,
                    supersededDrafts,
                };
                if (nextConflict) return { status: "conflict", conflict: nextConflict, ...ownership };
                return { status: "unlocked", ...ownership };
            }
            return { status: "failed" };
        },

        exportConflictDrafts: async (canvasId, ownDraftId, signal) => {
            const opened = await store.readOpenSnapshot(scopeId, signal);
            if (opened.status !== "ok") return null;
            const byId = new Map(opened.snapshot.drafts.map((draft) => [draft.draftId, draft] as const));
            const ids = [ownDraftId, ...(opened.snapshot.marker?.entries.map((entry) => entry.draftId) ?? [])];
            const projects: CanvasProject[] = [];
            for (const draftId of new Set(ids)) {
                if (projects.length >= MAX_CONFLICT_MARKER_ENTRIES) break;
                const draft = byId.get(draftId);
                if (!draft || draft.state !== "pending") continue;
                const markerEntry = opened.snapshot.marker?.entries.find((entry) => entry.draftId === draftId);
                if (markerEntry && markerEntry.baseRevision !== draft.envelope.document.baseRevision) continue;
                projects.push({ ...draftToProject({ canvasId, title: draft.envelope.document.title, snapshot: draft.envelope.document.snapshot, savedAt: draft.savedAt }), viewport: draft.envelope.localUi.viewport });
            }
            return projects;
        },

        /**
         * 旧行的内容已被复制进本会话自己的行，且那一行确认落盘后才会调用这里。
         * marker 仍引用的行绝不回收：它是冲突证据，用户还要能导出。
         */
        retireSupersededDrafts: async (candidates, signal) => {
            if (!candidates.length) return;
            for (let attempt = 0; attempt < MAX_COORDINATION_ATTEMPTS; attempt += 1) {
                const opened = await store.readOpenSnapshot(scopeId, signal);
                if (opened.status !== "ok") return;
                const referenced = new Set(opened.snapshot.marker?.entries.map((entry) => entry.draftId) ?? []);
                const targets = candidates.filter((row) => !referenced.has(row.draftId) && opened.snapshot.drafts.some((draft) => draft.draftId === row.draftId));
                if (!targets.length) return;
                const outcome = await store.commitCoordination(
                    {
                        scopeId,
                        expectedCoordinationRevision: opened.snapshot.epoch.coordinationRevision,
                        expectedDeletionGeneration: opened.snapshot.epoch.deletionGeneration,
                        retireDrafts: targets,
                    },
                    signal,
                );
                if (outcome.status !== "stale") return;
            }
        },
    };
}
