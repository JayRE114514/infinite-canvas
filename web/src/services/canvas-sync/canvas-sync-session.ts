import type { CanvasSnapshot } from "@infinite-canvas/contracts";

import { projectToSnapshot } from "@/lib/canvas/canvas-snapshot";
import type { RecoveryScopeId } from "@/services/canvas-recovery/scope";
import type { CanvasDraftState } from "@/services/canvas-recovery/types";
import { classifyCanvasSaveError } from "@/services/canvas-repository";
import { cleanResolution } from "@/services/canvas-sync/canvas-recovery-coordinator";
import {
    CANVAS_DOCUMENT_PATCH_FIELDS,
    CanvasSyncInvariantError,
    DETACHED_LOCAL_MS,
    DETACHED_NETWORK_MS,
    LOCAL_COALESCE_MS,
    LOCAL_FLUSH_TIMEOUT_MS,
    NETWORK_DEBOUNCE_MS,
    NETWORK_MAX_WAIT_MS,
    settleWithin,
    type CanvasDraftWriter,
    type CanvasDisposeReason,
    type CanvasLoadResult,
    type CanvasLocalPersistState,
    type CanvasProjectPatch,
    type CanvasRecoveryResolution,
    type CanvasRenameOutcome,
    type CanvasRetryRecoveryResult,
    type CanvasSaveFailure,
    type CanvasSessionRecoveryCoordinator,
    type CanvasSyncConflictView,
    type CanvasSyncInvariantContext,
    type CanvasSyncPhase,
    type CanvasSyncRepository,
    type CanvasSyncSaveError,
    type CanvasSyncSession,
    type CanvasSyncView,
} from "@/services/canvas-sync/types";
import type { CanvasProject, CanvasScope, ViewportTransform } from "@/types/canvas";

export type CanvasSyncSessionDeps = {
    repository: CanvasSyncRepository;
    writeDraft: CanvasDraftWriter;
    coordinator: CanvasSessionRecoveryCoordinator;
    now: () => number;
    isDev: boolean;
};

export type CanvasSessionInit = {
    sessionId: number;
    scope: CanvasScope;
    scopeToken: number;
    openToken: number;
    canvasId: string;
    scopeId: RecoveryScopeId;
    resolution: CanvasRecoveryResolution;
};

export { cleanResolution };

const ACTIVE_PHASES: CanvasSyncPhase[] = ["clean", "dirty", "saving", "save-error", "conflict", "recovery-blocked"];
type SessionEvent = "install" | "update" | "rename" | "localTick" | "networkTick" | "saveAck" | "saveConflict" | "saveFail" | "retrySave" | "retryRecovery" | "flush" | "hold" | "dispose";

const ALLOWED_PHASES: Record<SessionEvent, CanvasSyncPhase[]> = {
    install: ["loading"],
    update: ACTIVE_PHASES,
    rename: ACTIVE_PHASES,
    localTick: [...ACTIVE_PHASES, "disposing"],
    networkTick: ["dirty", "saving", "save-error"],
    /** 收尾期间仍要处理自己那次在飞请求的结果（7.4）：revision、草稿与 marker 都还归本会话。 */
    saveAck: ["saving", "disposing"],
    saveConflict: ["saving", "disposing"],
    saveFail: ["saving", "disposing"],
    retrySave: ["dirty", "save-error"],
    retryRecovery: ["recovery-blocked"],
    flush: [...ACTIVE_PHASES, "tombstoned"],
    hold: [...ACTIVE_PHASES, "tombstoned"],
    dispose: [...ACTIVE_PHASES, "loading", "tombstoned"],
};

