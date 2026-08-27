import type { WorkspaceRole, WorkspaceStatus, WorkspaceType } from "@infinite-canvas/contracts";
import { and, eq } from "drizzle-orm";

import { AppError } from "../../errors.js";
import type { AppTransaction } from "../../infrastructure/database/types.js";
import { workspaceMembers, workspaces } from "./schema.js";

export type WorkspaceAccess = {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    workspaceType: WorkspaceType;
    workspaceStatus: WorkspaceStatus;
};

const ROLE_RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };

export function parseWorkspaceRole(role: string): WorkspaceRole {
    if (role === "owner" || role === "admin" || role === "member") return role;
    throw new Error(`Unsupported workspace role: ${role}`);
}

/**
 * 授权只在调用方已经打开的事务上执行，和后续业务 SQL 共用同一条连接。
 * RLS 是第二道边界，不能替代这里的成员与角色检查。
 */
export async function requireWorkspaceAccess(
    tx: AppTransaction,
    input: { userId: string; workspaceId: string; minimumRole?: WorkspaceRole },
): Promise<WorkspaceAccess> {
    const [row] = await tx
        .select({
            role: workspaceMembers.role,
            workspaceType: workspaces.type,
            workspaceStatus: workspaces.status,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(
            and(
                eq(workspaceMembers.workspaceId, input.workspaceId),
                eq(workspaceMembers.userId, input.userId),
                eq(workspaceMembers.status, "active"),
            ),
        )
        .limit(1);

    if (!row) throw new AppError("workspace_forbidden", 403, "无权访问当前空间");

    const access: WorkspaceAccess = {
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: parseWorkspaceRole(row.role),
        workspaceType: row.workspaceType,
        workspaceStatus: row.workspaceStatus,
    };

    if (input.minimumRole && ROLE_RANK[access.role] < ROLE_RANK[input.minimumRole]) {
        throw new AppError("workspace_admin_required", 403, "需要空间所有者或管理员权限");
    }

    return access;
}

/** 只有活跃空间允许普通业务写入；被暂停或下线的空间一律拒绝。 */
export function requireActiveWorkspace(access: WorkspaceAccess): void {
    if (access.workspaceStatus === "active") return;
    throw new AppError("workspace_inactive", 409, "当前空间已停用");
}

export function requireTeamWorkspace(access: WorkspaceAccess): void {
    if (access.workspaceType === "team") return;
    throw new AppError("personal_workspace_single_member", 409, "个人空间只能包含所有者");
}

export function requireWorkspaceManager(access: WorkspaceAccess): void {
    if (access.role === "owner" || access.role === "admin") return;
    throw new AppError("workspace_admin_required", 403, "需要空间所有者或管理员权限");
}
