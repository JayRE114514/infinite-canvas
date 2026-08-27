import type { CanvasSnapshot } from "@infinite-canvas/contracts";

import { draftToProject, projectToSnapshot, snapshotToProjectContent } from "@/lib/canvas/canvas-snapshot";
import { canvasDraftKey } from "@/services/canvas-local-recovery";
import { classifyCanvasSaveError } from "@/services/canvas-repository";
import {
    CANVAS_PATCH_FIELDS,
    CanvasSyncInvariantError,
    DETACHED_LOCAL_MS,
    DETACHED_NETWORK_MS,
    LOCAL_COALESCE_MS,
    LOCAL_FLUSH_TIMEOUT_MS,
    LOCAL_READ_TIMEOUT_MS,
    MAX_CONFLICT_MARKER_ENTRIES,
    NETWORK_DEBOUNCE_MS,
    NETWORK_MAX_WAIT_MS,
    settleWithin,
    type CanvasConflictMarker,
    type CanvasConflictMarkerEntry,
    type CanvasDisposeReason,
    type CanvasDraftRecord,
    type CanvasDraftScope,
    type CanvasDraftState,
    type CanvasLoadResult,
    type CanvasLocalPersistState,
    type CanvasLocalRecovery,
    type CanvasProjectPatch,
    type CanvasRenameOutcome,
    type CanvasRetryRecoveryResult,
    type CanvasSaveFailure,
    type CanvasSyncConflictView,
    type CanvasSyncInvariantContext,
    type CanvasSyncPhase,
    type CanvasSyncRepository,
    type CanvasSyncSaveError,
    type CanvasSyncSession,
    type CanvasSyncView,
} from "@/services/canvas-sync/types";
import type { CanvasProject, CanvasScope } from "@/types/canvas";

export type CanvasSyncSessionDeps = {
    repository: CanvasSyncRepository;
    recovery: CanvasLocalRecovery;
    now: () => number;
    createDraftId: () => string;
    isDev: boolean;
};

export type CanvasRecoveryResolution = {
    phase: "clean" | "dirty" | "conflict" | "recovery-blocked";
    /** 冲突或 dirty 时是本地草稿叠加后的内容，其余是服务端内容。 */
    content: CanvasProject;
    revision: number;
    /** 复用被恢复草稿的 draftId，使会话继续写同一条记录；否则是新的 nanoid。 */
    draftId: string;
    conflict: CanvasSyncConflictView | null;
};

export type CanvasSessionInit = {
    sessionId: number;
    scope: CanvasScope;
    scopeToken: number;
    openToken: number;
    canvasId: string;
    resolution: CanvasRecoveryResolution;
};

/** 本地存储偶发超时很常见：自动重试一次，真正读不出来才是 recovery-blocked。 */
async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch {
        return await read();
    }
}

function restoreContent(server: CanvasProject, draft: CanvasDraftRecord): CanvasProject {
    return { ...server, ...snapshotToProjectContent(draft.snapshot), title: draft.title || server.title };
}

