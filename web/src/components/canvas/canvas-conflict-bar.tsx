import { useState } from "react";
import { App } from "antd";
import { CloudDownload, Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasCommitServerCopyResult } from "@/services/canvas-sync/types";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 版本冲突提示条：出现即表示该画布的自动保存已经停止。
 * 只提供「重新载入服务端版本」和「导出本地草稿」两个显式动作，不做任何自动合并或覆盖。
 */
export function CanvasConflictBar({ projectId, onReloadServerCopy }: { projectId: string; onReloadServerCopy: () => Promise<CanvasCommitServerCopyResult> }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const conflict = useCanvasStore((state) => (state.sync?.canvasId === projectId ? state.sync.conflict : null));
    const degraded = useCanvasStore((state) => (state.sync?.canvasId === projectId ? state.sync.localPersist === "degraded" : false));
    const exportConflictDrafts = useCanvasStore((state) => state.exportConflictDrafts);
    const [busy, setBusy] = useState<"reload" | "export" | null>(null);

    if (!conflict) return null;

    const reload = async () => {
        setBusy("reload");
        try {
            const result = await onReloadServerCopy();
            /** cancelled 表示被新的打开或重载取代，保持安静。 */
            if (result === "committed") message.success(t("canvas.conflict.reloaded"));
            if (result === "failed") message.error(t("canvas.conflict.reloadFailed"));
        } finally {
            setBusy(null);
        }
    };

    const exportDrafts = async () => {
        setBusy("export");
        try {
            const projects = await exportConflictDrafts(projectId);
            if (!projects.length) return message.error(t("canvas.conflict.draftMissing"));
            /** 最多两份，新→旧，一起打包进同一个 zip。 */
            await exportCanvasProjects(projects, t("canvas.conflict.draftName", { title: projects[0].title || t("canvas.project.untitled") }));
            message.success(t("canvas.conflict.exported"));
        } catch {
            message.error(t("canvas.conflict.exportFailed"));
        } finally {
            setBusy(null);
        }
    };
    const exportLabel = conflict.extraDraftCount > 0 ? t("canvas.conflict.exportDraftMultiple", { count: conflict.extraDraftCount + 1 }) : t("canvas.conflict.exportDraft");

    return (
        <div role="status" className="pointer-events-auto absolute left-1/2 top-16 z-50 flex max-w-[min(680px,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-xs" style={{ background: theme.node.panel, color: theme.node.text }}>
            <span className="font-medium">{t("canvas.conflict.title")}</span>
            <span className="min-w-0 flex-1" style={{ color: theme.node.muted }}>
                {t("canvas.conflict.description")}
            </span>
            <button
                type="button"
                onClick={() => void reload()}
                disabled={busy !== null}
                aria-label={t("canvas.conflict.reload")}
                className="flex items-center gap-1 rounded-md px-2 py-1 font-medium transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
            >
                <CloudDownload className="size-3.5" />
                {t("canvas.conflict.reload")}
            </button>
            <button
                type="button"
                onClick={() => void exportDrafts()}
                disabled={busy !== null}
                aria-label={exportLabel}
                className="flex items-center gap-1 rounded-md px-2 py-1 font-medium transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
            >
                <Download className="size-3.5" />
                {exportLabel}
            </button>
            {degraded ? (
                <span className="w-full" style={{ color: theme.node.muted }}>
                    {t("canvas.conflict.localDegraded")}
                </span>
            ) : null}
        </div>
    );
}
