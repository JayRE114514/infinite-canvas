import { eq, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import type { AppTransaction } from "../../infrastructure/database/types.js";
import { creditWallets } from "./schema.js";

export type WalletBalance = { available: bigint; held: bigint };
export type WalletAdjustmentResult = {
    transactionId: string;
    replayed: boolean;
    balance: WalletBalance;
};
export type HoldResult = { holdId: string; replayed: boolean; balance: WalletBalance };
export type LedgerOutcome = { transactionId?: string; replayed: boolean; balance: WalletBalance };

export async function getWalletBalance(tx: AppTransaction, workspaceId: string): Promise<WalletBalance> {
    const [wallet] = await tx
        .select({ available: creditWallets.availableAmount, held: creditWallets.heldAmount })
        .from(creditWallets)
        .where(eq(creditWallets.workspaceId, workspaceId))
        .limit(1);

    if (!wallet) throw new AppError("credit_wallet_not_found", 404, "积分账户不存在");
    return wallet;
}

type WalletAdjustmentRow = {
    transaction_id: string;
    replayed: boolean;
    available_amount: string;
    held_amount: string;
};

/** 管理员赠送的唯一 TypeScript 入口；actor/target/purpose 仍由数据库从 xid 绑定操作推导。 */
export async function executeWalletAdjustment(
    tx: AppTransaction,
    input: { amount: bigint; reason: string; operationKey: string; requestHash: string },
): Promise<WalletAdjustmentResult> {
    const result = await tx.execute<WalletAdjustmentRow>(
        sql`select * from public.execute_wallet_adjustment(${input.amount}, ${input.reason}, ${input.operationKey}, ${input.requestHash})`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("execute_wallet_adjustment returned no result");
    return {
        transactionId: row.transaction_id,
        replayed: row.replayed,
        balance: { available: BigInt(row.available_amount), held: BigInt(row.held_amount) },
    };
}

type HoldRow = WalletAdjustmentRow & { hold_id: string };

export async function reserveCredits(
    tx: AppTransaction,
    input: {
        workspaceId: string;
        billingOrderId: string;
        amount: bigint;
        operationKey: string;
        requestHash: string;
    },
): Promise<HoldResult> {
    const result = await tx.execute<HoldRow>(sql`
        select * from public.reserve_credit_hold(
            ${input.workspaceId}, ${input.billingOrderId}::uuid, ${input.amount},
            ${input.operationKey}, ${input.requestHash}
        )
    `);
    const row = result.rows[0];
    if (!row) throw new Error("reserve_credit_hold returned no result");
    return {
        holdId: row.hold_id,
        replayed: row.replayed,
        balance: { available: BigInt(row.available_amount), held: BigInt(row.held_amount) },
    };
}

type LedgerOutcomeRow = Omit<WalletAdjustmentRow, "transaction_id"> & { transaction_id?: string };

function ledgerOutcome(row: LedgerOutcomeRow | undefined, source: string): LedgerOutcome {
    if (!row) throw new Error(`${source} returned no result`);
    return {
        ...(row.transaction_id ? { transactionId: row.transaction_id } : {}),
        replayed: row.replayed,
        balance: { available: BigInt(row.available_amount), held: BigInt(row.held_amount) },
    };
}

export async function captureHold(
    tx: AppTransaction,
    input: { workspaceId: string; holdId: string; amount: bigint; operationKey: string; requestHash: string },
): Promise<LedgerOutcome> {
    const result = await tx.execute<LedgerOutcomeRow>(sql`
        select * from public.capture_credit_hold(
            ${input.workspaceId}, ${input.holdId}::uuid, ${input.amount}, ${input.operationKey}, ${input.requestHash}
        )
    `);
    return ledgerOutcome(result.rows[0], "capture_credit_hold");
}

export async function releaseHold(
    tx: AppTransaction,
    input: { workspaceId: string; holdId: string; operationKey: string; requestHash: string },
): Promise<LedgerOutcome> {
    const result = await tx.execute<LedgerOutcomeRow>(sql`
        select * from public.release_credit_hold(
            ${input.workspaceId}, ${input.holdId}::uuid, ${input.operationKey}, ${input.requestHash}
        )
    `);
    return ledgerOutcome(result.rows[0], "release_credit_hold");
}

export async function compensateCapture(
    tx: AppTransaction,
    input: {
        workspaceId: string;
        captureTransactionId: string;
        amount: bigint;
        operationKey: string;
        requestHash: string;
    },
): Promise<LedgerOutcome> {
    const result = await tx.execute<LedgerOutcomeRow>(sql`
        select * from public.compensate_credit_capture(
            ${input.workspaceId}, ${input.captureTransactionId}::uuid, ${input.amount},
            ${input.operationKey}, ${input.requestHash}
        )
    `);
    return ledgerOutcome(result.rows[0], "compensate_credit_capture");
}
