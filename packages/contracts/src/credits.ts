import { Type, type Static } from "typebox";

import { WorkspaceIdSchema } from "./workspaces.js";

export const CREDIT_AMOUNT_PATTERN = "^(?:0|-?[1-9][0-9]*)$";
export const CreditAmountStringSchema = Type.String({ pattern: CREDIT_AMOUNT_PATTERN });
export type CreditAmountString = Static<typeof CreditAmountStringSchema>;

const PositiveCreditAmountStringSchema = Type.String({ pattern: "^[1-9][0-9]*$" });

export const CreditBalanceSchema = Type.Object(
    {
        workspaceId: WorkspaceIdSchema,
        available: CreditAmountStringSchema,
        held: CreditAmountStringSchema,
    },
    { additionalProperties: false },
);
export type CreditBalance = Static<typeof CreditBalanceSchema>;

export const CreditBalanceResponseSchema = Type.Object(
    { balance: CreditBalanceSchema },
    { additionalProperties: false },
);
export type CreditBalanceResponse = Static<typeof CreditBalanceResponseSchema>;

export const GrantWorkspaceCreditsBodySchema = Type.Object(
    {
        amount: PositiveCreditAmountStringSchema,
        reason: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
export type GrantWorkspaceCreditsBody = Static<typeof GrantWorkspaceCreditsBodySchema>;

export const IdempotencyHeadersSchema = Type.Object(
    { "idempotency-key": Type.String({ minLength: 1 }) },
    { additionalProperties: true },
);
export type IdempotencyHeaders = Static<typeof IdempotencyHeadersSchema>;

export const GrantWorkspaceCreditsResponseSchema = Type.Object(
    {
        transactionId: Type.String({ format: "uuid" }),
        replayed: Type.Boolean(),
        balance: CreditBalanceSchema,
    },
    { additionalProperties: false },
);
export type GrantWorkspaceCreditsResponse = Static<typeof GrantWorkspaceCreditsResponseSchema>;
