import { describe, expect, it } from "vitest";
import {
    CanvasListResponseSchema,
    CanvasPathSchema,
    CanvasResponseSchema,
    CanvasSummarySchema,
    CreateCanvasBodySchema,
    SaveCanvasRequestSchema,
} from "@infinite-canvas/contracts";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Value } from "typebox/value";

import { canvases } from "../../src/modules/canvases/schema.js";

const canvasId = "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192";
const timestamp = "2026-08-26T10:00:00.000Z";

describe("canvas save contract", () => {
    it("requires a non-negative baseRevision and a JSON snapshot", () => {
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 0, snapshot: { nodes: [], connections: [] } })).toBe(true);
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: -1, snapshot: {} })).toBe(false);
    });

    it("rejects fractional revisions, non-object snapshots and unknown properties", () => {
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 1.5, snapshot: {} })).toBe(false);
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 0, snapshot: [] })).toBe(false);
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 0 })).toBe(false);
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 0, snapshot: {}, revision: 3 })).toBe(false);
    });
});

describe("canvas create contract", () => {
    it("accepts a bounded title with an optional snapshot", () => {
        expect(Value.Check(CreateCanvasBodySchema, { title: "我的画布" })).toBe(true);
        expect(Value.Check(CreateCanvasBodySchema, { title: "我的画布", snapshot: { nodes: [] } })).toBe(true);
    });

    it("rejects empty, oversized and unknown title input", () => {
        expect(Value.Check(CreateCanvasBodySchema, { title: "" })).toBe(false);
        expect(Value.Check(CreateCanvasBodySchema, { title: "标".repeat(201) })).toBe(false);
        expect(Value.Check(CreateCanvasBodySchema, { title: "我的画布", workspaceId: "ws_1" })).toBe(false);
    });
});

describe("canvas response contracts", () => {
    const summary = {
        id: canvasId,
        workspaceId: "workspace-opaque-id",
        title: "我的画布",
        revision: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
    };

    it("keeps snapshots out of summaries and inside full responses", () => {
        expect(Value.Check(CanvasSummarySchema, summary)).toBe(true);
        expect(Value.Check(CanvasListResponseSchema, { canvases: [summary] })).toBe(true);
        expect(Value.Check(CanvasResponseSchema, { canvas: summary })).toBe(false);
        expect(Value.Check(CanvasResponseSchema, { canvas: { ...summary, snapshot: { nodes: [] } } })).toBe(true);
    });

    it("requires UUID canvas ids, opaque workspace ids and date-time timestamps", () => {
        expect(Value.Check(CanvasSummarySchema, { ...summary, id: "canvas-1" })).toBe(false);
        expect(Value.Check(CanvasSummarySchema, { ...summary, workspaceId: "" })).toBe(false);
        expect(Value.Check(CanvasSummarySchema, { ...summary, updatedAt: "2026-08-26" })).toBe(false);
    });

    it("binds canvas paths to an opaque workspace id and a UUID canvas id", () => {
        expect(Value.Check(CanvasPathSchema, { workspaceId: "workspace-opaque-id", canvasId })).toBe(true);
        expect(Value.Check(CanvasPathSchema, { workspaceId: "workspace-opaque-id", canvasId: "canvas-1" })).toBe(false);
        expect(Value.Check(CanvasPathSchema, { canvasId })).toBe(false);
    });
});

describe("canvases table", () => {
    const config = getTableConfig(canvases);
    const columns = new Map(config.columns.map((column) => [column.name, column]));

    it("stores revisioned snapshots with a nullable soft-delete marker", () => {
        expect(config.name).toBe("canvases");
        expect(columns.get("id")?.primary).toBe(true);
        expect(columns.get("snapshot_json")?.getSQLType()).toBe("jsonb");
        expect(columns.get("revision")?.getSQLType()).toBe("bigint");
        expect(columns.get("revision")?.notNull).toBe(true);
        expect(columns.get("workspace_id")?.getSQLType()).toBe("text");
        expect(columns.get("deleted_at")?.notNull).toBe(false);
    });

    it("cascades from workspaces and users and indexes recent canvases per workspace", () => {
        const references = config.foreignKeys.map((foreignKey) => {
            const reference = foreignKey.reference();
            return {
                column: reference.columns[0]?.name,
                table: getTableConfig(reference.foreignTable).name,
                onDelete: foreignKey.onDelete,
            };
        });

        expect(references).toEqual(
            expect.arrayContaining([
                { column: "workspace_id", table: "workspaces", onDelete: "cascade" },
                { column: "created_by", table: "users", onDelete: "cascade" },
                { column: "updated_by", table: "users", onDelete: "cascade" },
            ]),
        );

        const [listIndex] = config.indexes;
        expect(listIndex?.config.name).toBe("canvases_workspace_updated_at_idx");
        expect(listIndex?.config.columns.map((column) => (column as { name?: string }).name)).toEqual([
            "workspace_id",
            "updated_at",
        ]);
    });
});
