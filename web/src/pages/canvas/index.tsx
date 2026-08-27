import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button } from "antd";
import { Download, FileUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef("");
    const scope = useCanvasStore((state) => state.scope);
    const listStatus = useCanvasStore((state) => state.listStatus);
    const listError = useCanvasStore((state) => state.listError);
    const summaries = useCanvasStore((state) => state.summaries);
    const refreshList = useCanvasStore((state) => state.refreshList);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const loadProjectsForExport = useCanvasStore((state) => state.loadProjectsForExport);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const ready = Boolean(scope) && listStatus === "ready";
    const autoOpenScopeKey = scope ? JSON.stringify([scope.userId, scope.workspaceId]) : "";
    const enterProject = (id: string) => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${id}${agentQuery}${agentHash}`, { replace: Boolean(agentHash) });
    };
    /** 新建必须由用户显式触发，服务端返回 id 后才导航，避免拿到本地临时 id 后再对不上服务端画布。 */
    const createAndEnter = async () => {
        const result = await createProject(t("canvas.defaultTitle", { count: summaries.length + 1 }));
        if (result.status === "created") {
            enterProject(result.canvasId);
            return true;
        }
        /** 账号或 Workspace 已切换：既不导航也不提示失败，新作用域会自己再发起一次。 */
        if (result.status === "failed") message.error(t(result.messageKey));
        return false;
    };
    const exportProjects = async (ids: string[]) => {
        try {
            const projects = await loadProjectsForExport(ids);
            if (!projects.length) return;
            await exportCanvasProjects(projects, `${t("canvas.title")}-${projects.length}`);
        } catch {
            message.error(t("canvas.exportFailed"));
        }
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        const blob = zip.get(item.path);
                        if (!blob) return;
                        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                        await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                    }),
                ),
            );
            /** 导入是显式上传：逐个创建服务端画布并分别记账，避免「已创建若干却提示全失败」或谎报全部成功。 */
            let created = 0;
            let failed = 0;
            for (const item of data.projects) {
                const result = await importProject(item.project, t("canvas.project.imported"));
                /** 切换作用域后剩下的画布不再属于当前列表，直接停止，不计为失败。 */
                if (result.status === "scope-changed") break;
                if (result.status === "created") created += 1;
                else failed += 1;
            }
            if (created) message.success(t("canvas.imported", { count: created }));
            if (failed) message.error(t("canvas.importPartialFailed", { count: failed }));
            if (!created && !failed) return;
            await refreshList();
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (scope && listStatus === "idle") void refreshList();
    }, [listStatus, refreshList, scope]);

    /** Agent 的 mode=new / mode=recent 保持原语义，只是改为等服务端列表就绪后再决定打开哪个画布。 */
    useEffect(() => {
        if (!autoOpenScopeKey) {
            autoOpenRef.current = "";
            return;
        }
        if (!ready || autoOpenRef.current === autoOpenScopeKey || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = autoOpenScopeKey;
        void (async () => {
            const recentId = mode === "recent" ? summaries[0]?.id : undefined;
            if (recentId) {
                enterProject(recentId);
                return;
            }
            const opened = await createAndEnter();
            const currentScope = useCanvasStore.getState().scope;
            const currentScopeKey = currentScope ? JSON.stringify([currentScope.userId, currentScope.workspaceId]) : "";
            if (!opened && currentScopeKey === autoOpenScopeKey && autoOpenRef.current === autoOpenScopeKey && window.location.pathname === "/canvas") {
                autoOpenRef.current = "";
                navigate("/canvas", { replace: true });
            }
        })();
    }, [autoOpenScopeKey, mode, ready, summaries]);

    if (mode === "new" || mode === "recent") return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!ready} icon={<Download className="size-4" />} onClick={() => void exportProjects(selectedIds)}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!ready} onClick={() => setDeleteIds(selectedIds)}>
                                    {t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {summaries.length ? (
                            <Button disabled={!ready} onClick={() => setDeleteIds(summaries.map((summary) => summary.id))}>
                                {t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!ready} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!ready} type="primary" icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {listStatus === "error" ? (
                    <section className="flex min-h-[360px] flex-col items-center justify-center gap-3 border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">
                        <p>{t(listError || "canvas.listFailed")}</p>
                        <Button type="text" className="hover:bg-black/5 dark:hover:bg-white/10" onClick={() => void refreshList()}>
                            {t("canvas.retry")}
                        </Button>
                    </section>
                ) : !ready ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : summaries.length ? (
                    <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {summaries.map((summary) => (
                            <CanvasProjectCard key={summary.id} summary={summary} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}
