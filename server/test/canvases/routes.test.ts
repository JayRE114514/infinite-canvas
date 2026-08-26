import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Canvas, CanvasSnapshot, CanvasSummary } from "@infinite-canvas/contracts";
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

type CanvasApp = Awaited<ReturnType<typeof openCanvasApp>>;
type StoredCanvas = { id: string; title: string; revision: string; snapshot: CanvasSnapshot; deleted: boolean };

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

function saveCanvas(
    app: AuthApp,
    user: VerifiedUser,
    workspaceId: string,
    canvasId: string,
    payload: { baseRevision: number; title?: string; snapshot: CanvasSnapshot },
) {
    return app.inject({
        method: "PUT",
        url: `/api/v1/workspaces/${workspaceId}/canvases/${canvasId}`,
        headers: { cookie: user.cookie },
        payload,
    });
}

function deleteCanvas(app: AuthApp, user: VerifiedUser, workspaceId: string, canvasId: string) {
    return app.inject({
        method: "DELETE",
        url: `/api/v1/workspaces/${workspaceId}/canvases/${canvasId}`,
        headers: { cookie: user.cookie },
    });
}

/** 直接读库断言存储态，覆盖标题、快照、revision 与软删除标记是否被越权或并发请求改写。 */
async function storedCanvases(database: CanvasApp["database"], ids: string[]): Promise<Record<string, StoredCanvas>> {
    const result = await database.pool.query(
        `select "id", "title", "revision"::text as "revision", "snapshot_json" as "snapshot",
                ("deleted_at" is not null) as "deleted"
         from "canvases" where "id" = any($1::uuid[])`,
        [ids],
    );
    return Object.fromEntries((result.rows as StoredCanvas[]).map((row) => [row.id, row]));
}

