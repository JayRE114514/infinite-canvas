import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
    CreateWorkspaceBody,
    CreateWorkspaceInvitationBody,
    UpdateWorkspaceBody,
    WorkspaceInvitation,
    WorkspaceMember,
    WorkspaceRole,
    WorkspaceSummary,
} from "@infinite-canvas/contracts";
import { and, asc, eq, ne, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import type { AppTransaction } from "../../infrastructure/database/types.js";
import { users } from "../identity/schema.js";
import { workspaceAuditLogs } from "../platform-admin/schema.js";
import { parseWorkspaceRole, requireTeamWorkspace, type WorkspaceAccess } from "./authorization.js";
import { workspaceInvitations, workspaceMembers, workspaces } from "./schema.js";

export const WORKSPACE_SLUG_UNIQUE_INDEX = "workspaces_slug_uidx";
export const WORKSPACE_INVITATION_PENDING_UNIQUE_INDEX = "workspace_invitations_pending_email_unique";
const WORKSPACE_PERSONAL_OWNER_UNIQUE_INDEX = "workspaces_owner_personal_unique";
const WORKSPACE_MEMBER_UNIQUE_INDEX = "workspace_members_workspace_user_unique";
const DEFAULT_WORKSPACE_MEMBER_LIMIT = 100;
const INVITATION_TTL_DAYS = 7;

export type PersonalWorkspaceUser = { id: string; name: string };
export type WorkspaceInvitee = { id: string; email: string };
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInvitationRow = typeof workspaceInvitations.$inferSelect;

/**
 * 只有本模块的仓储函数可以给"已确认属于当前用户的空间 ID"打标记。
 * 路由拿不到这个品牌类型，因此无法把请求参数里的 ID 当成己方空间。
 */
declare const resolvedOwnedWorkspace: unique symbol;
export type ResolvedOwnedWorkspaceId = string & { readonly [resolvedOwnedWorkspace]: true };

function brandOwnedWorkspaceId(workspaceId: string): ResolvedOwnedWorkspaceId {
    return workspaceId as ResolvedOwnedWorkspaceId;
}

/** 原始令牌只出现在邮件里；数据库只保存它的 SHA-256 摘要。 */
export function hashInvitationToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

function createInvitationToken(): { token: string; digest: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, digest: hashInvitationToken(token) };
}

function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function toWorkspaceSummary(workspace: WorkspaceRow, role: WorkspaceRole): WorkspaceSummary {
    return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        type: workspace.type,
        status: workspace.status,
        ownerUserId: workspace.ownerUserId,
        role,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
        deletedAt: workspace.deletedAt?.toISOString() ?? null,
    };
}

