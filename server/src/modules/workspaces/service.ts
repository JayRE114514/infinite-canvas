import { randomUUID } from "node:crypto";

import type { WorkspaceRole, WorkspaceSummary } from "@infinite-canvas/contracts";
import { and, eq, sql } from "drizzle-orm";

import type { AppDatabase } from "../../infrastructure/database/types.js";
import { workspaceMembers, workspaces } from "../identity/auth-schema.js";

export const WORKSPACE_SLUG_UNIQUE_INDEX = "workspaces_slug_uidx";
const PERSONAL_OWNER_UNIQUE_INDEX = "workspaces_owner_personal_unique";

export type PersonalWorkspaceUser = { id: string; name: string };
export type WorkspaceRow = typeof workspaces.$inferSelect;

export function toWorkspaceSummary(workspace: WorkspaceRow, role: WorkspaceRole): WorkspaceSummary {
    if (workspace.workspaceType !== "personal" && workspace.workspaceType !== "team") {
        throw new Error(`Unsupported workspace type: ${workspace.workspaceType}`);
    }

    return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        type: workspace.workspaceType,
        status: workspace.status,
        ownerUserId: workspace.ownerUserId,
        role,
        createdAt: workspace.createdAt.toISOString(),
    };
}

/** 只按 SQLSTATE 与明确索引身份识别 PostgreSQL 唯一冲突。 */
export function isPostgresUniqueViolation(error: unknown, constraint: string): boolean {
    const pending = [error];
    const seen = new Set<unknown>();

    while (pending.length > 0) {
        const current = pending.shift();
        if (!current || typeof current !== "object" || seen.has(current)) continue;
        seen.add(current);

        const value = current as Record<string, unknown>;
        if (value.code === "23505" && value.constraint === constraint) return true;
        pending.push(value.cause);
        if (value.body && typeof value.body === "object") pending.push((value.body as Record<string, unknown>).cause);
    }

    return false;
}

/** 在一个事务中创建个人空间与唯一 owner；并发失败方读取已提交的胜出行。 */
export async function ensurePersonalWorkspace(db: AppDatabase, user: PersonalWorkspaceUser): Promise<WorkspaceSummary> {
    return await db.transaction(async (tx) => {
        const [created] = await tx
            .insert(workspaces)
            .values({
                id: randomUUID(),
                name: `${user.name}的个人空间`,
                slug: `personal-${user.id}-${randomUUID()}`,
                workspaceType: "personal",
                status: "active",
                ownerUserId: user.id,
            })
            .onConflictDoNothing({
                target: workspaces.ownerUserId,
                where: sql`workspace_type = 'personal'`,
            })
            .returning();

        if (created) {
            await tx.insert(workspaceMembers).values({
                id: randomUUID(),
                organizationId: created.id,
                userId: user.id,
                role: "owner",
            });
            return toWorkspaceSummary(created, "owner");
        }

        const [existing] = await tx
            .select()
            .from(workspaces)
            .where(and(eq(workspaces.ownerUserId, user.id), eq(workspaces.workspaceType, "personal")))
            .limit(1);

        if (!existing) {
            throw new Error(`Unique index ${PERSONAL_OWNER_UNIQUE_INDEX} reported a conflict without a committed row`);
        }
        return toWorkspaceSummary(existing, "owner");
    });
}
