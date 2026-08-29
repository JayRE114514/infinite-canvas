import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { createDatabase } from "../../src/infrastructure/database/client.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { createFixedImagePriceSnapshot } from "../../src/modules/billing/service.js";
import { TaskEventNotifier } from "../../src/modules/ai-tasks/events.js";
import type { AiTaskQueue } from "../../src/modules/ai-tasks/queue.js";
import { AiTaskModule } from "../../src/modules/ai-tasks/service.js";
import { MemoryMailer, registerVerifiedUser, type AuthApp, type VerifiedUser } from "../helpers/auth.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

let postgres: StartedRoleDatabase | undefined;
let database: DatabaseHandle | undefined;
let admin: Pool | undefined;
let notifier: TaskEventNotifier | undefined;
let app: AuthApp | undefined;
let baseUrl: string;
let user: VerifiedUser;
let workspaceId: string;
/** 由测试包装 subscribe 统计，用来观察客户端断开后订阅是否真的释放。 */
let activeSubscriptions = 0;

const descriptor = {
    adapterId: "openai-images",
    adapterVersion: "1",
    capabilityId: "image.generate" as const,
    exactModelId: "owner-image-model",
    supportsPolling: false,
    supportsCancellation: false,
};
const snapshot = createFixedImagePriceSnapshot({
    capabilityId: descriptor.capabilityId,
    routeId: "openai-images",
    exactModelId: descriptor.exactModelId,
    priceVersion: "fixed-v1",
    estimatedAmount: 25n,
    fixedAmount: 25n,
});

/** 事件流只读已持久化事件；一旦有人尝试入队就说明用例走错了路径。 */
const queue: AiTaskQueue = {
    async enqueue() {
        throw new Error("SSE regression test must not enqueue AI Task Jobs");
    },
};

type SseFrame = {
    id: string;
    event: string;
    data: { sequence: string; type: string; payload: Record<string, string>; createdAt: string };
};

type OpenStream = {
    response: Response;
    frames: SseFrame[];
    isClosed: () => boolean;
    close: () => Promise<void>;
};

function parseFrame(raw: string): SseFrame {
    const fields = new Map<string, string>();
    for (const line of raw.split("\n")) {
        const separator = line.indexOf(": ");
        if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 2));
    }
    const id = fields.get("id");
    const event = fields.get("event");
    const data = fields.get("data");
    if (id === undefined || event === undefined || data === undefined) {
        throw new Error(`SSE 帧缺少 id/event/data：${JSON.stringify(raw)}`);
    }
    return { id, event, data: JSON.parse(data) as SseFrame["data"] };
}

/** 用真实 HTTP 长连接读取 SSE，帧在后台泵中累积，断言只看已到达的帧和连接状态。 */
async function openEventStream(taskId: string, lastEventId?: string): Promise<OpenStream> {
    const controller = new AbortController();
    const headers: Record<string, string> = { cookie: user.cookie };
    if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
    const response = await fetch(
        `${baseUrl}/api/v1/ai/tasks/${taskId}/events?workspaceId=${encodeURIComponent(workspaceId)}`,
        { headers, signal: controller.signal },
    );

    const frames: SseFrame[] = [];
    let closed = false;
    const body = response.body;
    if (!body) throw new Error("SSE 响应没有可读流");
    const pump = (async () => {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                buffer += decoder.decode(chunk.value, { stream: true });
                let boundary = buffer.indexOf("\n\n");
                while (boundary >= 0) {
                    frames.push(parseFrame(buffer.slice(0, boundary)));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf("\n\n");
                }
            }
        } catch {
            // 客户端主动取消是预期的结束方式。
        } finally {
            closed = true;
        }
    })();

    return {
        response,
        frames,
        isClosed: () => closed,
        close: async () => {
            controller.abort();
            await pump;
        },
    };
}

async function waitFor(condition: () => boolean, describeState: () => string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`等待超时：${describeState()}`);
        await delay(20);
    }
}

async function appendEvent(taskId: string, event: { sequence: number; type: string; payload: Record<string, string> }) {
    await admin!.query(
        "insert into public.task_events (workspace_id, task_id, sequence, type, payload) values ($1, $2, $3, $4, $5::jsonb)",
        [workspaceId, taskId, event.sequence, event.type, JSON.stringify(event.payload)],
    );
}

