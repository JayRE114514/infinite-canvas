import { describe, expect, it, vi } from "vitest";

import type { AppDatabase, AppTransaction } from "../../src/infrastructure/database/types.js";
import type { ObjectStorage, StoredObject } from "../../src/infrastructure/object-storage/types.js";
import { ObjectStorageVerificationError } from "../../src/infrastructure/object-storage/types.js";

vi.mock("../../src/infrastructure/database/transactions.js", () => ({
    withTenantTransaction: async (
        db: FakeDatabase,
        _input: { userId: string; workspaceId: string },
        work: (tx: AppTransaction, access: object) => Promise<unknown>,
    ) => work(db.transaction(), { userId: "user-1", workspaceId: "workspace-1", workspaceStatus: "active" }),
}));

const { completeAssetUpload } = await import("../../src/modules/assets/service.js");

type StoredRow = {
    id: string;
    workspaceId: string;
    kind: string;
    status: string;
    fileName: string;
    contentType: string;
    byteSize: number | null;
    stagingObjectKey: string | null;
    finalObjectKey: string;
    etag: string | null;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
};

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

class FakeDatabase {
    readonly row: StoredRow = {
        id: "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192",
        workspaceId: "workspace-1",
        kind: "image",
        status: "staging",
        fileName: "reference.png",
        contentType: "image/png",
        byteSize: null,
        stagingObjectKey: "staging-key",
        finalObjectKey: "final-key",
        etag: null,
        createdBy: "user-1",
        createdAt: new Date("2026-08-29T10:00:00.000Z"),
        updatedAt: new Date("2026-08-29T10:00:00.000Z"),
    };
    readonly readyCommitted = deferred();

    transaction(): AppTransaction {
        const select = () => ({
            from: () => ({
                where: () => ({
                    for: () => ({ limit: async () => [{ ...this.row }] }),
                    limit: async () => [{ ...this.row }],
                }),
            }),
        });
        const update = () => ({
            set: (patch: Partial<StoredRow>) => ({
                where: () => {
                    const apply = () => {
                        if (this.row.status !== "staging") return [];
                        Object.assign(this.row, patch);
                        if ((this.row.status as string) === "ready") this.readyCommitted.resolve();
                        return [{ ...this.row }];
                    };
                    return {
                        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
                            Promise.resolve(apply()).then(resolve, reject),
                        returning: async () => apply(),
                    };
                },
            }),
        });
        return { select, update } as unknown as AppTransaction;
    }
}

function storageWithCompletion(completeUpload: ObjectStorage["completeUpload"]): ObjectStorage {
    return {
        completeUpload,
        async createUpload() {
            throw new Error("unused");
        },
        async createReadUrl() {
            throw new Error("unused");
        },
        async putResult() {
            throw new Error("unused");
        },
    };
}

const tenant = { userId: "user-1", workspaceId: "workspace-1" };
const stored: StoredObject = { key: "final-key", contentType: "image/png", byteSize: 12, etag: "etag" };

describe("concurrent Asset completion", () => {
    it("returns ready to both callers when the losing storage call fails after the winner commits", async () => {
        const db = new FakeDatabase();
        const secondStarted = deferred();
        let calls = 0;
        const storage = storageWithCompletion(async () => {
            calls += 1;
            if (calls === 1) {
                await secondStarted.promise;
                return stored;
            }
            secondStarted.resolve();
            await db.readyCommitted.promise;
            throw new Error("staging disappeared after concurrent completion");
        });

        const [first, second] = await Promise.all([
            completeAssetUpload(db as unknown as AppDatabase, tenant, db.row.id, storage),
            completeAssetUpload(db as unknown as AppDatabase, tenant, db.row.id, storage),
        ]);

        expect(first.status).toBe("ready");
        expect(second).toEqual(first);
        expect(db.row.status).toBe("ready");
    });

    it("leaves transient or ambiguous storage failures staging and retryable", async () => {
        const db = new FakeDatabase();
        const storage = storageWithCompletion(async () => {
            throw new Error("connection reset");
        });

        await expect(
            completeAssetUpload(db as unknown as AppDatabase, tenant, db.row.id, storage),
        ).rejects.toMatchObject({ code: "asset_upload_completion_retryable", statusCode: 503, retryable: true });
        expect(db.row.status).toBe("staging");
    });

    it("CASes staging to failed only for a typed definitive verification mismatch", async () => {
        const db = new FakeDatabase();
        const storage = storageWithCompletion(async () => {
            throw new ObjectStorageVerificationError();
        });

        await expect(
            completeAssetUpload(db as unknown as AppDatabase, tenant, db.row.id, storage),
        ).rejects.toMatchObject({ code: "asset_upload_verification_failed", statusCode: 422 });
        expect(db.row.status).toBe("failed");
    });

    it("treats mismatched metadata returned by storage as a definitive verification failure", async () => {
        const db = new FakeDatabase();
        const storage = storageWithCompletion(async () => ({ ...stored, key: "unexpected-final-key" }));

        await expect(
            completeAssetUpload(db as unknown as AppDatabase, tenant, db.row.id, storage),
        ).rejects.toMatchObject({ code: "asset_upload_verification_failed", statusCode: 422 });
        expect(db.row.status).toBe("failed");
    });
});
