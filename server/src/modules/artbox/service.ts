import { randomUUID } from "node:crypto";

import type {
    ArtBoxGenerationError,
    ArtBoxVideoGeneration,
    ArtBoxVideoGenerationStatus,
    CreateArtBoxVideoGenerationBody,
} from "@infinite-canvas/contracts";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import { hashCanonicalRequest } from "../../infrastructure/idempotency.js";
import { withTenantTransaction } from "../../infrastructure/database/transactions.js";
import type { AppDatabase, AppTransaction } from "../../infrastructure/database/types.js";
import type { ObjectStorage, StoredObject } from "../../infrastructure/object-storage/types.js";
import { assets } from "../assets/schema.js";
import { getReadyAssets, type ReadyAssetObject } from "../assets/service.js";
import { requireActiveWorkspace } from "../workspaces/authorization.js";
import type { ArtBoxAdapter, ArtBoxPollOutcome } from "./adapter.js";
import { artboxVideoGenerations } from "./schema.js";

type GenerationRow = typeof artboxVideoGenerations.$inferSelect;
type TenantInput = { userId: string; workspaceId: string };

export type ArtBoxResultDownloadConfig = {
    requestTimeoutMs: number;
    resultMaxBytes: number;
    resultAllowedHosts: readonly string[];
};

export type ArtBoxServiceDependencies = ArtBoxResultDownloadConfig & {
    adapter: ArtBoxAdapter;
    storage: ObjectStorage;
    signedUrlTtlSeconds: number;
    pollLeaseSeconds: number;
    fetchImpl?: typeof fetch;
};

class PollLeaseLostError extends Error {}

function publicError(value: unknown): ArtBoxGenerationError | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.code === "string" &&
        typeof candidate.message === "string" &&
        typeof candidate.retryable === "boolean"
        ? { code: candidate.code, message: candidate.message, retryable: candidate.retryable }
        : null;
}

