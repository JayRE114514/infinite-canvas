import type { WorkspaceRole } from "@infinite-canvas/contracts";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import { AppError } from "../../errors.js";
import { requireDatabase } from "../../infrastructure/database/plugin.js";
import { workspaceMembers } from "../identity/auth-schema.js";
import { requireSession } from "../identity/session.js";

export type WorkspaceAccess = { workspaceId: string; userId: string; role: WorkspaceRole };

export function parseWorkspaceRole(role: string): WorkspaceRole {
    if (role === "owner" || role === "admin" || role === "member") return role;
    throw new Error(`Unsupported workspace role: ${role}`);
}

/** 路径中的 workspaceId 每次都重新查询成员表，不信任 Session activeOrganizationId。 */
export async function requireWorkspaceMember(
    request: FastifyRequest,
    workspaceId: string,
): Promise<WorkspaceAccess> {
    const { userId } = await requireSession(request);
    const { db } = requireDatabase(request.server);
    const member = await db.query.workspaceMembers.findFirst({
        where: and(eq(workspaceMembers.organizationId, workspaceId), eq(workspaceMembers.userId, userId)),
    });

    if (!member) throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
    return { workspaceId, userId, role: parseWorkspaceRole(member.role) };
}

export function requireWorkspaceManager(access: WorkspaceAccess): void {
    if (access.role === "owner" || access.role === "admin") return;
    throw new AppError("workspace_admin_required", 403, "需要空间所有者或管理员权限");
}
