import { useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 云端保存状态：和 Agent 状态同一视觉重量，纯文字、无边框无底色无阴影。
 * 版本冲突由冲突提示条负责，这里不重复表达。
 */
export function CanvasSaveStatus() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const saveState = useCanvasStore((state) => state.saveState);
    const canvasId = useCanvasStore((state) => state.active?.project.id ?? "");
    const retrySave = useCanvasStore((state) => state.retrySave);
    const retryCanvasRecovery = useCanvasStore((state) => state.retryCanvasRecovery);
    const [busy, setBusy] = useState(false);

    if (!canvasId || saveState === "idle" || saveState === "conflict") return null;

    const recovery = saveState === "recoveryError";
    const failed = recovery || saveState === "error";
    const label = recovery ? t("canvas.save.recoveryFailed") : saveState === "error" ? t("canvas.save.failed") : saveState === "saving" ? t("canvas.save.saving") : t("canvas.save.saved");
    const retryLabel = recovery ? t("canvas.save.recoveryRetry") : t("canvas.save.retry");

    /** 重试都要真正重新执行：普通保存重新捕获当前最新内容，恢复失败则重新读本地 marker/草稿。 */
    const retry = async () => {
        setBusy(true);
        try {
            if (recovery) {
                if (!(await retryCanvasRecovery(canvasId))) message.error(t("canvas.save.recoveryRetryFailed"));
            } else {
                await retrySave(canvasId);
            }
        } catch {
            message.error(t(recovery ? "canvas.save.recoveryRetryFailed" : "canvas.save.failed"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <span className="flex h-8 items-center gap-1.5 text-xs" style={{ color: failed ? "#dc2626" : theme.node.muted }}>
            <span className="max-w-[220px] truncate">{label}</span>
            {failed ? (
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void retry()}
                    aria-label={retryLabel}
                    className="font-medium underline underline-offset-2 transition hover:opacity-75 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {retryLabel}
                </button>
            ) : null}
        </span>
    );
}
