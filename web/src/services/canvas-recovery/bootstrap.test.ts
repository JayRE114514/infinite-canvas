import { describe, expect, it, vi } from "vitest";

import { upgradeRecoveryStorage } from "./bootstrap";

const makeStorage = (initial: [string, string][] = []) => {
    const bag = new Map<string, string>(initial);
    return { getItem: (k: string) => bag.get(k) ?? null, setItem: (k: string, v: string) => void bag.set(k, v), bag };
};

describe("explicit legacy recovery upgrade", () => {
    it("drops the legacy store once and records that it ran", async () => {
        const storage = makeStorage();
        const dropLegacy = vi.fn(async () => undefined);
        expect(await upgradeRecoveryStorage({ storage, dropLegacy })).toBe("upgraded");
        expect(dropLegacy).toHaveBeenCalledTimes(1);
        expect(await upgradeRecoveryStorage({ storage, dropLegacy })).toBe("already-upgraded");
        // Never a second drop: the upgrade is an explicit one-time action.
        expect(dropLegacy).toHaveBeenCalledTimes(1);

        /**
         * A storage that refuses reads (disabled cookies, private mode, quota policy) is contained in
         * the declared union. Nothing is dropped, because an unreadable flag cannot prove the state.
         */
        const unreadable = {
            getItem: () => {
                throw new Error("blocked");
            },
            setItem: () => undefined,
        };
        const untouched = vi.fn(async () => undefined);
        expect(await upgradeRecoveryStorage({ storage: unreadable, dropLegacy: untouched })).toBe("failed");
        expect(untouched).not.toHaveBeenCalled();
    });

    it("does not record success when the drop fails, so it can be retried", async () => {
        const storage = makeStorage();
        const dropLegacy = vi.fn(async () => {
            throw new Error("blocked");
        });
        expect(await upgradeRecoveryStorage({ storage, dropLegacy })).toBe("failed");
        expect(storage.getItem("canvas-recovery-upgrade")).toBeNull();

        /**
         * A successful drop whose receipt cannot be persisted is still "failed" and still retryable,
         * so the next explicit run drops again. dropLegacy MUST therefore be idempotent: dropping an
         * already-absent legacy store has to succeed rather than throw.
         */
        const unwritable = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
        const dropped = vi.fn(async () => undefined);
        expect(await upgradeRecoveryStorage({ storage: unwritable, dropLegacy: dropped })).toBe("failed");
        expect(dropped).toHaveBeenCalledTimes(1);
        expect(await upgradeRecoveryStorage({ storage: unwritable, dropLegacy: dropped })).toBe("failed");
        expect(dropped).toHaveBeenCalledTimes(2);
    });

    it("never reads legacy data: the upgrade only drops", async () => {
        const storage = makeStorage();
        const dropLegacy = vi.fn(async () => undefined);
        await upgradeRecoveryStorage({ storage, dropLegacy });
        // The module exposes no legacy read path at all.
        const moduleExports = await import("./bootstrap");
        expect(Object.keys(moduleExports).sort()).toEqual(["upgradeRecoveryStorage"]);
    });
});
