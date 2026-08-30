import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";

import { AppError } from "../../errors.js";
import { withTenantTransaction, withUserTransaction, withWorkerTransaction } from "../../infrastructure/database/transactions.js";
import type { AppDatabase, AppTransaction } from "../../infrastructure/database/types.js";
import type { ObjectStoreAdapter } from "./object-store.js";

export type ReadyAsset = {
    assetId: string;
    displayName: string;
    mediaType: string;
    byteSize: bigint;
    sha256: string;
};

type AssetStorage = { objectKey: string; status: string };
type AssetStorageRow = { object_key: string; status: string };
type ReadyAssetRow = {
    asset_id: string;
    display_name: string;
    media_type: string;
    byte_size: string;
    sha256: string;
};

class AssetVerificationError extends Error {}

export class AssetModule {
    constructor(
        private readonly db: AppDatabase,
        private readonly objectStore: ObjectStoreAdapter,
    ) {}

    async createStagingAsset(
        tx: AppTransaction,
        input: { workspaceId: string; displayName: string },
    ): Promise<{ assetId: string }> {
        const result = await tx.execute<{ asset_id: string }>(
            sql`select public.create_staging_asset(${input.workspaceId}, ${input.displayName}) as asset_id`,
        );
        const assetId = result.rows[0]?.asset_id;
        if (!assetId) throw new Error("create_staging_asset returned no id");
        return { assetId };
    }

    async storeAndVerifyOutput(input: {
        workspaceId: string;
        assetId: string;
        output: { bytes: Uint8Array; mediaType: string };
    }): Promise<void> {
        const storage = await this.readStorage(input.workspaceId, input.assetId);
        if (storage.status !== "staging" && storage.status !== "ready") {
            throw new AppError("asset_not_storable", 409, "素材当前状态不允许写入");
        }

        const sha256 = createHash("sha256").update(input.output.bytes).digest("hex");
        await this.objectStore.putIfAbsent({
            key: storage.objectKey,
            bytes: input.output.bytes,
            mediaType: input.output.mediaType,
            sha256,
        });

        try {
            const stored = await this.objectStore.get(storage.objectKey);
            const storedHash = createHash("sha256").update(stored).digest("hex");
            const detected = await fileTypeFromBuffer(stored);
            if (storedHash !== sha256 || stored.byteLength !== input.output.bytes.byteLength) {
                throw new AssetVerificationError("stored output checksum or size mismatch");
            }
            if (!detected || detected.mime !== input.output.mediaType) {
                throw new AssetVerificationError("stored output media type mismatch");
            }

            await withWorkerTransaction(
                this.db,
                { workspaceId: input.workspaceId, verify: (tx) => this.getStorage(tx, input.workspaceId, input.assetId) },
                async (tx) => {
                    await tx.execute(sql`
                        select public.mark_asset_ready(
                            ${input.workspaceId}, ${input.assetId}::uuid, ${detected.mime},
                            ${BigInt(stored.byteLength)}, ${storedHash}
                        )
                    `);
                },
            );
        } catch (error) {
            if (error instanceof AssetVerificationError) {
                await withWorkerTransaction(
                    this.db,
                    { workspaceId: input.workspaceId, verify: (tx) => this.getStorage(tx, input.workspaceId, input.assetId) },
                    (tx) => this.markFailed(tx, { workspaceId: input.workspaceId, assetId: input.assetId, reason: "output_verification_failed" }),
                );
            }
            throw error;
        }
    }

    async getReadyAsset(
        tx: AppTransaction,
        input: { workspaceId: string; assetId: string },
    ): Promise<ReadyAsset> {
        const result = await tx.execute<ReadyAssetRow>(
            sql`select * from public.get_ready_asset(${input.workspaceId}, ${input.assetId}::uuid)`,
        );
        const row = result.rows[0];
        if (!row) throw new AppError("asset_not_ready", 404, "素材不存在或尚未就绪");
        return {
            assetId: row.asset_id,
            displayName: row.display_name,
            mediaType: row.media_type,
            byteSize: BigInt(row.byte_size),
            sha256: row.sha256,
        };
    }

    async markFailed(
        tx: AppTransaction,
        input: { workspaceId: string; assetId: string; reason: string },
    ): Promise<void> {
        await tx.execute(sql`select public.mark_asset_failed(${input.workspaceId}, ${input.assetId}::uuid, ${input.reason})`);
    }

    async logicalDelete(
        tx: AppTransaction,
        input: { workspaceId: string; assetId: string },
    ): Promise<void> {
        await tx.execute(sql`select public.logical_delete_asset(${input.workspaceId}, ${input.assetId}::uuid)`);
    }

    async openReadyAssetContent(input: { userId: string; assetId: string; signal: AbortSignal }) {
        const workspaceId = await withUserTransaction(this.db, input.userId, async (tx) => {
            const result = await tx.execute<{ workspace_id: string | null }>(
                sql`select public.resolve_visible_asset_workspace(${input.assetId}::uuid, ${input.userId}) as workspace_id`,
            );
            const resolved = result.rows[0]?.workspace_id;
            if (!resolved) throw new AppError("asset_not_found", 404, "素材不存在");
            return resolved;
        });
        const storage = await withTenantTransaction(this.db, { userId: input.userId, workspaceId }, async (tx) => {
            const result = await tx.execute<{
                object_key: string;
                status: string;
                display_name: string;
                media_type: string | null;
                byte_size: string | null;
                sha256: string | null;
            }>(
                sql`select * from public.get_ready_asset_storage(${workspaceId}, ${input.assetId}::uuid)`,
            );
            const row = result.rows[0];
            if (!row || row.status === "deleted") throw new AppError("asset_not_found", 404, "素材不存在");
            if (row.status !== "ready" || !row.media_type || row.byte_size === null || !row.sha256) {
                throw new AppError("asset_not_ready", 409, "素材尚未就绪");
            }
            return {
                objectKey: row.object_key,
                displayName: row.display_name,
                mediaType: row.media_type,
                byteSize: BigInt(row.byte_size),
                sha256: row.sha256,
            };
        });
        try {
            return {
                stream: await this.objectStore.open(storage.objectKey, input.signal),
                displayName: storage.displayName,
                mediaType: storage.mediaType,
                byteSize: storage.byteSize,
                sha256: storage.sha256,
            };
        } catch {
            throw new AppError("asset_content_unavailable", 503, "素材内容暂时不可用", true);
        }
    }

    private async readStorage(workspaceId: string, assetId: string): Promise<AssetStorage> {
        return withWorkerTransaction(
            this.db,
            { workspaceId, verify: (tx) => this.getStorage(tx, workspaceId, assetId) },
            async (_tx, storage) => storage,
        );
    }

    private async getStorage(tx: AppTransaction, workspaceId: string, assetId: string): Promise<AssetStorage | null> {
        const result = await tx.execute<AssetStorageRow>(
            sql`select * from public.get_staging_asset_storage(${workspaceId}, ${assetId}::uuid)`,
        );
        const row = result.rows[0];
        return row ? { objectKey: row.object_key, status: row.status } : null;
    }
}
