import { randomUUID } from "node:crypto";

import type {
    Asset,
    AssetKind,
    CreateAssetBody,
    CreateAssetResponse,
} from "@infinite-canvas/contracts";
import { and, eq, inArray } from "drizzle-orm";

import { AppError } from "../../errors.js";
import { withTenantTransaction } from "../../infrastructure/database/transactions.js";
import type { AppDatabase, AppTransaction } from "../../infrastructure/database/types.js";
import {
    ObjectStorageVerificationError,
    type ObjectStorage,
    type StoredObject,
} from "../../infrastructure/object-storage/types.js";
import { requireActiveWorkspace } from "../workspaces/authorization.js";
import { assets } from "./schema.js";

type AssetRow = typeof assets.$inferSelect;
type TenantInput = { userId: string; workspaceId: string };
export type ReadyAssetRef = { assetId: string; kind: AssetKind };
export type ReadyAssetObject = { id: string; kind: AssetKind; key: string; contentType: string; byteSize: number };

function assetNotFound(): AppError {
    return new AppError("asset_not_found", 404, "素材不存在");
}

function toAsset(row: AssetRow): Asset {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        kind: row.kind as AssetKind,
        status: row.status as Asset["status"],
        fileName: row.fileName,
        contentType: row.contentType,
        byteSize: row.byteSize,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

async function findAsset(tx: AppTransaction, workspaceId: string, assetId: string, lock = false): Promise<AssetRow> {
    const query = tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId)));
    const rows = lock ? await query.for("update").limit(1) : await query.limit(1);
    const row = rows[0];
    if (!row || row.status === "deleted") throw assetNotFound();
    return row;
}

function assertStoredObject(stored: StoredObject, row: AssetRow): void {
    if (
        stored.key !== row.finalObjectKey ||
        stored.contentType !== row.contentType ||
        !Number.isSafeInteger(stored.byteSize) ||
        stored.byteSize < 0
    ) {
        throw new ObjectStorageVerificationError();
    }
}

export async function createAssetUpload(
    db: AppDatabase,
    tenant: TenantInput,
    input: CreateAssetBody,
    storage: ObjectStorage,
    signedUrlTtlSeconds: number,
): Promise<CreateAssetResponse> {
    const id = randomUUID();
    const stagingObjectKey = `assets/staging/${id}/${randomUUID()}`;
    const finalObjectKey = `assets/final/${id}/${randomUUID()}`;
    const asset = await withTenantTransaction(db, tenant, async (tx, access) => {
        requireActiveWorkspace(access);
        const [created] = await tx
            .insert(assets)
            .values({
                id,
                workspaceId: access.workspaceId,
                kind: input.kind,
                fileName: input.fileName,
                contentType: input.contentType,
                stagingObjectKey,
                finalObjectKey,
                createdBy: access.userId,
            })
            .returning();
        if (!created) throw new Error("Asset insert returned no row");
        return toAsset(created);
    });

    const upload = await storage.createUpload({
        stagingKey: stagingObjectKey,
        contentType: input.contentType,
        expiresInSeconds: signedUrlTtlSeconds,
    });
    return { asset, upload };
}

