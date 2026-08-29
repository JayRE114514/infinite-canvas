import { CREDIT_AMOUNT_PATTERN } from "@infinite-canvas/contracts";

const CANONICAL_CREDIT_AMOUNT = new RegExp(CREDIT_AMOUNT_PATTERN);

/** HTTP 十进制字符串进入领域层的唯一转换入口。 */
export function parseCreditAmount(input: string): bigint {
    if (!CANONICAL_CREDIT_AMOUNT.test(input)) throw new Error("credit amount must be a canonical decimal string");
    return BigInt(input);
}

/** 领域金额离开 HTTP seam 时只序列化为规范十进制字符串。 */
export function formatCreditAmount(input: bigint): string {
    return input.toString(10);
}
