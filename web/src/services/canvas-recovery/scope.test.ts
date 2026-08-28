import { describe, expect, it } from "vitest";

import { buildRecoveryScopeId, readInstallationId } from "./scope";

describe("recovery scope id", () => {
    it("builds the two approved shapes", () => {
        expect(buildRecoveryScopeId({ kind: "local", installationId: "inst1", localCanvasId: "c1" })).toBe("local:inst1:c1");
        expect(buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })).toBe("account:u1:workspace:w1:canvas:c1");
    });

    it("refuses untrusted ids instead of encoding them", () => {
        expect(buildRecoveryScopeId({ kind: "local", installationId: "inst:1", localCanvasId: "c1" })).toBeNull();
        expect(buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w:1", canvasId: "c1" })).toBeNull();
        expect(buildRecoveryScopeId({ kind: "account", userId: "", workspaceId: "w1", canvasId: "c1" })).toBeNull();
        expect(buildRecoveryScopeId({ kind: "local", installationId: "inst1", localCanvasId: "c".repeat(129) })).toBeNull();
        expect(buildRecoveryScopeId({ kind: "unknown", userId: "u1", workspaceId: "w1", canvasId: "c1" } as never)).toBeNull();
    });

    it("keeps identities distinct so one scope can never address another", () => {
        expect(buildRecoveryScopeId({ kind: "account", userId: "u1", workspaceId: "w1", canvasId: "c1" })).not.toBe(buildRecoveryScopeId({ kind: "account", userId: "u2", workspaceId: "w1", canvasId: "c1" }));
    });

    it("persists one installation id and reuses it", () => {
        const bag = new Map<string, string>();
        const storage = { getItem: (k: string) => bag.get(k) ?? null, setItem: (k: string, v: string) => void bag.set(k, v) };
        let calls = 0;
        expect(readInstallationId(storage, () => "generated" + ++calls)).toBe("generated1");
        expect(readInstallationId(storage, () => "generated" + ++calls)).toBe("generated1");
        expect(calls).toBe(1);
    });

    it("replaces a corrupted id and contains generation or storage failures", () => {
        const bag = new Map<string, string>([["canvas-recovery-installation", "bad:id"]]);
        const storage = { getItem: (k: string) => bag.get(k) ?? null, setItem: (k: string, v: string) => void bag.set(k, v) };
        expect(readInstallationId(storage, () => "fresh")).toBe("fresh");

        let writes = 0;
        expect(readInstallationId({ getItem: () => null, setItem: () => void writes++ }, () => "bad:id")).toBeNull();
        expect(writes).toBe(0);

        let creates = 0;
        expect(
            readInstallationId(
                {
                    getItem: () => {
                        throw new Error("get failed");
                    },
                    setItem: () => undefined,
                },
                () => "generated" + ++creates,
            ),
        ).toBeNull();
        expect(creates).toBe(0);
        expect(
            readInstallationId(
                {
                    getItem: () => null,
                    setItem: () => {
                        throw new Error("set failed");
                    },
                },
                () => "fresh2",
            ),
        ).toBeNull();
    });
});
