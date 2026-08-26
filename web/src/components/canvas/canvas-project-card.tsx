import { Check, Download, Pencil, Trash2, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Input } from "antd";
import { useTranslation } from "react-i18next";

import type { CanvasProjectSummary } from "@/lib/canvas/canvas-snapshot";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";

export function CanvasProjectCard({ summary }: { summary: CanvasProjectSummary }) {
    const { i18n, t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const renameProject = useCanvasStore((state) => state.renameProject);
    const loadProjectsForExport = useCanvasStore((state) => state.loadProjectsForExport);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const editingId = useCanvasUiStore((state) => state.editingProjectId);
    const editingTitle = useCanvasUiStore((state) => state.editingProjectTitle);
    const startEditing = useCanvasUiStore((state) => state.startEditingProject);
    const setEditingTitle = useCanvasUiStore((state) => state.setEditingProjectTitle);
    const stopEditing = useCanvasUiStore((state) => state.stopEditingProject);
    const toggleSelected = useCanvasUiStore((state) => state.toggleSelectedProjectId);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const editing = editingId === summary.id;
    const selected = selectedIds.includes(summary.id);
    const open = () => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${summary.id}${searchParams.toString() ? `?${searchParams.toString()}` : ""}${agentHash}`, { replace: Boolean(agentHash) });
    };
    /** 改名要等服务端确认；冲突或失败时保留输入框内容，让用户自己决定重试。 */
    const saveTitle = async () => {
        try {
            await renameProject(summary.id, editingTitle);
            stopEditing();
        } catch {
            message.error(t("canvas.renameFailed"));
        }
    };
    /** 列表只有摘要，导出前需要按 id 从服务端取回完整快照。 */
    const exportProject = async () => {
        try {
            const projects = await loadProjectsForExport([summary.id]);
            if (!projects.length) return;
            await exportCanvasProjects(projects, summary.title || t("canvas.title"));
        } catch {
            message.error(t("canvas.exportFailed"));
        }
    };

    return (
        <article className="group flex min-h-44 cursor-pointer flex-col justify-between rounded-2xl bg-[#f1eee8] p-5 transition hover:bg-[#ebe6dc] dark:bg-white/5 dark:hover:bg-white/10" onClick={() => !editing && open()}>
            <div className="flex items-start gap-3">
                <input
                    type="checkbox"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => toggleSelected(summary.id, event.target.checked)}
                    className="mt-1 size-4 accent-stone-950 dark:accent-stone-100"
                    aria-label={t("canvas.project.select", { name: summary.title })}
                />
                {editing ? (
                    <Input className="min-w-0" value={editingTitle} onClick={(event) => event.stopPropagation()} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void saveTitle()} autoFocus />
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer text-left"
                        onClick={(event) => {
                            event.stopPropagation();
                            open();
                        }}
                    >
                        <h2 className="truncate text-xl font-semibold">{summary.title}</h2>
                        {summary.nodeCount === null || summary.connectionCount === null ? null : (
                            <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-400">
                                {t("canvas.project.stats", { nodes: summary.nodeCount, connections: summary.connectionCount })}
                            </p>
                        )}
                    </button>
                )}
            </div>
            <div className="mt-8 flex items-end justify-between gap-3">
                <p className="text-xs text-stone-500">{t("canvas.project.updated", { date: new Date(summary.updatedAt).toLocaleString(i18n.resolvedLanguage, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })}</p>
                <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {editing ? (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Check className="size-4" />} onClick={() => void saveTitle()} aria-label={t("canvas.project.saveName")} />
                            <Button type="text" size="small" shape="circle" icon={<X className="size-4" />} onClick={stopEditing} aria-label={t("canvas.project.cancelRename")} />
                        </>
                    ) : (
                        <>
                            <Button type="text" size="small" shape="circle" icon={<Download className="size-4" />} onClick={() => void exportProject()} aria-label={t("canvas.project.export")} />
                            <Button type="text" size="small" shape="circle" icon={<Pencil className="size-4" />} onClick={() => startEditing(summary.id, summary.title)} aria-label={t("canvas.project.rename")} />
                            <Button type="text" size="small" shape="circle" icon={<Trash2 className="size-4" />} onClick={() => setDeleteIds([summary.id])} aria-label={t("canvas.project.delete")} />
                        </>
                    )}
                </div>
            </div>
        </article>
    );
}
