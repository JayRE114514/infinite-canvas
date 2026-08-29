import { and, eq, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import type { AppTransaction } from "../../infrastructure/database/types.js";
import type { ResolvedOwnedWorkspaceId } from "./service.js";
import { workspaceMembers, workspaces } from "./schema.js";

/**
 * 采纳"已确认属于当前用户的空间"作为事务上下文。
 * 只接受仓储函数打过品牌的 ID；即便如此仍在运行期重新校验归属，
 * 因此路由无法把请求参数里的空间 ID 变成自己的上下文。
 */
export async function adoptOwnedWorkspaceContext(
    tx: AppTransaction,
    userId: string,
    resolvedWorkspaceId: ResolvedOwnedWorkspaceId,
): Promise<string> {
    // 事务局部上下文必须已经是同一个用户，避免跨用户串上下文。
    const current = await tx.execute<{ user_id: string | null }>(
        sql`select nullif(current_setting('app.user_id', true), '') as user_id`,
    );
    if (current.rows[0]?.user_id !== userId) {
        throw new AppError("workspace_context_adoption_forbidden", 403, "无法采纳该空间上下文");
    }

    // 在空间上下文尚未建立时，SELECT FOR UPDATE 会先命中要求 workspace_id 的 UPDATE 策略。
    // 用事务级 advisory lock 锁定该不透明 ID，随后在同一事务内复查两条归属根记录。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${resolvedWorkspaceId}, 0))`);

    const [owned] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.id, resolvedWorkspaceId), eq(workspaces.ownerUserId, userId)))
        .limit(1);

    if (!owned) throw new AppError("workspace_context_adoption_forbidden", 403, "无法采纳该空间上下文");

    const [owner] = await tx
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
            and(
                eq(workspaceMembers.workspaceId, owned.id),
                eq(workspaceMembers.userId, userId),
                eq(workspaceMembers.role, "owner"),
                eq(workspaceMembers.status, "active"),
            ),
        )
        .limit(1);

    if (!owner) throw new AppError("workspace_context_adoption_forbidden", 403, "无法采纳该空间上下文");

    await tx.execute(sql`select set_config('app.workspace_id', ${owned.id}, true)`);
    return owned.id;
}
