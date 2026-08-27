import { nanoid } from "nanoid";

import { clampCanvasTitle, projectToImportBody, projectToSnapshot, projectToSummary } from "@/lib/canvas/canvas-snapshot";
import { platformErrorTranslationKey } from "@/services/api/platform-client";
import { canvasDraftKey, canvasLocalRecovery } from "@/services/canvas-local-recovery";
import { canvasRepository, classifyCanvasOpenError, classifyCanvasSaveError } from "@/services/canvas-repository";
import { createCanvasSyncSession, resolveCanvasOpenRecovery, type CanvasRecoveryResolution, type CanvasSyncSessionDeps } from "@/services/canvas-sync/canvas-sync-session";
import {
    DETACHED_LOCAL_MS,
    EXPORT_BATCH_SIZE,
    LOCAL_FLUSH_TIMEOUT_MS,
    LOCAL_READ_TIMEOUT_MS,
    MAX_DETACHED_SESSIONS,
    sameCanvasScope,
    settleWithin,
    type CanvasCommitServerCopyResult,
    type CanvasCreateResult,
    type CanvasDeleteResult,
    type CanvasDisposeReason,
    type CanvasDraftScope,
    type CanvasListResult,
    type CanvasLoadResult,
    type CanvasRenameResult,
    type CanvasSyncManager,
    type CanvasSyncSession,
    type PreparedCanvasOpen,
} from "@/services/canvas-sync/types";
import type { CanvasProject, CanvasScope } from "@/types/canvas";

export type CanvasSyncManagerDeps = CanvasSyncSessionDeps;

