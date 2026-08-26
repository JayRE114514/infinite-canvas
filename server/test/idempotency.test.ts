import { describe, expect, it } from "vitest";

import { hashCanonicalRequest } from "../src/infrastructure/idempotency.js";

describe("hashCanonicalRequest", () => {
    it("ignores key order", () => {
        expect(hashCanonicalRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashCanonicalRequest({ b: { d: 3, c: 2 }, a: 1 }));
    });

    it("keeps array order significant", () => {
        expect(hashCanonicalRequest([1, 2])).not.toBe(hashCanonicalRequest([2, 1]));
    });

    it("separates different values", () => {
        expect(hashCanonicalRequest({ prompt: "cat" })).not.toBe(hashCanonicalRequest({ prompt: "dog" }));
    });

    it("returns a lowercase sha256 hex digest", () => {
        expect(hashCanonicalRequest({ prompt: "cat" })).toMatch(/^[0-9a-f]{64}$/);
    });
});
