import { afterEach, describe, expect, it, vi } from "vitest";

import { canvasRepository } from "./canvas-repository";

const RECEIPT = { canvasId: "11111111-1111-4111-8111-111111111111", deletionReceipt: "22222222-2222-4222-8222-222222222222", deletedAt: "2020-01-01T00:00:00.000Z" };

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const errorResponse = (code: string, status: number) => jsonResponse({ error: { code, message: "", retryable: false, requestId: "r" } }, status);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("canvas delete receipt classification", () => {
    it("accepts a matching receipt as the only positive proof", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(RECEIPT)));
        expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "deleted", receipt: RECEIPT });
    });

    it("accepts an idempotent replay of the same receipt", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(RECEIPT)));
        expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "deleted", receipt: RECEIPT });
        expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "deleted", receipt: RECEIPT });
    });

    it("refuses a receipt for a different canvas", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...RECEIPT, canvasId: "33333333-3333-4333-8333-333333333333" })));
        expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "indeterminate", reason: "mismatched-receipt", messageKey: "canvas.delete.unconfirmed" });
    });

    it("refuses a malformed success response", async () => {
        for (const body of [
            { success: true },
            { ...RECEIPT, deletionReceipt: "not-a-uuid" },
            { ...RECEIPT, deletedAt: "not-a-date" },
        ]) {
            vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
            expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "indeterminate", reason: "invalid-response", messageKey: "canvas.delete.unconfirmed" });
        }
    });

    it("never treats a plain 404 as deletion proof", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => errorResponse("canvas_not_found", 404)));
        expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "denied", code: "canvas_not_found", messageKey: "canvas.delete.unavailable" });
    });

    it("never treats forbidden, non-active workspace or removed membership as proof", async () => {
        for (const [code, status] of [
            ["workspace_forbidden", 403],
            ["platform_forbidden", 403],
            ["workspace_not_active", 409],
            ["platform_unauthorized", 401],
        ] as const) {
            vi.stubGlobal("fetch", vi.fn(async () => errorResponse(code, status)));
            expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "denied", code, messageKey: "canvas.delete.unavailable" });
        }
    });

    it("never treats a network failure as proof", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new TypeError("offline");
        }));
        expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "indeterminate", reason: "network", messageKey: "canvas.delete.unconfirmed" });
    });

    it("never treats a timeout as proof", async () => {
        vi.useFakeTimers();
        vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
        const pending = canvasRepository.remove("w1", RECEIPT.canvasId);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(await pending).toEqual({ status: "indeterminate", reason: "timeout", messageKey: "canvas.delete.unconfirmed" });
    });

    it("never treats an invalid JSON response, server error or unknown failure as proof", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
        expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "indeterminate", reason: "invalid-response", messageKey: "canvas.delete.unconfirmed" });

        vi.stubGlobal("fetch", vi.fn(async () => errorResponse("internal_error", 500)));
        expect(await canvasRepository.remove("w1", RECEIPT.canvasId)).toEqual({ status: "indeterminate", reason: "unknown", messageKey: "canvas.delete.unconfirmed" });
    });
});