/** 唯一的会话所有者：持有作用域与令牌、安装/替换活动会话、收尾被替换的会话，并承担不属于任何会话的列表级操作。 */
export function createCanvasSyncManager(deps: CanvasSyncManagerDeps): CanvasSyncManager {
    let scope: CanvasScope | null = null;
    let scopeToken = 0;
    let openToken = 0;
    let sessionSeq = 0;
    let active: CanvasSyncSession | null = null;
    let activeUnsubscribe: (() => void) | null = null;
    const detached = new Set<CanvasSyncSession>();
    /**
     * 已被驱逐、不再计入 detached，但仍在硬收尾与本地落定中的会话数。
     * 逻辑会话数由 detached 有界保证（上限 MAX_DETACHED_SESSIONS）；这里只计数不持有会话引用，
     * 用来把「不可取消的 localforage 写」与「逻辑会话跟踪」分开，并在本地存储明显堆积时给出可观测信号。
     */
    let evicting = 0;
    const listeners = new Set<() => void>();

    const notify = () => listeners.forEach((listener) => listener());
    const isStale = (token: number, open: number) => token !== scopeToken || open !== openToken;
    const draftScopeOf = (session: CanvasSyncSession): CanvasDraftScope => ({ userId: session.scope.userId, workspaceId: session.scope.workspaceId, canvasId: session.canvasId });

    /**
     * detached 上限为 2：超限时最老的一个立即硬收尾，打开新画布永远不等待任何收尾。
     * 被驱逐的会话立刻移出 detached，让「逻辑会话数」保持有界；但它的硬收尾与随后的本地落定仍被观察，
     * 由 evicting 单独计数，避免不可取消的 IndexedDB 写脱离视野后无人收尾。evicting 只增不漏：每个条目都在 finally 里减回。
     */
    function detach(session: CanvasSyncSession, reason: CanvasDisposeReason) {
        detached.add(session);
        while (detached.size > MAX_DETACHED_SESSIONS) {
            const oldest = detached.values().next().value as CanvasSyncSession | undefined;
            if (!oldest || oldest === session) break;
            /**
             * 先中止再移出集合：dispose("forced") 会升级仍在进行的 replaced/scope-changed 收尾，
             * 中止在飞请求并抑制后续本地写，因此被驱逐的会话不会带着请求与快照脱离视野。
             */
            const eviction = oldest.dispose("forced");
            detached.delete(oldest);
            evicting += 1;
            /** 驱逐时仍有多个会话卡在本地落定，说明本地存储已经严重变慢，开发期直接暴露出来。 */
            if (deps.isDev && evicting > MAX_DETACHED_SESSIONS) console.warn("[canvas-sync] local teardown backlog", { evicting, detached: detached.size });
            void eviction
                /** 有界 dispose 后继续观察该会话自己的 raw 写；不取消、不重试，也不阻塞新画布。 */
                .then(() => oldest.whenLocalSettled())
                .finally(() => {
                    evicting -= 1;
                });
        }
        void session
            .dispose(reason)
            .then(() => session.whenLocalSettled())
            .finally(() => detached.delete(session));
    }

    function installSession(session: CanvasSyncSession, content: CanvasProject, previousReason: CanvasDisposeReason) {
        const previous = active;
        activeUnsubscribe?.();
        active = session;
        activeUnsubscribe = session.subscribe(() => notify());
        session.install(content);
        if (previous) detach(previous, previousReason);
        notify();
    }

    function setScope(next: CanvasScope | null) {
        const unchanged = scopeToken > 0 && ((scope === null && next === null) || sameCanvasScope(scope, next));
        if (unchanged) return;
        scopeToken += 1;
        openToken += 1;
        scope = next;
        const previous = active;
        activeUnsubscribe?.();
        activeUnsubscribe = null;
        active = null;
        /** 旧会话继续按自己捕获的作用域收尾；它写出的 marker/草稿永远落在旧作用域下。 */
        if (previous) detach(previous, "scope-changed");
        notify();
    }

    async function prepare(canvasId: string, withRecovery: boolean): Promise<PreparedCanvasOpen> {
        const current = scope;
        if (!current) return { status: "cancelled" };
        const token = scopeToken;
        const open = ++openToken;
        let load: CanvasLoadResult;
        try {
            load = await deps.repository.load(current.workspaceId, canvasId);
        } catch (error) {
            if (isStale(token, open)) return { status: "cancelled" };
            const failure = classifyCanvasOpenError(error);
            return failure.kind === "missing" ? { status: "missing" } : { status: "failed", messageKey: failure.messageKey };
        }
        if (isStale(token, open)) return { status: "cancelled" };
        if (load.project.id !== canvasId) return { status: "missing" };
        const resolution = withRecovery
            ? await resolveCanvasOpenRecovery(deps, current, load)
            : ({ phase: "clean", content: load.project, revision: load.revision, draftId: deps.createDraftId(), conflict: null } satisfies CanvasRecoveryResolution);
        if (isStale(token, open)) return { status: "cancelled" };
        /** 全程不改 active：补水期间旧会话仍是权威，迟到编辑发不出属于新画布的保存。 */
        const session = createCanvasSyncSession({ sessionId: ++sessionSeq, scope: current, scopeToken: token, openToken: open, canvasId, resolution }, deps);
        return { status: "ready", canvasId, project: resolution.content, session };
    }

    function commitAllowed(prepared: Extract<PreparedCanvasOpen, { status: "ready" }>, content: CanvasProject) {
        const session = prepared.session;
        return session.scopeToken === scopeToken && session.openToken === openToken && sameCanvasScope(session.scope, scope) && content.id === session.canvasId;
    }

    function commitPrepared(prepared: PreparedCanvasOpen, content: CanvasProject) {
        if (prepared.status !== "ready" || !commitAllowed(prepared, content)) return false;
        installSession(prepared.session, content, "replaced");
        void collectDraftGarbage(prepared.session);
        return true;
    }

    function commitServerCopy(prepared: PreparedCanvasOpen, content: CanvasProject): CanvasCommitServerCopyResult {
        if (prepared.status === "cancelled") return "cancelled";
        if (prepared.status !== "ready") return "failed";
        if (!commitAllowed(prepared, content)) return "cancelled";
        const session = prepared.session;
        /**
         * 服务端版本重载只允许替换「同一张画布的同一作用域会话」：
         * 为 A 准备的重载绝不能收尾 B，更不能拿 B 的 draftKey 去删 B 的草稿。对不上就当作过期结果静默取消。
         */
        const previous = active && active.canvasId === session.canvasId && sameCanvasScope(active.scope, session.scope) ? active : null;
        if (active && !previous) return "cancelled";
        /** 用户显式选择服务端版本：旧冲突会话的本地工作被丢弃，因此用 forced 收尾，不再写任何草稿。 */
        installSession(session, content, "forced");
        void runServerCopyCleanup(session, previous);
        return "committed";
    }

    /**
     * 用户显式选择服务端版本后，旧会话自己的草稿与它迟到写回的 marker 必须最终消失。
     * 但 IndexedDB 的 setItem 不可取消：有界 result/dispose 超时后，原始草稿或 marker 写仍可能在清理之后落盘。
     * 因此做两段：先在有界等待后立即清理一次（快路径，UI 立刻自洽），
     * 再等被替换会话真正本地落定后补一次幂等清理（慢路径，负责删掉超时后才写回的那条）。
     * 两段都不阻塞 commit 与画布补水；第二段只观察 previous 会话的 owner-scoped 信号，绝不等待同 canvasId 的新会话。
     */
    async function runServerCopyCleanup(session: CanvasSyncSession, previous: CanvasSyncSession | null) {
        const draftScope = draftScopeOf(session);
        /**
         * marker 可能有两条条目（8.3：本会话条目 + 外来条目），只删被替换会话自己的那一条，
         * 另一条会作为 pending 草稿在下次打开时重新升级成冲突。因此先读一次 marker，把它引用的草稿键全部收集起来。
         */
        const markerBefore = await settleWithin(deps.recovery.readMarker(draftScope), LOCAL_READ_TIMEOUT_MS);
        const markerKeys = markerBefore.status === "ok" && markerBefore.value ? markerBefore.value.entries.map((entry) => entry.draftKey) : [];
        /** 新会话的草稿键绝不能被删：它是这次「载入服务端版本」之后的当前会话。 */
        const oldDraftKeys = [...new Set([...(previous ? [previous.draftKey] : []), ...markerKeys])].filter((key) => key !== session.draftKey);
        if (previous) await settleWithin(previous.dispose("forced"), DETACHED_LOCAL_MS);
        await clearConflictRecovery(draftScope, oldDraftKeys);
        if (!previous) return;
        /**
         * 第二段无条件执行：dispose 与 write.result 都有界，只有 whenLocalSettled 会观察 raw setItem 的成功或拒绝。
         * 重复调用共享 previous 会话唯一的观察器；永久挂起只留下这条后台链，不影响 commit/open/UI。
        */
        await previous.whenLocalSettled();
        await clearConflictRecovery(draftScope, oldDraftKeys);
    }

    /**
     * 只删被替换会话明确拥有的草稿键，marker 则按身份条件删除。
     * 第二段清理可能在很久之后才跑：此时若已有更新的会话写入了自己的 marker，无条件删除会抹掉一份真实冲突。
     */
    async function clearConflictRecovery(draftScope: CanvasDraftScope, oldDraftKeys: string[]) {
        await settleWithin(
            Promise.allSettled([...oldDraftKeys.map((key) => deps.recovery.deleteDraftByKey(key).result), deps.recovery.deleteMarkerIfOwned(draftScope, oldDraftKeys).result]),
            LOCAL_FLUSH_TIMEOUT_MS,
        );
    }

    /** 画布已被删除：该画布下的全部草稿与 marker 都没有价值，一次清干净。 */
    async function clearDeletedCanvasRecovery(draftScope: CanvasDraftScope) {
        const drafts = await settleWithin(deps.recovery.listCanvasDrafts(draftScope), LOCAL_READ_TIMEOUT_MS);
        const keys = drafts.status === "ok" ? drafts.value.map((draft) => canvasDraftKey(draftScope, draft.draftId)) : [];
        /** 画布已确认删除，marker 无条件清理：这个 canvasId 不会再有合法的新会话。 */
        await settleWithin(Promise.allSettled([...keys.map((key) => deps.recovery.deleteDraftByKey(key).result), deps.recovery.deleteMarker(draftScope).result]), LOCAL_FLUSH_TIMEOUT_MS);
    }

    /** 4.5：打开成功后异步回收，保留当前会话草稿与 marker 引用的草稿，其余超过 6 小时才删。 */
    async function collectDraftGarbage(session: CanvasSyncSession) {
        const draftScope = draftScopeOf(session);
        const marker = await settleWithin(deps.recovery.readMarker(draftScope), LOCAL_READ_TIMEOUT_MS);
        /** marker 归属未知时完全跳过回收：「读不出来」不能降级成「没有 marker」，否则会删掉正被引用的冲突草稿。 */
        if (marker.status !== "ok") return;
        const keep = [session.draftKey, ...(marker.value ? marker.value.entries.map((entry) => entry.draftKey) : [])];
        await deps.recovery.collectGarbage(draftScope, keep);
    }

    const scopeChanged = (token: number, captured: CanvasScope) => token !== scopeToken || !sameCanvasScope(captured, scope);

    async function listCanvases(): Promise<CanvasListResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const summaries = await deps.repository.list(current.workspaceId);
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "ready", summaries };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.listFailed") };
        }
    }

    /** 新建不等待任何会话收尾；作用域已切换时返回 scope-changed 且不导航，已创建的空画布留在旧 Workspace。 */
    async function createCanvas(title: string): Promise<CanvasCreateResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const { project, revision } = await deps.repository.create(current.workspaceId, clampCanvasTitle(title));
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "created", canvasId: project.id, summary: projectToSummary(project, revision) };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.createFailed") };
        }
    }

    async function importCanvas(source: Partial<CanvasProject>, fallbackTitle: string): Promise<CanvasCreateResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const token = scopeToken;
        try {
            const { project, revision } = await deps.repository.importProject(current.workspaceId, projectToImportBody(source, fallbackTitle));
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "created", canvasId: project.id, summary: projectToSummary(project, revision) };
        } catch (error) {
            return scopeChanged(token, current) ? { status: "scope-changed" } : { status: "failed", messageKey: platformErrorTranslationKey(error, "canvas.importFailed") };
        }
    }

    async function renameCanvas(canvasId: string, title: string): Promise<CanvasRenameResult> {
        const current = scope;
        if (!current) return { status: "scope-changed" };
        const trimmed = clampCanvasTitle(title);
        if (!trimmed) return { status: "failed", messageKey: "canvas.renameFailed" };
        if (active && active.canvasId === canvasId && sameCanvasScope(active.scope, current)) {
            /** 活动画布走会话：标题并入同一次防抖保存，冲突或恢复阻断时只落本地草稿。 */
            return active.rename(trimmed) === "scheduled" ? { status: "scheduled" } : { status: "local-only" };
        }
        const token = scopeToken;
        try {
            const loaded = await deps.repository.load(current.workspaceId, canvasId);
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            const saved = await deps.repository.save(current.workspaceId, canvasId, { baseRevision: loaded.revision, title: trimmed, snapshot: projectToSnapshot(loaded.project) });
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            return { status: "saved", summary: projectToSummary({ ...saved.project, title: trimmed }, saved.revision) };
        } catch (error) {
            if (scopeChanged(token, current)) return { status: "scope-changed" };
            /** 列表项重命名遇到 409 不写任何 marker：让用户打开该画布处理冲突。 */
            return classifyCanvasSaveError(error).kind === "conflict" ? { status: "conflict" } : { status: "failed", messageKey: "canvas.renameFailed" };
        }
    }

    async function deleteCanvases(canvasIds: string[]): Promise<CanvasDeleteResult> {
        const current = scope;
        if (!current || !canvasIds.length) return { deleted: [], failed: [] };
        const target = active && canvasIds.includes(active.canvasId) ? active : null;
        if (target) {
            /**
             * 删除结果未知之前只做「可逆冻结」：停编辑、停网络、强制把最后一次编辑落到本地，
             * 但仍持有会话。删除失败时必须能原样恢复，否则活动画布会连同它最新的编辑一起消失。
             */
            await target.holdForDelete();
        }
        const outcomes = await Promise.allSettled(canvasIds.map((canvasId) => deps.repository.remove(current.workspaceId, canvasId)));
        const deleted = canvasIds.filter((_id, index) => outcomes[index].status === "fulfilled");
        const failed = canvasIds.filter((canvasId) => !deleted.includes(canvasId));
        if (target) {
            if (deleted.includes(target.canvasId)) {
                /** 服务端确认删除后才终结：此时清空 active，并按 deleted 收尾跳过网络。 */
                if (active === target) {
                    activeUnsubscribe?.();
                    activeUnsubscribe = null;
                    active = null;
                }
                await target.dispose("deleted");
                notify();
            } else {
                /** 删除失败：同一个会话继续可用，冻结期间的编辑重新排程，UI 也要立刻回到可编辑状态。 */
                target.releaseHold();
                notify();
            }
        }
        /**
         * 故意使用调用时捕获的 current，而不是当前 scope：这些画布是在 current 下被删除的，
         * 它们的草稿与 marker 也只存在于 current 作用域的键下。删除期间若发生作用域切换，
         * 这里仍必须清理旧作用域，否则旧作用域的草稿会永远泄漏。不要在此加作用域守卫。
         */
        deleted.forEach((canvasId) => {
            const draftScope = { userId: current.userId, workspaceId: current.workspaceId, canvasId };
            /** 只有被收尾的那张活动画布可能还有在飞的本地写；其余画布没有会话，一次清理即可。 */
            const late = target && target.canvasId === canvasId ? target : null;
            void runDeletedCanvasCleanup(draftScope, late);
        });
        return { deleted, failed };
    }

    /**
     * 画布删除后的清理与服务端版本重载同构：dispose 与 write.result 都有界，
     * 返回时 raw setItem 可能仍在飞，并在清理之后落盘，把已删画布的草稿或 marker 写回来。
     * 因此先立即清理一次（删除结果与 UI 不等待本地存储），再等会话真正本地落定后幂等地补清一次。
     * 第二段无上界，但只是后台清理链，不在删除结果、UI 或打开画布的等待路径上。
     */
    async function runDeletedCanvasCleanup(draftScope: CanvasDraftScope, late: CanvasSyncSession | null) {
        await clearDeletedCanvasRecovery(draftScope);
        if (!late) return;
        /** 只观察 late 这个会话的 raw 写与生产尾巴；同 canvasId 的其他会话不在其 owner-scoped 集合中。 */
        await late.whenLocalSettled();
        await clearDeletedCanvasRecovery(draftScope);
    }

    async function loadForExport(canvasIds: string[]): Promise<CanvasProject[]> {
        const current = scope;
        if (!current || !canvasIds.length) return [];
        const projects: CanvasProject[] = [];
        for (let index = 0; index < canvasIds.length; index += EXPORT_BATCH_SIZE) {
            /** 任一批失败直接抛出，由 UI 提示导出失败，绝不返回缺内容的空包。 */
            const batch = await Promise.all(
                canvasIds.slice(index, index + EXPORT_BATCH_SIZE).map(async (canvasId) => {
                    if (active && active.canvasId === canvasId && sameCanvasScope(active.scope, current)) return active.content;
                    return (await deps.repository.load(current.workspaceId, canvasId)).project;
                }),
            );
            projects.push(...batch);
        }
        return projects;
    }

    return {
        getScope: () => scope,
        setScope,
        getActiveSession: () => active,
        prepareOpen: (canvasId) => prepare(canvasId, true),
        commitPrepared,
        prepareServerCopy: (canvasId) => prepare(canvasId, false),
        commitServerCopy,
        listCanvases,
        createCanvas,
        importCanvas,
        renameCanvas,
        deleteCanvases,
        loadForExport,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export const canvasSyncManager = createCanvasSyncManager({
    repository: canvasRepository,
    recovery: canvasLocalRecovery,
    now: () => Date.now(),
    createDraftId: () => nanoid(),
    isDev: import.meta.env.DEV,
});
