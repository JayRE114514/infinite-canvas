import { describe, expect, it } from "vitest";

import { freshIndexedDB } from "../../../test/setup-indexeddb";
import { createRecoveryDatabase, DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE, RECOVERY_DB_NAME, RECOVERY_DB_VERSION, RECOVERY_OPEN_TIMEOUT_MS, SCOPE_INDEX } from "./database";

describe("recovery database", () => {
    /**
     * fake-indexeddb 6.2.5 drained 100,000 sequential gets in about 225 ms in the
     * final-review probe. Keep this bound well above the requests drainable inside
     * either the 50 ms deadline or the 20 ms owner-cancel window; do not reduce it
     * without first measuring that both aborts still happen while the queue is live.
     */
    const TRANSACTION_HOLD_REQUESTS = 100_000;

    it("creates exactly the fixed version 1 schema", async () => {
        const factory = freshIndexedDB();
        const db = createRecoveryDatabase(factory);
        const result = await db.run("readonly", [EPOCHS_STORE], 2_000, async (txn) => txn.store(EPOCHS_STORE).name);
        expect(result).toEqual({ status: "ok", value: EPOCHS_STORE });

        const opened = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        expect(opened.version).toBe(1);
        expect([...opened.objectStoreNames].sort()).toEqual([DRAFTS_STORE, EPOCHS_STORE, MARKERS_STORE].sort());
        const tx = opened.transaction([DRAFTS_STORE, MARKERS_STORE, EPOCHS_STORE], "readonly");
        expect(tx.objectStore(DRAFTS_STORE).keyPath).toEqual(["scopeId", "draftId"]);
        expect(tx.objectStore(MARKERS_STORE).keyPath).toEqual(["scopeId", "markerId"]);
        expect(tx.objectStore(EPOCHS_STORE).keyPath).toBe("scopeId");
        expect([...tx.objectStore(DRAFTS_STORE).indexNames]).toEqual([SCOPE_INDEX]);
        expect([...tx.objectStore(MARKERS_STORE).indexNames]).toEqual([SCOPE_INDEX]);
        opened.close();
        db.close();
    });

    it("opens nothing until run is called", async () => {
        const factory = freshIndexedDB();
        createRecoveryDatabase(factory);
        expect(await factory.databases()).toEqual([]);
    });

    it("returns a controlled bounded failure when open reports blocked", async () => {
        const request = {} as IDBOpenDBRequest;
        const factory = {
            open: () => {
                queueMicrotask(() => request.onblocked?.({} as IDBVersionChangeEvent));
                return request;
            },
        } as IDBFactory;
        const startedAt = performance.now();
        const result = await createRecoveryDatabase(factory).run("readonly", [EPOCHS_STORE], 2_000, async () => 0);
        expect(result).toEqual({ status: "failed", reason: "blocked" });
        expect(performance.now() - startedAt).toBeLessThan(RECOVERY_OPEN_TIMEOUT_MS);
    });

    it("aborts the transaction when the deadline expires instead of allowing a late commit", async () => {
        const factory = freshIndexedDB();
        const db = createRecoveryDatabase(factory);
        const scopeId = "local:i:c";
        const stalled = await db.run("readwrite", [EPOCHS_STORE], 50, async (txn) => {
            await txn.req(txn.store(EPOCHS_STORE).put({ scopeId, coordinationRevision: 1, deletionGeneration: 0, tombstonedAt: null }));
            /**
             * Keep the transaction alive only with legal IndexedDB requests. The loop is
             * deliberately finite: with abort removed it eventually drains and commits,
             * which makes the rollback assertion below turn red instead of hanging.
             */
            for (let index = 0; index < TRANSACTION_HOLD_REQUESTS; index += 1) {
                await txn.req(txn.store(EPOCHS_STORE).get(scopeId));
            }
            return "drained";
        });
        expect(stalled).toEqual({ status: "failed", reason: "timeout" });

        const readBack = await db.run("readonly", [EPOCHS_STORE], 30_000, (txn) => txn.req(txn.store(EPOCHS_STORE).get(scopeId)));
        // The initial put and every queued read belonged to the aborted transaction.
        expect(readBack).toEqual({ status: "ok", value: undefined });
        db.close();
    });

    it("rolls back every write when the work function throws midway", async () => {
        const factory = freshIndexedDB();
        const db = createRecoveryDatabase(factory);
        const failed = await db.run("readwrite", [EPOCHS_STORE, MARKERS_STORE], 2_000, async (txn) => {
            txn.store(EPOCHS_STORE).put({ scopeId: "local:i:c", coordinationRevision: 1, deletionGeneration: 0, tombstonedAt: null });
            txn.store(MARKERS_STORE).put({ scopeId: "local:i:c", markerId: "conflict", entries: [] });
            throw new Error("midway");
        });
        expect(failed.status).toBe("failed");
        expect(await db.run("readonly", [EPOCHS_STORE], 2_000, (txn) => txn.req(txn.store(EPOCHS_STORE).get("local:i:c")))).toEqual({ status: "ok", value: undefined });
        expect(await db.run("readonly", [MARKERS_STORE], 2_000, (txn) => txn.req(txn.store(MARKERS_STORE).get(["local:i:c", "conflict"])))).toEqual({ status: "ok", value: undefined });
        db.close();
    });

    it("aborts and rolls back when the operation owner cancels its signal", async () => {
        const factory = freshIndexedDB();
        const db = createRecoveryDatabase(factory);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        const result = await db.run(
            "readwrite",
            [EPOCHS_STORE],
            2_000,
            async (txn) => {
                await txn.req(txn.store(EPOCHS_STORE).put({ scopeId: "local:i:cancelled", coordinationRevision: 1, deletionGeneration: 0, tombstonedAt: null }));
                for (let index = 0; index < TRANSACTION_HOLD_REQUESTS; index += 1) await txn.req(txn.store(EPOCHS_STORE).get("local:i:cancelled"));
                return "drained";
            },
            controller.signal,
        );
        expect(result).toEqual({ status: "failed", reason: "aborted" });
        expect(await db.run("readonly", [EPOCHS_STORE], 2_000, (txn) => txn.req(txn.store(EPOCHS_STORE).get("local:i:cancelled")))).toEqual({ status: "ok", value: undefined });
        db.close();
    });

    it("closes on versionchange so a newer tab is never blocked, and reports a bounded failure afterwards", async () => {
        const factory = freshIndexedDB();
        const first = createRecoveryDatabase(factory);
        await first.run("readonly", [EPOCHS_STORE], 2_000, async () => 0);

        const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(RECOVERY_DB_NAME, RECOVERY_DB_VERSION + 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error("blocked: versionchange did not close the old connection"));
        });
        upgraded.close();

        const afterUpgrade = await createRecoveryDatabase(factory).run("readonly", [EPOCHS_STORE], 2_000, async () => 0);
        expect(afterUpgrade.status).toBe("failed");
        first.close();
    });
});