function listedIds(body: { canvases: CanvasSummary[] }): string[] {
    return body.canvases.map((canvas) => canvas.id).sort();
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

    it("separates a max-safe limit from a stale max-safe base and never overflows", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "max-revision@example.com" });
        const workspace = await createTeam(app, owner, "版本团队", "revision-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "上限画布", snapshot: { stable: true } });
        const fresh = await createCanvas(app, owner, workspace.id, { title: "新画布", snapshot: { fresh: true } });
        const missingId = randomUUID();

        // revision 仍是 0 的活跃画布收到上限 base，属于过期写入而不是触达上限。
        const staleMaxBase = await saveCanvas(app, owner, workspace.id, fresh.id, {
            baseRevision: Number.MAX_SAFE_INTEGER,
            title: "过期上限标题",
            snapshot: { overwritten: true },
        });
        const missingMaxBase = await saveCanvas(app, owner, workspace.id, missingId, {
            baseRevision: Number.MAX_SAFE_INTEGER,
            snapshot: { overwritten: true },
        });
        await database.pool.query('update "canvases" set "revision" = $1 where "id" = $2', [
            String(Number.MAX_SAFE_INTEGER),
            created.id,
        ]);

        const atLimit = await saveCanvas(app, owner, workspace.id, created.id, {
            baseRevision: Number.MAX_SAFE_INTEGER,
            snapshot: { overwritten: true },
        });
        const deletedAtLimit = await createCanvas(app, owner, workspace.id, { title: "删除画布", snapshot: { gone: true } });
        await deleteCanvas(app, owner, workspace.id, deletedAtLimit.id);
        await database.pool.query('update "canvases" set "revision" = $1 where "id" = $2', [
            String(Number.MAX_SAFE_INTEGER),
            deletedAtLimit.id,
        ]);
        const deletedMaxBase = await saveCanvas(app, owner, workspace.id, deletedAtLimit.id, {
            baseRevision: Number.MAX_SAFE_INTEGER,
            snapshot: { overwritten: true },
        });
        const stored = await storedCanvases(database, [created.id, fresh.id, deletedAtLimit.id]);

        expect(staleMaxBase.statusCode).toBe(409);
        expect(staleMaxBase.json().error.code).toBe("revision_conflict");
        expect(missingMaxBase.statusCode).toBe(404);
        expect(missingMaxBase.json().error.code).toBe("canvas_not_found");
        expect(atLimit.statusCode).toBe(409);
        expect(atLimit.json().error.code).toBe("canvas_revision_limit_reached");
        expect(deletedMaxBase.statusCode).toBe(404);
        expect(deletedMaxBase.json().error.code).toBe("canvas_not_found");
        expect(stored[created.id]).toMatchObject({
            title: "上限画布",
            revision: String(Number.MAX_SAFE_INTEGER),
            snapshot: { stable: true },
            deleted: false,
        });
        expect(stored[fresh.id]).toMatchObject({
            title: "新画布",
            revision: "0",
            snapshot: { fresh: true },
            deleted: false,
        });
        expect(stored[deletedAtLimit.id]).toMatchObject({
            title: "删除画布",
            snapshot: { gone: true },
            deleted: true,
        });
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

    it("lists only each workspace's own canvases without snapshots", async () => {
        const { app, mailer } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "list-scope@example.com" });
        const first = await createTeam(app, owner, "列表团队甲", "list-scope-first");
        const second = await createTeam(app, owner, "列表团队乙", "list-scope-second");
        const firstCanvases = [
            await createCanvas(app, owner, first.id, { title: "甲一", snapshot: { owner: "first-1" } }),
            await createCanvas(app, owner, first.id, { title: "甲二", snapshot: { owner: "first-2" } }),
        ];
        const secondCanvases = [
            await createCanvas(app, owner, second.id, { title: "乙一", snapshot: { owner: "second-1" } }),
        ];

        const firstList = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${first.id}/canvases`,
            headers: { cookie: owner.cookie },
        });
        const secondList = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${second.id}/canvases`,
            headers: { cookie: owner.cookie },
        });

        expect(firstList.statusCode).toBe(200);
        expect(secondList.statusCode).toBe(200);
        expect(listedIds(firstList.json())).toEqual(firstCanvases.map((canvas) => canvas.id).sort());
        expect(listedIds(secondList.json())).toEqual(secondCanvases.map((canvas) => canvas.id).sort());
        for (const summary of [...firstList.json().canvases, ...secondList.json().canvases]) {
            expect(summary).not.toHaveProperty("snapshot");
        }
        expect(firstList.json().canvases.map((summary: CanvasSummary) => summary.workspaceId)).toEqual([
            first.id,
            first.id,
        ]);
        expect(secondList.json().canvases.map((summary: CanvasSummary) => summary.workspaceId)).toEqual([second.id]);
    }, 90_000);

    it("leaves sibling canvases untouched when saving a missing canvas id", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "missing-save@example.com" });
        const workspace = await createTeam(app, owner, "缺失保存团队", "missing-save-team");
        const other = await createTeam(app, owner, "缺失保存旁团队", "missing-save-other");
        const siblings = [
            await createCanvas(app, owner, workspace.id, { title: "同伴一", snapshot: { sibling: 1 } }),
            await createCanvas(app, owner, workspace.id, { title: "同伴二", snapshot: { sibling: 2 } }),
            await createCanvas(app, owner, other.id, { title: "旁团队画布", snapshot: { sibling: 3 } }),
        ];
        const before = await storedCanvases(database, siblings.map((canvas) => canvas.id));

        const response = await saveCanvas(app, owner, workspace.id, randomUUID(), {
            baseRevision: 0,
            title: "越权标题",
            snapshot: { overwritten: true },
        });
        const after = await storedCanvases(database, siblings.map((canvas) => canvas.id));

        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("canvas_not_found");
        expect(after).toEqual(before);
    }, 90_000);

    it("refuses to mutate a soft-deleted canvas through save", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "deleted-save@example.com" });
        const workspace = await createTeam(app, owner, "删除保存团队", "deleted-save-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "待删画布", snapshot: { kept: true } });
        expect((await deleteCanvas(app, owner, workspace.id, created.id)).statusCode).toBe(200);
        const before = await storedCanvases(database, [created.id]);

        const response = await saveCanvas(app, owner, workspace.id, created.id, {
            baseRevision: created.revision,
            title: "删除后标题",
            snapshot: { overwritten: true },
        });
        const after = await storedCanvases(database, [created.id]);

        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("canvas_not_found");
        expect(after[created.id]).toMatchObject({
            title: "待删画布",
            revision: before[created.id]!.revision,
            snapshot: { kept: true },
            deleted: true,
        });
    }, 90_000);

    it("commits exactly one of two concurrent same-base saves", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "race-save@example.com" });
        const workspace = await createTeam(app, owner, "并发保存团队", "race-save-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "并发画布", snapshot: { start: true } });

        const responses = await Promise.all([
            saveCanvas(app, owner, workspace.id, created.id, {
                baseRevision: 0,
                title: "写入甲",
                snapshot: { writer: "a" },
            }),
            saveCanvas(app, owner, workspace.id, created.id, {
                baseRevision: 0,
                title: "写入乙",
                snapshot: { writer: "b" },
            }),
        ]);
        const winner = responses.find((response) => response.statusCode === 200);
        const loser = responses.find((response) => response.statusCode === 409);
        const stored = await storedCanvases(database, [created.id]);

        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        expect(loser!.json().error.code).toBe("revision_conflict");
        expect(winner!.json().canvas).toMatchObject({ revision: 1 });
        // 最终行必须完整等于胜者返回的标题与快照，不允许出现两次写入的混合结果。
        expect(stored[created.id]).toMatchObject({
            title: winner!.json().canvas.title,
            revision: "1",
            snapshot: winner!.json().canvas.snapshot,
            deleted: false,
        });
    }, 90_000);

    it("keeps concurrent deletes successful and idempotent", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "race-delete@example.com" });
        const workspace = await createTeam(app, owner, "并发删除团队", "race-delete-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "并发删除画布", snapshot: { keep: true } });

        const responses = await Promise.all([
            deleteCanvas(app, owner, workspace.id, created.id),
            deleteCanvas(app, owner, workspace.id, created.id),
        ]);
        const stored = await storedCanvases(database, [created.id]);
        const listed = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie },
        });

        expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
        expect(responses.map((response) => response.json())).toEqual([{ success: true }, { success: true }]);
        expect(stored[created.id]).toMatchObject({ title: "并发删除画布", snapshot: { keep: true }, deleted: true });
        expect(listed.json()).toEqual({ canvases: [] });
    }, 90_000);

    it("linearizes a concurrent save and delete without resurrecting the canvas", async () => {
        const { app, mailer, database } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "race-mixed@example.com" });
        const workspace = await createTeam(app, owner, "并发混合团队", "race-mixed-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "混合画布", snapshot: { start: true } });

        const [save, remove] = await Promise.all([
            saveCanvas(app, owner, workspace.id, created.id, {
                baseRevision: 0,
                title: "混合新标题",
                snapshot: { writer: "save" },
            }),
            deleteCanvas(app, owner, workspace.id, created.id),
        ]);
        const stored = await storedCanvases(database, [created.id]);
        const loaded = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });
        const listed = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie },
        });

        // 删除总是成功；保存要么先于删除提交（revision 1 + 新标题快照），要么整体失败（保持初始值）。
        expect(remove.statusCode).toBe(200);
        expect(remove.json()).toEqual({ success: true });
        expect([200, 404]).toContain(save.statusCode);
        if (save.statusCode === 200) {
            expect(stored[created.id]).toMatchObject({
                title: "混合新标题",
                revision: "1",
                snapshot: { writer: "save" },
            });
        } else {
            expect(save.json().error.code).toBe("canvas_not_found");
            expect(stored[created.id]).toMatchObject({
                title: "混合画布",
                revision: "0",
                snapshot: { start: true },
            });
        }
        // 无论哪种线性化顺序，删除态都不可被保存复活。
        expect(stored[created.id]!.deleted).toBe(true);
        expect(loaded.statusCode).toBe(404);
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
