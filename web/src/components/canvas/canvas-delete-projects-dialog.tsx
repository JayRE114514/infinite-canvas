import { useState } from "react";
import { App, Button, Modal } from "antd";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";

export function CanvasDeleteProjectsDialog() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [deleting, setDeleting] = useState(false);
    const ids = useCanvasUiStore((state) => state.deleteProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const removeSelectedIds = useCanvasUiStore((state) => state.removeSelectedProjectIds);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    /**
     * 删除以服务端结果为准，成功后才清理本地选中态。
     * 媒体文件不在这里回收：画布内容已在服务端，前端无法判断某个图片键是否仍被其他画布引用，
     * 盲目清理会删掉别的画布还在用的图片，媒体回收留到 Asset/AI 切换时统一处理。
     */
    const confirm = async () => {
        setDeleting(true);
        try {
            await deleteProjects(ids);
            removeSelectedIds(ids);
            setDeleteIds([]);
        } catch {
            message.error(t("canvas.deleteFailed"));
        } finally {
            setDeleting(false);
        }
    };

    return (
        <Modal
            title={t("canvas.project.deleteTitle")}
            open={ids.length > 0}
            centered
            onCancel={() => !deleting && setDeleteIds([])}
            footer={
                <>
                    <Button disabled={deleting} onClick={() => setDeleteIds([])}>{t("common.cancel")}</Button>
                    <Button danger type="primary" loading={deleting} onClick={() => void confirm()}>
                        {t("common.delete")}
                    </Button>
                </>
            }
        >
            <p className="text-sm text-stone-500">{t("canvas.project.deleteDescription", { count: ids.length })}</p>
        </Modal>
    );
}
