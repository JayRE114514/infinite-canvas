import {
    AppErrorResponseSchema,
    CreditBalanceResponseSchema,
    GrantWorkspaceCreditsBodySchema,
    GrantWorkspaceCreditsResponseSchema,
    IdempotencyHeadersSchema,
    WorkspacePathSchema,
    type GrantWorkspaceCreditsBody,
    type IdempotencyHeaders,
    type WorkspacePath,
} from "@infinite-canvas/contracts";
import type { FastifyInstance } from "fastify";

import { AppError } from "../../errors.js";
import { hashCanonicalRequest } from "../../infrastructure/idempotency.js";
import { requireDatabase } from "../../infrastructure/database/plugin.js";
import { withPlatformAdminTransaction, withTenantTransaction } from "../../infrastructure/database/transactions.js";
import { requireSession } from "../identity/session.js";
import { formatCreditAmount, parseCreditAmount } from "./amount.js";
import { executeWalletAdjustment, getWalletBalance } from "./service.js";

const errorResponses = {
    400: AppErrorResponseSchema,
    401: AppErrorResponseSchema,
    403: AppErrorResponseSchema,
    404: AppErrorResponseSchema,
    409: AppErrorResponseSchema,
    500: AppErrorResponseSchema,
};

function hasPostgresCode(error: unknown, code: string): boolean {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const value = current as Record<string, unknown>;
        if (value.code === code) return true;
        current = value.cause;
    }
    return false;
}

function rethrowWalletAdjustment(error: unknown): never {
    if (error instanceof AppError) throw error;
    if (hasPostgresCode(error, "P4090")) {
        throw new AppError("idempotency_conflict", 409, "幂等键已用于不同请求");
    }
    if (hasPostgresCode(error, "P4040")) {
        throw new AppError("credit_wallet_not_found", 404, "积分账户不存在");
    }
    if (hasPostgresCode(error, "42501")) {
        throw new AppError("platform_admin_forbidden", 403, "需要活跃的平台管理员权限");
    }
    throw error;
}

function balanceResponse(workspaceId: string, balance: { available: bigint; held: bigint }) {
    return {
        workspaceId,
        available: formatCreditAmount(balance.available),
        held: formatCreditAmount(balance.held),
    };
}

export function registerCreditRoutes(app: FastifyInstance): void {
    app.get<{ Params: WorkspacePath }>(
        "/api/v1/workspaces/:workspaceId/credits/balance",
        {
            schema: {
                params: WorkspacePathSchema,
                response: { 200: CreditBalanceResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            const workspaceId = request.params.workspaceId;
            return withTenantTransaction(db, { userId, workspaceId }, async (tx) => ({
                balance: balanceResponse(workspaceId, await getWalletBalance(tx, workspaceId)),
            }));
        },
    );

    app.post<{ Params: WorkspacePath; Headers: IdempotencyHeaders; Body: GrantWorkspaceCreditsBody }>(
        "/api/v1/admin/workspaces/:workspaceId/credits/grant",
        {
            schema: {
                params: WorkspacePathSchema,
                headers: IdempotencyHeadersSchema,
                body: GrantWorkspaceCreditsBodySchema,
                response: { 200: GrantWorkspaceCreditsResponseSchema, ...errorResponses },
            },
        },
        async (request) => {
            const { userId } = await requireSession(request);
            const { db } = requireDatabase(request.server);
            const workspaceId = request.params.workspaceId;
            const rawKey = request.headers["idempotency-key"];
            try {
                return await withPlatformAdminTransaction(
                    db,
                    {
                        userId,
                        requestId: request.id,
                        target: { kind: "workspace", workspaceId },
                        purpose: "wallet_adjust",
                    },
                    async (tx) => {
                        const result = await executeWalletAdjustment(tx, {
                            amount: parseCreditAmount(request.body.amount),
                            reason: request.body.reason,
                            operationKey: `wallet_adjust:${rawKey}`,
                            requestHash: hashCanonicalRequest(request.body),
                        });
                        return {
                            transactionId: result.transactionId,
                            replayed: result.replayed,
                            balance: balanceResponse(workspaceId, result.balance),
                        };
                    },
                );
            } catch (error) {
                rethrowWalletAdjustment(error);
            }
        },
    );
}