export function createCanvasSyncSession(init: CanvasSessionInit, deps: CanvasSyncSessionDeps): CanvasSyncSession {
    const { sessionId, scope, scopeToken, openToken, canvasId, scopeId, resolution } = init;

    let phase: CanvasSyncPhase = "loading";
    let content = resolution.content;
    let revision = resolution.revision;
    let deletionGeneration = resolution.expectedDeletionGeneration;
    /** 本会话当前拥有的草稿行。重试重新确立所有权时会换成新铸的行，因此不是只读常量。 */
    let ownDraftId = resolution.draftId;
    /** 每个会话独占一行草稿，因此序号从 0 开始；不会与其他标签页共享同一行。 */
    let writeSeq = 0;
    /** 被本会话复制走的旧草稿行，等自己的行确认落盘后回收一次。 */
    let supersededDrafts = resolution.supersededDrafts;
    let editSeq = 0;
    let materializedSeq = 0;
    let persistedSeq = 0;
    let savedSeq = 0;
    let localUiSeq = 0;
    let materializedLocalUiSeq = 0;
    let persistedLocalUiSeq = 0;
    let localViewport = resolution.content.viewport;
    const documentDefaultViewport: ViewportTransform = { ...resolution.documentDefaultViewport };
    let inflightSeq = -1;
    let savedOnce = false;
    let tombstoned = resolution.phase === "tombstoned";
    let localPersist: CanvasLocalPersistState = tombstoned ? "tombstoned" : "ok";
    let saveError: CanvasSyncSaveError | null = null;
    let conflict: CanvasSyncConflictView | null = resolution.conflict;
    /** 冲突草稿固定基于产生冲突时的 baseRevision，不随后续服务端 revision 变化。 */
    let conflictBaseRevision: number | null = resolution.conflict ? resolution.conflict.baseRevision : null;
    let lastEditAt = 0;
    let firstUnsavedEditAt = 0;
    let localTimer: ReturnType<typeof setTimeout> | null = null;
    let networkTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotCache: { seq: number; title: string; snapshot: CanvasSnapshot } | null = null;
    let pendingSlot: {
        state: CanvasDraftState;
        title: string;
        snapshot: CanvasSnapshot;
        documentSeq: number;
        localUiSeq: number;
        viewport: ViewportTransform;
    } | null = null;
    let drainPromise: Promise<void> | null = null;
    const localAbortController = new AbortController();
    let inflightController: AbortController | null = null;
    /**
     * 在飞保存请求的完整生命周期，由会话自己持有。
     * 只记 inflightSeq 无法在收尾时等待或中止它，因此 dispose 必须能拿到这个 promise。
     */
    let inflightRequest: Promise<void> | null = null;
    /** 删除活动画布期间的可逆冻结：拒绝新编辑与新请求，但不终结会话。 */
    let held = false;
    let disposePromise: Promise<void> | null = null;
    /** 已经开始的收尾等级；forced 必须能在 replaced/deleted 收尾进行中升级并中止在飞请求。 */
    let disposeReason: CanvasDisposeReason | null = null;
    /** forced 升级后置位：抑制此后一切本地写与网络后续动作。 */
    let aborted = false;
    let emitted: CanvasSyncView | null = null;
    const listeners = new Set<(view: CanvasSyncView) => void>();

    const invariantContext = (event: string): CanvasSyncInvariantContext => ({
        sessionId,
        canvasId,
        phase,
        event,
        editSeq,
        savedSeq,
        inflightSeq,
        revision,
        localUiSeq,
        materializedLocalUiSeq,
        persistedLocalUiSeq,
    });

    function assertEvent(event: SessionEvent) {
        if (!ALLOWED_PHASES[event].includes(phase)) throw new CanvasSyncInvariantError(invariantContext(event));
    }

    /** 5.2 的序号不变量：任何一条被打破都按不变量事故处理，不静默继续。 */
    function assertCounters(event: string) {
        const ordered = savedSeq <= editSeq && persistedSeq <= materializedSeq && materializedSeq <= editSeq;
        const localUiOrdered = persistedLocalUiSeq <= materializedLocalUiSeq && materializedLocalUiSeq <= localUiSeq;
        const inflightOk = inflightSeq < 0 || (savedSeq <= inflightSeq && inflightSeq <= editSeq);
        const cleanOk = phase !== "clean" || (savedSeq === editSeq && inflightSeq < 0 && networkTimer === null);
        if (!ordered || !localUiOrdered || !inflightOk || !cleanOk) throw new CanvasSyncInvariantError(invariantContext(event));
    }

    function canUseNetwork() {
        if (saveError?.kind === "invariant") return false;
        /** 冻结期间既不排程也不发请求，等待删除结果裁决。 */
        if (held || aborted || tombstoned) return false;
        return phase === "clean" || phase === "dirty" || phase === "saving" || phase === "save-error";
    }

    function buildView(): CanvasSyncView {
        return { canvasId, scope, title: content.title, revision, phase, hasUnsavedEdits: editSeq > savedSeq, savedOnce, saveError, localPersist, conflict, unavailableKey: tombstoned ? "canvas.recovery.tombstoned" : null };
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
            emitted.conflict === next.conflict &&
            emitted.unavailableKey === next.unavailableKey
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
            /**
             * 恢复出来的本地内容本身就是一次未保存编辑。内容此时只在内存和旧行里，本会话自己的行还是空的，
             * 所以不能假称已落盘：必须真正写一次，写成功后才回收旧行。
             */
            editSeq = 1;
            lastEditAt = deps.now();
            firstUnsavedEditAt = lastEditAt;
            scheduleLocal();
        }
        if (phase === "dirty") scheduleNetwork();
        assertCounters("install");
        notify();
    }

    function update(patch: CanvasProjectPatch): boolean {
        if (held || tombstoned || phase === "loading" || phase === "disposing" || phase === "disposed") return false;
        assertEvent("update");
        let documentChanged = false;
        for (const field of CANVAS_DOCUMENT_PATCH_FIELDS) {
            const next = patch[field];
            if (next === undefined || Object.is(next, content[field])) continue;
            documentChanged = true;
        }
        const nextViewport = patch.viewport;
        if (nextViewport !== undefined && !Object.is(nextViewport, localViewport)) {
            localViewport = nextViewport;
            content = { ...content, viewport: nextViewport };
            localUiSeq += 1;
            scheduleLocal();
        }
        if (!documentChanged) return false;
        const { viewport: _viewport, ...documentPatch } = patch;
        content = { ...content, ...documentPatch };
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
        if (held || tombstoned || phase === "loading" || phase === "disposing" || phase === "disposed") return "local-only";
        assertEvent("rename");
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

    function ensureDocumentSnapshot(): { seq: number; title: string; snapshot: CanvasSnapshot } {
        if (snapshotCache && snapshotCache.seq === editSeq && snapshotCache.title === content.title) return snapshotCache;
        /** Live viewport is local UI; every document serializer substitutes the frozen canonical default. */
        snapshotCache = { seq: editSeq, title: content.title, snapshot: projectToSnapshot({ ...content, viewport: documentDefaultViewport }) };
        return snapshotCache;
    }

    function materialize() {
        clearLocalTimer();
        const documentChanged = materializedSeq < editSeq;
        const localUiChanged = materializedLocalUiSeq < localUiSeq;
        if (!documentChanged && !localUiChanged) return;
        assertEvent("localTick");
        const payload = ensureDocumentSnapshot();
        if (documentChanged) materializedSeq = editSeq;
        if (localUiChanged) materializedLocalUiSeq = localUiSeq;
        pendingSlot = {
            state: editSeq > savedSeq ? "pending" : "synced",
            title: payload.title,
            snapshot: payload.snapshot,
            documentSeq: materializedSeq,
            localUiSeq: materializedLocalUiSeq,
            viewport: localViewport,
        };
        assertCounters("localTick");
        void drainLocal();
    }

    function drainLocal(): Promise<void> {
        if (drainPromise) return drainPromise;
        drainPromise = (async () => {
            while (pendingSlot && !aborted && !tombstoned) {
                const entry = pendingSlot;
                pendingSlot = null;
                writeSeq += 1;
                const outcome = await deps.writeDraft(
                    {
                        scopeId,
                        draftId: ownDraftId,
                        writeSeq,
                        expectedDeletionGeneration: deletionGeneration,
                        state: entry.state,
                        envelope: {
                            document: { title: entry.title, baseRevision: conflictBaseRevision ?? revision, snapshot: entry.snapshot },
                            localUi: { viewport: entry.viewport },
                            assets: {},
                        },
                        savedAt: new Date(deps.now()).toISOString(),
                    },
                    localAbortController.signal,
                );
                if (outcome.status === "written") {
                    persistedSeq = Math.max(persistedSeq, entry.documentSeq);
                    persistedLocalUiSeq = Math.max(persistedLocalUiSeq, entry.localUiSeq);
                    assertCounters("localPersisted");
                    /** 自己的行已落盘，内容已在新行里，恢复来源行到此才安全回收。 */
                    if (supersededDrafts.length) {
                        const retiring = supersededDrafts;
                        supersededDrafts = [];
                        void deps.coordinator.retireSupersededDrafts(retiring, localAbortController.signal);
                    }
                    continue;
                }
                if (outcome.status === "tombstoned" || outcome.status === "generation-changed") {
                    enterTombstoned();
                    return;
                }
                /**
                 * superseded 说明本会话独占的草稿行已被别的写者接管：绝不能用本地内容盖回去，
                 * 只能标记为不可信，让 UI 持续提示。
                 */
                if (outcome.status === "superseded" || outcome.reason !== "aborted" || !aborted) {
                    materializedSeq = Math.min(materializedSeq, persistedSeq);
                    materializedLocalUiSeq = Math.min(materializedLocalUiSeq, persistedLocalUiSeq);
                    markDegraded();
                    return;
                }
            }
        })().finally(() => {
            drainPromise = null;
        });
        return drainPromise;
    }

    /** degraded 在会话生命周期内是粘性的：一次失败就说明本地草稿不可信，UI 必须持续提示直到重新打开画布。 */
    function markDegraded() {
        if (localPersist === "degraded" || tombstoned) return;
        localPersist = "degraded";
        notify();
    }

    function enterTombstoned() {
        if (tombstoned) return;
        tombstoned = true;
        phase = "tombstoned";
        pendingSlot = null;
        clearLocalTimer();
        clearNetworkTimer();
        inflightController?.abort();
        localAbortController.abort();
        localPersist = "tombstoned";
        notify();
    }

    async function flushLocal(timeoutMs: number) {
        clearLocalTimer();
        materialize();
        const settled = await settleWithin(drainPromise ?? Promise.resolve(), timeoutMs);
        if (settled.status !== "ok") markDegraded();
        if (!aborted && !tombstoned && (persistedSeq < editSeq || persistedLocalUiSeq < localUiSeq)) {
            materialize();
            const final = await settleWithin(drainPromise ?? Promise.resolve(), timeoutMs);
            if (final.status !== "ok") markDegraded();
        }
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
        const payload = ensureDocumentSnapshot();
        const baseRevision = revision;
        const controller = new AbortController();
        inflightSeq = payload.seq;
        inflightController = controller;
        phase = "saving";
        clearNetworkTimer();
        /**
         * 捕获即关闭本批次的 5 s 窗口：请求期间的新编辑属于下一批，从它自己的时间戳重新计时。
         * 否则每次 saveAck 都会算出 0 延迟，连续编辑退化成一次请求一个来回。
         */
        firstUnsavedEditAt = 0;
        assertCounters("startSave");
        notify();
        /** 请求 promise 由会话持有：收尾时必须能等待它、并按它的结果决定是否补发最终保存。 */
        const request: Promise<void> = (async () => {
            try {
                const result = await deps.repository.save(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot }, controller.signal);
                guard(() => onSaveAck(result), undefined);
            } catch (error) {
                const failure = classifyCanvasSaveError(error);
                if (failure.kind === "conflict") await guardAsync(() => onSaveConflict(baseRevision), undefined);
                else guard(() => onSaveFail(failure), undefined);
            }
        })();
        /** 登记的必须是 tracked 本身：登记 request 而清理时比较派生 promise 会让引用永远对不上，收尾误判成仍有请求在飞。 */
        const tracked: Promise<void> = request.finally(() => {
            if (inflightRequest === tracked) inflightRequest = null;
        });
        inflightRequest = tracked;
        await tracked;
    }

    function settleAfterRequest() {
        inflightSeq = -1;
        inflightController = null;
    }

    /**
     * 只有被 forced 中止或已终结的会话才丢弃请求结果。
     * 普通收尾必须继续处理这次 ack/409：revision、草稿状态与 marker 都还归本会话所有。
     */
    function requestOutdated() {
        if (!aborted && phase !== "disposed" && !tombstoned) return false;
        settleAfterRequest();
        return true;
    }

    /** 收尾期间的结果只更新事实，不再排程后续工作。 */
    const tearingDown = () => phase === "disposing" || phase === "disposed";

    function onSaveAck(result: CanvasLoadResult) {
        if (requestOutdated()) return;
        assertEvent("saveAck");
        if (result.revision < revision) throw new CanvasSyncInvariantError(invariantContext("saveAck"));
        revision = result.revision;
        savedSeq = inflightSeq;
        savedOnce = true;
        saveError = null;
        settleAfterRequest();
        if (tearingDown()) {
            /** 先把草稿改写到刚返回的 baseRevision，避免下次打开把已保存内容误判成冲突。 */
            queueDraftSettlement(editSeq === savedSeq ? "synced" : "pending");
            notify();
            return;
        }
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

    /** 保存成功后保留 synced 行：document 已确认，localUi 仍是下次打开所需的本地偏好。 */
    function queueDraftSettlement(state: CanvasDraftState) {
        const payload = ensureDocumentSnapshot();
        materializedSeq = Math.max(materializedSeq, payload.seq);
        materializedLocalUiSeq = Math.max(materializedLocalUiSeq, localUiSeq);
        pendingSlot = {
            state,
            title: payload.title,
            snapshot: payload.snapshot,
            documentSeq: materializedSeq,
            localUiSeq: materializedLocalUiSeq,
            viewport: localViewport,
        };
        void drainLocal();
    }

    function onSaveFail(failure: Extract<CanvasSaveFailure, { messageKey: string }>) {
        if (requestOutdated()) return;
        assertEvent("saveFail");
        settleAfterRequest();
        clearNetworkTimer();
        /** 收尾期间不改阶段，只保留盘上的 pending 草稿等待下次打开。 */
        if (tearingDown()) return;
        saveError = { kind: failure.kind, messageKey: failure.messageKey };
        phase = "save-error";
        assertCounters("saveFail");
        /** 不自动重试：下一次编辑或显式重试才再次发请求；pending 草稿保持在盘上。 */
        notify();
    }

    async function onSaveConflict(baseRevision: number) {
        if (requestOutdated()) return;
        assertEvent("saveConflict");
        settleAfterRequest();
        clearNetworkTimer();
        conflictBaseRevision = baseRevision;
        /** 冲突事实先同步建立：收尾路径据此永久阻断网络，绝不会在 409 之后再补发一次保存。 */
        conflict = { baseRevision, source: "save", extraDraftCount: 0 };
        if (!tearingDown()) {
            saveError = null;
            phase = "conflict";
            firstUnsavedEditAt = 0;
            assertCounters("saveConflict");
            notify();
        }
        await persistConflictRecords(baseRevision);
    }

    async function persistConflictRecords(baseRevision: number) {
        const payload = ensureDocumentSnapshot();
        materializedSeq = Math.max(materializedSeq, payload.seq);
        materializedLocalUiSeq = Math.max(materializedLocalUiSeq, localUiSeq);
        pendingSlot = { state: "pending", title: payload.title, snapshot: payload.snapshot, documentSeq: materializedSeq, localUiSeq: materializedLocalUiSeq, viewport: localViewport };
        const written = await settleWithin(drainLocal(), LOCAL_FLUSH_TIMEOUT_MS);
        if (written.status !== "ok") markDegraded();
        if (tombstoned || aborted) return;
        const outcome = await deps.coordinator.publishConflict(ownDraftId, baseRevision, localAbortController.signal);
        if (outcome.status === "tombstoned") enterTombstoned();
        else if (outcome.status === "unavailable") markDegraded();
        else if (conflict && conflict.extraDraftCount !== outcome.extraDraftCount) {
            conflict = { ...conflict, extraDraftCount: outcome.extraDraftCount };
            notify();
        }
    }

    async function flush() {
        if (phase === "loading" || phase === "disposing" || phase === "disposed" || phase === "tombstoned") return;
        assertEvent("flush");
        await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
        if (canUseNetwork() && editSeq > savedSeq && inflightSeq < 0) {
            await startSave();
            await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
        }
    }

    /**
     * 删除活动画布前的可逆冻结（10 与 11 的「失败项待保存编辑不被丢弃」）。
     * 只做两件事：停掉计时器与网络、把最后一次编辑强制物化到本地；会话所有权原样保留。
     */
    async function holdForDelete() {
        if (held || phase === "loading" || phase === "tombstoned" || tearingDown()) return;
        assertEvent("hold");
        held = true;
        clearNetworkTimer();
        notify();
        /** 冻结前先落盘：删除失败时这份内容仍在，删除成功时它由 deleted 清理统一删除。 */
        await flushLocal(LOCAL_FLUSH_TIMEOUT_MS);
    }

    /** 删除失败：同一个会话继续可用，冻结期间累积的编辑重新排程。 */
    function releaseHold() {
        if (!held) return;
        held = false;
        if (editSeq > savedSeq && (phase === "clean" || phase === "dirty" || phase === "save-error")) {
            phase = "dirty";
            scheduleLocal();
            scheduleNetwork();
        }
        notify();
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
        const hadUnsavedEdits = editSeq > savedSeq;
        const outcome = await deps.coordinator.retryRecovery(recoveryLoad(), ownDraftId, hadUnsavedEdits, localAbortController.signal);
        if (outcome.status === "failed") return "failed";
        if (outcome.status === "tombstoned") {
            enterTombstoned();
            return "failed";
        }
        /**
         * 采纳这次重新确立的所有权事实。在证明本会话内容确实落到自己的新行之前，
         * 既不恢复 localPersist，也不解锁云端保存：只改 phase 等于在存储换代之后假装仍然可信。
         */
        ownDraftId = outcome.draftId;
        deletionGeneration = outcome.expectedDeletionGeneration;
        supersededDrafts = outcome.supersededDrafts;
        writeSeq = 0;
        /**
         * degraded 在普通写入路径上是粘性的。这里是用户显式重试，且下面会用一次真实写入
         * 重新取证，所以先清掉旧标记，让这次写入的结果自己说话；取证失败会立刻重新标记。
         */
        localPersist = "ok";
        /** 新行是空的，本会话当前内容必须重新落盘一次，不能沿用旧行的落盘进度。 */
        persistedSeq = 0;
        persistedLocalUiSeq = 0;
        materializedSeq = 0;
        materializedLocalUiSeq = 0;
        snapshotCache = null;
        if (!(await persistOwnRow())) {
            markDegraded();
            notify();
            return "failed";
        }
        if (outcome.status === "conflict") {
            conflictBaseRevision = outcome.conflict.baseRevision;
            conflict = outcome.conflict;
            phase = "conflict";
            clearNetworkTimer();
            notify();
            return "conflict";
        }
        if (hadUnsavedEdits || editSeq > savedSeq) {
            phase = "dirty";
            notify();
            await startSave();
        } else {
            phase = "clean";
            notify();
        }
        return "unlocked";
    }

    /**
     * 把当前内存内容写进本会话自己的行，并要求写入被正面确认。
     * 这是"本地可恢复"的唯一证据；拿不到证据就必须继续停在 recovery-blocked。
     */
    async function persistOwnRow(): Promise<boolean> {
        const payload = ensureDocumentSnapshot();
        materializedSeq = payload.seq;
        materializedLocalUiSeq = localUiSeq;
        pendingSlot = {
            state: editSeq > savedSeq ? "pending" : "synced",
            title: payload.title,
            snapshot: payload.snapshot,
            documentSeq: materializedSeq,
            localUiSeq: materializedLocalUiSeq,
            viewport: localViewport,
        };
        const written = await settleWithin(drainLocal(), LOCAL_FLUSH_TIMEOUT_MS);
        /** drainLocal 只要遇到失败就会 markDegraded，因此这里既看落盘序号也看它是否被重新标记。 */
        return written.status === "ok" && persistedSeq >= materializedSeq && localPersist === "ok" && !tombstoned;
    }

    const recoveryLoad = (): CanvasLoadResult => ({ project: { ...content, viewport: documentDefaultViewport }, revision });

    async function exportConflictDrafts(): Promise<CanvasProject[]> {
        const projects = await deps.coordinator.exportConflictDrafts(canvasId, ownDraftId, localAbortController.signal);
        if (projects) return projects;
        return phase === "conflict" || editSeq > savedSeq ? [content] : [];
    }

    function reportRecoveryState(state: { status: "degraded" } | { status: "tombstoned" } | { status: "conflict"; conflict: CanvasSyncConflictView }) {
        if (phase === "disposed") return;
        if (state.status === "tombstoned") return enterTombstoned();
        if (state.status === "degraded") return markDegraded();
        if (tombstoned || phase === "disposing") return;
        conflict = state.conflict;
        conflictBaseRevision = state.conflict.baseRevision;
        phase = "conflict";
        clearNetworkTimer();
        notify();
    }

    /** forced 是唯一可以升级已有收尾的等级：中止在飞请求、抑制后续本地写、跳过所有等待。 */
    function escalateToForced() {
        aborted = true;
        disposeReason = "forced";
        pendingSlot = null;
        clearLocalTimer();
        clearNetworkTimer();
        inflightController?.abort();
        localAbortController.abort();
        settleAfterRequest();
    }

    function dispose(reason: CanvasDisposeReason): Promise<void> {
        if (disposePromise) {
            /** 已在收尾中：forced 必须真正升级，而不是拿回一个无法中止的旧 promise。 */
            if (reason === "forced" && disposeReason !== "forced") escalateToForced();
            return disposePromise;
        }
        assertEvent("dispose");
        disposeReason = reason;
        held = false;
        disposePromise = (async () => {
            const networkAllowed = canUseNetwork();
            phase = "disposing";
            clearLocalTimer();
            clearNetworkTimer();
            notify();
            if (reason === "forced" || reason === "deleted") {
                aborted = true;
                pendingSlot = null;
                localAbortController.abort();
                inflightController?.abort();
                settleAfterRequest();
                await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
            } else {
                await flushLocal(DETACHED_LOCAL_MS);
                if (networkAllowed) await settleWithin(finishNetwork(), DETACHED_NETWORK_MS);
                if (drainPromise || pendingSlot || persistedSeq < editSeq || persistedLocalUiSeq < localUiSeq || inflightSeq >= 0 || inflightRequest) escalateToForced();
            }
            phase = "disposed";
            notify();
            listeners.clear();
        })();
        return disposePromise;
    }

    /**
     * 7.4 第 3 步：detached 会话的网络收尾。
     * 先 settle 已经在飞的那次请求——它的 ack/409 仍归本会话处理，revision 与草稿状态都要推进——
     * 再按刚返回的 revision 至多补发一次最终保存。合计仍是「单飞行 + 最多一次最终保存」。
     */
    async function finishNetwork() {
        if (inflightRequest) await inflightRequest;
        /** 冲突或不变量事故期间永久阻断网络（5.2 不变量 4），收尾也不例外。 */
        if (aborted || conflict || saveError?.kind === "invariant" || editSeq <= savedSeq || inflightSeq >= 0) return;
        await finalSave();
    }

    /**
     * detached 会话最多再发一次保存；409 只写自己作用域的 marker 与冲突草稿，没有任何 UI。
     * 结果统一走 onSaveAck/onSaveConflict/onSaveFail，因此成功后草稿一定被改写到新的 baseRevision，
     * 不会在盘上留下一条旧 baseRevision 的 pending 记录被下次打开误判成冲突。
     */
    async function finalSave() {
        const payload = ensureDocumentSnapshot();
        const baseRevision = revision;
        const controller = new AbortController();
        inflightSeq = payload.seq;
        inflightController = controller;
        try {
            const result = await deps.repository.save(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot }, controller.signal);
            guard(() => onSaveAck(result), undefined);
        } catch (error) {
            const failure = classifyCanvasSaveError(error);
            if (failure.kind === "conflict") await guardAsync(() => onSaveConflict(baseRevision), undefined);
            else guard(() => onSaveFail(failure), undefined);
        }
        await flushLocal(DETACHED_LOCAL_MS);
    }

    const session: CanvasSyncSession = {
        sessionId,
        canvasId,
        scope,
        scopeToken,
        openToken,
        get draftId() {
            return ownDraftId;
        },
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
        holdForDelete: () => guardAsync(() => holdForDelete(), undefined),
        releaseHold: () => guard(() => releaseHold(), undefined),
        retrySave: () => guardAsync(() => retrySave(), undefined),
        retryRecovery: () => guardAsync(() => retryRecovery(), "failed" as CanvasRetryRecoveryResult),
        exportConflictDrafts: () => guardAsync(() => exportConflictDrafts(), []),
        dispose: (reason) => guardAsync(() => dispose(reason), undefined),
        reportRecoveryState: (state) => guard(() => reportRecoveryState(state), undefined),
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