/** 直接播种 Task、账单与事件，不触发 Worker、Provider 或队列。 */
async function seedTask(events: { sequence: number; type: string; payload: Record<string, string> }[]): Promise<string> {
    const taskId = randomUUID();
    await admin!.query(
        `insert into public.ai_tasks
            (id, workspace_id, created_by, capability_id, adapter_id, adapter_version, exact_model_id, input, idempotency_key, request_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
        [
            taskId,
            workspaceId,
            user.userId,
            descriptor.capabilityId,
            descriptor.adapterId,
            descriptor.adapterVersion,
            descriptor.exactModelId,
            JSON.stringify({ prompt: "画一只猫" }),
            `sse-${taskId}`,
            "a".repeat(64),
        ],
    );
    await admin!.query(
        `insert into public.billing_orders
            (workspace_id, task_id, capability_id, price_version, price_snapshot, estimated_amount, created_at, review_after)
         values ($1, $2, $3, $4, $5::jsonb, $6, now(), now() + interval '24 hours')`,
        [
            workspaceId,
            taskId,
            descriptor.capabilityId,
            snapshot.priceVersion,
            JSON.stringify({
                capabilityId: snapshot.capabilityId,
                routeId: snapshot.routeId,
                exactModelId: snapshot.exactModelId,
                priceVersion: snapshot.priceVersion,
                rule: { kind: "fixed_per_image", amount: snapshot.fixedAmount.toString() },
            }),
            snapshot.estimatedAmount.toString(),
        ],
    );
    for (const event of events) await appendEvent(taskId, event);
    return taskId;
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
    database = createDatabase({ url: postgres.api, poolMax: 4, expectedRole: "app_api" });
    admin = new Pool({ connectionString: postgres.admin, max: 2 });

    notifier = new TaskEventNotifier(postgres.api);
    await notifier.start();
    // 只在测试侧包装实例方法计数，LISTEN/NOTIFY 仍走真实实现。
    const subscribe = notifier.subscribe.bind(notifier);
    notifier.subscribe = (taskId: string, subscriber: () => void) => {
        activeSubscriptions += 1;
        const unsubscribe = subscribe(taskId, subscriber);
        return () => {
            activeSubscriptions -= 1;
            unsubscribe();
        };
    };

    const mailer = new MemoryMailer();
    app = await buildApp({
        logger: false,
        database,
        mailer,
        aiTaskModule: new AiTaskModule(database.db, queue, descriptor, snapshot),
        taskEventNotifier: notifier,
        config: loadConfig({
            NODE_ENV: "test",
            DATABASE_URL_API: postgres.api,
            BETTER_AUTH_SECRET: "t".repeat(32),
            APP_ORIGIN: "http://localhost:3000",
            SMTP_HOST: "localhost",
            SMTP_FROM: "no-reply@example.com",
        }),
    });
    // SSE 必须走真实 HTTP 长连接，inject 无法表达连接保持与取消。
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

    user = await registerVerifiedUser(app, mailer, {
        name: "AI task event reader",
        email: `ai-task-sse-${randomUUID()}@example.com`,
    });
    const workspace = await app.inject({ method: "GET", url: "/api/v1/workspaces", headers: { cookie: user.cookie } });
    workspaceId = workspace.json().workspaces[0].id as string;
}, 180_000);

afterAll(async () => {
    await app?.close().catch(() => {});
    await notifier?.close().catch(() => {});
    if (database && !database.pool.ending && !database.pool.ended) await database.pool.end().catch(() => {});
    await admin?.end().catch(() => {});
    await postgres?.stop().catch(() => {});
}, 60_000);

describe("AI Task event stream", () => {
    it("streams persisted events, keeps the connection open, and delivers new events over NOTIFY", async () => {
        const taskId = await seedTask([
            { sequence: 1, type: "queued", payload: {} },
            { sequence: 2, type: "submitting", payload: { attempt: "1" } },
        ]);

        const stream = await openEventStream(taskId);
        try {
            expect(stream.response.status).toBe(200);
            expect(stream.response.headers.get("content-type")).toContain("text/event-stream");

            await waitFor(
                () => stream.frames.length >= 2,
                () => `已持久事件未形成完整帧，已收到 ${stream.frames.length} 帧，连接已结束=${stream.isClosed()}`,
            );
            expect(stream.frames.map((frame) => [frame.id, frame.event])).toEqual([
                ["1", "queued"],
                ["2", "submitting"],
            ]);
            expect(stream.frames[1]!.data).toMatchObject({ sequence: "2", type: "submitting", payload: { attempt: "1" } });
            for (const frame of stream.frames) {
                expect(new Date(frame.data.createdAt).toISOString()).toBe(frame.data.createdAt);
            }

            // 初始帧写完后连接必须保持打开，EventSource 才不会反复重连。
            await delay(500);
            expect(stream.isClosed()).toBe(false);
            expect(stream.frames).toHaveLength(2);
            expect(activeSubscriptions).toBe(1);

            await appendEvent(taskId, { sequence: 3, type: "succeeded", payload: { note: "done" } });
            await waitFor(
                () => stream.frames.length >= 3,
                () => `NOTIFY 事件未写入同一连接，已收到 ${stream.frames.length} 帧，连接已结束=${stream.isClosed()}`,
            );
            const latest = stream.frames[2]!;
            expect([latest.id, latest.event]).toEqual(["3", "succeeded"]);
            expect(latest.data).toMatchObject({ sequence: "3", type: "succeeded", payload: { note: "done" } });
            expect(new Date(latest.data.createdAt).toISOString()).toBe(latest.data.createdAt);
        } finally {
            await stream.close();
        }

        await waitFor(
            () => activeSubscriptions === 0,
            () => `客户端取消后订阅未释放，仍有 ${activeSubscriptions} 个`,
        );
    }, 60_000);

    it("replays only sequences greater than Last-Event-ID", async () => {
        const taskId = await seedTask([
            { sequence: 1, type: "queued", payload: {} },
            { sequence: 2, type: "submitting", payload: {} },
            { sequence: 3, type: "succeeded", payload: { note: "done" } },
        ]);

        const stream = await openEventStream(taskId, "2");
        try {
            expect(stream.response.status).toBe(200);
            await waitFor(
                () => stream.frames.length >= 1,
                () => `Last-Event-ID 重放未产生帧，连接已结束=${stream.isClosed()}`,
            );
            await delay(500);
            expect(stream.frames.map((frame) => frame.id)).toEqual(["3"]);
            expect(stream.isClosed()).toBe(false);
        } finally {
            await stream.close();
        }

        await waitFor(
            () => activeSubscriptions === 0,
            () => `客户端取消后订阅未释放，仍有 ${activeSubscriptions} 个`,
        );
    }, 60_000);
});
