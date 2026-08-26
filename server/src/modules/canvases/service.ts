import type {
    Canvas,
    CanvasSnapshot,
    CanvasSummary,
    CreateCanvasBody,
    SaveCanvasRequest,
} from "@infinite-canvas/contracts";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { AppError } from "../../errors.js";
import type { AppDatabase } from "../../infrastructure/database/types.js";
import type { WorkspaceAccess } from "../workspaces/authorization.js";
import { canvases } from "./schema.js";

type CanvasRow = typeof canvases.$inferSelect;
type CanvasSummaryRow = Pick<CanvasRow, "id" | "workspaceId" | "title" | "revision" | "createdAt" | "updatedAt">;

function toCanvas(row: CanvasRow): Canvas {
    return {
        id: row.id,
        workspaceId: row.workspaceId,
        title: row.title,
        snapshot: row.snapshotJson as CanvasSnapshot,
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
        revision: row.revision,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function canvasNotFound(): AppError {
    return new AppError("canvas_not_found", 404, "画布不存在");
}

async function findActiveCanvas(db: AppDatabase, access: WorkspaceAccess, canvasId: string): Promise<CanvasRow> {
    const row = await db.query.canvases.findFirst({
        where: and(
            eq(canvases.id, canvasId),
            eq(canvases.workspaceId, access.workspaceId),
            isNull(canvases.deletedAt),
        ),
    });
    if (!row) throw canvasNotFound();
    return row;
}

export async function createCanvas(
    db: AppDatabase,
    access: WorkspaceAccess,
    input: CreateCanvasBody,
): Promise<Canvas> {
    const [created] = await db
        .insert(canvases)
        .values({
            workspaceId: access.workspaceId,
            title: input.title,
            snapshotJson: input.snapshot ?? {},
            createdBy: access.userId,
            updatedBy: access.userId,
        })
        .returning();
    if (!created) throw new Error("Canvas insert returned no row");
    return toCanvas(created);
}

export async function listCanvases(db: AppDatabase, access: WorkspaceAccess): Promise<CanvasSummary[]> {
    const rows = await db
        .select({
            id: canvases.id,
            workspaceId: canvases.workspaceId,
            title: canvases.title,
            revision: canvases.revision,
            createdAt: canvases.createdAt,
            updatedAt: canvases.updatedAt,
        })
        .from(canvases)
        .where(and(eq(canvases.workspaceId, access.workspaceId), isNull(canvases.deletedAt)))
        .orderBy(desc(canvases.updatedAt), desc(canvases.id));

    return rows.map(toCanvasSummary);
}

export async function getCanvas(db: AppDatabase, access: WorkspaceAccess, canvasId: string): Promise<Canvas> {
    return toCanvas(await findActiveCanvas(db, access, canvasId));
}

export async function saveCanvas(
    db: AppDatabase,
    access: WorkspaceAccess,
    canvasId: string,
    input: SaveCanvasRequest,
): Promise<Canvas> {
    if (input.baseRevision === Number.MAX_SAFE_INTEGER) {
        await findActiveCanvas(db, access, canvasId);
        throw new AppError("canvas_revision_limit_reached", 409, "画布版本已达到上限");
    }

    const [saved] = await db
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
                eq(canvases.revision, input.baseRevision),
                isNull(canvases.deletedAt),
            ),
        )
        .returning();

    if (saved) return toCanvas(saved);

    await findActiveCanvas(db, access, canvasId);
    throw new AppError("revision_conflict", 409, "画布已在其他位置更新");
}

export async function softDeleteCanvas(db: AppDatabase, access: WorkspaceAccess, canvasId: string): Promise<void> {
    const now = new Date();
    const [deleted] = await db
        .update(canvases)
        .set({ deletedAt: now, updatedAt: now, updatedBy: access.userId })
        .where(
            and(
                eq(canvases.id, canvasId),
                eq(canvases.workspaceId, access.workspaceId),
                isNull(canvases.deletedAt),
            ),
        )
        .returning({ id: canvases.id });
    if (deleted) return;

    const [existing] = await db
        .select({ id: canvases.id })
        .from(canvases)
        .where(and(eq(canvases.id, canvasId), eq(canvases.workspaceId, access.workspaceId)))
        .limit(1);
    if (!existing) throw canvasNotFound();
}
