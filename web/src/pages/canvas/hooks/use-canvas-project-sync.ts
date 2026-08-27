import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { canvasSyncManager } from "@/services/canvas-sync/canvas-sync-manager";
import { sameCanvasScope, type CanvasCommitServerCopyResult } from "@/services/canvas-sync/types";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { CanvasProject } from "@/types/canvas";

export type CanvasProjectSyncStatus = "loading" | "ready" | "error";

export type UseCanvasProjectSyncParams = {
    projectId: string;
    /** 只做媒体补水，不写 React 状态；返回的引用原样交给 commit 与 apply。 */
    hydrate: (project: CanvasProject) => Promise<CanvasProject>;
    /** 在 commit 之后同步写入页面 React 状态。 */
    applyToCanvas: (project: CanvasProject) => void;
};

export type UseCanvasProjectSyncResult = {
    /** 渲染闸门：ready 且活动会话的 canvasId 与作用域都与当前路由一致。 */
    ready: boolean;
    status: CanvasProjectSyncStatus;
    errorKey: string | null;
    title: string;
    /** 重新走一次标准 prepare/commit 打开流程，用于闸门错误重试与不变量事故恢复。 */
    reopen: () => void;
    reloadServerCopy: () => Promise<CanvasCommitServerCopyResult>;
};

export function useCanvasProjectSync({ projectId, hydrate, applyToCanvas }: UseCanvasProjectSyncParams): UseCanvasProjectSyncResult {
    const navigate = useNavigate();
    const { message } = App.useApp();
    const { t } = useTranslation();
    const scope = useCanvasStore((state) => state.scope);
    const sync = useCanvasStore((state) => state.sync);
    const activeCanvasId = useCanvasStore((state) => state.activeCanvasId);
    const [status, setStatus] = useState<CanvasProjectSyncStatus>("loading");
    const [errorKey, setErrorKey] = useState<string | null>(null);
    const [applied, setApplied] = useState(false);
    const [openRun, setOpenRun] = useState(0);
    const runRef = useRef(0);
    const hydrateRef = useRef(hydrate);
    const applyRef = useRef(applyToCanvas);
    hydrateRef.current = hydrate;
    applyRef.current = applyToCanvas;
    const scopeKey = scope ? [scope.userId, scope.workspaceId].join(":") : "";

    useEffect(() => {
        if (!projectId || !scopeKey) return;
        /** 打开画布同时作废仍在进行的冲突重载：两者共用一个运行序号。 */
        const run = ++runRef.current;
        const superseded = () => run !== runRef.current;
        setApplied(false);
        setStatus("loading");
        setErrorKey(null);
        void (async () => {
            const prepared = await canvasSyncManager.prepareOpen(projectId);
            if (superseded() || prepared.status === "cancelled") return;
            if (prepared.status === "missing") {
                message.error(t("canvas.notFound"));
                navigate("/canvas", { replace: true });
                return;
            }
            if (prepared.status === "failed") {
                setStatus("error");
                setErrorKey(prepared.messageKey);
                return;
            }
            const hydrated = await hydrateRef.current(prepared.project);
            if (superseded()) return;
            /** commit 返回 false 一律按 cancelled 处理：不写 React、不导航、不提示。 */
            if (!canvasSyncManager.commitPrepared(prepared, hydrated)) return;
            applyRef.current(hydrated);
            setApplied(true);
            setStatus("ready");
        })();
        return () => {
            runRef.current += 1;
        };
    }, [message, navigate, openRun, projectId, scopeKey, t]);

    const reloadServerCopy = useCallback(async (): Promise<CanvasCommitServerCopyResult> => {
        const run = ++runRef.current;
        const superseded = () => run !== runRef.current;
        /** 闸门先关：补水期间画布容器不挂载，因此不可交互，也产生不了编辑。 */
        setApplied(false);
        const prepared = await canvasSyncManager.prepareServerCopy(projectId);
        if (superseded()) return "cancelled";
        if (prepared.status !== "ready") {
            setApplied(true);
            return prepared.status === "cancelled" ? "cancelled" : "failed";
        }
        const hydrated = await hydrateRef.current(prepared.project);
        if (superseded()) return "cancelled";
        const result = canvasSyncManager.commitServerCopy(prepared, hydrated);
        if (result !== "committed") {
            /** 失败时 store 完全没被改过：恢复原来的冲突会话与冲突条，不停在空壳上。 */
            setApplied(true);
            return result;
        }
        applyRef.current(hydrated);
        setApplied(true);
        return "committed";
    }, [projectId]);

    const reopen = useCallback(() => {
        runRef.current += 1;
        setApplied(false);
        setOpenRun((value) => value + 1);
    }, []);
    const ready = status === "ready" && applied && activeCanvasId === projectId && sync?.canvasId === projectId && sameCanvasScope(sync.scope, scope);

    return { ready, status, errorKey, title: sync?.canvasId === projectId ? sync.title : "", reopen, reloadServerCopy };
}