export async function completeAssetUpload(
    db: AppDatabase,
    tenant: TenantInput,
    assetId: string,
    storage: ObjectStorage,
): Promise<Asset> {
    const row = await withTenantTransaction(db, tenant, async (tx, access) => {
        requireActiveWorkspace(access);
        return findAsset(tx, access.workspaceId, assetId, true);
    });
    if (row.status === "ready") return toAsset(row);
    if (row.status !== "staging" || !row.stagingObjectKey) {
        throw new AppError("asset_not_ready", 409, "素材未就绪");
    }

    let stored: StoredObject;
    try {
        stored = await storage.completeUpload({
            stagingKey: row.stagingObjectKey,
            finalKey: row.finalObjectKey,
            expectedContentType: row.contentType,
        });
        assertStoredObject(stored, row);
    } catch (error) {
        const recovery = await withTenantTransaction(db, tenant, async (tx, access) => {
            requireActiveWorkspace(access);
            const current = await findAsset(tx, access.workspaceId, assetId, true);
            if (current.status === "ready") return { kind: "ready" as const, asset: toAsset(current) };
            if (current.status !== "staging") throw new AppError("asset_not_ready", 409, "素材未就绪");
            if (!(error instanceof ObjectStorageVerificationError)) return { kind: "retryable" as const };

            const [failed] = await tx
                .update(assets)
                .set({ status: "failed", updatedAt: new Date() })
                .where(
                    and(
                        eq(assets.id, assetId),
                        eq(assets.workspaceId, access.workspaceId),
                        eq(assets.status, "staging"),
                    ),
                )
                .returning();
            if (!failed) throw new Error("Asset failure update returned no row");
            return { kind: "failed" as const };
        });
        if (recovery.kind === "ready") return recovery.asset;
        if (recovery.kind === "retryable") {
            throw new AppError("asset_upload_completion_retryable", 503, "素材上传完成状态暂时无法确认", true);
        }
        throw new AppError("asset_upload_verification_failed", 422, "素材上传校验失败");
    }

    return withTenantTransaction(db, tenant, async (tx, access) => {
        requireActiveWorkspace(access);
        const current = await findAsset(tx, access.workspaceId, assetId, true);
        if (current.status === "ready") return toAsset(current);
        if (current.status !== "staging") throw new AppError("asset_not_ready", 409, "素材未就绪");
        const [ready] = await tx
            .update(assets)
            .set({
                status: "ready",
                stagingObjectKey: null,
                byteSize: stored.byteSize,
                etag: stored.etag ?? null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(assets.id, assetId),
                    eq(assets.workspaceId, access.workspaceId),
                    eq(assets.status, "staging"),
                ),
            )
            .returning();
        if (!ready) throw new Error("Asset completion update returned no row");
        return toAsset(ready);
    });
}

async function findReadyAsset(
    db: AppDatabase,
    tenant: TenantInput,
    assetId: string,
): Promise<AssetRow> {
    const row = await withTenantTransaction(db, tenant, async (tx, access) => {
        requireActiveWorkspace(access);
        return findAsset(tx, access.workspaceId, assetId);
    });
    if (row.status !== "ready") throw new AppError("asset_not_ready", 409, "素材未就绪");
    return row;
}

export async function readAssetMetadata(db: AppDatabase, tenant: TenantInput, assetId: string): Promise<Asset> {
    return toAsset(await findReadyAsset(db, tenant, assetId));
}

export async function createAssetReadUrl(
    db: AppDatabase,
    tenant: TenantInput,
    assetId: string,
    storage: ObjectStorage,
    signedUrlTtlSeconds: number,
): Promise<string> {
    const row = await findReadyAsset(db, tenant, assetId);
    return storage.createReadUrl({
        key: row.finalObjectKey,
        expiresInSeconds: signedUrlTtlSeconds,
    });
}

export async function getReadyAssets(
    tx: AppTransaction,
    workspaceId: string,
    refs: readonly ReadyAssetRef[],
): Promise<ReadyAssetObject[]> {
    if (refs.length === 0) return [];
    const ids = [...new Set(refs.map((ref) => ref.assetId))];
    const rows = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.workspaceId, workspaceId), inArray(assets.id, ids)));
    const byId = new Map(rows.map((row) => [row.id, row]));

    return refs.map((ref) => {
        const row = byId.get(ref.assetId);
        if (!row || row.status === "deleted") throw assetNotFound();
        if (row.kind !== ref.kind) throw new AppError("asset_kind_mismatch", 422, "素材类型不匹配");
        if (row.status !== "ready" || row.byteSize === null) throw new AppError("asset_not_ready", 409, "素材未就绪");
        return {
            id: row.id,
            kind: row.kind as AssetKind,
            key: row.finalObjectKey,
            contentType: row.contentType,
            byteSize: row.byteSize,
        };
    });
}
