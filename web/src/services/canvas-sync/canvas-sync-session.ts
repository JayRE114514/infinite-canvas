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
    type CanvasLocalWrite,
    type CanvasProjectPatch,
    type CanvasRecoveryRepair,
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
    /** 判定过程中需要的本地修复；由 install() 之后的会话执行并观察，prepare 被取消时一条都不执行。 */
    repairs: CanvasRecoveryRepair[];
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

/** 4.4 与 9.6：marker 条目必须真正指向一条有效的 pending 草稿，且 draftId 与 baseRevision 都对得上，其余一律剔除。 */
function markerEntryMatches(entry: CanvasConflictMarkerEntry, draft: CanvasDraftRecord | undefined): boolean {
    if (!draft) return false;
    return draft.state === "pending" && draft.draftId === entry.draftId && draft.baseRevision === entry.baseRevision;
}

export async function resolveCanvasOpenRecovery(
    deps: Pick<CanvasSyncSessionDeps, "recovery" | "createDraftId">,
    scope: CanvasScope,
    load: CanvasLoadResult,
): Promise<CanvasRecoveryResolution> {
    const canvasId = load.project.id;
    const draftScope: CanvasDraftScope = { userId: scope.userId, workspaceId: scope.workspaceId, canvasId };
    const server: CanvasRecoveryResolution = { phase: "clean", content: load.project, revision: load.revision, draftId: deps.createDraftId(), conflict: null, repairs: [] };

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
        /** 只按键存在判断太弱：条目必须与记录的 draftId、baseRevision 完全一致才算有效入口。 */
        const valid = marker.entries.filter((entry) => markerEntryMatches(entry, draftByKey.get(entry.draftKey)));
        if (valid.length) {
            const draft = draftByKey.get(valid[0].draftKey) as CanvasDraftRecord;
            return {
                phase: "conflict",
                content: restoreContent(load.project, draft),
                revision: load.revision,
                draftId: draft.draftId,
                conflict: { baseRevision: draft.baseRevision, source: "restored", extraDraftCount: valid.length - 1 },
                /** entries[0] 无效时剔除无效条目并重写 marker，最新的一条永远排在最前；改写交给会话执行。 */
                repairs: valid.length === marker.entries.length ? [] : [{ kind: "write-marker", marker: { ...marker, entries: valid } }],
            };
        }
        /** 全部条目都指向已消失或校验失败的草稿，这条 marker 才算确认失效；删除仍需按身份条件执行。 */
        server.repairs.push({ kind: "delete-marker", expectedDraftKeys: marker.entries.map((entry) => entry.draftKey) });
    }

    const pending = drafts.find((draft) => draft.state === "pending");
    if (pending && pending.baseRevision === load.revision) {
        /** 同 revision 的未确认草稿：内容照常恢复，并立即安排一次保存。 */
        return { ...server, phase: "dirty", content: restoreContent(load.project, pending), draftId: pending.draftId };
    }
    if (pending) {
        /** 崩溃或离线路径产生的冲突：提升为 marker 后按冲突处理。 */
        const entry: CanvasConflictMarkerEntry = { draftKey: canvasDraftKey(draftScope, pending.draftId), draftId: pending.draftId, baseRevision: pending.baseRevision, savedAt: pending.savedAt };
        return {
            phase: "conflict",
            content: restoreContent(load.project, pending),
            revision: load.revision,
            draftId: pending.draftId,
            conflict: { baseRevision: pending.baseRevision, source: "restored", extraDraftCount: 0 },
            repairs: [...server.repairs, { kind: "write-marker", marker: { ...draftScope, entries: [entry] } }],
        };
    }

    /** state === "synced" 表示服务端已确认过这份内容，打开时直接删除，绝不当作冲突。 */
    drafts.filter((draft) => draft.state === "synced").forEach((draft) => server.repairs.push({ kind: "delete-draft", draftKey: canvasDraftKey(draftScope, draft.draftId) }));
    return server;
}

const ACTIVE_PHASES: CanvasSyncPhase[] = ["clean", "dirty", "saving", "save-error", "conflict", "recovery-blocked"];
type SessionEvent = "install" | "update" | "localTick" | "networkTick" | "saveAck" | "saveConflict" | "saveFail" | "retrySave" | "retryRecovery" | "flush" | "hold" | "dispose";

