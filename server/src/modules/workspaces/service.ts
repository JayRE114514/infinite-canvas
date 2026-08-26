import { randomUUID } from "node:crypto";

import type { CreateWorkspaceBody, WorkspaceRole, WorkspaceSummary } from "@infinite-canvas/contracts";
import { and, eq, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import type { AppDatabase } from "../../infrastructure/database/types.js";
import { workspaceInvitations, workspaceMembers, workspaces } from "../identity/auth-schema.js";

export const WORKSPACE_SLUG_UNIQUE_INDEX = "workspaces_slug_uidx";
export const WORKSPACE_INVITATION_PENDING_UNIQUE_INDEX = "workspace_invitations_pending_email_unique";
const WORKSPACE_MEMBER_UNIQUE_INDEX = "workspace_members_workspace_user_unique";
const PERSONAL_OWNER_UNIQUE_INDEX = "workspaces_owner_personal_unique";
const DEFAULT_WORKSPACE_MEMBER_LIMIT = 100;

export type PersonalWorkspaceUser = { id: string; name: string };
export type WorkspaceInvitee = { id: string; email: string };
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

/** 团队空间与 owner 成员在同一个应用事务中创建，不写 Better Auth 活跃组织状态。 */
export async function createTeamWorkspace(
    db: AppDatabase,
    user: PersonalWorkspaceUser,
    input: CreateWorkspaceBody,
): Promise<WorkspaceSummary> {
    return await db.transaction(async (tx) => {
        const [workspace] = await tx
            .insert(workspaces)
            .values({
                id: randomUUID(),
                name: input.name,
                slug: input.slug,
                workspaceType: "team",
                status: "active",
                ownerUserId: user.id,
            })
            .returning();
        if (!workspace) throw new Error("Workspace insert returned no row");

        await tx.insert(workspaceMembers).values({
            id: randomUUID(),
            organizationId: workspace.id,
            userId: user.id,
            role: "owner",
        });

        return toWorkspaceSummary(workspace, "owner");
    });
}

/** 条件认领邀请、创建成员并标记接受必须同事务提交；重复请求只会有一个成功。 */
export async function acceptWorkspaceInvitation(
    db: AppDatabase,
    user: WorkspaceInvitee,
    invitationId: string,
): Promise<{ workspaceId: string }> {
    try {
        return await db.transaction(async (tx) => {
            const [invitation] = await tx
                .update(workspaceInvitations)
                .set({ status: "accepted" })
                .where(
                    and(
                        eq(workspaceInvitations.id, invitationId),
                        eq(workspaceInvitations.status, "pending"),
                        sql`${workspaceInvitations.expiresAt} > now()`,
                        sql`lower(${workspaceInvitations.email}) = lower(${user.email})`,
                    ),
                )
                .returning();

            if (!invitation) {
                const [existing] = await tx
                    .select({ email: workspaceInvitations.email })
                    .from(workspaceInvitations)
                    .where(eq(workspaceInvitations.id, invitationId))
                    .limit(1);
                if (existing && existing.email.toLowerCase() !== user.email.toLowerCase()) {
                    throw new AppError("workspace_invitation_recipient_mismatch", 403, "该邀请不属于当前用户");
                }
                throw new AppError("workspace_invitation_unavailable", 409, "邀请不存在、已过期或已处理");
            }

            const [workspace] = await tx
                .select({ workspaceType: workspaces.workspaceType })
                .from(workspaces)
                .where(eq(workspaces.id, invitation.organizationId))
                .limit(1)
                .for("update");
            if (!workspace || workspace.workspaceType !== "team" || (invitation.role !== "admin" && invitation.role !== "member")) {
                throw new AppError("workspace_invitation_unavailable", 409, "邀请不存在、已过期或已处理");
            }

            const [inviter] = await tx
                .select({ id: workspaceMembers.id })
                .from(workspaceMembers)
                .where(
                    and(
                        eq(workspaceMembers.organizationId, invitation.organizationId),
                        eq(workspaceMembers.userId, invitation.inviterId),
                    ),
                )
                .limit(1);
            if (!inviter) throw new AppError("workspace_invitation_unavailable", 409, "邀请不存在、已过期或已处理");

            const [memberCount] = await tx
                .select({ value: sql<number>`count(*)::int` })
                .from(workspaceMembers)
                .where(eq(workspaceMembers.organizationId, invitation.organizationId));
            if ((memberCount?.value ?? 0) >= DEFAULT_WORKSPACE_MEMBER_LIMIT) {
                throw new AppError("workspace_member_limit_reached", 409, "空间成员数量已达上限");
            }

            await tx.insert(workspaceMembers).values({
                id: randomUUID(),
                organizationId: invitation.organizationId,
                userId: user.id,
                role: invitation.role,
            });

            return { workspaceId: invitation.organizationId };
        });
    } catch (error) {
        if (isPostgresUniqueViolation(error, WORKSPACE_MEMBER_UNIQUE_INDEX)) {
            throw new AppError("workspace_invitation_already_member", 409, "该用户已是空间成员");
        }
        throw error;
    }
}
