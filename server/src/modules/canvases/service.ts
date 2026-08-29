import type {
    Canvas,
    CanvasDeletionReceipt,
    CanvasSnapshot,
    CanvasSummary,
    CreateCanvasBody,
    SaveCanvasRequest,
} from "@infinite-canvas/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import type { AppTransaction } from "../../infrastructure/database/types.js";
import type { WorkspaceAccess } from "../workspaces/authorization.js";
import { canvases } from "./schema.js";

type CanvasRow = typeof canvases.$inferSelect;
type CanvasSummaryRow = Pick<CanvasRow, "id" | "workspaceId" | "title" | "documentMode" | "revision" | "createdAt" | "updatedAt">;

/** 内部不变量错误：锁定后条件更新返回零行，属于实现错误而非用户请求错误。 */
export class CanvasSaveInvariantError extends Error {
    constructor(
        readonly canvasId: string,
        readonly workspaceId: string,
        readonly expectedRevision: number,
    ) {
        super(`Canvas save invariant failed: id=${canvasId} workspace=${workspaceId} rev=${expectedRevision}`);
        this.name = "CanvasSaveInvariantError";
    }
}

/**
 * 删除路径的内部不变量错误：锁定活跃行后条件更新仍返回零行或缺少触发器回执，
 * 属于实现错误而非用户请求错误。诊断字段不复用 revision 语义。
 */
export class CanvasDeleteInvariantError extends Error {
    constructor(
        readonly canvasId: string,
        readonly workspaceId: string,
        readonly reason: "zero_row_update" | "missing_receipt",
    ) {
        super(`Canvas delete invariant failed: id=${canvasId} workspace=${workspaceId} reason=${reason}`);
        this.name = "CanvasDeleteInvariantError";
    }
}

