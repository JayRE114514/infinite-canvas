import { sql } from "drizzle-orm";

import type { AppTransaction } from "../../infrastructure/database/types.js";
import { formatCreditAmount } from "../credits/amount.js";
import { parseCreditAmount } from "../credits/amount.js";
import type { PriceSnapshotJson } from "./schema.js";

export type FixedImagePriceSnapshot = {
    capabilityId: string;
    routeId: string;
    exactModelId: string;
    priceVersion: string;
    estimatedAmount: bigint;
    fixedAmount: bigint;
};

export function createFixedImagePriceSnapshot(input: FixedImagePriceSnapshot): FixedImagePriceSnapshot {
    if (input.estimatedAmount <= 0n || input.fixedAmount < 0n || input.fixedAmount > input.estimatedAmount) {
        throw new Error("fixed image price is outside the estimated Credit amount");
    }
    return { ...input };
}

export function calculateActualCreditAmount(snapshot: FixedImagePriceSnapshot, _providerBillingFact: unknown): bigint {
    return snapshot.fixedAmount;
}

export function calculateStoredActualCreditAmount(
    snapshot: PriceSnapshotJson,
    estimatedAmount: bigint,
    _providerBillingFact: unknown,
): bigint {
    if (snapshot.rule.kind !== "fixed_per_image") throw new Error("Unsupported stored price rule");
    const amount = parseCreditAmount(snapshot.rule.amount);
    if (amount < 0n || amount > estimatedAmount) throw new Error("Stored price snapshot is invalid");
    return amount;
}

export async function createBillingOrder(
    tx: AppTransaction,
    input: { workspaceId: string; taskId: string; snapshot: FixedImagePriceSnapshot },
): Promise<string> {
    const stored: PriceSnapshotJson = {
        capabilityId: input.snapshot.capabilityId,
        routeId: input.snapshot.routeId,
        exactModelId: input.snapshot.exactModelId,
        priceVersion: input.snapshot.priceVersion,
        rule: { kind: "fixed_per_image", amount: formatCreditAmount(input.snapshot.fixedAmount) },
    };
    const result = await tx.execute<{ order_id: string }>(sql`
        select public.create_billing_order(
            ${input.workspaceId}, ${input.taskId}::uuid, ${input.snapshot.capabilityId},
            ${input.snapshot.priceVersion}, ${JSON.stringify(stored)}::jsonb, ${input.snapshot.estimatedAmount}
        ) as order_id
    `);
    const orderId = result.rows[0]?.order_id;
    if (!orderId) throw new Error("create_billing_order returned no id");
    return orderId;
}

export async function markBillingOrderReview(
    tx: AppTransaction,
    input: { workspaceId: string; billingOrderId: string },
): Promise<boolean> {
    const result = await tx.execute<{ changed: boolean }>(
        sql`select public.mark_billing_order_review(${input.workspaceId}, ${input.billingOrderId}::uuid) as changed`,
    );
    return result.rows[0]?.changed ?? false;
}