export async function resolveCanvasOpenRecovery(
    deps: Pick<CanvasSyncSessionDeps, "recovery" | "createDraftId">,
    scope: CanvasScope,
    load: CanvasLoadResult,
): Promise<CanvasRecoveryResolution> {
    const canvasId = load.project.id;
    const draftScope: CanvasDraftScope = { userId: scope.userId, workspaceId: scope.workspaceId, canvasId };
    const server: CanvasRecoveryResolution = { phase: "clean", content: load.project, revision: load.revision, draftId: deps.createDraftId(), conflict: null };

    let marker: CanvasConflictMarker | null;
    let drafts: CanvasDraftRecord[];
    try {
        marker = await readWithRetry(() => deps.recovery.readMarker(draftScope));
        drafts = await readWithRetry(() => deps.recovery.listCanvasDrafts(draftScope));
    } catch {
        /** 读不出来是第三种状态，不是「没有冲突」：以服务端内容打开并阻断网络保存。 */
        return { ...server, phase: "recovery-blocked" };
    }

    const draftByKey = new Map(drafts.map((draft) => [canvasDraftKey(draftScope, draft.draftId), draft] as const));

    if (marker) {
        const valid = marker.entries.filter((entry) => draftByKey.has(entry.draftKey));
        if (valid.length) {
            /** entries[0] 无效时剔除无效条目并重写 marker，最新的一条永远排在最前。 */
            if (valid.length !== marker.entries.length) {
                await settleWithin(deps.recovery.writeMarker({ ...marker, entries: valid }), LOCAL_FLUSH_TIMEOUT_MS);
            }
            const draft = draftByKey.get(valid[0].draftKey) as CanvasDraftRecord;
            return {
                phase: "conflict",
                content: restoreContent(load.project, draft),
                revision: load.revision,
                draftId: draft.draftId,
                conflict: { baseRevision: draft.baseRevision, source: "restored", extraDraftCount: valid.length - 1 },
            };
        }
        /** 全部条目都指向已消失或校验失败的草稿，这条 marker 才算确认失效。 */
        await settleWithin(deps.recovery.deleteMarker(draftScope), LOCAL_FLUSH_TIMEOUT_MS);
    }

    const pending = drafts.find((draft) => draft.state === "pending");
    if (pending && pending.baseRevision === load.revision) {
        /** 同 revision 的未确认草稿：内容照常恢复，并立即安排一次保存。 */
        return { phase: "dirty", content: restoreContent(load.project, pending), revision: load.revision, draftId: pending.draftId, conflict: null };
    }
    if (pending) {
        /** 崩溃或离线路径产生的冲突：提升为 marker 后按冲突处理。 */
        const entry: CanvasConflictMarkerEntry = { draftKey: canvasDraftKey(draftScope, pending.draftId), draftId: pending.draftId, baseRevision: pending.baseRevision, savedAt: pending.savedAt };
        await settleWithin(deps.recovery.writeMarker({ ...draftScope, entries: [entry] }), LOCAL_FLUSH_TIMEOUT_MS);
        return {
            phase: "conflict",
            content: restoreContent(load.project, pending),
            revision: load.revision,
            draftId: pending.draftId,
            conflict: { baseRevision: pending.baseRevision, source: "restored", extraDraftCount: 0 },
        };
    }

    /** state === "synced" 表示服务端已确认过这份内容，打开时直接删除，绝不当作冲突。 */
    drafts
        .filter((draft) => draft.state === "synced")
        .forEach((draft) => void settleWithin(deps.recovery.deleteDraftByKey(canvasDraftKey(draftScope, draft.draftId)), LOCAL_FLUSH_TIMEOUT_MS));
    return server;
}

const ACTIVE_PHASES: CanvasSyncPhase[] = ["clean", "dirty", "saving", "save-error", "conflict", "recovery-blocked"];
type SessionEvent = "install" | "update" | "localTick" | "networkTick" | "saveAck" | "saveConflict" | "saveFail" | "retrySave" | "retryRecovery" | "flush" | "dispose";

const ALLOWED_PHASES: Record<SessionEvent, CanvasSyncPhase[]> = {
    install: ["loading"],
    update: ACTIVE_PHASES,
    /** disposing 仍要做最后一次物化落盘（7.4 第 2 步），因此本地物化比其他事件多允许这一个阶段。 */
    localTick: [...ACTIVE_PHASES, "disposing"],
    networkTick: ["dirty", "saving", "save-error"],
    saveAck: ["saving"],
    saveConflict: ["saving"],
    saveFail: ["saving"],
    retrySave: ["dirty", "save-error"],
    retryRecovery: ["recovery-blocked"],
    flush: ACTIVE_PHASES,
    dispose: [...ACTIVE_PHASES, "loading"],
};

