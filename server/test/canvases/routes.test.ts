import { randomUUID } from "node:crypto";

import type { Canvas, CanvasSnapshot, CanvasSummary } from "@infinite-canvas/contracts";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    createAuthTestHarness,
    registerVerifiedUser,
    type AuthApp,
    type VerifiedUser,
} from "../helpers/auth.js";

const CANVAS_BODY_LIMIT = 10 * 1024 * 1024;
const BELOW_CANVAS_BODY_LIMIT = CANVAS_BODY_LIMIT - 1024;
const harness = createAuthTestHarness();

type CanvasApp = Awaited<ReturnType<typeof openCanvasApp>>;
type StoredCanvas = {
    id: string;
    title: string;
    revision: string;
    snapshot: CanvasSnapshot;
    deleted: boolean;
    deletedAt: string | null;
    deletionReceipt: string | null;
};

async function openCanvasApp() {
    return harness.openAuthApp();
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
async function storedCanvases(adminPool: CanvasApp["adminPool"], ids: string[]): Promise<Record<string, StoredCanvas>> {
    const result = await adminPool.query(
        `select "id", "title", "revision"::text as "revision", "snapshot_json" as "snapshot",
                ("deleted_at" is not null) as "deleted", "deleted_at"::text as "deletedAt",
                "deletion_receipt_id"::text as "deletionReceipt"
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

function testObjectNames(prefix: string) {
    const suffix = randomUUID().replaceAll("-", "");
    return { functionName: `${prefix}_${suffix}`, triggerName: `a_${prefix}_${suffix}` };
}

async function installSuppressingUpdateTrigger(adminPool: CanvasApp["adminPool"], canvasId: string) {
    const names = testObjectNames("test_canvas_suppress");
    await adminPool.query(`
        create function public.${names.functionName}()
        returns trigger language plpgsql security invoker set search_path = pg_catalog, public
        as $function$
        begin
            if old.id = '${canvasId}'::uuid then return null; end if;
            return new;
        end
        $function$;
        create trigger ${names.triggerName}
        before update on public.canvases
        for each row execute function public.${names.functionName}();
    `);
    return async () => {
        await adminPool.query(`drop trigger if exists ${names.triggerName} on public.canvases`);
        await adminPool.query(`drop function if exists public.${names.functionName}()`);
    };
}

async function installFailingAfterUpdateTrigger(adminPool: CanvasApp["adminPool"], canvasId: string) {
    const names = testObjectNames("test_canvas_after_failure");
    await adminPool.query(`
        create function public.${names.functionName}()
        returns trigger language plpgsql security invoker set search_path = pg_catalog, public
        as $function$
        begin
            if new.id = '${canvasId}'::uuid then
                raise exception 'injected post-update failure' using errcode = 'P0001';
            end if;
            return new;
        end
        $function$;
        create trigger ${names.triggerName}
        after update on public.canvases
        for each row execute function public.${names.functionName}();
    `);
    return async () => {
        await adminPool.query(`drop trigger if exists ${names.triggerName} on public.canvases`);
        await adminPool.query(`drop function if exists public.${names.functionName}()`);
    };
}

async function waitForCanvasUpdateWait(
    adminPool: CanvasApp["adminPool"],
    accepts: (waitEvents: string[]) => boolean,
    description: string,
): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const result = await adminPool.query<{ wait_event: string }>(`
            select wait_event
            from pg_stat_activity
            where usename = 'app_api'
              and state = 'active'
              and wait_event_type = 'Lock'
              and (
                  ltrim(query) ~* '^update[[:space:]]+"?canvases"?'
                  or query ~* 'from[[:space:]]+"?canvases"?'
              )
            order by pid
        `);
        const waitEvents = result.rows.map((row) => row.wait_event);
        if (accepts(waitEvents)) return;
        // 轮询数据库可观察状态，不用固定延时推测请求先后。
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

async function forceCanvasUpdateOrder<TFirst, TSecond>(
    adminPool: CanvasApp["adminPool"],
    canvasId: string,
    first: () => Promise<TFirst>,
    second: () => Promise<TSecond>,
): Promise<[TFirst, TSecond]> {
    const names = testObjectNames("test_canvas_barrier");
    const advisoryKey = (Number.parseInt(randomUUID().slice(0, 8), 16) & 0x7fffffff) || 1;
    const control: PoolClient = await adminPool.connect();
    let firstRequest: Promise<TFirst> | undefined;
    let secondRequest: Promise<TSecond> | undefined;
    let released = false;
    try {
        await adminPool.query(`
            create function public.${names.functionName}()
            returns trigger language plpgsql security invoker set search_path = pg_catalog, public
            as $function$
            begin
                if old.id = '${canvasId}'::uuid then perform pg_advisory_xact_lock(${advisoryKey}); end if;
                return new;
            end
            $function$;
            create trigger ${names.triggerName}
            before update on public.canvases
            for each row execute function public.${names.functionName}();
        `);
        await control.query("select pg_advisory_lock($1)", [advisoryKey]);

        firstRequest = first();
        await waitForCanvasUpdateWait(
            adminPool,
            (events) => events.includes("advisory"),
            "the first Canvas update to block on the advisory barrier",
        );

        secondRequest = second();
        await waitForCanvasUpdateWait(
            adminPool,
            (events) => events.includes("advisory") && events.some((event) => event === "transactionid" || event === "tuple"),
            "the second Canvas request to wait on the first row lock",
        );

        await control.query("select pg_advisory_unlock($1)", [advisoryKey]);
        released = true;
        return await Promise.all([firstRequest, secondRequest]);
    } finally {
        if (!released) await control.query("select pg_advisory_unlock($1)", [advisoryKey]).catch(() => {});
        await Promise.allSettled([firstRequest, secondRequest].filter((request) => request !== undefined));
        await adminPool.query(`drop trigger if exists ${names.triggerName} on public.canvases`).catch(() => {});
        await adminPool.query(`drop function if exists public.${names.functionName}()`).catch(() => {});
        control.release();
    }
}

beforeAll(async () => {
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
        const { app, mailer, adminPool } = await openCanvasApp();
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

        const countAfterInvalidCreates = await adminPool.query('select count(*)::int as count from "canvases"');
        const created = await createCanvas(app, owner, workspace.id, { title: "有效画布", snapshot: {} });
        const invalidSave = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie, "content-type": "application/json" },
            payload: '{"baseRevision":0,"snapshot":{"line\\u2028key":undefined}}',
        });
        const stored = await adminPool.query(
            'select "revision"::text, "snapshot_json" from "canvases" where "id" = $1',
            [created.id],
        );

        expect(countAfterInvalidCreates.rows).toEqual([{ count: 0 }]);
        expect(invalidSave.statusCode).toBe(400);
        expect(invalidSave.json().error.code).toBe("invalid_request");
        expect(stored.rows).toEqual([{ revision: "0", snapshot_json: {} }]);
    }, 90_000);

    it("rejects unknown create and save fields instead of stripping them", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "unknown@example.com" });
        const workspace = await createTeam(app, owner, "严格请求团队", "strict-request-team");

        const unknownCreate = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie },
            payload: { title: "未知字段", snapshot: {}, workspaceId: workspace.id },
        });
        const countAfterCreate = await adminPool.query('select count(*)::int as count from "canvases"');
        const created = await createCanvas(app, owner, workspace.id, { title: "有效画布", snapshot: {} });
        const unknownSave = await app.inject({
            method: "PUT",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
            payload: { baseRevision: 0, snapshot: { changed: true }, force: true },
        });
        const stored = await adminPool.query(
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
        const { app, mailer, adminPool } = await openCanvasApp();
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
        await adminPool.query('update "canvases" set "revision" = $1 where "id" = $2', [
            String(Number.MAX_SAFE_INTEGER),
            created.id,
        ]);

        const atLimit = await saveCanvas(app, owner, workspace.id, created.id, {
            baseRevision: Number.MAX_SAFE_INTEGER,
            snapshot: { overwritten: true },
        });
        const deletedAtLimit = await createCanvas(app, owner, workspace.id, { title: "删除画布", snapshot: { gone: true } });
        await deleteCanvas(app, owner, workspace.id, deletedAtLimit.id);
        await adminPool.query('update "canvases" set "revision" = $1 where "id" = $2', [
            String(Number.MAX_SAFE_INTEGER),
            deletedAtLimit.id,
        ]);
        const deletedMaxBase = await saveCanvas(app, owner, workspace.id, deletedAtLimit.id, {
            baseRevision: Number.MAX_SAFE_INTEGER,
            snapshot: { overwritten: true },
        });
        const stored = await storedCanvases(adminPool, [created.id, fresh.id, deletedAtLimit.id]);

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
        const { app, mailer, adminPool } = await openCanvasApp();
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
        const unchangedAfterCrossDelete = await storedCanvases(adminPool, [created.id]);
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
        expect(crossDelete.body).not.toContain("deletionReceipt");
        expect(unchangedAfterCrossDelete[created.id]).toMatchObject({ deleted: false, deletionReceipt: null });
        expect(unchanged.statusCode).toBe(200);
        expect(unchanged.json().canvas.snapshot).toEqual({ secret: true });
        expect(firstDelete.statusCode).toBe(200);
        expect(firstDelete.json()).toEqual({
            canvasId: created.id,
            deletionReceipt: expect.any(String),
            deletedAt: expect.any(String),
        });
        expect(repeatedDelete.statusCode).toBe(200);
        // 重放返回逐字节相同的持久化回执，不产生第二次状态变更。
        expect(repeatedDelete.json()).toEqual(firstDelete.json());
        expect(unauthorizedRepeat.statusCode).toBe(403);
        expect(unauthorizedRepeat.json().error.code).toBe("workspace_forbidden");
        expect(afterDelete.statusCode).toBe(404);
        expect(listed.json()).toEqual({ canvases: [] });
    }, 90_000);

    it("denies deletion after an active member is removed without issuing a receipt", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "removed-owner@example.com" });
        const member = await registerVerifiedUser(app, mailer, { name: "成员", email: "removed-member@example.com" });
        const workspace = await createTeam(app, owner, "移除成员团队", "removed-member-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "受保护画布", snapshot: { stable: true } });
        const memberId = randomUUID();
        await adminPool.query(
            "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'member', 'active')",
            [memberId, workspace.id, member.userId],
        );

        const visibleBeforeRemoval = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: member.cookie },
        });
        const removed = await app.inject({
            method: "DELETE",
            url: `/api/v1/workspaces/${workspace.id}/members/${memberId}`,
            headers: { cookie: owner.cookie },
        });
        const denied = await deleteCanvas(app, member, workspace.id, created.id);
        const stored = await storedCanvases(adminPool, [created.id]);

        expect(visibleBeforeRemoval.statusCode).toBe(200);
        expect(removed.statusCode).toBe(200);
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.code).toBe("workspace_forbidden");
        expect(denied.body).not.toContain("deletionReceipt");
        expect(stored[created.id]).toMatchObject({ deleted: false, deletedAt: null, deletionReceipt: null });
    }, 90_000);

    it("denies deletion in suspended and deactivated workspaces without issuing a receipt", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "inactive-delete@example.com" });

        for (const status of ["suspended", "deactivated"] as const) {
            const workspace = await createTeam(app, owner, `${status} 团队`, `inactive-delete-${status}`);
            const created = await createCanvas(app, owner, workspace.id, { title: `${status} 画布`, snapshot: { stable: true } });
            if (status === "suspended") {
                await adminPool.query("update public.workspaces set status = 'suspended' where id = $1", [workspace.id]);
            } else {
                await adminPool.query(
                    "update public.workspaces set status = 'deactivated', deleted_at = now() where id = $1",
                    [workspace.id],
                );
            }

            const denied = await deleteCanvas(app, owner, workspace.id, created.id);
            const stored = await storedCanvases(adminPool, [created.id]);

            expect(denied.statusCode).toBe(409);
            expect(denied.json().error.code).toBe("workspace_inactive");
            expect(denied.body).not.toContain("deletionReceipt");
            expect(stored[created.id]).toMatchObject({ deleted: false, deletedAt: null, deletionReceipt: null });
        }
    }, 90_000);

    it("rolls back a deletion when a failure occurs after the row update", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "delete-fault@example.com" });
        const workspace = await createTeam(app, owner, "删除故障团队", "delete-fault-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "故障画布", snapshot: { stable: true } });
        const removeFault = await installFailingAfterUpdateTrigger(adminPool, created.id);

        let response;
        try {
            response = await deleteCanvas(app, owner, workspace.id, created.id);
        } finally {
            await removeFault();
        }
        const stored = await storedCanvases(adminPool, [created.id]);

        expect(response!.statusCode).toBe(500);
        expect(response!.json().error.code).toBe("internal_error");
        expect(response!.body).not.toContain("deletionReceipt");
        expect(response!.body).not.toContain("injected post-update failure");
        expect(stored[created.id]).toMatchObject({ deleted: false, deletedAt: null, deletionReceipt: null });
    }, 90_000);

    it("maps forced save and delete zero-row updates to structured non-retryable invariant failures", async () => {
        const lines: string[] = [];
        const { app, mailer, adminPool } = await harness.openAuthApp(
            {},
            {
                logger: {
                    level: "error",
                    stream: { write: (line: string) => lines.push(line) },
                },
            },
        );
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "canvas-invariant@example.com" });
        const workspace = await createTeam(app, owner, "不变量团队", "canvas-invariant-team");
        const saveTarget = await createCanvas(app, owner, workspace.id, { title: "保存不变量", snapshot: { stable: true } });
        const deleteTarget = await createCanvas(app, owner, workspace.id, { title: "删除不变量", snapshot: { stable: true } });

        const removeSaveSuppression = await installSuppressingUpdateTrigger(adminPool, saveTarget.id);
        let saveFailure;
        try {
            saveFailure = await saveCanvas(app, owner, workspace.id, saveTarget.id, {
                baseRevision: 0,
                snapshot: { shouldRollback: true },
            });
        } finally {
            await removeSaveSuppression();
        }

        const removeDeleteSuppression = await installSuppressingUpdateTrigger(adminPool, deleteTarget.id);
        let deleteFailure;
        try {
            deleteFailure = await deleteCanvas(app, owner, workspace.id, deleteTarget.id);
        } finally {
            await removeDeleteSuppression();
        }
        const stored = await storedCanvases(adminPool, [saveTarget.id, deleteTarget.id]);
        const logs = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        const saveLog = logs.find((line) => line.msg === "canvas save invariant failed");
        const deleteLog = logs.find((line) => line.msg === "canvas delete invariant failed");

        expect(saveFailure!.statusCode).toBe(500);
        expect(saveFailure!.json()).toEqual({
            error: {
                code: "canvas_save_invariant_failed",
                message: "内部错误：画布保存不变量失败",
                retryable: false,
                requestId: expect.any(String),
            },
        });
        expect(deleteFailure!.statusCode).toBe(500);
        expect(deleteFailure!.json()).toEqual({
            error: {
                code: "canvas_delete_invariant_failed",
                message: "内部错误：画布删除不变量失败",
                retryable: false,
                requestId: expect.any(String),
            },
        });
        expect(saveLog).toMatchObject({
            requestId: saveFailure!.json().error.requestId,
            canvasId: saveTarget.id,
            workspaceId: workspace.id,
            expectedRevision: 0,
            err: expect.any(Object),
        });
        expect(deleteLog).toMatchObject({
            requestId: deleteFailure!.json().error.requestId,
            canvasId: deleteTarget.id,
            workspaceId: workspace.id,
            reason: "zero_row_update",
            err: expect.any(Object),
        });
        expect(stored[saveTarget.id]).toMatchObject({ revision: "0", snapshot: { stable: true }, deleted: false });
        expect(stored[deleteTarget.id]).toMatchObject({ deleted: false, deletedAt: null, deletionReceipt: null });
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
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "missing-save@example.com" });
        const workspace = await createTeam(app, owner, "缺失保存团队", "missing-save-team");
        const other = await createTeam(app, owner, "缺失保存旁团队", "missing-save-other");
        const siblings = [
            await createCanvas(app, owner, workspace.id, { title: "同伴一", snapshot: { sibling: 1 } }),
            await createCanvas(app, owner, workspace.id, { title: "同伴二", snapshot: { sibling: 2 } }),
            await createCanvas(app, owner, other.id, { title: "旁团队画布", snapshot: { sibling: 3 } }),
        ];
        const before = await storedCanvases(adminPool, siblings.map((canvas) => canvas.id));

        const response = await saveCanvas(app, owner, workspace.id, randomUUID(), {
            baseRevision: 0,
            title: "越权标题",
            snapshot: { overwritten: true },
        });
        const after = await storedCanvases(adminPool, siblings.map((canvas) => canvas.id));

        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("canvas_not_found");
        expect(after).toEqual(before);
    }, 90_000);

    it("refuses to mutate a soft-deleted canvas through save", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "deleted-save@example.com" });
        const workspace = await createTeam(app, owner, "删除保存团队", "deleted-save-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "待删画布", snapshot: { kept: true } });
        expect((await deleteCanvas(app, owner, workspace.id, created.id)).statusCode).toBe(200);
        const before = await storedCanvases(adminPool, [created.id]);

        const response = await saveCanvas(app, owner, workspace.id, created.id, {
            baseRevision: created.revision,
            title: "删除后标题",
            snapshot: { overwritten: true },
        });
        const after = await storedCanvases(adminPool, [created.id]);

        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("canvas_not_found");
        expect(after[created.id]).toMatchObject({
            title: "待删画布",
            revision: before[created.id]!.revision,
            snapshot: { kept: true },
            deleted: true,
        });
    }, 90_000);

    it("commits exactly one of two overlapping same-base saves after observing the second row-lock wait", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "race-save@example.com" });
        const workspace = await createTeam(app, owner, "并发保存团队", "race-save-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "并发画布", snapshot: { start: true } });

        const responses = await forceCanvasUpdateOrder(
            adminPool,
            created.id,
            () => saveCanvas(app, owner, workspace.id, created.id, {
                baseRevision: 0,
                title: "写入甲",
                snapshot: { writer: "a" },
            }),
            () => saveCanvas(app, owner, workspace.id, created.id, {
                baseRevision: 0,
                title: "写入乙",
                snapshot: { writer: "b" },
            }),
        );
        const winner = responses.find((response) => response.statusCode === 200);
        const loser = responses.find((response) => response.statusCode === 409);
        const stored = await storedCanvases(adminPool, [created.id]);

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

    it("keeps overlapping deletes successful and byte-identical after observing the second row-lock wait", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "race-delete@example.com" });
        const workspace = await createTeam(app, owner, "并发删除团队", "race-delete-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "并发删除画布", snapshot: { keep: true } });

        const responses = await forceCanvasUpdateOrder(
            adminPool,
            created.id,
            () => deleteCanvas(app, owner, workspace.id, created.id),
            () => deleteCanvas(app, owner, workspace.id, created.id),
        );
        const stored = await storedCanvases(adminPool, [created.id]);
        const listed = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie },
        });

        expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
        // 并发删除都成功，且两次返回同一持久化回执。
        expect(responses[0]!.json()).toEqual(responses[1]!.json());
        expect(responses[0]!.json()).toMatchObject({
            canvasId: created.id,
            deletionReceipt: expect.any(String),
            deletedAt: expect.any(String),
        });
        expect(stored[created.id]).toMatchObject({ title: "并发删除画布", snapshot: { keep: true }, deleted: true });
        expect(listed.json()).toEqual({ canvases: [] });
    }, 90_000);

    it("linearizes save-first overlap before delete and preserves the saved revision in the tombstone", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "race-mixed@example.com" });
        const workspace = await createTeam(app, owner, "并发混合团队", "race-mixed-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "混合画布", snapshot: { start: true } });

        const [save, remove] = await forceCanvasUpdateOrder(
            adminPool,
            created.id,
            () => saveCanvas(app, owner, workspace.id, created.id, {
                baseRevision: 0,
                title: "混合新标题",
                snapshot: { writer: "save" },
            }),
            () => deleteCanvas(app, owner, workspace.id, created.id),
        );
        const stored = await storedCanvases(adminPool, [created.id]);
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

        // 已观测 save 首先持有行锁，因此结果只能是保存提交后删除，不接受调度器随机顺序。
        expect(remove.statusCode).toBe(200);
        expect(remove.json()).toMatchObject({
            canvasId: created.id,
            deletionReceipt: expect.any(String),
            deletedAt: expect.any(String),
        });
        expect(save.statusCode).toBe(200);
        expect(stored[created.id]).toMatchObject({
            title: "混合新标题",
            revision: "1",
            snapshot: { writer: "save" },
            deleted: true,
            deletionReceipt: remove.json().deletionReceipt,
        });
        expect(loaded.statusCode).toBe(404);
        expect(listed.json()).toEqual({ canvases: [] });
    }, 90_000);

    it("linearizes delete-first overlap before save and rejects resurrection", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "race-delete-first@example.com" });
        const workspace = await createTeam(app, owner, "删除优先团队", "race-delete-first-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "删除优先画布", snapshot: { start: true } });

        const [remove, save] = await forceCanvasUpdateOrder(
            adminPool,
            created.id,
            () => deleteCanvas(app, owner, workspace.id, created.id),
            () => saveCanvas(app, owner, workspace.id, created.id, {
                baseRevision: 0,
                title: "不应提交",
                snapshot: { resurrected: true },
            }),
        );
        const stored = await storedCanvases(adminPool, [created.id]);

        expect(remove.statusCode).toBe(200);
        expect(save.statusCode).toBe(404);
        expect(save.json().error.code).toBe("canvas_not_found");
        expect(stored[created.id]).toMatchObject({
            title: "删除优先画布",
            revision: "0",
            snapshot: { start: true },
            deleted: true,
            deletionReceipt: remove.json().deletionReceipt,
        });
    }, 90_000);

    it("applies the 10 MiB limit and stable error to create without changing the global limit", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
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
        const count = await adminPool.query('select count(*)::int as count from "canvases"');

        expect(belowCanvasLimit.statusCode).toBe(201);
        expect(belowCanvasLimit.json().canvas.snapshot.content).toHaveLength(BELOW_CANVAS_BODY_LIMIT);
        expect(response.statusCode).toBe(413);
        expect(response.json().error.code).toBe("canvas_snapshot_too_large");
        expect(response.body).not.toContain("FST_ERR_CTP_BODY_TOO_LARGE");
        expect(response.body).not.toContain("Request body is too large");
        expect(count.rows).toEqual([{ count: 1 }]);
    }, 90_000);

    it("applies the 10 MiB limit and stable error to save without changing the canvas", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
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
        const stored = await adminPool.query(
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
    it("returns read-only snapshot mode in create response and rejects client mode input", async () => {
        const { app, mailer } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "doc-mode@example.com" });
        const workspace = await createTeam(app, owner, "模式团队", "doc-mode-team");

        const created = await createCanvas(app, owner, workspace.id, { title: "快照画布", snapshot: {} });
        const withMode = await app.inject({
            method: "POST",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie },
            payload: { title: "强制模式", snapshot: {}, documentMode: "collaborative" },
        });

        expect(created.documentMode).toBe("snapshot");
        expect(withMode.statusCode).toBe(400);
        expect(withMode.json().error.code).toBe("invalid_request");
    }, 90_000);

    it("returns a durable deletion receipt instead of generic success", async () => {
        const { app, mailer } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "receipt@example.com" });
        const workspace = await createTeam(app, owner, "回执团队", "receipt-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "待删画布", snapshot: {} });

        const response = await deleteCanvas(app, owner, workspace.id, created.id);

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            canvasId: created.id,
            deletionReceipt: expect.any(String),
            deletedAt: expect.any(String),
        });
    }, 90_000);

    it("checks visibility, then mode, then revision under one row lock", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "lock-order@example.com" });
        const workspace = await createTeam(app, owner, "锁序团队", "lock-order-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "锁序画布", snapshot: { start: true } });

        // 编排型夹具走隔离容器管理员（超级用户绕过 RLS），行为断言仍走 app_api。
        const flipped = await adminPool.query(
            `update "canvases" set "document_mode" = 'collaborative' where "id" = $1`,
            [created.id],
        );
        expect(flipped.rowCount).toBe(1);

        // 模式不匹配先于 revision 冲突：即使 base 明显过期也必须返回模式错误。
        const modeMismatch = await saveCanvas(app, owner, workspace.id, created.id, {
            baseRevision: 999,
            snapshot: { overwritten: true },
        });

        const softDeleted = await adminPool.query(
            `update "canvases" set "deleted_at" = now(), "deletion_receipt_id" = gen_random_uuid() where "id" = $1`,
            [created.id],
        );
        expect(softDeleted.rowCount).toBe(1);

        // 不可见性先于模式检查：已删除行一律 404。
        const afterDelete = await saveCanvas(app, owner, workspace.id, created.id, {
            baseRevision: 999,
            snapshot: { overwritten: true },
        });
        const stored = await storedCanvases(adminPool, [created.id]);

        expect(modeMismatch.statusCode).toBe(409);
        expect(modeMismatch.json().error.code).toBe("canvas_document_mode_mismatch");
        expect(afterDelete.statusCode).toBe(404);
        expect(afterDelete.json().error.code).toBe("canvas_not_found");
        expect(stored[created.id]).toMatchObject({ revision: "0", snapshot: { start: true } });
    }, 90_000);

    it("replays the persisted receipt without a second state change and never leaks it elsewhere", async () => {
        const { app, mailer, adminPool } = await openCanvasApp();
        const owner = await registerVerifiedUser(app, mailer, { name: "所有者", email: "replay@example.com" });
        const outsider = await registerVerifiedUser(app, mailer, { name: "外部用户", email: "replay-out@example.com" });
        const workspace = await createTeam(app, owner, "重放团队", "replay-team");
        const created = await createCanvas(app, owner, workspace.id, { title: "重放画布", snapshot: {} });

        const first = await deleteCanvas(app, owner, workspace.id, created.id);
        const storedAfterFirst = await adminPool.query(
            'select "deletion_receipt_id"::text as receipt, "deleted_at"::text as deleted_at from "canvases" where "id" = $1',
            [created.id],
        );
        const replay = await deleteCanvas(app, owner, workspace.id, created.id);
        const storedAfterReplay = await adminPool.query(
            'select "deletion_receipt_id"::text as receipt, "deleted_at"::text as deleted_at from "canvases" where "id" = $1',
            [created.id],
        );

        // 重放逐字节返回同一持久化回执，且底层状态没有第二次变更。
        expect(first.statusCode).toBe(200);
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual(first.json());
        expect(first.json().deletionReceipt).toBe(storedAfterFirst.rows[0]!.receipt);
        expect(storedAfterReplay.rows).toEqual(storedAfterFirst.rows);

        // 未授权与不可见路径都不得产生回执。
        const unauthorized = await deleteCanvas(app, outsider, workspace.id, created.id);
        const missing = await deleteCanvas(app, owner, workspace.id, randomUUID());
        const normalGet = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases/${created.id}`,
            headers: { cookie: owner.cookie },
        });
        const listed = await app.inject({
            method: "GET",
            url: `/api/v1/workspaces/${workspace.id}/canvases`,
            headers: { cookie: owner.cookie },
        });

        expect(unauthorized.statusCode).toBe(403);
        expect(unauthorized.body).not.toContain(first.json().deletionReceipt);
        expect(missing.statusCode).toBe(404);
        expect(missing.body).not.toContain("deletionReceipt");
        expect(normalGet.statusCode).toBe(404);
        expect(normalGet.body).not.toContain("deletionReceipt");
        expect(normalGet.body).not.toContain(first.json().deletionReceipt);
        expect(listed.json()).toEqual({ canvases: [] });
    }, 90_000);
});
