import { useEffect } from "react";

import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";
import { useWorkspaceStore } from "@/stores/use-workspace-store";

/**
 * 画布数据的作用域 = 已登录 userId + 当前 Workspace ID。
 * 任一变化都要立刻清空内存中的服务端数据、计时器与冲突态，避免上一个作用域的数据泄漏到当前界面。
 */
export function useCanvasScopeSync() {
    const userId = useUserStore((state) => state.user?.id ?? "");
    const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId ?? "");
    const setScope = useCanvasStore((state) => state.setScope);

    useEffect(() => {
        setScope(userId && workspaceId ? { userId, workspaceId } : null);
    }, [setScope, userId, workspaceId]);
}