export function createCanvasSyncSession(init: CanvasSessionInit, deps: CanvasSyncSessionDeps): CanvasSyncSession {
    const { sessionId, scope, scopeToken, openToken, canvasId, resolution } = init;
    const draftScope: CanvasDraftScope = { userId: scope.userId, workspaceId: scope.workspaceId, canvasId };
    const draftKey = canvasDraftKey(draftScope, resolution.draftId);

    let phase: CanvasSyncPhase = "loading";
    let content = resolution.content;
    let revision = resolution.revision;
    let editSeq = 0;
    let materializedSeq = 0;
    let persistedSeq = 0;
    let savedSeq = 0;
    let inflightSeq = -1;
    let savedOnce = false;
    let localPersist: CanvasLocalPersistState = "ok";
    let saveError: CanvasSyncSaveError | null = null;
    let conflict: CanvasSyncConflictView | null = resolution.conflict;
    /** 冲突草稿固定基于产生冲突时的 baseRevision，不随后续服务端 revision 变化。 */
    let conflictBaseRevision: number | null = resolution.conflict ? resolution.conflict.baseRevision : null;
    let lastEditAt = 0;
    let firstUnsavedEditAt = 0;
    let localTimer: ReturnType<typeof setTimeout> | null = null;
    let networkTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotCache: { seq: number; title: string; snapshot: CanvasSnapshot } | null = null;
    let pendingSlot: { record: CanvasDraftRecord; seq: number; deleteAfterWrite: boolean } | null = null;
    let drainPromise: Promise<void> | null = null;
    let inflightController: AbortController | null = null;
    let disposePromise: Promise<void> | null = null;
    let emitted: CanvasSyncView | null = null;
    const listeners = new Set<(view: CanvasSyncView) => void>();

    const invariantContext = (event: string): CanvasSyncInvariantContext => ({ sessionId, canvasId, phase, event, editSeq, savedSeq, inflightSeq, revision });

    function assertEvent(event: SessionEvent) {
        if (!ALLOWED_PHASES[event].includes(phase)) throw new CanvasSyncInvariantError(invariantContext(event));
    }

    /** 5.2 的序号不变量：任何一条被打破都按不变量事故处理，不静默继续。 */
    function assertCounters(event: string) {
        const ordered = savedSeq <= editSeq && materializedSeq <= editSeq && persistedSeq <= materializedSeq;
        const inflightOk = inflightSeq < 0 || (savedSeq <= inflightSeq && inflightSeq <= editSeq);
        const cleanOk = phase !== "clean" || (savedSeq === editSeq && inflightSeq < 0 && networkTimer === null);
        if (!ordered || !inflightOk || !cleanOk) throw new CanvasSyncInvariantError(invariantContext(event));
    }

    function canUseNetwork() {
        if (saveError?.kind === "invariant") return false;
        return phase === "clean" || phase === "dirty" || phase === "saving" || phase === "save-error";
    }

    function buildView(): CanvasSyncView {
        return { canvasId, scope, title: content.title, revision, phase, hasUnsavedEdits: editSeq > savedSeq, savedOnce, saveError, localPersist, conflict };
    }

    /** 拖动期间 editSeq 每帧自增，但视图字段不变，因此这里做一次逐字段比较，避免每帧唤醒 UI。 */
    function notify() {
        const next = buildView();
        if (
            emitted &&
            emitted.title === next.title &&
            emitted.revision === next.revision &&
            emitted.phase === next.phase &&
            emitted.hasUnsavedEdits === next.hasUnsavedEdits &&
            emitted.savedOnce === next.savedOnce &&
            emitted.saveError === next.saveError &&
            emitted.localPersist === next.localPersist &&
            emitted.conflict === next.conflict
        )
            return;
        emitted = next;
        listeners.forEach((listener) => listener(next));
    }

    /** 5.4：不变量事故永久阻断网络保存，保留本地写能力，UI 提示重新载入画布。 */
    function enterInvariant(error: CanvasSyncInvariantError) {
        if (deps.isDev) console.error("[canvas-sync] invariant violation", error.context);
        clearNetworkTimer();
        inflightController?.abort();
        inflightController = null;
        inflightSeq = -1;
        saveError = { kind: "invariant", messageKey: "canvas.save.invariant" };
        phase = "save-error";
        emitted = null;
        notify();
    }

    function guard<T>(run: () => T, fallback: T): T {
        try {
            return run();
        } catch (error) {
            if (error instanceof CanvasSyncInvariantError) {
                enterInvariant(error);
                return fallback;
            }
            throw error;
        }
    }

    async function guardAsync<T>(run: () => Promise<T>, fallback: T): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (error instanceof CanvasSyncInvariantError) {
                enterInvariant(error);
                return fallback;
            }
            throw error;
        }
    }

    function install(hydrated: CanvasProject) {
        assertEvent("install");
        if (hydrated.id !== canvasId) throw new CanvasSyncInvariantError(invariantContext("install"));
        content = hydrated;
        phase = resolution.phase;
        if (phase === "dirty" || phase === "conflict") {
            /** 恢复出来的本地内容本身就是一次未保存编辑：草稿已在盘上，所以物化与落盘序号同步推进。 */
            editSeq = 1;
            materializedSeq = 1;
            persistedSeq = 1;
            lastEditAt = deps.now();
            firstUnsavedEditAt = lastEditAt;
        }
        if (phase === "dirty") scheduleNetwork();
        assertCounters("install");
        notify();
    }

    function update(patch: CanvasProjectPatch): boolean {
        if (phase === "loading" || phase === "disposing" || phase === "disposed") return false;
        assertEvent("update");
        let changed = false;
        for (const field of CANVAS_PATCH_FIELDS) {
            const next = patch[field];
            if (next === undefined || Object.is(next, content[field])) continue;
            changed = true;
        }
        /** 引用全同说明这是补水或回流，不是编辑：不计 editSeq，不排程任何工作。 */
        if (!changed) return false;
        content = { ...content, ...patch };
        registerEdit();
        return true;
    }

    function registerEdit() {
        editSeq += 1;
        lastEditAt = deps.now();
        if (!firstUnsavedEditAt) firstUnsavedEditAt = lastEditAt;
        if (phase === "clean" || phase === "save-error") {
            phase = "dirty";
            saveError = null;
        }
        scheduleLocal();
        if (canUseNetwork() && phase !== "saving") scheduleNetwork();
        assertCounters("update");
        notify();
    }

    function rename(nextTitle: string): CanvasRenameOutcome {
        if (phase === "loading" || phase === "disposing" || phase === "disposed") return "local-only";
        if (nextTitle !== content.title) {
            content = { ...content, title: nextTitle };
            registerEdit();
        }
        /** 标题并入同一次防抖保存请求；冲突或恢复阻断时只落本地草稿。 */
        return canUseNetwork() ? "scheduled" : "local-only";
    }

    function scheduleLocal() {
        /** trailing 且不可饿死：已启动的合并计时器不重排，连续编辑下每 120 ms 落盘一次。 */
        if (localTimer) return;
        localTimer = setTimeout(() => {
            localTimer = null;
            guard(() => materialize(), undefined);
        }, LOCAL_COALESCE_MS);
    }

    function clearLocalTimer() {
        if (localTimer) clearTimeout(localTimer);
        localTimer = null;
    }

    function ensureSnapshot(): { seq: number; title: string; snapshot: CanvasSnapshot } {
        if (snapshotCache && snapshotCache.seq === editSeq) return snapshotCache;
        /** 唯一的全量序列化入口，本地草稿与网络请求共用同一份缓存。 */
        snapshotCache = { seq: editSeq, title: content.title, snapshot: projectToSnapshot(content) };
        return snapshotCache;
    }

    function buildDraftRecord(state: CanvasDraftState, payload: { title: string; snapshot: CanvasSnapshot }): CanvasDraftRecord {
        return {
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            canvasId,
            draftId: resolution.draftId,
            baseRevision: conflictBaseRevision ?? revision,
            state,
            title: payload.title,
            snapshot: payload.snapshot,
            savedAt: new Date(deps.now()).toISOString(),
        };
    }

    function materialize() {
        clearLocalTimer();
        if (materializedSeq >= editSeq) return;
        assertEvent("localTick");
        const payload = ensureSnapshot();
        materializedSeq = payload.seq;
        /** 单槽直接覆盖：慢速 IndexedDB 下内存里最多压着一份完整快照。 */
        pendingSlot = { record: buildDraftRecord("pending", payload), seq: payload.seq, deleteAfterWrite: false };
        assertCounters("localTick");
        void drainLocal();
    }

    function drainLocal(): Promise<void> {
        if (drainPromise) return drainPromise;
        drainPromise = (async () => {
            while (pendingSlot) {
                const entry = pendingSlot;
                pendingSlot = null;
                try {
                    await deps.recovery.writeDraft(entry.record);
                    persistedSeq = Math.max(persistedSeq, entry.seq);
                } catch {
                    /** 丢弃这一条即可：下一次 materialize 会带上更新的内容。 */
                    markDegraded();
                    continue;
                }
                /** 保存成功后的收尾固定「先改写、后删除」，中途崩溃留下的必须是一条 synced 记录。 */
                if (entry.deleteAfterWrite && !pendingSlot && phase === "clean" && editSeq === savedSeq) {
                    try {
                        await deps.recovery.deleteDraftByKey(draftKey);
                    } catch {
                        markDegraded();
                    }
                }
            }
        })().finally(() => {
            drainPromise = null;
        });
        return drainPromise;
    }

    /** degraded 在会话生命周期内是粘性的：一次失败就说明本地草稿不可信，UI 必须持续提示直到重新打开画布。 */
    function markDegraded() {
        if (localPersist === "degraded") return;
        localPersist = "degraded";
        notify();
    }

    async function flushLocal(timeoutMs: number) {
        materialize();
        const settled = await settleWithin(drainPromise ?? Promise.resolve(), timeoutMs);
        if (settled.status !== "ok") markDegraded();
    }

    function clearNetworkTimer() {
        if (networkTimer) clearTimeout(networkTimer);
        networkTimer = null;
    }

    /** 同时表达三件事：最后编辑后 400 ms、连续编辑 5 s 上界、saveAck 后按 max(0, 400 - (now - lastEditAt)) 重排。 */
    function scheduleNetwork() {
        if (!canUseNetwork() || editSeq <= savedSeq) return;
        const now = deps.now();
        const trailing = Math.max(0, NETWORK_DEBOUNCE_MS - (now - lastEditAt));
        const capped = firstUnsavedEditAt ? Math.max(0, NETWORK_MAX_WAIT_MS - (now - firstUnsavedEditAt)) : NETWORK_DEBOUNCE_MS;
        clearNetworkTimer();
        networkTimer = setTimeout(() => {
            networkTimer = null;
            void guardAsync(() => onNetworkTick(), undefined);
        }, Math.min(trailing, capped));
    }

    async function onNetworkTick() {
        /** 已有请求在飞时只标记「请求后待发」，绝不排队第二个请求；重排交给 saveAck。 */
        if (inflightSeq >= 0) return;
        assertEvent("networkTick");
        await startSave();
    }

    async function startSave() {
        if (!canUseNetwork() || inflightSeq >= 0 || editSeq <= savedSeq) return;
        const payload = ensureSnapshot();
        const baseRevision = revision;
        const controller = new AbortController();
        inflightSeq = payload.seq;
        inflightController = controller;
        phase = "saving";
        clearNetworkTimer();
        assertCounters("startSave");
        notify();
        try {
            const result = await deps.repository.save(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot }, controller.signal);
            guard(() => onSaveAck(result), undefined);
        } catch (error) {
            const failure = classifyCanvasSaveError(error);
            if (failure.kind === "conflict") guard(() => onSaveConflict(baseRevision), undefined);
            else guard(() => onSaveFail(failure), undefined);
        }
    }

    function settleAfterRequest() {
        inflightSeq = -1;
        inflightController = null;
    }

    /** 会话被替换后返回的结果不再改写阶段：dispose 有自己的收尾路径。 */
    function requestOutdated() {
        if (phase !== "disposing" && phase !== "disposed") return false;
        settleAfterRequest();
        return true;
    }

    function onSaveAck(result: CanvasLoadResult) {
        if (requestOutdated()) return;
        assertEvent("saveAck");
        if (result.revision < revision) throw new CanvasSyncInvariantError(invariantContext("saveAck"));
        revision = result.revision;
        savedSeq = inflightSeq;
        savedOnce = true;
        saveError = null;
        settleAfterRequest();
        if (editSeq === savedSeq) {
            phase = "clean";
            firstUnsavedEditAt = 0;
            clearNetworkTimer();
            queueDraftSettlement("synced");
        } else {
            phase = "dirty";
            queueDraftSettlement("pending");
            scheduleNetwork();
        }
        assertCounters("saveAck");
        notify();
    }

    /** 保存成功后的草稿收尾走同一个单槽：写入新的 baseRevision，clean 时再删除，顺序不可颠倒。 */
    function queueDraftSettlement(state: CanvasDraftState) {
        const payload = ensureSnapshot();
        materializedSeq = Math.max(materializedSeq, payload.seq);
        pendingSlot = { record: buildDraftRecord(state, payload), seq: payload.seq, deleteAfterWrite: state === "synced" };
        void drainLocal();
    }

    function onSaveFail(failure: Extract<CanvasSaveFailure, { messageKey: string }>) {
        if (requestOutdated()) return;
        assertEvent("saveFail");
        settleAfterRequest();
        clearNetworkTimer();
        saveError = { kind: failure.kind, messageKey: failure.messageKey };
        phase = "save-error";
        assertCounters("saveFail");
        /** 不自动重试：下一次编辑或显式重试才再次发请求；pending 草稿保持在盘上。 */
        notify();
    }

    function onSaveConflict(baseRevision: number) {
        if (requestOutdated()) return;
        assertEvent("saveConflict");
        settleAfterRequest();
        clearNetworkTimer();
        conflictBaseRevision = baseRevision;
        conflict = { baseRevision, source: "save", extraDraftCount: 0 };
        saveError = null;
        phase = "conflict";
        firstUnsavedEditAt = 0;
        assertCounters("saveConflict");
        notify();
        void persistConflictRecords(baseRevision);
    }

    async function persistConflictRecords(baseRevision: number) {
        const payload = ensureSnapshot();
        materializedSeq = Math.max(materializedSeq, payload.seq);
        pendingSlot = { record: buildDraftRecord("pending", payload), seq: payload.seq, deleteAfterWrite: false };
        const written = await settleWithin(drainLocal(), LOCAL_FLUSH_TIMEOUT_MS);
        if (written.status !== "ok") markDegraded();
        const entry: CanvasConflictMarkerEntry = { draftKey, draftId: resolution.draftId, baseRevision, savedAt: new Date(deps.now()).toISOString() };
        const existing = await settleWithin(deps.recovery.readMarker(draftScope), LOCAL_READ_TIMEOUT_MS);
        const older = existing.status === "ok" && existing.value ? existing.value.entries.filter((item) => item.draftKey !== draftKey) : [];
        /** 最新的本地内容永远排在 entries[0]，旧 marker 不能夺回入口。 */
        const entries = [entry, ...older].slice(0, MAX_CONFLICT_MARKER_ENTRIES);
        const marked = await settleWithin(deps.recovery.writeMarker({ ...draftScope, entries }), LOCAL_FLUSH_TIMEOUT_MS);
        if (marked.status !== "ok") markDegraded();
        if (conflict && conflict.extraDraftCount !== entries.length - 1) {
            conflict = { ...conflict, extraDraftCount: entries.length - 1 };
            notify();
        }
    }

    async function flush() {
        if (phase === "loading" || phase === "disposing" || phase === "disposed") return;
        assertEvent("flush");
        await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
        if (canUseNetwork() && editSeq > savedSeq && inflightSeq < 0) await startSave();
    }

    async function retrySave() {
        if (phase !== "save-error" && phase !== "dirty") return;
        if (saveError?.kind === "invariant" || inflightSeq >= 0) return;
        assertEvent("retrySave");
        saveError = null;
        if (editSeq <= savedSeq) {
            phase = "clean";
            clearNetworkTimer();
            assertCounters("retrySave");
            notify();
            return;
        }
        phase = "dirty";
        notify();
        /** 重新捕获当前内容并跳过 400 ms，不重放上一条已失败的候选。 */
        await startSave();
    }

    async function retryRecovery(): Promise<CanvasRetryRecoveryResult> {
        if (phase !== "recovery-blocked") return "failed";
        assertEvent("retryRecovery");
        let marker: CanvasConflictMarker | null;
        let drafts: CanvasDraftRecord[];
        try {
            marker = await readWithRetry(() => deps.recovery.readMarker(draftScope));
            drafts = await readWithRetry(() => deps.recovery.listCanvasDrafts(draftScope));
        } catch {
            return "failed";
        }
        if (phase !== "recovery-blocked") return "failed";
        const valid = marker ? marker.entries.filter((entry) => drafts.some((draft) => canvasDraftKey(draftScope, draft.draftId) === entry.draftKey)) : [];
        if (!valid.length) {
            if (marker) await settleWithin(deps.recovery.deleteMarker(draftScope), LOCAL_FLUSH_TIMEOUT_MS);
            if (editSeq > savedSeq) {
                phase = "dirty";
                notify();
                /** 恢复期间的编辑只落了本地草稿，解锁后立即补一次云端保存。 */
                await startSave();
                return "unlocked";
            }
            phase = "clean";
            notify();
            return "unlocked";
        }
        /** 恢复重试只修正 lineage，绝不替换画布内容：替换内容只允许走冲突条上的显式动作。 */
        const own: CanvasConflictMarkerEntry[] = editSeq > savedSeq ? [{ draftKey, draftId: resolution.draftId, baseRevision: revision, savedAt: new Date(deps.now()).toISOString() }] : [];
        const entries = [...own, ...valid.filter((entry) => entry.draftKey !== draftKey)].slice(0, MAX_CONFLICT_MARKER_ENTRIES);
        const marked = await settleWithin(deps.recovery.writeMarker({ ...draftScope, entries }), LOCAL_FLUSH_TIMEOUT_MS);
        if (marked.status !== "ok") markDegraded();
        conflictBaseRevision = own.length ? revision : valid[0].baseRevision;
        conflict = { baseRevision: conflictBaseRevision, source: "restored", extraDraftCount: entries.length - 1 };
        phase = "conflict";
        clearNetworkTimer();
        assertCounters("retryRecovery");
        notify();
        return "conflict";
    }

    /** 8.4：第一份来自内存，保证本地存储完全不可用时冲突内容仍可导出；其余逐条有界读取，读失败跳过。 */
    async function exportConflictDrafts(): Promise<CanvasProject[]> {
        const projects: CanvasProject[] = [];
        if (editSeq > savedSeq) projects.push(content);
        const marker = await settleWithin(deps.recovery.readMarker(draftScope), LOCAL_READ_TIMEOUT_MS);
        const entries = marker.status === "ok" && marker.value ? marker.value.entries.filter((entry) => entry.draftKey !== draftKey) : [];
        for (const entry of entries) {
            if (projects.length >= MAX_CONFLICT_MARKER_ENTRIES) break;
            const read = await settleWithin(deps.recovery.readDraftByKey(entry.draftKey), LOCAL_READ_TIMEOUT_MS);
            if (read.status === "ok" && read.value) projects.push(draftToProject(read.value));
        }
        return projects;
    }

    function dispose(reason: CanvasDisposeReason): Promise<void> {
        if (disposePromise) return disposePromise;
        assertEvent("dispose");
        disposePromise = (async () => {
            const networkAllowed = canUseNetwork() && editSeq > savedSeq;
            phase = "disposing";
            clearLocalTimer();
            clearNetworkTimer();
            notify();
            if (reason === "forced") {
                /** 超出 detached 上限时的硬收尾：中止在飞请求、跳过所有等待。 */
                inflightController?.abort();
                settleAfterRequest();
                /** 不再新增任何本地写；只等已经在飞的那一次结束，避免它写在清理之后。 */
                pendingSlot = null;
                await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
            } else if (reason === "deleted") {
                /** 画布已被删除：不再新增任何本地写，只等已经在飞的那一次结束，避免写在清理之后。 */
                pendingSlot = null;
                await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
            } else {
                await flushLocal(DETACHED_LOCAL_MS);
                if (networkAllowed && inflightSeq < 0) await settleWithin(finalSave(), DETACHED_NETWORK_MS);
            }
            phase = "disposed";
            notify();
            listeners.clear();
        })();
        return disposePromise;
    }

    /** detached 会话最多再发一次保存；409 只写自己作用域的 marker 与冲突草稿，没有任何 UI。 */
    async function finalSave() {
        const payload = ensureSnapshot();
        const baseRevision = revision;
        const controller = new AbortController();
        inflightController = controller;
        try {
            const result = await deps.repository.save(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot }, controller.signal);
            revision = result.revision;
            savedSeq = payload.seq;
            savedOnce = true;
        } catch (error) {
            if (classifyCanvasSaveError(error).kind !== "conflict") return;
            conflictBaseRevision = baseRevision;
            await settleWithin(persistConflictRecords(baseRevision), DETACHED_LOCAL_MS);
        } finally {
            inflightController = null;
        }
    }

    const session: CanvasSyncSession = {
        sessionId,
        canvasId,
        scope,
        scopeToken,
        openToken,
        draftKey,
        get view() {
            return emitted ?? buildView();
        },
        get content() {
            return content;
        },
        install: (hydrated) => guard(() => install(hydrated), undefined),
        update: (patch) => guard(() => update(patch), false),
        rename: (title) => guard(() => rename(title), "local-only" as CanvasRenameOutcome),
        flush: () => guardAsync(() => flush(), undefined),
        retrySave: () => guardAsync(() => retrySave(), undefined),
        retryRecovery: () => guardAsync(() => retryRecovery(), "failed" as CanvasRetryRecoveryResult),
        exportConflictDrafts: () => guardAsync(() => exportConflictDrafts(), []),
        dispose: (reason) => guardAsync(() => dispose(reason), undefined),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
    emitted = buildView();
    return session;
}
