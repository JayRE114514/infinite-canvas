import { describe, expect, it } from "vitest";

import { formatCreditAmount, parseCreditAmount } from "../../src/modules/credits/amount.js";

describe("credit amount HTTP adapter", () => {
    it("round-trips canonical integers exactly beyond the JavaScript safe integer range", () => {
        for (const value of ["0", "-1", "9007199254740992", "-900719925474099200000000000000000000"]) {
            expect(formatCreditAmount(parseCreditAmount(value))).toBe(value);
        }
    });

    it.each(["", " 1", "1 ", "+1", "00", "01", "-0", "1.0", ".5", "1e3"])(
        "rejects non-canonical input %j",
        (value) => {
            expect(() => parseCreditAmount(value)).toThrow("canonical decimal string");
        },
    );
});