const ALLOWED_PHASES: Record<SessionEvent, CanvasSyncPhase[]> = {
    install: ["loading"],
    update: ACTIVE_PHASES,
    /** disposing 仍要做最后一次物化落盘（7.4 第 2 步），因此本地物化比其他事件多允许这一个阶段。 */
    localTick: [...ACTIVE_PHASES, "disposing"],
    networkTick: ["dirty", "saving", "save-error"],
    /** 收尾期间仍要处理自己那次在飞请求的结果（7.4）：revision、草稿与 marker 都还归本会话。 */
    saveAck: ["saving", "disposing"],
    saveConflict: ["saving", "disposing"],
    saveFail: ["saving", "disposing"],
    retrySave: ["dirty", "save-error"],
    retryRecovery: ["recovery-blocked"],
    flush: ACTIVE_PHASES,
    hold: ACTIVE_PHASES,
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
    /**
     * 本会话自己发起、仍在飞的本地恢复操作：原始草稿/marker 写落定信号、可产生写入的完整尾巴及其有界读取。
     * 集合归属于这个 session 闭包，不按 canvasId 全局共享；只登记引用，不重试、不排队快照。
     */
    const inFlightLocal = new Set<Promise<unknown>>();
    let localSettlementWatcher: Promise<void> | null = null;
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
        /** 冻结期间既不排程也不发请求，等待删除结果裁决。 */
        if (held || aborted) return false;
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
        /** prepare 期间只判定不改写：真正的本地修复到这里才执行，并登记为本会话拥有的尾巴。 */
        runRecoveryRepairs();
        notify();
    }

    /** 执行 resolver 给出的修复意图。全部登记进 inFlightLocal，因此清理路径能通过 whenLocalSettled 观察到它们。 */
    function runRecoveryRepairs() {
        for (const repair of resolution.repairs) {
            if (repair.kind === "write-marker") void trackLocal(deps.recovery.writeMarker(repair.marker).settled);
            else if (repair.kind === "delete-marker") void trackLocal(deps.recovery.deleteMarkerIfOwned(draftScope, repair.expectedDraftKeys).settled);
            else void trackLocal(deps.recovery.deleteDraftByKey(repair.draftKey).settled);
        }
    }

    function update(patch: CanvasProjectPatch): boolean {
        if (held || phase === "loading" || phase === "disposing" || phase === "disposed") return false;
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
        if (held || phase === "loading" || phase === "disposing" || phase === "disposed") return "local-only";
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
                /** forced 升级后不再落任何盘：它的清理可能已经跑过，迟到写会把旧状态写回来。 */
                if (aborted) {
                    pendingSlot = null;
                    break;
                }
                const entry = pendingSlot;
                pendingSlot = null;
                try {
                    const write = deps.recovery.writeDraft(entry.record);
                    /** 必须先同步登记 raw settled，再等待可能在 2 秒提前失败的 result。 */
                    await trackWrite(write);
                    persistedSeq = Math.max(persistedSeq, entry.seq);
                } catch {
                    /** 丢弃这一条即可：下一次 materialize 会带上更新的内容。 */
                    markDegraded();
                    continue;
                }
                /** 保存成功后的收尾固定「先改写、后删除」，中途崩溃留下的必须是一条 synced 记录。 */
                if (entry.deleteAfterWrite && !pendingSlot && !aborted && editSeq === savedSeq && (phase === "clean" || tearingDown())) {
                    try {
                        await trackWrite(deps.recovery.deleteDraftByKey(draftKey));
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

    /**
     * 登记一条本会话发起的本地恢复操作，使其可被 whenLocalSettled 观察到。
     * 登记的是同一个 promise 引用，不复制、不重试；结束后自动摘除。
     */
    function trackLocal<T>(work: Promise<T>): Promise<T> {
        inFlightLocal.add(work);
        void work.catch(() => undefined).finally(() => inFlightLocal.delete(work));
        return work;
    }

    /** settled 永不拒绝；同步登记后才把有界 result 交还正常控制流。 */
    function trackWrite(write: CanvasLocalWrite): Promise<void> {
        trackLocal(write.settled);
        return write.result;
    }

    /**
     * 等到本会话的 drain、写入生产尾巴与每条 raw settled 信号都结束，不设上界。
     * dispose 会阻断新入口，已启动而稍后才可能产生写入的 finalSave/persistConflictRecords 尾巴也先登记在本集合，
     * 因此无工作时可立即返回；有工作时必须循环，等待期间新登记的 marker 写交给下一轮。
     * 同一会话只创建一个观察器。它不取消或重试，原始写永久挂起时这个后台观察器也永久挂起。
     */
    function whenLocalSettled(): Promise<void> {
        if (localSettlementWatcher) return localSettlementWatcher;
        localSettlementWatcher = (async () => {
            while (drainPromise || inFlightLocal.size) {
                /** 快照当前批次后整批等待；期间新登记的操作留给下一轮循环。 */
                const pending = [drainPromise, ...inFlightLocal].filter(Boolean) as Promise<unknown>[];
                /** raw settled 永不拒绝；allSettled 同时保护其他尾巴失败时不提前结束观察。 */
                await Promise.allSettled(pending);
            }
        })();
        return localSettlementWatcher;
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
                if (failure.kind === "conflict") guard(() => onSaveConflict(baseRevision), undefined);
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
        if (!aborted && phase !== "disposed") return false;
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
        /** 收尾期间不改阶段，只保留盘上的 pending 草稿等待下次打开。 */
        if (tearingDown()) return;
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
        /** 冲突事实先同步建立：收尾路径据此永久阻断网络，绝不会在 409 之后再补发一次保存。 */
        conflict = { baseRevision, source: "save", extraDraftCount: 0 };
        if (tearingDown()) {
            /** 迟到的 409 没有 UI，但冲突事实必须落盘：下次打开该画布时呈现。 */
            void trackLocal(persistConflictRecords(baseRevision));
            return;
        }
        saveError = null;
        phase = "conflict";
        firstUnsavedEditAt = 0;
        assertCounters("saveConflict");
        notify();
        /** 尾巴登记为在飞的本地操作：marker 写落在 drain 之后，清理必须等到它也结束。 */
        void trackLocal(persistConflictRecords(baseRevision));
    }

    async function persistConflictRecords(baseRevision: number) {
        const payload = ensureSnapshot();
        materializedSeq = Math.max(materializedSeq, payload.seq);
        pendingSlot = { record: buildDraftRecord("pending", payload), seq: payload.seq, deleteAfterWrite: false };
        const written = await settleWithin(drainLocal(), LOCAL_FLUSH_TIMEOUT_MS);
        if (written.status !== "ok") markDegraded();
        const entry: CanvasConflictMarkerEntry = { draftKey, draftId: resolution.draftId, baseRevision, savedAt: new Date(deps.now()).toISOString() };
        /** 完整尾巴已登记；这里也登记有界读取，保证 marker 写开始前观察器不会越过步骤间隙。 */
        const existing = await settleWithin(trackLocal(deps.recovery.readMarker(draftScope)), LOCAL_READ_TIMEOUT_MS);
        const older = existing.status === "ok" && existing.value ? existing.value.entries.filter((item) => item.draftKey !== draftKey) : [];
        /** 最新的本地内容永远排在 entries[0]，旧 marker 不能夺回入口。 */
        const entries = [entry, ...older].slice(0, MAX_CONFLICT_MARKER_ENTRIES);
        const markerWrite = deps.recovery.writeMarker({ ...draftScope, entries });
        /** raw settled 先进入本会话集合；有界 result 仍负责 degraded。 */
        const marked = await settleWithin(trackWrite(markerWrite), LOCAL_FLUSH_TIMEOUT_MS);
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

    /**
     * 删除活动画布前的可逆冻结（10 与 11 的「失败项待保存编辑不被丢弃」）。
     * 只做两件事：停掉计时器与网络、把最后一次编辑强制物化到本地；会话所有权原样保留。
     */
    async function holdForDelete() {
        if (held || phase === "loading" || tearingDown()) return;
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
        let marker: CanvasConflictMarker | null;
        let drafts: CanvasDraftRecord[];
        try {
            marker = await readWithRetry(() => deps.recovery.readMarker(draftScope));
            drafts = await readWithRetry(() => deps.recovery.listCanvasDrafts(draftScope));
        } catch {
            return "failed";
        }
        if (phase !== "recovery-blocked") return "failed";
        const draftByKey = new Map(drafts.map((draft) => [canvasDraftKey(draftScope, draft.draftId), draft] as const));
        /** 与 4.4 同一张判定表：条目必须指向 draftId 与 baseRevision 都一致的 pending 草稿。 */
        const valid = marker ? marker.entries.filter((entry) => markerEntryMatches(entry, draftByKey.get(entry.draftKey))) : [];
        /**
         * 没有有效 marker 不等于没有冲突：盘上可能还躺着一条未被 marker 引用的外来 pending 草稿
         * （本会话之外的标签页或上一次崩溃留下的）。它必须被提升为 marker 条目，而不是被忽略后解锁自动保存。
         */
        const foreignPending = !valid.length ? drafts.filter((draft) => draft.state === "pending" && canvasDraftKey(draftScope, draft.draftId) !== draftKey && draft.baseRevision !== revision) : [];
        if (!valid.length && !foreignPending.length) {
            if (marker) await settleWithin(trackLocal(deps.recovery.deleteMarkerIfOwned(draftScope, marker.entries.map((entry) => entry.draftKey)).result), LOCAL_FLUSH_TIMEOUT_MS);
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
        /** 未被 marker 引用的外来 pending 草稿在此提升为条目，排在本会话条目之后，旧 marker 永远不夺回入口。 */
        const promoted: CanvasConflictMarkerEntry[] = foreignPending.map((draft) => ({ draftKey: canvasDraftKey(draftScope, draft.draftId), draftId: draft.draftId, baseRevision: draft.baseRevision, savedAt: draft.savedAt }));
        const entries = [...own, ...[...valid, ...promoted].filter((entry) => entry.draftKey !== draftKey)].slice(0, MAX_CONFLICT_MARKER_ENTRIES);
        const markerWrite = deps.recovery.writeMarker({ ...draftScope, entries });
        /** 恢复重试也是本会话所有：先登记 raw settled，再等待有界 result。 */
        const marked = await settleWithin(trackWrite(markerWrite), LOCAL_FLUSH_TIMEOUT_MS);
        if (marked.status !== "ok") markDegraded();
        conflictBaseRevision = own.length ? revision : entries[0].baseRevision;
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

    /** forced 是唯一可以升级已有收尾的等级：中止在飞请求、抑制后续本地写、跳过所有等待。 */
    function escalateToForced() {
        aborted = true;
        disposeReason = "forced";
        pendingSlot = null;
        clearLocalTimer();
        clearNetworkTimer();
        inflightController?.abort();
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
            if (reason === "forced") {
                escalateToForced();
                /** 不再新增任何本地写；只等已经在飞的那一次结束，避免它写在清理之后。 */
                await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
            } else if (reason === "deleted") {
                /** 画布已被删除：不再新增任何本地写，只等已经在飞的那一次结束，避免写在清理之后。 */
                pendingSlot = null;
                inflightController?.abort();
                settleAfterRequest();
                await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
            } else {
                await flushLocal(DETACHED_LOCAL_MS);
                if (networkAllowed) await settleWithin(trackLocal(finishNetwork()), DETACHED_NETWORK_MS);
                /** 10 s 上界必须真正成立：等待结束仍未落定就中止那次请求，绝不把会话拖到 20 s 之外。 */
                if (inflightSeq >= 0 || inflightRequest) escalateToForced();
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
        const payload = ensureSnapshot();
        const baseRevision = revision;
        const controller = new AbortController();
        inflightSeq = payload.seq;
        inflightController = controller;
        try {
            const result = await deps.repository.save(scope.workspaceId, canvasId, { baseRevision, title: payload.title, snapshot: payload.snapshot }, controller.signal);
            guard(() => onSaveAck(result), undefined);
        } catch (error) {
            const failure = classifyCanvasSaveError(error);
            if (failure.kind === "conflict") guard(() => onSaveConflict(baseRevision), undefined);
            else guard(() => onSaveFail(failure), undefined);
        }
        /** 成功分支的草稿改写已排入单槽，这里有界等待它落盘，让 disposed 之后不再新增写。 */
        await settleWithin(drainPromise ?? Promise.resolve(), DETACHED_LOCAL_MS);
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
        holdForDelete: () => guardAsync(() => holdForDelete(), undefined),
        releaseHold: () => guard(() => releaseHold(), undefined),
        retrySave: () => guardAsync(() => retrySave(), undefined),
        retryRecovery: () => guardAsync(() => retryRecovery(), "failed" as CanvasRetryRecoveryResult),
        exportConflictDrafts: () => guardAsync(() => exportConflictDrafts(), []),
        dispose: (reason) => guardAsync(() => dispose(reason), undefined),
        whenLocalSettled: () => whenLocalSettled(),
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