function toCanvas(row: CanvasRow): Canvas {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        title: row.title,
        snapshot: row.snapshotJson as CanvasSnapshot,
        documentMode: row.documentMode as "snapshot" | "collaborative",
        revision: row.revision,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function toCanvasSummary(row: CanvasSummaryRow): CanvasSummary {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        title: row.title,
        documentMode: row.documentMode as "snapshot" | "collaborative",
        revision: row.revision,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function canvasNotFound(): AppError {
    return new AppError("canvas_not_found", 404, "画布不存在");
}

function revisionConflict(): AppError {
    return new AppError("revision_conflict", 409, "画布已在其他位置更新");
}

/**
 * 在同一 FOR UPDATE 锁下读行（含已删除行），不可见/跨租户返回 undefined。
 * 已删除行由调用方根据需要处理。
 */
async function lockCanvas(
    tx: AppTransaction,
    access: WorkspaceAccess,
    canvasId: string,
): Promise<CanvasRow | undefined> {
    const [row] = await tx
        .select()
        .from(canvases)
        .where(and(eq(canvases.id, canvasId), eq(canvases.workspaceId, access.workspaceId)))
        .for("update")
        .limit(1);
    return row;
}

async function findActiveCanvas(tx: AppTransaction, access: WorkspaceAccess, canvasId: string): Promise<CanvasRow> {
    const [row] = await tx
        .select()
        .from(canvases)
        .where(
            and(
                eq(canvases.id, canvasId),
                eq(canvases.workspaceId, access.workspaceId),
                isNull(canvases.deletedAt),
            ),
        )
        .limit(1);
    if (!row) throw canvasNotFound();
    return row;
}

export async function createCanvas(
    tx: AppTransaction,
    access: WorkspaceAccess,
    input: CreateCanvasBody,
): Promise<Canvas> {
    const [created] = await tx
        .insert(canvases)
        .values({
            workspaceId: access.workspaceId,
            title: input.title,
            snapshotJson: input.snapshot ?? {},
            documentMode: "snapshot",
            createdBy: access.userId,
            updatedBy: access.userId,
        })
        .returning();
    if (!created) throw new Error("Canvas insert returned no row");
    return toCanvas(created);
}

export async function listCanvases(tx: AppTransaction, access: WorkspaceAccess): Promise<CanvasSummary[]> {
    const rows = await tx
        .select({
            id: canvases.id,
            workspaceId: canvases.workspaceId,
            title: canvases.title,
            documentMode: canvases.documentMode,
            revision: canvases.revision,
            createdAt: canvases.createdAt,
            updatedAt: canvases.updatedAt,
        })
        .from(canvases)
        .where(and(eq(canvases.workspaceId, access.workspaceId), isNull(canvases.deletedAt)))
        .orderBy(desc(canvases.updatedAt), desc(canvases.id));

    return rows.map(toCanvasSummary);
}

export async function getCanvas(tx: AppTransaction, access: WorkspaceAccess, canvasId: string): Promise<Canvas> {
    return toCanvas(await findActiveCanvas(tx, access, canvasId));
}

/**
 * saveCanvas 排他锁实现（Task 6 锁定顺序）：
 * 1. FOR UPDATE 锁行（含已删除行）——不存在/跨租户 → 404
 * 2. 已删除 → 404
 * 3. mode 不是 snapshot → 409 canvas_document_mode_mismatch
 * 4. revision 不匹配 → 409 revision_conflict（含 base=MAX 但存储非 MAX）
 * 5. base=MAX 且存储=MAX → 409 canvas_revision_limit_reached
 * 6. 条件更新含 id/workspace/mode/revision/not-deleted；零行 → CanvasSaveInvariantError
 */
export async function saveCanvas(
    tx: AppTransaction,
    access: WorkspaceAccess,
    canvasId: string,
    input: SaveCanvasRequest,
): Promise<Canvas> {
    const locked = await lockCanvas(tx, access, canvasId);

    // 不存在、跨租户不可见、或已软删除 → 404
    if (!locked || locked.deletedAt !== null) throw canvasNotFound();

    // mode 检查先于 revision 检查
    if (locked.documentMode !== "snapshot") {
        throw new AppError("canvas_document_mode_mismatch", 409, "画布文档模式不支持此操作");
    }

    if (locked.revision !== input.baseRevision) {
        throw revisionConflict();
    }

    if (input.baseRevision === Number.MAX_SAFE_INTEGER) {
        throw new AppError("canvas_revision_limit_reached", 409, "画布版本已达到上限");
    }

    const [saved] = await tx
        .update(canvases)
        .set({
            snapshotJson: input.snapshot,
            ...(input.title === undefined ? {} : { title: input.title }),
            revision: sql`${canvases.revision} + 1`,
            updatedBy: access.userId,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(canvases.id, canvasId),
                eq(canvases.workspaceId, access.workspaceId),
                sql`${canvases.documentMode} = 'snapshot'`,
                eq(canvases.revision, input.baseRevision),
                isNull(canvases.deletedAt),
            ),
        )
        .returning();

    if (saved) return toCanvas(saved);

    // 锁定后条件更新零行是内部不变量错误，不是用户冲突。
    throw new CanvasSaveInvariantError(canvasId, access.workspaceId, input.baseRevision);
}

/**
 * deleteCanvas 返回持久化的删除回执（Task 6）：
 * - 锁定 id+workspace 行（含已删除行）——不可见行 → 404
 * - 活跃行：只写 deleted_at，回执由 BEFORE UPDATE 触发器生成并经 RETURNING 返回
 * - 已删除行：幂等返回持久化回执，无第二次状态变更
 * - 锁定后零行更新或缺少回执 → CanvasDeleteInvariantError
 */
export async function deleteCanvas(
    tx: AppTransaction,
    access: WorkspaceAccess,
    canvasId: string,
): Promise<CanvasDeletionReceipt> {
    // 锁定行（含已删除）；不存在/跨租户 → 404。
    const locked = await lockCanvas(tx, access, canvasId);
    if (!locked) throw canvasNotFound();

    // 已删除：幂等返回持久化回执。
    if (locked.deletedAt !== null && locked.deletionReceiptId !== null) {
        return {
            canvasId: locked.id,
            deletionReceipt: locked.deletionReceiptId,
            deletedAt: locked.deletedAt.toISOString(),
        };
    }

    const now = new Date();
    const [deleted] = await tx
        .update(canvases)
        .set({
            deletedAt: now,
            updatedAt: now,
            updatedBy: access.userId,
        })
        .where(
            and(
                eq(canvases.id, canvasId),
                eq(canvases.workspaceId, access.workspaceId),
                isNull(canvases.deletedAt),
            ),
        )
        .returning({ id: canvases.id, deletedAt: canvases.deletedAt, deletionReceiptId: canvases.deletionReceiptId });

    // 回执由 BEFORE UPDATE 触发器生成，这里只通过 RETURNING 接收权威值。
    if (!deleted) throw new CanvasDeleteInvariantError(canvasId, access.workspaceId, "zero_row_update");
    if (deleted.deletedAt === null || deleted.deletionReceiptId === null) {
        throw new CanvasDeleteInvariantError(canvasId, access.workspaceId, "missing_receipt");
    }

    return {
        canvasId: deleted.id,
        deletionReceipt: deleted.deletionReceiptId,
        deletedAt: deleted.deletedAt.toISOString(),
    };
}
