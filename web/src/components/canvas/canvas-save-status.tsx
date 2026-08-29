import { useState } from "react";
import { App, theme as antdTheme } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 云端保存状态：和 Agent 状态同一视觉重量，纯文字、无边框无底色无阴影。
 * 版本冲突由冲突提示条负责，这里不重复表达。
 */
export function CanvasSaveStatus({ onReloadCanvas }: { onReloadCanvas: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const sync = useCanvasStore((state) => state.sync);
    const retrySave = useCanvasStore((state) => state.retrySave);
    const retryRecovery = useCanvasStore((state) => state.retryRecovery);
    const [busy, setBusy] = useState(false);
    if (!sync) return null;

    const canvasId = sync.canvasId;
    const degraded = sync.localPersist === "degraded";
    const tombstoned = sync.phase === "tombstoned";
    const invariant = sync.saveError?.kind === "invariant";
    /** clean 且本会话从未保存过时不显示状态位；冲突由冲突条表达。 */
    const label =
        tombstoned
            ? t(sync.unavailableKey || "canvas.recovery.tombstoned")
            : sync.phase === "saving"
            ? t("canvas.save.saving")
            : sync.phase === "dirty"
              ? t("canvas.save.unsaved")
              : sync.phase === "save-error"
                ? t(sync.saveError?.messageKey || "canvas.save.failed")
                : sync.phase === "recovery-blocked"
                  ? t("canvas.save.recoveryFailed")
                  : sync.phase === "clean" && sync.savedOnce
                    ? t("canvas.save.saved")
                    : "";
    if (!label && !degraded) return null;

    const action = invariant
        ? { label: t("canvas.save.reloadCanvas"), run: async () => onReloadCanvas() }
        : sync.phase === "save-error"
          ? { label: t("canvas.save.retry"), run: () => retrySave(canvasId) }
          : sync.phase === "recovery-blocked"
            ? {
                  label: t("canvas.save.recoveryRetry"),
                  run: async () => {
                      if ((await retryRecovery(canvasId)) === "failed") message.error(t("canvas.save.recoveryRetryFailed"));
                  },
              }
            : null;
    const failed = tombstoned || degraded || sync.phase === "save-error" || sync.phase === "recovery-blocked";
    const statusLabel = [label, degraded ? t("canvas.save.localDegraded") : ""].filter(Boolean).join(" · ");

    /** 重试都要真正重新执行：普通保存重新捕获当前最新内容，恢复失败则重新读本地 marker/草稿。 */
    const runAction = async () => {
        if (!action || busy) return;
        setBusy(true);
        try {
            await action.run();
        } catch {
            message.error(t(sync.phase === "recovery-blocked" ? "canvas.save.recoveryRetryFailed" : "canvas.save.failed"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className="flex h-8 items-center gap-1.5 text-xs" style={{ color: failed ? token.colorError : theme.node.muted }}>
            <span className="max-w-[220px] truncate">{statusLabel}</span>
            {action ? (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runAction()}
                    aria-label={action.label}
                    className="font-medium underline underline-offset-2 transition hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {action.label}
                </button>
            ) : null}
        </span>
    );
}
