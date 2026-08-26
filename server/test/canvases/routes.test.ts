import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Canvas, CanvasSnapshot } from "@infinite-canvas/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    createAuthTestHarness,
    registerVerifiedUser,
    type AuthApp,
    type VerifiedUser,
} from "../helpers/auth.js";

const CANVAS_MIGRATION_URL = new URL("../../migrations/0001_canvases.sql", import.meta.url);
const CANVAS_BODY_LIMIT = 10 * 1024 * 1024;
const BELOW_CANVAS_BODY_LIMIT = CANVAS_BODY_LIMIT - 1024;
const harness = createAuthTestHarness();
let canvasMigrationSql = "";

async function openCanvasApp() {
    const opened = await harness.openAuthApp();
    await opened.database.pool.query(canvasMigrationSql);
    return opened;
}

async function createTeam(app: AuthApp, owner: VerifiedUser, name: string, slug: string) {
    const response = await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: { cookie: owner.cookie },
        payload: { name, slug },
    });

    expect(response.statusCode).toBe(201);
    return response.json().workspace as { id: string };
}

async function createCanvas(
    app: AuthApp,
    user: VerifiedUser,
    workspaceId: string,
    input: { title: string; snapshot?: CanvasSnapshot },
): Promise<Canvas> {
    const response = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/canvases`,
        headers: { cookie: user.cookie },
        payload: input,
    });

    expect(response.statusCode).toBe(201);
    return response.json().canvas as Canvas;
}

function lineSeparatorSnapshot(label: string): CanvasSnapshot {
    return {
        keys: Object.fromEntries([
            [`${label}\nlf`, { separator: "LF" }],
            [`${label}\rcr`, { separator: "CR" }],
            [`${label}\u2028ls`, { separator: "U+2028" }],
            [`${label}\u2029ps`, { separator: "U+2029" }],
        ]),
        nested: [{ "line\nfeed": [1, null, true] }],
    };
}

function oversizedCreateBody(): string {
    return JSON.stringify({ title: "超大画布", snapshot: { content: "x".repeat(CANVAS_BODY_LIMIT) } });
}

function oversizedSaveBody(baseRevision: number): string {
    return JSON.stringify({ baseRevision, snapshot: { content: "x".repeat(CANVAS_BODY_LIMIT) } });
}

beforeAll(async () => {
    canvasMigrationSql = await readFile(CANVAS_MIGRATION_URL, "utf8");
    await harness.start();
}, 180_000);

afterEach(async () => {
    await harness.cleanup();
}, 30_000);

afterAll(async () => {
    await harness.stop();
}, 60_000);

describe("canvas routes", () => {
    it("creates an omitted snapshot as an empty object and lists summaries without snapshots", async () => {
        const { app, mailer } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "owner@example.com" });
        const workspace = await createTeam(app, owner, "画布团队", "canvas-team");

        const created = await createCanvas(app, owner, workspace.id, { title: "空白画布" });
        const listed = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie },
        });
        const loaded = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });

        expect(created).toMatchObject({ workspaceId: workspace.id, title: "空白画布", snapshot: {}, revision: 0 });
        expect(listed.statusCode).toBe(200);
        expect(Object.keys(listed.json())).toEqual(["canvases"]);
        expect(listed.json().canvases).toHaveLength(1);
        expect(listed.json().canvases[0]).toMatchObject({ id: created.id, title: "空白画布", revision: 0 });
        expect(listed.json().canvases[0]).not.toHaveProperty("snapshot");
        expect(loaded.statusCode).toBe(200);
        expect(Object.keys(loaded.json())).toEqual(["canvas"]);
        expect(loaded.json().canvas).toEqual(created);
    }, 90_000);

    it("atomically saves title and snapshot once and rejects a stale base revision", async () => {
        const { app, mailer } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "save@example.com" });
        const workspace = await createTeam(app, owner, "保存团队", "save-team");
        const created = await createCanvas(app, owner, workspace.id, {
            title: "初始标题",
            snapshot: { nodes: [] },
        });

        const saved = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
            payload: { baseRevision: 0, title: "新标题", snapshot: { nodes: [{ id: "n1" }] } },
        });
        const stale = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
            payload: { baseRevision: 0, title: "过期标题", snapshot: { nodes: [{ id: "stale" }] } },
        });
        const loaded = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });

        expect(saved.statusCode).toBe(200);
        expect(saved.json().canvas).toMatchObject({
            id: created.id,
            title: "新标题",
            snapshot: { nodes: [{ id: "n1" }] },
            revision: 1,
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json().error.code).toBe("revision_conflict");
        expect(loaded.json().canvas).toMatchObject({
            title: "新标题",
            snapshot: { nodes: [{ id: "n1" }] },
            revision: 1,
        });
    }, 90_000);

    it("round-trips LF, CR, U+2028 and U+2029 keys through create and save JSON bodies", async () => {
        const { app, mailer } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "keys@example.com" });
        const workspace = await createTeam(app, owner, "键名团队", "json-key-team");
        const createSnapshot = lineSeparatorSnapshot("create");
        const saveSnapshot = lineSeparatorSnapshot("save");

        const created = await createCanvas(app, owner, workspace.id, { title: "特殊键", snapshot: createSnapshot });
        const saved = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
            payload: { baseRevision: 0, snapshot: saveSnapshot },
        });
        const loaded = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });

        expect(created.snapshot).toEqual(createSnapshot);
        expect(saved.statusCode).toBe(200);
        expect(saved.json().canvas.snapshot).toEqual(saveSnapshot);
        expect(loaded.json().canvas.snapshot).toEqual(saveSnapshot);
    }, 90_000);

    it("rejects bigint-like, undefined-like and other non-JSON wire values", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "invalid-json@example.com" });
        const workspace = await createTeam(app, owner, "非法 JSON 团队", "invalid-json-team");

        for (const invalidValue of ["1n", "undefined", "NaN", "Infinity", "1e1000"]) {
            const response = await app.inject({
                method: "POST",
                url: `/api/v1/workspaces/${workspace.id}/canvases`,
                headers: { cookie: owner.cookie, "content-type": "application/json" },
                payload: `{"title":"非法值","snapshot":{"line\\nkey":${invalidValue}}}`,
            });

            expect(response.statusCode).toBe(400);
            expect(response.json().error.code).toBe("invalid_request");
        }

        const countAfterInvalidCreates = await database.pool.query('select count(*)::int as count from "canvases"');
        const created = await createCanvas(app, owner, workspace.id, { title: "有效画布", snapshot: {} });
        const invalidSave = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie, "content-type": "application/json" },
            payload: '{"baseRevision":0,"snapshot":{"line\\u2028key":undefined}}',
        });
        const stored = await database.pool.query(
            'select "revision"::text, "snapshot_json" from "canvases" where "id" = $1',
            [created.id],
        );

        expect(countAfterInvalidCreates.rows).toEqual([{ count: 0 }]);
        expect(invalidSave.statusCode).toBe(400);
        expect(invalidSave.json().error.code).toBe("invalid_request");
        expect(stored.rows).toEqual([{ revision: "0", snapshot_json: {} }]);
    }, 90_000);

    it("rejects unknown create and save fields instead of stripping them", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "unknown@example.com" });
        const workspace = await createTeam(app, owner, "严格请求团队", "strict-request-team");

        const unknownCreate = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie },
            payload: { title: "未知字段", snapshot: {}, workspaceId: workspace.id },
        });
        const countAfterCreate = await database.pool.query('select count(*)::int as count from "canvases"');
        const created = await createCanvas(app, owner, workspace.id, { title: "有效画布", snapshot: {} });
        const unknownSave = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
            payload: { baseRevision: 0, snapshot: { changed: true }, force: true },
        });
        const stored = await database.pool.query(
            'select "revision"::text, "snapshot_json" from "canvases" where "id" = $1',
            [created.id],
        );

        expect(unknownCreate.statusCode).toBe(400);
        expect(unknownCreate.json().error.code).toBe("invalid_request");
        expect(countAfterCreate.rows).toEqual([{ count: 0 }]);
        expect(unknownSave.statusCode).toBe(400);
        expect(unknownSave.json().error.code).toBe("invalid_request");
        expect(stored.rows).toEqual([{ revision: "0", snapshot_json: {} }]);
    }, 90_000);

    it("rejects a max-safe base revision deterministically without overflowing", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "max-revision@example.com" });
        const workspace = await createTeam(app, owner, "版本团队", "revision-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "上限画布", snapshot: { stable: true } });
        await database.pool.query('update "canvases" set "revision" = $1 where "id" = $2', [
            String(Number.MAX_SAFE_INTEGER),
            created.id,
        ]);

        const response = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
            payload: { baseRevision: Number.MAX_SAFE_INTEGER, snapshot: { overwritten: true } },
        });
        const stored = await database.pool.query(
            'select "revision"::text, "snapshot_json" from "canvases" where "id" = $1',
            [created.id],
        );

        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe("canvas_revision_limit_reached");
        expect(stored.rows).toEqual([
            { revision: String(Number.MAX_SAFE_INTEGER), snapshot_json: { stable: true } },
        ]);
    }, 90_000);

    it("isolates path workspaces and makes soft delete repeat-idempotent only after membership authorization", async () => {
        const { app, mailer } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "isolation@example.com" });
        const outsider = await registerVerifiedUser(app, mailer, { name: "外部用户", email: "outsider@example.com" });
        const first = await createTeam(app, owner, "第一团队", "first-canvas-team");
        const second = await createTeam(app, owner, "第二团队", "second-canvas-team");
        const created = await createCanvas(app, owner, first.id, { title: "私有画布", snapshot: { secret: true } });
        const missingId = randomUUID();

        const crossGet = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${second.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });
        const missingGet = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${second.id}/canvases/${missingId}`,
            headers: { cookie: owner.cookie },
        });
        const crossSave = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${second.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
            payload: { baseRevision: 0, snapshot: { leaked: true } },
        });
        const crossDelete = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${second.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });
        const unchanged = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${first.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });
        const firstDelete = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${first.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });
        const repeatedDelete = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${first.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });
        const unauthorizedRepeat = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${first.id}/canvases/${created.id}`,
            headers: { cookie: outsider.cookie },
        });
        const afterDelete = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${first.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });
        const listed = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${first.id}/canvases`,
            headers: { cookie: owner.cookie },
        });

        expect(crossGet.statusCode).toBe(404);
        expect(missingGet.statusCode).toBe(404);
        expect(crossGet.json().error.code).toBe(missingGet.json().error.code);
        expect(crossSave.statusCode).toBe(404);
        expect(crossSave.json().error.code).toBe("canvas_not_found");
        expect(crossDelete.statusCode).toBe(404);
        expect(crossDelete.json().error.code).toBe("canvas_not_found");
        expect(unchanged.statusCode).toBe(200);
        expect(unchanged.json().canvas.snapshot).toEqual({ secret: true });
        expect(firstDelete.statusCode).toBe(200);
        expect(firstDelete.json()).toEqual({ success: true });
        expect(repeatedDelete.statusCode).toBe(200);
        expect(repeatedDelete.json()).toEqual({ success: true });
        expect(unauthorizedRepeat.statusCode).toBe(403);
        expect(unauthorizedRepeat.json().error.code).toBe("workspace_forbidden");
        expect(afterDelete.statusCode).toBe(404);
        expect(listed.json()).toEqual({ canvases: [] });
    }, 90_000);

    it("applies the 10 MiB limit and stable error to create without changing the global limit", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "large-create@example.com" });
        const workspace = await createTeam(app, owner, "大创建团队", "large-create-team");

        const belowCanvasLimit = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie, "content-type": "application/json" },
            payload: JSON.stringify({
                title: "超过全局限制",
                snapshot: { content: "x".repeat(BELOW_CANVAS_BODY_LIMIT) },
            }),
        });
        const response = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie, "content-type": "application/json" },
            payload: oversizedCreateBody(),
        });
        const count = await database.pool.query('select count(*)::int as count from "canvases"');

        expect(belowCanvasLimit.statusCode).toBe(201);
        expect(belowCanvasLimit.json().canvas.snapshot.content).toHaveLength(BELOW_CANVAS_BODY_LIMIT);
        expect(response.statusCode).toBe(413);
        expect(response.json().error.code).toBe("canvas_snapshot_too_large");
        expect(response.body).not.toContain("FST_ERR_CTP_BODY_TOO_LARGE");
        expect(response.body).not.toContain("Request body is too large");
        expect(count.rows).toEqual([{ count: 1 }]);
    }, 90_000);

    it("applies the 10 MiB limit and stable error to save without changing the canvas", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "large-save@example.com" });
        const workspace = await createTeam(app, owner, "大保存团队", "large-save-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "未修改", snapshot: { stable: true } });

        const belowCanvasLimit = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie, "content-type": "application/json" },
            payload: JSON.stringify({
                baseRevision: 0,
                snapshot: { content: "x".repeat(BELOW_CANVAS_BODY_LIMIT) },
            }),
        });
        const response = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie, "content-type": "application/json" },
            payload: oversizedSaveBody(1),
        });
        const stored = await database.pool.query(
            `select "revision"::text, length("snapshot_json"->>'content')::int as "content_length"
             from "canvases" where "id" = $1`,
            [created.id],
        );

        expect(belowCanvasLimit.statusCode).toBe(200);
        expect(belowCanvasLimit.json().canvas).toMatchObject({ revision: 1 });
        expect(belowCanvasLimit.json().canvas.snapshot.content).toHaveLength(BELOW_CANVAS_BODY_LIMIT);
        expect(response.statusCode).toBe(413);
        expect(response.json().error.code).toBe("canvas_snapshot_too_large");
        expect(response.body).not.toContain("FST_ERR_CTP_BODY_TOO_LARGE");
        expect(response.body).not.toContain("Request body is too large");
        expect(stored.rows).toEqual([{ revision: "1", content_length: BELOW_CANVAS_BODY_LIMIT }]);
    }, 90_000);
});
