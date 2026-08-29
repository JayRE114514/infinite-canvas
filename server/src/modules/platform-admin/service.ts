import type { AdminWorkspace } from "@infinite-canvas/contracts";
import { sql } from "drizzle-orm";

import type { AppTransaction } from "../../infrastructure/database/types.js";

export type WorkspaceLifecycleAction = "suspend" | "deactivate" | "restore";

type WorkspaceAdminOperationRow = {
    workspace_id: string;
    workspace_name: string;
    workspace_slug: string;
    workspace_type: AdminWorkspace["type"];
    workspace_status: AdminWorkspace["status"];
    owner_user_id: string;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
};

function toAdminWorkspace(workspace: WorkspaceAdminOperationRow): AdminWorkspace {
    return {
        id: workspace.workspace_id,
        name: workspace.workspace_name,
        slug: workspace.workspace_slug,
        type: workspace.workspace_type,
        status: workspace.workspace_status,
        ownerUserId: workspace.owner_user_id,
        createdAt: new Date(workspace.created_at).toISOString(),
        updatedAt: new Date(workspace.updated_at).toISOString(),
        deletedAt: workspace.deleted_at === null ? null : new Date(workspace.deleted_at).toISOString(),
    };
}

/** 唯一管理员数据入口不接受第二份 actor/target/purpose；数据库从 xid 绑定操作推导并强制审计。 */
export async function executeWorkspaceAdminOperation(tx: AppTransaction): Promise<AdminWorkspace> {
    const result = await tx.execute<WorkspaceAdminOperationRow>(
        sql`select * from public.execute_workspace_admin_operation()`,
    );
    const workspace = result.rows[0];
    if (!workspace) throw new Error("execute_workspace_admin_operation returned no Workspace");
    return toAdminWorkspace(workspace);
}