function toGeneration(row: GenerationRow): ArtBoxVideoGeneration {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        status: row.status as ArtBoxVideoGenerationStatus,
        resultAssetId: row.resultAssetId,
        error: publicError(row.publicError),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function generationNotFound(): AppError {
    return new AppError("artbox_generation_not_found", 404, "视频生成记录不存在");
}

async function findGeneration(
    tx: AppTransaction,
    workspaceId: string,
    generationId: string,
    lock = false,
): Promise<GenerationRow> {
    const query = tx
        .select()
        .from(artboxVideoGenerations)
        .where(and(eq(artboxVideoGenerations.id, generationId), eq(artboxVideoGenerations.workspaceId, workspaceId)));
    const rows = lock ? await query.for("update").limit(1) : await query.limit(1);
    const row = rows[0];
    if (!row) throw generationNotFound();
    return row;
}

function terminal(row: GenerationRow): boolean {
    return row.status === "succeeded" || row.status === "failed" || row.status === "reconciling";
}

function storageFailure(): ArtBoxGenerationError {
    return { code: "asset_transport_error", message: "素材传输暂时失败", retryable: false };
}

async function persistCreateOutcome(
    db: AppDatabase,
    tenant: TenantInput,
    generationId: string,
    outcome:
        | { kind: "submitted"; remoteTaskId: string }
        | { kind: "failed" | "reconciling"; error: ArtBoxGenerationError },
): Promise<ArtBoxVideoGeneration> {
    return withTenantTransaction(db, tenant, async (tx, access) => {
        requireActiveWorkspace(access);
        const current = await findGeneration(tx, access.workspaceId, generationId, true);
        if (current.status !== "submitting") return toGeneration(current);
        const [updated] = await tx
            .update(artboxVideoGenerations)
            .set(
                outcome.kind === "submitted"
                    ? { status: "queued", remoteTaskId: outcome.remoteTaskId, publicError: null, updatedAt: new Date() }
                    : { status: outcome.kind, publicError: outcome.error, updatedAt: new Date() },
            )
            .where(
                and(
                    eq(artboxVideoGenerations.id, current.id),
                    eq(artboxVideoGenerations.workspaceId, access.workspaceId),
                    eq(artboxVideoGenerations.status, "submitting"),
                ),
            )
            .returning();
        if (!updated) throw new Error("ArtBox create outcome update returned no row");
        return toGeneration(updated);
    });
}

export async function createArtBoxVideoGeneration(
    db: AppDatabase,
    tenant: TenantInput,
    input: CreateArtBoxVideoGenerationBody,
    idempotencyKey: string,
    dependencies: ArtBoxServiceDependencies,
): Promise<ArtBoxVideoGeneration> {
    const requestHash = hashCanonicalRequest(input);
    const prepared = await withTenantTransaction(db, tenant, async (tx, access) => {
        requireActiveWorkspace(access);
        const [existing] = await tx
            .select()
            .from(artboxVideoGenerations)
            .where(
                and(
                    eq(artboxVideoGenerations.workspaceId, access.workspaceId),
                    eq(artboxVideoGenerations.idempotencyKey, idempotencyKey),
                ),
            )
            .limit(1);
        if (existing) {
            if (existing.requestHash !== requestHash) {
                throw new AppError("idempotency_conflict", 409, "幂等键已用于不同请求");
            }
            return { kind: "existing" as const, generation: toGeneration(existing) };
        }

        const readyAssets = await getReadyAssets(tx, access.workspaceId, input.bindings);
        const id = randomUUID();
        const [created] = await tx
            .insert(artboxVideoGenerations)
            .values({
                id,
                workspaceId: access.workspaceId,
                idempotencyKey,
                requestHash,
                normalizedInput: input,
                createdBy: access.userId,
            })
            .onConflictDoNothing({
                target: [artboxVideoGenerations.workspaceId, artboxVideoGenerations.idempotencyKey],
            })
            .returning();
        if (created) return { kind: "created" as const, row: created, readyAssets };

        const [concurrent] = await tx
            .select()
            .from(artboxVideoGenerations)
            .where(
                and(
                    eq(artboxVideoGenerations.workspaceId, access.workspaceId),
                    eq(artboxVideoGenerations.idempotencyKey, idempotencyKey),
                ),
            )
            .limit(1);
        if (!concurrent) throw new Error("ArtBox idempotency conflict returned no row");
        if (concurrent.requestHash !== requestHash) {
            throw new AppError("idempotency_conflict", 409, "幂等键已用于不同请求");
        }
        return { kind: "existing" as const, generation: toGeneration(concurrent) };
    });

    if (prepared.kind === "existing") return prepared.generation;

    let providerBindings: { nodeId: string; kind: ReadyAssetObject["kind"]; url: string }[];
    try {
        providerBindings = await Promise.all(
            prepared.readyAssets.map(async (asset, index) => ({
                nodeId: input.bindings[index]!.nodeId,
                kind: asset.kind,
                url: await dependencies.storage.createReadUrl({
                    key: asset.key,
                    expiresInSeconds: dependencies.signedUrlTtlSeconds,
                }),
            })),
        );
    } catch {
        return persistCreateOutcome(db, tenant, prepared.row.id, { kind: "failed", error: storageFailure() });
    }

    const outcome = await dependencies.adapter.create({
        model: input.model,
        promptTemplate: input.promptTemplate,
        bindings: providerBindings,
        seconds: input.seconds,
        ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
        ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
        generateAudio: input.generateAudio,
    });
    return persistCreateOutcome(db, tenant, prepared.row.id, outcome);
}

function resultError(code: string, message: string, retryable: boolean): AppError {
    return new AppError(code, retryable ? 503 : 422, message, retryable);
}

function validateResultUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw resultError("provider_result_rejected", "生成结果地址不安全", false);
    }
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !allowedHosts.includes(url.hostname.toLowerCase())
    ) {
        throw resultError("provider_result_rejected", "生成结果地址不安全", false);
    }
    return url;
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
        const size = Number(declared);
        if (!Number.isSafeInteger(size) || size < 0 || size > maximum) {
            throw resultError("provider_result_too_large", "生成结果超过大小限制", false);
        }
    }
    if (!response.body) return new Uint8Array();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximum) {
            await reader.cancel().catch(() => {});
            throw resultError("provider_result_too_large", "生成结果超过大小限制", false);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

export async function downloadArtBoxResult(
    rawUrl: string,
    config: ArtBoxResultDownloadConfig,
    fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = validateResultUrl(rawUrl, config.resultAllowedHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
        const response = await fetchImpl(url.toString(), {
            method: "GET",
            redirect: "error",
            signal: controller.signal,
        });
        if (!response.ok) throw resultError("provider_result_unavailable", "生成结果暂时无法下载", true);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (!contentType?.startsWith("video/")) {
            throw resultError("provider_result_rejected", "生成结果不是受支持的视频", false);
        }
        return { bytes: await boundedBody(response, config.resultMaxBytes), contentType };
    } catch (error) {
        if (error instanceof AppError) throw error;
        throw resultError("provider_result_unavailable", "生成结果暂时无法下载", true);
    } finally {
        clearTimeout(timer);
    }
}

async function acquirePollLease(
    db: AppDatabase,
    tenant: TenantInput,
    generationId: string,
    leaseSeconds: number,
): Promise<{ generation: ArtBoxVideoGeneration; row?: GenerationRow }> {
    return withTenantTransaction(db, tenant, async (tx, access) => {
        requireActiveWorkspace(access);
        const current = await findGeneration(tx, access.workspaceId, generationId);
        if (terminal(current) || !current.remoteTaskId) return { generation: toGeneration(current) };

        const [leased] = await tx
            .update(artboxVideoGenerations)
            .set({
                pollLeaseEpoch: sql`${artboxVideoGenerations.pollLeaseEpoch} + 1`,
                pollLeaseUntil: sql`now() + ${leaseSeconds} * interval '1 second'`,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(artboxVideoGenerations.id, current.id),
                    eq(artboxVideoGenerations.workspaceId, access.workspaceId),
                    eq(artboxVideoGenerations.pollLeaseEpoch, current.pollLeaseEpoch),
                    or(isNull(artboxVideoGenerations.pollLeaseUntil), lte(artboxVideoGenerations.pollLeaseUntil, new Date())),
                ),
            )
            .returning();
        if (!leased) return { generation: toGeneration(await findGeneration(tx, access.workspaceId, generationId)) };
        return { generation: toGeneration(leased), row: leased };
    });
}

async function persistPollOutcome(
    db: AppDatabase,
    tenant: TenantInput,
    leased: GenerationRow,
    outcome: Exclude<ArtBoxPollOutcome, { kind: "succeeded" }>,
): Promise<ArtBoxVideoGeneration> {
    return withTenantTransaction(db, tenant, async (tx, access) => {
        requireActiveWorkspace(access);
        let values: { status: string; publicError: ArtBoxGenerationError | null };
        if (!("error" in outcome)) {
            values = { status: outcome.kind, publicError: null };
        } else if (outcome.kind === "retryable") {
            values = { status: leased.status, publicError: outcome.error };
        } else {
            values = { status: outcome.kind, publicError: outcome.error };
        }
        const [updated] = await tx
            .update(artboxVideoGenerations)
            .set({ ...values, pollLeaseUntil: null, updatedAt: new Date() })
            .where(
                and(
                    eq(artboxVideoGenerations.id, leased.id),
                    eq(artboxVideoGenerations.workspaceId, access.workspaceId),
                    eq(artboxVideoGenerations.pollLeaseEpoch, leased.pollLeaseEpoch),
                ),
            )
            .returning();
        return toGeneration(updated ?? (await findGeneration(tx, access.workspaceId, leased.id)));
    });
}

function storedResultMatches(stored: StoredObject, key: string, contentType: string, byteSize: number): boolean {
    return (
        stored.key === key &&
        stored.contentType === contentType &&
        stored.byteSize === byteSize &&
        Number.isSafeInteger(stored.byteSize) &&
        stored.byteSize >= 0
    );
}

async function persistSuccessfulResult(
    db: AppDatabase,
    tenant: TenantInput,
    leased: GenerationRow,
    stored: StoredObject,
    assetId: string,
    finalObjectKey: string,
    contentType: string,
): Promise<ArtBoxVideoGeneration> {
    try {
        return await withTenantTransaction(db, tenant, async (tx, access) => {
            requireActiveWorkspace(access);
            await tx.insert(assets).values({
                id: assetId,
                workspaceId: access.workspaceId,
                kind: "video",
                status: "ready",
                fileName: `artbox-${leased.id}.${contentType === "video/webm" ? "webm" : "mp4"}`,
                contentType,
                byteSize: stored.byteSize,
                stagingObjectKey: null,
                finalObjectKey,
                etag: stored.etag ?? null,
                createdBy: access.userId,
            });
            const [updated] = await tx
                .update(artboxVideoGenerations)
                .set({
                    status: "succeeded",
                    resultAssetId: assetId,
                    publicError: null,
                    pollLeaseUntil: null,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(artboxVideoGenerations.id, leased.id),
                        eq(artboxVideoGenerations.workspaceId, access.workspaceId),
                        eq(artboxVideoGenerations.pollLeaseEpoch, leased.pollLeaseEpoch),
                    ),
                )
                .returning();
            if (!updated) throw new PollLeaseLostError();
            return toGeneration(updated);
        });
    } catch (error) {
        if (!(error instanceof PollLeaseLostError)) throw error;
        return withTenantTransaction(db, tenant, async (tx, access) => {
            requireActiveWorkspace(access);
            return toGeneration(await findGeneration(tx, access.workspaceId, leased.id));
        });
    }
}

export async function pollArtBoxVideoGeneration(
    db: AppDatabase,
    tenant: TenantInput,
    generationId: string,
    dependencies: ArtBoxServiceDependencies,
): Promise<ArtBoxVideoGeneration> {
    const lease = await acquirePollLease(db, tenant, generationId, dependencies.pollLeaseSeconds);
    if (!lease.row?.remoteTaskId) return lease.generation;

    const outcome = await dependencies.adapter.poll(lease.row.remoteTaskId);
    if (outcome.kind !== "succeeded") return persistPollOutcome(db, tenant, lease.row, outcome);

    try {
        const result = await downloadArtBoxResult(outcome.resultUrl, dependencies, dependencies.fetchImpl);
        const assetId = randomUUID();
        const finalObjectKey = `assets/final/${assetId}/${randomUUID()}`;
        const stored = await dependencies.storage.putResult({
            key: finalObjectKey,
            contentType: result.contentType,
            bytes: result.bytes,
        });
        if (!storedResultMatches(stored, finalObjectKey, result.contentType, result.bytes.byteLength)) {
            throw resultError("asset_result_verification_failed", "生成结果存储校验失败", false);
        }
        return persistSuccessfulResult(
            db,
            tenant,
            lease.row,
            stored,
            assetId,
            finalObjectKey,
            result.contentType,
        );
    } catch (error) {
        const failure =
            error instanceof AppError
                ? { code: error.code, message: error.message, retryable: error.retryable }
                : { code: "asset_result_storage_error", message: "生成结果暂时无法保存", retryable: true };
        return persistPollOutcome(
            db,
            tenant,
            lease.row,
            failure.retryable
                ? { kind: "retryable", error: failure }
                : { kind: "failed", error: failure },
        );
    }
}
