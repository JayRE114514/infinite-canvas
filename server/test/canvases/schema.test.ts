import { describe, expect, it } from "vitest";
import {
    CanvasSchema,
    CanvasListResponseSchema,
    CanvasPathSchema,
    CanvasResponseSchema,
    CanvasSnapshotSchema,
    CanvasSummarySchema,
    CreateCanvasBodySchema,
    SaveCanvasRequestSchema,
} from "@infinite-canvas/contracts";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Value } from "typebox/value";

import { canvases } from "../../src/modules/canvases/schema.js";

const canvasId = "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192";
const timestamp = "2026-08-26T10:00:00.000Z";
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;

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

    it("bounds baseRevision to the JSON safe integer range", () => {
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: MAX_SAFE_REVISION, snapshot: {} })).toBe(true);
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: MAX_SAFE_REVISION + 1, snapshot: {} })).toBe(false);
    });

    it("accepts an optional bounded title so renames stay revision-checked", () => {
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 1, title: "新标题", snapshot: {} })).toBe(true);
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 1, title: "", snapshot: {} })).toBe(false);
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 1, title: "标".repeat(201), snapshot: {} })).toBe(false);
        expect(Value.Check(SaveCanvasRequestSchema, { baseRevision: 1, title: "新标题" })).toBe(false);
    });
});

describe("canvas snapshot json contract", () => {
    it("accepts nested JSON values", () => {
        expect(
            Value.Check(CanvasSnapshotSchema, {
                nodes: [{ id: "n1", position: { x: 1, y: -2.5 }, label: "文本", locked: false, parent: null }],
                meta: { tags: ["a", "b"], counts: [1, 2, 3] },
            }),
        ).toBe(true);
        expect(Value.Check(CanvasSnapshotSchema, {})).toBe(true);
    });

    it("rejects non-JSON values at the top level and when nested", () => {
        expect(Value.Check(CanvasSnapshotSchema, { a: undefined })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, { a: 1n })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, { a: () => 1 })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, { a: Symbol("s") })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, { a: Number.NaN })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, { a: Number.POSITIVE_INFINITY })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, { nodes: [{ meta: { bad: 1n } }] })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, { nodes: [{ meta: { bad: Number.NaN } }] })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, { nodes: [[{ deep: undefined }]] })).toBe(false);
        expect(Value.Check(CanvasSnapshotSchema, [])).toBe(false);
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

    it("rejects extra properties on summaries, canvases and envelopes", () => {
        expect(Value.Check(CanvasSummarySchema, { ...summary, snapshot: { nodes: [] } })).toBe(false);
        expect(Value.Check(CanvasSchema, { ...summary, snapshot: {}, deletedAt: timestamp })).toBe(false);
        expect(Value.Check(CanvasResponseSchema, { canvas: { ...summary, snapshot: {} }, extra: 1 })).toBe(false);
        expect(Value.Check(CanvasListResponseSchema, { canvases: [summary], total: 1 })).toBe(false);
        expect(Value.Check(CanvasListResponseSchema, { canvases: [{ ...summary, snapshot: {} }] })).toBe(false);
    });

    it("bounds revisions inside responses to the JSON safe integer range", () => {
        expect(Value.Check(CanvasSummarySchema, { ...summary, revision: MAX_SAFE_REVISION })).toBe(true);
        expect(Value.Check(CanvasSummarySchema, { ...summary, revision: MAX_SAFE_REVISION + 1 })).toBe(false);
        expect(Value.Check(CanvasSummarySchema, { ...summary, revision: -1 })).toBe(false);
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
        expect(columns.get("id")?.getSQLType()).toBe("uuid");
        expect(columns.get("id")?.hasDefault).toBe(true);
        expect(columns.get("snapshot_json")?.getSQLType()).toBe("jsonb");
        expect(columns.get("revision")?.getSQLType()).toBe("bigint");
        expect(columns.get("revision")?.notNull).toBe(true);
        expect(columns.get("revision")?.default).toBe(0);
        expect(columns.get("workspace_id")?.getSQLType()).toBe("text");
        expect(columns.get("deleted_at")?.notNull).toBe(false);
    });

    it("keeps content columns required and creator columns nullable", () => {
        for (const name of ["workspace_id", "title", "snapshot_json", "created_at", "updated_at"]) {
            expect(columns.get(name)?.notNull).toBe(true);
        }
        // 账号注销时署名置空，所以这两列必须可空。
        expect(columns.get("created_by")?.notNull).toBe(false);
        expect(columns.get("updated_by")?.notNull).toBe(false);
    });

    it("defaults timestamps in the database", () => {
        expect(columns.get("created_at")?.hasDefault).toBe(true);
        expect(columns.get("updated_at")?.hasDefault).toBe(true);
        expect(columns.get("created_at")?.getSQLType()).toBe("timestamp with time zone");
        expect(columns.get("deleted_at")?.hasDefault).toBe(false);
    });

    it("bounds revision in the database", () => {
        const checks = config.checks.map((constraint) => constraint.name);
        expect(checks).toEqual(
            expect.arrayContaining(["canvases_revision_non_negative", "canvases_revision_max_safe"]),
        );
    });

    it("never deletes shared canvases through foreign keys and indexes recent canvases per workspace", () => {
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
                // 空间必须走软下线，物理删除应被拒绝而不是连带删画布。
                { column: "workspace_id", table: "workspaces", onDelete: "restrict" },
                { column: "created_by", table: "users", onDelete: "set null" },
                { column: "updated_by", table: "users", onDelete: "set null" },
            ]),
        );
        expect(references).toHaveLength(3);
        for (const reference of references) {
            expect(reference.onDelete).not.toBe("cascade");
        }

        const [listIndex] = config.indexes;
        expect(listIndex?.config.name).toBe("canvases_workspace_updated_at_idx");
        expect(listIndex?.config.unique).toBe(false);
        expect(listIndex?.config.columns.map((column) => (column as { name?: string }).name)).toEqual([
            "workspace_id",
            "updated_at",
        ]);
        // 列表按最近更新倒序取数，索引方向必须是 workspace_id 升序 + updated_at 降序。
        expect(
            listIndex?.config.columns.map(
                (column) => (column as { indexConfig?: { order?: string } }).indexConfig?.order,
            ),
        ).toEqual(["asc", "desc"]);
    });
});