function toWorkspaceInvitation(invitation: WorkspaceInvitationRow): WorkspaceInvitation {
    return {
        id: invitation.id,
        workspaceId: invitation.workspaceId,
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        inviterId: invitation.inviterId,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
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

/**
 * 个人空间：插入或读取当前用户终身唯一的那一行，并返回带品牌的空间 ID。
 * 只有这里与团队创建能生成品牌值。
 */
export async function resolvePersonalWorkspace(
    tx: AppTransaction,
    user: PersonalWorkspaceUser,
): Promise<{ summary: WorkspaceSummary; resolvedWorkspaceId: ResolvedOwnedWorkspaceId }> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'personal:' + user.id}, 0))`);

    const [existing] = await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.ownerUserId, user.id), eq(workspaces.type, "personal")))
        .limit(1);
    if (existing) {
        return { summary: toWorkspaceSummary(existing, "owner"), resolvedWorkspaceId: brandOwnedWorkspaceId(existing.id) };
    }

    const workspaceId = randomUUID();
    try {
        const inserted = await tx
            .insert(workspaces)
            .values({
                id: workspaceId,
                name: `${user.name}的个人空间`,
                slug: `personal-${user.id}-${randomUUID()}`,
                type: "personal",
                status: "active",
                ownerUserId: user.id,
            });
        if (inserted.rowCount !== 1) throw new Error("Personal Workspace insert affected no row");
    } catch (error) {
        if (isPostgresUniqueViolation(error, WORKSPACE_PERSONAL_OWNER_UNIQUE_INDEX)) {
            throw new AppError("personal_workspace_already_exists", 409, "个人空间已存在但当前不可访问");
        }
        throw error;
    }
    await tx.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId,
        userId: user.id,
        role: "owner",
        status: "active",
    });

    const [created] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
    if (!created) throw new Error("Created personal Workspace is not visible after owner insertion");
    return { summary: toWorkspaceSummary(created, "owner"), resolvedWorkspaceId: brandOwnedWorkspaceId(created.id) };
}

/** 团队空间与其唯一 owner 成员在同一个调用方事务里写入。 */
export async function createTeamWorkspace(
    tx: AppTransaction,
    user: PersonalWorkspaceUser,
    input: CreateWorkspaceBody,
): Promise<{ summary: WorkspaceSummary; resolvedWorkspaceId: ResolvedOwnedWorkspaceId }> {
    const workspaceId = randomUUID();
    const inserted = await tx
        .insert(workspaces)
        .values({
            id: workspaceId,
            name: input.name,
            slug: input.slug,
            type: "team",
            status: "active",
            ownerUserId: user.id,
        });
    if (inserted.rowCount !== 1) throw new Error("Workspace insert affected no row");

    await tx.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId,
        userId: user.id,
        role: "owner",
        status: "active",
    });

    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!workspace) throw new Error("Created Workspace is not visible after owner insertion");
    return { summary: toWorkspaceSummary(workspace, "owner"), resolvedWorkspaceId: brandOwnedWorkspaceId(workspace.id) };
}

/** 当前用户拥有活跃成员身份的全部空间。 */
export async function listWorkspaces(tx: AppTransaction, userId: string): Promise<WorkspaceSummary[]> {
    const rows = await tx
        .select({ workspace: workspaces, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, "active")))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id));

    return rows.map(({ workspace, role }) => toWorkspaceSummary(workspace, parseWorkspaceRole(role)));
}

export async function getWorkspace(tx: AppTransaction, access: WorkspaceAccess): Promise<WorkspaceSummary> {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, access.workspaceId)).limit(1);
    if (!workspace) throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
    return toWorkspaceSummary(workspace, access.role);
}

/** 更新只接受名称与标识，其他字段一律不可由客户端改写。 */
export async function updateWorkspace(
    tx: AppTransaction,
    access: WorkspaceAccess,
    input: UpdateWorkspaceBody,
): Promise<WorkspaceSummary> {
    const [locked] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, access.workspaceId))
        .limit(1)
        .for("update");
    if (!locked) {
        // UPDATE RLS 会在等待期间重新检查新版本；管理员先提交时，再以成员 SELECT 策略读取稳定状态。
        const [current] = await tx
            .select({ status: workspaces.status })
            .from(workspaces)
            .where(eq(workspaces.id, access.workspaceId))
            .limit(1);
        if (current && current.status !== "active") {
            throw new AppError("workspace_inactive", 409, "当前空间已停用");
        }
        throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
    }
    if (locked.status !== "active") throw new AppError("workspace_inactive", 409, "当前空间已停用");

    const [updated] = await tx
        .update(workspaces)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(workspaces.id, access.workspaceId), eq(workspaces.status, "active")))
        .returning();

    if (!updated) throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
    return toWorkspaceSummary(updated, access.role);
}

/** owner 只能下线活跃团队空间；审计先写、条件更新最后执行，任一步失败都回滚。 */
export async function deactivateOwnedTeamWorkspace(
    tx: AppTransaction,
    access: WorkspaceAccess,
): Promise<WorkspaceSummary> {
    if (access.workspaceType === "personal") {
        throw new AppError("personal_workspace_cannot_be_deactivated", 409, "个人空间不能下线");
    }
    if (access.role !== "owner") throw new AppError("workspace_owner_required", 403, "需要空间所有者权限");
    if (access.workspaceStatus !== "active") {
        throw new AppError("workspace_status_transition_invalid", 409, "当前空间状态不允许此操作");
    }

    const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.id, access.workspaceId), eq(workspaces.status, "active")))
        .limit(1)
        .for("update");
    if (!workspace) throw new AppError("workspace_status_transition_conflict", 409, "空间状态已发生变化");

    await tx.insert(workspaceAuditLogs).values({
        workspaceId: workspace.id,
        actorUserId: access.userId,
        action: "workspace_deactivate",
        fromStatus: workspace.status,
        toStatus: "deactivated",
        transactionXid: sql`pg_current_xact_id()`,
    });

    const changedAt = new Date();
    const updated = await tx
        .update(workspaces)
        .set({ status: "deactivated", deletedAt: changedAt, updatedAt: changedAt })
        .where(and(eq(workspaces.id, workspace.id), eq(workspaces.status, "active"), eq(workspaces.type, "team")));
    if (updated.rowCount !== 1) {
        throw new AppError("workspace_status_transition_conflict", 409, "空间状态已发生变化");
    }

    return toWorkspaceSummary(
        { ...workspace, status: "deactivated", deletedAt: changedAt, updatedAt: changedAt },
        access.role,
    );
}

export async function listWorkspaceMembers(
    tx: AppTransaction,
    access: WorkspaceAccess,
): Promise<{ members: WorkspaceMember[]; total: number }> {
    const rows = await tx
        .select({ member: workspaceMembers, user: users })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(eq(workspaceMembers.workspaceId, access.workspaceId), eq(workspaceMembers.status, "active")))
        .orderBy(asc(workspaceMembers.joinedAt), asc(workspaceMembers.id));

    const members = rows.map(({ member, user }) => ({
        id: member.id,
        userId: member.userId,
        role: parseWorkspaceRole(member.role),
        joinedAt: member.joinedAt.toISOString(),
        user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
    }));

    return { members, total: members.length };
}

/** 条件删除排除 owner，因此 owner 成员永远不会被移除。 */
export async function removeWorkspaceMember(
    tx: AppTransaction,
    access: WorkspaceAccess,
    memberId: string,
): Promise<void> {
    requireTeamWorkspace(access);

    const [removed] = await tx
        .delete(workspaceMembers)
        .where(
            and(
                eq(workspaceMembers.id, memberId),
                eq(workspaceMembers.workspaceId, access.workspaceId),
                ne(workspaceMembers.role, "owner"),
            ),
        )
        .returning({ id: workspaceMembers.id });

    if (removed) return;

    // 区分"目标是 owner"与"目标不存在"，保持既有稳定错误码。
    const [existing] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.id, memberId), eq(workspaceMembers.workspaceId, access.workspaceId)))
        .limit(1);

    if (existing && parseWorkspaceRole(existing.role) === "owner") {
        throw new AppError("workspace_owner_cannot_be_removed", 409, "不能移除空间所有者");
    }
    throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
}

export async function listWorkspaceInvitations(
    tx: AppTransaction,
    access: WorkspaceAccess,
): Promise<WorkspaceInvitation[]> {
    requireTeamWorkspace(access);

    const rows = await tx
        .select()
        .from(workspaceInvitations)
        .where(and(eq(workspaceInvitations.workspaceId, access.workspaceId), eq(workspaceInvitations.status, "pending")))
        .orderBy(asc(workspaceInvitations.createdAt), asc(workspaceInvitations.id));

    return rows.map(toWorkspaceInvitation);
}

/**
 * 生成随机令牌，只把 SHA-256 摘要落库；原始令牌仅返回给调用方拼接邮件链接。
 * 令牌不会进入响应体、日志或数据库。
 */
export async function createWorkspaceInvitation(
    tx: AppTransaction,
    access: WorkspaceAccess,
    input: CreateWorkspaceInvitationBody,
): Promise<{ invitation: WorkspaceInvitation; token: string }> {
    requireTeamWorkspace(access);

    const email = normalizeEmail(input.email);
    const { token, digest } = createInvitationToken();

    // 同一邮箱的过期待处理邀请先作废，避免唯一索引挡住重新邀请。
    await tx
        .update(workspaceInvitations)
        .set({ status: "canceled" })
        .where(
            and(
                eq(workspaceInvitations.workspaceId, access.workspaceId),
                eq(workspaceInvitations.email, email),
                eq(workspaceInvitations.status, "pending"),
                sql`${workspaceInvitations.expiresAt} <= now()`,
            ),
        );

    const [alreadyMember] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(eq(workspaceMembers.workspaceId, access.workspaceId), eq(users.email, email)))
        .limit(1);
    if (alreadyMember) throw new AppError("workspace_invitation_conflict", 409, "该用户已加入或已收到邀请");

    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [invitation] = await tx
        .insert(workspaceInvitations)
        .values({
            id: randomUUID(),
            workspaceId: access.workspaceId,
            email,
            role: input.role,
            status: "pending",
            tokenDigest: digest,
            inviterId: access.userId,
            expiresAt,
        })
        .returning();
    if (!invitation) throw new Error("Workspace invitation insert returned no row");

    return { invitation: toWorkspaceInvitation(invitation), token };
}

export async function cancelWorkspaceInvitation(
    tx: AppTransaction,
    access: WorkspaceAccess,
    invitationId: string,
): Promise<void> {
    requireTeamWorkspace(access);

    const [canceled] = await tx
        .update(workspaceInvitations)
        .set({ status: "canceled" })
        .where(
            and(
                eq(workspaceInvitations.id, invitationId),
                eq(workspaceInvitations.workspaceId, access.workspaceId),
                eq(workspaceInvitations.status, "pending"),
            ),
        )
        .returning({ id: workspaceInvitations.id });

    if (!canceled) throw new AppError("workspace_forbidden", 403, "无权访问当前空间");
}

/**
 * 用原始令牌的摘要条件认领邀请：认领、建成员、标记 accepted 必须同事务提交。
 * 邀请 ID 不能替代令牌；重复或并发认领只会有一个赢家。
 */
export async function acceptWorkspaceInvitation(
    tx: AppTransaction,
    user: WorkspaceInvitee,
    token: string,
): Promise<{ workspaceId: string }> {
    try {
        const email = normalizeEmail(user.email);
        const [invitation] = await tx
            .update(workspaceInvitations)
            .set({ status: "accepted" })
            .where(
                and(
                    eq(workspaceInvitations.tokenDigest, hashInvitationToken(token)),
                    eq(workspaceInvitations.status, "pending"),
                    eq(workspaceInvitations.email, email),
                    sql`${workspaceInvitations.expiresAt} > now()`,
                ),
            )
            .returning();

        if (!invitation) throw new AppError("workspace_invitation_unavailable", 409, "邀请不存在、已过期或已处理");

        // 接收人没有 Workspace UPDATE 权限，SELECT FOR UPDATE 会被对应 RLS 策略隐藏；
        // 事务级 advisory lock 仍能按空间串行化容量检查和成员插入。
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${invitation.workspaceId}, 0))`);
        const [workspace] = await tx
            .select({ type: workspaces.type, status: workspaces.status })
            .from(workspaces)
            .where(eq(workspaces.id, invitation.workspaceId))
            .limit(1);
        if (!workspace || workspace.type !== "team" || workspace.status !== "active") {
            throw new AppError("workspace_invitation_unavailable", 409, "邀请不存在、已过期或已处理");
        }

        const [memberCount] = await tx
            .select({ value: sql<number>`count(*)::int` })
            .from(workspaceMembers)
            .where(
                and(
                    eq(workspaceMembers.workspaceId, invitation.workspaceId),
                    eq(workspaceMembers.status, "active"),
                ),
            );
        if ((memberCount?.value ?? 0) >= DEFAULT_WORKSPACE_MEMBER_LIMIT) {
            throw new AppError("workspace_member_limit_reached", 409, "空间成员数量已达上限");
        }

        await tx.insert(workspaceMembers).values({
            id: randomUUID(),
            workspaceId: invitation.workspaceId,
            userId: user.id,
            role: invitation.role,
            status: "active",
        });

        return { workspaceId: invitation.workspaceId };
    } catch (error) {
        if (isPostgresUniqueViolation(error, WORKSPACE_MEMBER_UNIQUE_INDEX)) {
            throw new AppError("workspace_invitation_already_member", 409, "该用户已是空间成员");
        }
        throw error;
    }
}
