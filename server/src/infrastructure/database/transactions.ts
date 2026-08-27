import type { WorkspaceRole } from "@infinite-canvas/contracts";
import { sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import { requireWorkspaceAccess, type WorkspaceAccess } from "../../modules/workspaces/authorization.js";
import type { AppDatabase, AppTransaction } from "./types.js";

/**
 * 全部业务事务入口都在这里：先开事务，立刻写入事务局部上下文，
 * 在同一个 tx 上完成授权，再把该 tx 交给业务函数。
 * 只使用 set_config(..., true)，绝不设置会话级变量，因此连接归还后不残留上下文。
 */

/** Gate 0 固定的管理员用途词表；本 Gate 只实现空间读取与状态流转。 */
export const PLATFORM_ADMIN_PURPOSES = [
    "user_read",
    "model_read",
    "model_write",
    "provider_route_read",
    "provider_route_write",
] as const;

export const WORKSPACE_ADMIN_PURPOSES = [
    "workspace_read",
    "workspace_suspend",
    "workspace_deactivate",
    "workspace_restore",
    "wallet_adjust",
    "wallet_status_write",
    "billing_confirm_charge",
    "billing_confirm_no_charge",
    "ledger_compensate",
    "workspace_export",
] as const;

export type PlatformAdminPurpose = (typeof PLATFORM_ADMIN_PURPOSES)[number];
export type WorkspaceAdminPurpose = (typeof WORKSPACE_ADMIN_PURPOSES)[number];

export type AdminOperationTarget = { kind: "platform" } | { kind: "workspace"; workspaceId: string };

export type PlatformAdminTransactionInput = {
    userId: string;
    requestId: string;
    target: AdminOperationTarget;
    purpose: PlatformAdminPurpose | WorkspaceAdminPurpose;
};

export type WorkerTransactionInput<TResource> = {
    workspaceId: string;
    /** 必填校验器：返回 null 表示资源不属于该空间，事务立即中止。 */
    verify: (tx: AppTransaction) => Promise<TResource | null>;
};

type ContextKey = "app.user_id" | "app.workspace_id";

/** 事务局部写入，第三个参数 true 保证提交或回滚后自动失效。 */
async function setLocal(tx: AppTransaction, key: ContextKey, value: string): Promise<void> {
    await tx.execute(sql`select set_config(${key}, ${value}, true)`);
}

/** 仅用户维度的事务：可以列出自己参与的空间，但不携带任何空间上下文。 */
export async function withUserTransaction<T>(
    db: AppDatabase,
    userId: string,
    work: (tx: AppTransaction) => Promise<T>,
): Promise<T> {
    return db.transaction(async (tx) => {
        await setLocal(tx, "app.user_id", userId);
        return work(tx);
    });
}

/** 租户事务：写入用户与空间上下文，并在同一个 tx 上复查成员与角色。 */
export async function withTenantTransaction<T>(
    db: AppDatabase,
    input: { userId: string; workspaceId: string; minimumRole?: WorkspaceRole },
    work: (tx: AppTransaction, access: WorkspaceAccess) => Promise<T>,
): Promise<T> {
    return db.transaction(async (tx) => {
        await setLocal(tx, "app.user_id", input.userId);
        await setLocal(tx, "app.workspace_id", input.workspaceId);
        const access = await requireWorkspaceAccess(tx, input);
        return work(tx, access);
    });
}

/**
 * Worker 事务：只写空间上下文，绝不伪造 app.user_id。
 * verify 是 TypeScript 层面的必填项，返回 null 时事务中止。
 */
export async function withWorkerTransaction<TResource, T>(
    db: AppDatabase,
    input: WorkerTransactionInput<TResource>,
    work: (tx: AppTransaction, resource: TResource) => Promise<T>,
): Promise<T> {
    if (typeof input.verify !== "function") {
        throw new AppError("worker_verifier_required", 500, "Worker 事务必须提供资源校验器");
    }

    return db.transaction(async (tx) => {
        await setLocal(tx, "app.workspace_id", input.workspaceId);
        const resource = await input.verify(tx);
        if (resource === null) throw new AppError("worker_resource_not_found", 404, "任务资源不存在或不属于该空间");
        return work(tx, resource);
    });
}

/**
 * 管理员事务：写入用户上下文后由数据库函数校验活跃管理员身份与用途，
 * 并把操作 ID 绑定到当前事务；具体数据操作必须走不接受第二份授权参数的窄口函数。
 */
export async function withPlatformAdminTransaction<T>(
    db: AppDatabase,
    input: PlatformAdminTransactionInput,
    work: (tx: AppTransaction, operationId: string) => Promise<T>,
): Promise<T> {
    return db.transaction(async (tx) => {
        await setLocal(tx, "app.user_id", input.userId);

        const workspaceId = input.target.kind === "workspace" ? input.target.workspaceId : null;
        const result = await tx.execute<{ operation_id: string }>(
            sql`select public.begin_admin_operation(${input.target.kind}, ${workspaceId}, ${input.purpose}, ${input.requestId}) as operation_id`,
        );

        const operationId = result.rows[0]?.operation_id;
        if (!operationId) throw new Error("begin_admin_operation returned no operation id");

        return work(tx, operationId);
    });
}
