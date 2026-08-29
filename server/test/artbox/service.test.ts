import { randomUUID } from "node:crypto";

import type { CreateArtBoxVideoGenerationBody } from "@infinite-canvas/contracts";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../src/infrastructure/database/client.js";
import { withTenantTransaction } from "../../src/infrastructure/database/transactions.js";
import type { AppDatabase, DatabaseHandle } from "../../src/infrastructure/database/types.js";
import type { ObjectStorage, StoredObject } from "../../src/infrastructure/object-storage/types.js";
import type { ArtBoxAdapter } from "../../src/modules/artbox/adapter.js";
import { artboxVideoGenerations } from "../../src/modules/artbox/schema.js";
import {
    createArtBoxVideoGeneration,
    downloadArtBoxResult,
    pollArtBoxVideoGeneration,
    type ArtBoxServiceDependencies,
} from "../../src/modules/artbox/service.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

const downloadConfig = {
    requestTimeoutMs: 250,
    resultMaxBytes: 8,
    resultAllowedHosts: ["results.artbox.test"],
};

function videoResponse(bytes: number[], headers: Record<string, string> = {}): Response {
    return new Response(Uint8Array.from(bytes), {
        status: 200,
        headers: { "content-type": "video/mp4", ...headers },
    });
}

describe("ArtBox result ingestion boundary", () => {
    it("fetches an allowlisted credential-free HTTPS result with redirects disabled", async () => {
        const fetchImpl = vi.fn(async () => videoResponse([1, 2, 3]));

        await expect(
            downloadArtBoxResult("https://results.artbox.test/video.mp4?transport=ephemeral", downloadConfig, fetchImpl),
        ).resolves.toEqual({ bytes: Uint8Array.from([1, 2, 3]), contentType: "video/mp4" });
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://results.artbox.test/video.mp4?transport=ephemeral",
            expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }),
        );
    });

    it.each([
        "http://results.artbox.test/video.mp4",
        "https://user:pass@results.artbox.test/video.mp4",
        "https://results.artbox.test:8443/video.mp4",
        "not-a-url",
    ])("rejects unsafe result URL %s before fetch", async (url) => {
        const fetchImpl = vi.fn(async () => videoResponse([1]));
        await expect(downloadArtBoxResult(url, downloadConfig, fetchImpl)).rejects.toMatchObject({
            code: "provider_result_rejected",
            retryable: false,
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("reports a safe but unconfigured result host as retryable without fetching or leaking it", async () => {
        const fetchImpl = vi.fn(async () => videoResponse([1]));
        const error = await downloadArtBoxResult(
            "https://unconfigured-secret-host.test/video.mp4?token=secret",
            downloadConfig,
            fetchImpl,
        ).catch((caught: unknown) => caught);

        expect(error).toMatchObject({
            code: "provider_result_host_unconfigured",
            statusCode: 503,
            retryable: true,
        });
        expect(JSON.stringify(error)).not.toMatch(/unconfigured-secret-host|token=secret/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("rejects declared and streamed bodies over the configured maximum", async () => {
        await expect(
            downloadArtBoxResult(
                "https://results.artbox.test/declared.mp4",
                downloadConfig,
                async () => videoResponse([1], { "content-length": "9" }),
            ),
        ).rejects.toMatchObject({ code: "provider_result_too_large" });

        await expect(
            downloadArtBoxResult(
                "https://results.artbox.test/streamed.mp4",
                downloadConfig,
                async () => videoResponse([1, 2, 3, 4, 5, 6, 7, 8, 9]),
            ),
        ).rejects.toMatchObject({ code: "provider_result_too_large" });
    });

    it("rejects redirects, non-video content, and upstream failures without leaking the URL", async () => {
        for (const response of [
            new Response(null, { status: 302, headers: { location: "https://secret.test/signed" } }),
            new Response("not video", { status: 200, headers: { "content-type": "text/plain" } }),
            new Response("raw secret", { status: 503 }),
        ]) {
            const error = await downloadArtBoxResult(
                "https://results.artbox.test/video.mp4?token=secret",
                downloadConfig,
                async () => response,
            ).catch((caught: unknown) => caught);
            expect(error).toMatchObject({ retryable: expect.any(Boolean) });
            expect(JSON.stringify(error)).not.toContain("token=secret");
            expect(JSON.stringify(error)).not.toContain("raw secret");
        }
    });
});

class FakeStorage implements ObjectStorage {
    readonly readUrls: string[] = [];
    readonly results: { key: string; ownerId: string; contentType: string; bytes: Uint8Array }[] = [];
    beforeNetwork: () => Promise<void> = async () => {};

    async createUpload(): Promise<never> {
        throw new Error("not used");
    }
    async completeUpload(): Promise<never> {
        throw new Error("not used");
    }
    async createReadUrl(input: { key: string }): Promise<string> {
        await this.beforeNetwork();
        const url = `https://media.test/${encodeURIComponent(input.key)}?transport=ephemeral`;
        this.readUrls.push(url);
        return url;
    }
    async putResult(input: { key: string; ownerId: string; contentType: string; bytes: Uint8Array }): Promise<StoredObject> {
        await this.beforeNetwork();
        this.results.push(input);
        return { key: input.key, contentType: input.contentType, byteSize: input.bytes.byteLength, etag: "result-etag" };
    }
}

class DeferredCreateOnceStorage extends FakeStorage {
    readonly createdKeys = new Set<string>();
    private readonly objects = new Map<string, StoredObject>();
    private firstCreatedResolve: () => void = () => {};
    private releaseFirstResolve: () => void = () => {};
    readonly firstCreated = new Promise<void>((resolve) => (this.firstCreatedResolve = resolve));
    private readonly firstRelease = new Promise<void>((resolve) => (this.releaseFirstResolve = resolve));

    override async putResult(input: {
        key: string;
        ownerId: string;
        contentType: string;
        bytes: Uint8Array;
    }): Promise<StoredObject> {
        this.results.push(input);
        let stored = this.objects.get(input.key);
        if (!stored) {
            stored = { key: input.key, contentType: input.contentType, byteSize: input.bytes.byteLength, etag: "result-etag" };
            this.objects.set(input.key, stored);
            this.createdKeys.add(input.key);
        }
        if (this.results.length === 1) {
            this.firstCreatedResolve();
            await this.firstRelease;
        }
        return stored;
    }

    releaseFirst() {
        this.releaseFirstResolve();
    }
}

describe("ArtBox service input boundary", () => {
    it.each([
        [
            "same-kind",
            [
                { nodeId: "duplicate", kind: "image" as const, assetId: "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192" },
                { nodeId: "duplicate", kind: "image" as const, assetId: "7f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708193" },
            ],
        ],
        [
            "different-kind",
            [
                { nodeId: "duplicate", kind: "image" as const, assetId: "6f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708192" },
                { nodeId: "duplicate", kind: "audio" as const, assetId: "7f1d3f3c-1f2a-4c6f-9a3b-4d5e6f708193" },
            ],
        ],
    ] as const)("rejects %s duplicate node ids before hashing, transaction, storage, or Provider calls", async (_label, bindings) => {
        const transaction = vi.fn(() => {
            throw new Error("database must not be touched");
        });
        const storage = new FakeStorage();
        const adapter: ArtBoxAdapter = { create: vi.fn(), poll: vi.fn() };

        await expect(
            createArtBoxVideoGeneration(
                { transaction } as unknown as AppDatabase,
                { userId: "user-1", workspaceId: "workspace-1" },
                {
                    model: "Artdance 2 Mini-480p",
                    promptTemplate: "参考 @[node:duplicate]",
                    bindings: [...bindings],
                    seconds: "5",
                    generateAudio: true,
                },
                "duplicate-key",
                {
                    adapter,
                    storage,
                    signedUrlTtlSeconds: 300,
                    requestTimeoutMs: 250,
                    resultMaxBytes: 8,
                    resultAllowedHosts: ["results.artbox.test"],
                    pollLeaseSeconds: 20,
                },
            ),
        ).rejects.toMatchObject({ code: "duplicate_media_binding", statusCode: 422, retryable: false });
        expect(transaction).not.toHaveBeenCalled();
        expect(adapter.create).not.toHaveBeenCalled();
        expect(storage.readUrls).toEqual([]);
    });
});

describe("ArtBox Workspace lifecycle", () => {
    let postgres: StartedRoleDatabase | undefined;
    let admin: Pool;
    let database: DatabaseHandle;
    let userId: string;
    let workspaceId: string;
    let otherWorkspaceId: string;
    let readyImageId: string;
    let stagingImageId: string;
    let otherReadyVideoId: string;

    const body = (): CreateArtBoxVideoGenerationBody => ({
        model: "Artdance 2 Mini-480p",
        promptTemplate: "参考 @[node:image-1]",
        bindings: [{ nodeId: "image-1", kind: "image", assetId: readyImageId }],
        seconds: "5",
        generateAudio: true,
    });

    function dependencies(adapter: ArtBoxAdapter, storage = new FakeStorage(), fetchImpl: typeof fetch = fetch) {
        return {
            adapter,
            storage,
            signedUrlTtlSeconds: 300,
            requestTimeoutMs: 250,
            resultMaxBytes: 8,
            resultAllowedHosts: ["results.artbox.test"],
            pollLeaseSeconds: 20,
            fetchImpl,
        } satisfies ArtBoxServiceDependencies;
    }

    beforeAll(async () => {
        postgres = await startRoleDatabase();
    }, 180_000);

    beforeEach(async () => {
        if (!postgres) throw new Error("PostgreSQL container is not started");
        await database?.pool.end().catch(() => {});
        await admin?.end().catch(() => {});
        admin = new Pool({ connectionString: postgres.admin, max: 4 });
        await admin.query("drop schema if exists drizzle cascade");
        await admin.query("drop schema if exists public cascade; create schema public");
        await admin.query("alter schema public owner to schema_owner");
        await admin.query("revoke create on schema public from public");
        await admin.query("grant create, usage on schema public to schema_owner");
        await runMigrations(postgres.schemaOwner);
        database = createDatabase({ url: postgres.api, poolMax: 4, expectedRole: "app_api" });

        userId = randomUUID();
        workspaceId = randomUUID();
        otherWorkspaceId = randomUUID();
        readyImageId = randomUUID();
        stagingImageId = randomUUID();
        otherReadyVideoId = randomUUID();
        await admin.query('insert into public.users (id, name, email, "emailVerified") values ($1, $2, $3, true)', [
            userId,
            "artbox owner",
            `artbox-${userId}@example.com`,
        ]);
        for (const id of [workspaceId, otherWorkspaceId]) {
            await admin.query(
                "insert into public.workspaces (id, name, slug, type, owner_user_id, status) values ($1, 'ArtBox', $2, 'team', $3, 'active')",
                [id, `artbox-${id}`, userId],
            );
            await admin.query(
                "insert into public.workspace_members (id, workspace_id, user_id, role, status) values ($1, $2, $3, 'owner', 'active')",
                [randomUUID(), id, userId],
            );
        }
        await admin.query(
            `insert into public.assets
                (id, workspace_id, kind, status, file_name, content_type, byte_size, final_object_key, created_by)
             values ($1, $2, 'image', 'ready', 'reference.png', 'image/png', 3, $3, $4)`,
            [readyImageId, workspaceId, `assets/final/${readyImageId}`, userId],
        );
        await admin.query(
            `insert into public.assets
                (id, workspace_id, kind, status, file_name, content_type, staging_object_key, final_object_key, created_by)
             values ($1, $2, 'image', 'staging', 'staging.png', 'image/png', $3, $4, $5)`,
            [stagingImageId, workspaceId, `assets/staging/${stagingImageId}`, `assets/final/${stagingImageId}`, userId],
        );
        await admin.query(
            `insert into public.assets
                (id, workspace_id, kind, status, file_name, content_type, byte_size, final_object_key, created_by)
             values ($1, $2, 'video', 'ready', 'other.mp4', 'video/mp4', 3, $3, $4)`,
            [otherReadyVideoId, otherWorkspaceId, `assets/final/${otherReadyVideoId}`, userId],
        );
    }, 120_000);

    afterAll(async () => {
        await database?.pool.end().catch(() => {});
        await admin?.end().catch(() => {});
        await postgres?.stop().catch(() => {});
    }, 60_000);

    it("replays the same canonical request without a second Provider POST and rejects conflicting hashes", async () => {
        const storage = new FakeStorage();
        const create = vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-task-1" }) as const);
        storage.beforeNetwork = async () => {
            const active = await admin.query<{ count: number }>(`
                select count(*)::int as count from pg_stat_activity
                where usename = 'app_api' and state <> 'idle' and xact_start is not null
            `);
            expect(active.rows[0]?.count).toBe(0);
        };
        const adapter: ArtBoxAdapter = { create, poll: vi.fn() };
        const deps = dependencies(adapter, storage);

        const first = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "same-key",
            deps,
        );
        const replay = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "same-key",
            deps,
        );
        expect(replay).toEqual(first);
        expect(first).toMatchObject({ workspaceId, status: "queued", resultAssetId: null, error: null });
        expect(JSON.stringify(first)).not.toContain("remote-task-1");
        expect(create).toHaveBeenCalledTimes(1);
        expect(storage.readUrls).toHaveLength(1);

        await expect(
            createArtBoxVideoGeneration(
                database.db,
                { userId, workspaceId },
                { ...body(), seconds: "10" },
                "same-key",
                deps,
            ),
        ).rejects.toMatchObject({ code: "idempotency_conflict", statusCode: 409 });

        const stored = await admin.query(
            "select remote_task_id, normalized_input::text from artbox_video_generations where id = $1",
            [first.id],
        );
        expect(stored.rows[0]?.remote_task_id).toBe("remote-task-1");
        expect(stored.rows[0]?.normalized_input).not.toMatch(/https?:|storageKey|object_key|remote-task-1/);
    }, 90_000);

    it("durably finalizes an accepted Provider task after Workspace authorization is revoked", async () => {
        let accepted!: () => void;
        let release!: () => void;
        const providerAccepted = new Promise<void>((resolve) => (accepted = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => {
                accepted();
                await gate;
                return { kind: "submitted", remoteTaskId: "remote-after-revocation" } as const;
            }),
            poll: vi.fn(async () => ({ kind: "queued" }) as const),
        };
        const deps = dependencies(adapter);

        const creating = createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "revoked-after-acceptance",
            deps,
        );
        await providerAccepted;
        await admin.query("update public.workspaces set status = 'suspended', updated_at = now() where id = $1", [workspaceId]);
        release();

        await expect(creating).resolves.toMatchObject({ status: "queued", error: null });
        const stored = await admin.query(
            "select status, remote_task_id from public.artbox_video_generations where idempotency_key = $1",
            ["revoked-after-acceptance"],
        );
        expect(stored.rows).toEqual([{ status: "queued", remote_task_id: "remote-after-revocation" }]);

        await admin.query("update public.workspaces set status = 'active', updated_at = now() where id = $1", [workspaceId]);
        const replay = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "revoked-after-acceptance",
            deps,
        );
        expect(replay.status).toBe("queued");
        expect(adapter.create).toHaveBeenCalledTimes(1);

        await expect(
            pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, replay.id, deps),
        ).resolves.toMatchObject({ status: "queued" });
        expect(adapter.poll).toHaveBeenCalledTimes(1);
        expect(adapter.poll).toHaveBeenCalledWith("remote-after-revocation");
    }, 90_000);

    it("hides cross-tenant assets and distinguishes kind and readiness failures", async () => {
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "never" }) as const),
            poll: vi.fn(),
        };
        const deps = dependencies(adapter);

        await expect(
            createArtBoxVideoGeneration(database.db, { userId, workspaceId: otherWorkspaceId }, body(), "cross", deps),
        ).rejects.toMatchObject({ code: "asset_not_found", statusCode: 404 });
        await expect(
            createArtBoxVideoGeneration(
                database.db,
                { userId, workspaceId },
                { ...body(), bindings: [{ ...body().bindings[0]!, kind: "video" }] },
                "kind",
                deps,
            ),
        ).rejects.toMatchObject({ code: "asset_kind_mismatch", statusCode: 422 });
        await expect(
            createArtBoxVideoGeneration(
                database.db,
                { userId, workspaceId },
                { ...body(), bindings: [{ ...body().bindings[0]!, assetId: stagingImageId }] },
                "staging",
                deps,
            ),
        ).rejects.toMatchObject({ code: "asset_not_ready", statusCode: 409 });
        expect(adapter.create).not.toHaveBeenCalled();
    }, 90_000);

    it("persists ambiguous creates without resubmission and imports a successful result before success", async () => {
        const uncertainAdapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({
                kind: "reconciling",
                error: { code: "provider_submission_uncertain", message: "uncertain", retryable: false },
            }) as const),
            poll: vi.fn(),
        };
        const uncertainDeps = dependencies(uncertainAdapter);
        const uncertain = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "uncertain-key",
            uncertainDeps,
        );
        const uncertainReplay = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "uncertain-key",
            uncertainDeps,
        );
        expect(uncertain.status).toBe("reconciling");
        expect(uncertainReplay).toEqual(uncertain);
        expect(uncertainAdapter.create).toHaveBeenCalledTimes(1);

        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-success" }) as const),
            poll: vi.fn(
                async () =>
                    ({ kind: "succeeded", resultUrl: "https://results.artbox.test/video.mp4?token=secret" }) as const,
            ),
        };
        const storage = new FakeStorage();
        const deps = dependencies(adapter, storage, async () => videoResponse([1, 2, 3]));
        const queued = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "success-key",
            deps,
        );
        const succeeded = await pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);
        const replay = await pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);

        expect(succeeded).toMatchObject({ id: queued.id, status: "succeeded", resultAssetId: expect.any(String) });
        expect(replay).toEqual(succeeded);
        expect(adapter.poll).toHaveBeenCalledTimes(1);
        expect(storage.results).toHaveLength(1);
        const stored = await admin.query(
            `select g.status, g.result_asset_id, g.normalized_input::text,
                    a.status as asset_status, a.kind as asset_kind, a.byte_size
             from artbox_video_generations g join assets a on a.id = g.result_asset_id where g.id = $1`,
            [queued.id],
        );
        expect(stored.rows[0]).toMatchObject({
            status: "succeeded",
            result_asset_id: succeeded.resultAssetId,
            asset_status: "ready",
            asset_kind: "video",
            byte_size: "3",
        });
        expect(JSON.stringify(stored.rows[0])).not.toContain("token=secret");
    }, 90_000);

    it("keeps a completed task recoverable until its safe result host is configured", async () => {
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-new-result-host" }) as const),
            poll: vi.fn(
                async () =>
                    ({
                        kind: "succeeded",
                        resultUrl: "https://new-results.artbox.test/video.mp4?token=secret",
                    }) as const,
            ),
        };
        const storage = new FakeStorage();
        const blockedFetch = vi.fn(async () => videoResponse([1, 2, 3]));
        const deps = dependencies(adapter, storage, blockedFetch);
        const queued = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "new-result-host-key",
            deps,
        );

        const blocked = await pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);
        expect(blocked).toMatchObject({
            status: "queued",
            resultAssetId: null,
            error: { code: "provider_result_host_unconfigured", retryable: true },
        });
        expect(blockedFetch).not.toHaveBeenCalled();
        expect(storage.results).toEqual([]);

        const allowedFetch = vi.fn(async () => videoResponse([1, 2, 3]));
        const recovered = await pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, {
            ...deps,
            resultAllowedHosts: ["new-results.artbox.test"],
            fetchImpl: allowedFetch,
        });
        expect(recovered).toMatchObject({ status: "succeeded", resultAssetId: expect.any(String), error: null });
        expect(allowedFetch).toHaveBeenCalledTimes(1);
        expect(storage.results).toHaveLength(1);
        expect(adapter.create).toHaveBeenCalledTimes(1);
        expect(adapter.poll).toHaveBeenCalledTimes(2);
    }, 90_000);

    it("marks pre-submit COS signing failure retryable without reusing the idempotency key", async () => {
        const storage = new FakeStorage();
        storage.beforeNetwork = async () => {
            throw new Error("raw COS signing secret");
        };
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-after-signing-recovery" }) as const),
            poll: vi.fn(),
        };
        const deps = dependencies(adapter, storage);

        const failed = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "signing-failure-key",
            deps,
        );
        expect(failed).toMatchObject({
            status: "failed",
            error: { code: "asset_transport_error", retryable: true },
        });
        expect(JSON.stringify(failed)).not.toContain("raw COS signing secret");
        expect(adapter.create).not.toHaveBeenCalled();

        storage.beforeNetwork = async () => {};
        const sameKeyReplay = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "signing-failure-key",
            deps,
        );
        expect(sameKeyReplay).toEqual(failed);
        expect(storage.readUrls).toEqual([]);
        expect(adapter.create).not.toHaveBeenCalled();

        const newKeyRetry = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "signing-retry-key",
            deps,
        );
        expect(newKeyRetry).toMatchObject({ status: "queued", error: null });
        expect(storage.readUrls).toHaveLength(1);
        expect(adapter.create).toHaveBeenCalledTimes(1);
    }, 90_000);

    it("leases concurrent polls so only one Provider request runs", async () => {
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-concurrent" }) as const),
            poll: vi.fn(async () => {
                entered();
                await gate;
                return { kind: "queued" } as const;
            }),
        };
        const deps = dependencies(adapter);
        const queued = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "concurrent-key",
            deps,
        );

        const first = pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);
        await started;
        const second = await pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);
        expect(second.status).toBe("queued");
        expect(adapter.poll).toHaveBeenCalledTimes(1);
        release();
        await expect(first).resolves.toMatchObject({ status: "queued" });
    }, 90_000);

    it("reuses one generation-scoped result when the first poll lease expires during COS persistence", async () => {
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-expired-result-lease" }) as const),
            poll: vi.fn(async () => ({ kind: "succeeded", resultUrl: "https://results.artbox.test/video.mp4" }) as const),
        };
        const storage = new DeferredCreateOnceStorage();
        let downloadCount = 0;
        const deps = dependencies(adapter, storage, async () => {
            downloadCount += 1;
            return downloadCount === 1
                ? videoResponse([1, 2, 3, 4], { "content-type": "video/webm" })
                : videoResponse([9, 9, 9]);
        });
        const queued = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "expired-result-lease-key",
            deps,
        );

        const stalePoll = pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);
        await storage.firstCreated;
        await admin.query(
            `update public.artbox_video_generations
             set poll_lease_until = now() - interval '1 second', updated_at = now()
             where id = $1`,
            [queued.id],
        );

        let winner: Awaited<ReturnType<typeof pollArtBoxVideoGeneration>>;
        try {
            winner = await pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);
        } finally {
            storage.releaseFirst();
        }
        const stale = await stalePoll;
        const expectedKey = `assets/final/${queued.id}/artbox-result`;

        expect(winner).toMatchObject({ status: "succeeded", resultAssetId: queued.id });
        expect(stale).toEqual(winner);
        expect(adapter.poll).toHaveBeenCalledTimes(2);
        expect(storage.results.map((result) => result.key)).toEqual([expectedKey, expectedKey]);
        expect(storage.results.map((result) => result.ownerId)).toEqual([queued.id, queued.id]);
        expect(storage.results.map((result) => [result.contentType, result.bytes.byteLength])).toEqual([
            ["video/webm", 4],
            ["video/mp4", 3],
        ]);
        expect(storage.createdKeys).toEqual(new Set([expectedKey]));
        const stored = await admin.query(
            `select g.status, g.result_asset_id, a.id as asset_id, a.status as asset_status,
                    a.final_object_key, a.content_type, a.byte_size, a.file_name,
                    count(*) over ()::int as asset_count
             from public.artbox_video_generations g
             join public.assets a on a.id = g.result_asset_id
             where g.id = $1`,
            [queued.id],
        );
        expect(stored.rows).toEqual([
            {
                status: "succeeded",
                result_asset_id: queued.id,
                asset_id: queued.id,
                asset_status: "ready",
                final_object_key: expectedKey,
                content_type: "video/webm",
                byte_size: "4",
                file_name: `artbox-${queued.id}.webm`,
                asset_count: 1,
            },
        ]);
    }, 90_000);

    it("uses the PostgreSQL clock so a skewed application clock cannot steal an active lease", async () => {
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        let pollCalls = 0;
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-db-clock" }) as const),
            poll: vi.fn(async () => {
                pollCalls += 1;
                if (pollCalls === 1) {
                    entered();
                    await gate;
                }
                return { kind: "queued" } as const;
            }),
        };
        const deps = dependencies(adapter);
        const queued = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "database-clock-key",
            deps,
        );

        const first = pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);
        await started;
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
        try {
            await expect(
                pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps),
            ).resolves.toMatchObject({ status: "queued" });
            expect(adapter.poll).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
            release();
        }
        await expect(first).resolves.toMatchObject({ status: "queued" });
    }, 90_000);

    it("prevents a stale lease epoch from persisting an older Provider outcome", async () => {
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-stale-epoch" }) as const),
            poll: vi.fn(async () => {
                entered();
                await gate;
                return { kind: "queued" } as const;
            }),
        };
        const deps = dependencies(adapter);
        const queued = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "stale-epoch-key",
            deps,
        );

        const polling = pollArtBoxVideoGeneration(database.db, { userId, workspaceId }, queued.id, deps);
        await started;
        await admin.query(
            `update public.artbox_video_generations
             set poll_lease_epoch = poll_lease_epoch + 1, poll_lease_until = null, status = 'processing', updated_at = now()
             where id = $1`,
            [queued.id],
        );
        release();

        await expect(polling).resolves.toMatchObject({ status: "processing" });
        const stored = await admin.query(
            "select status, poll_lease_epoch::int as poll_lease_epoch from public.artbox_video_generations where id = $1",
            [queued.id],
        );
        expect(stored.rows).toEqual([{ status: "processing", poll_lease_epoch: 2 }]);
    }, 90_000);

    it("hides cross-Workspace generations from app_api reads and updates", async () => {
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-hidden" }) as const),
            poll: vi.fn(async () => ({ kind: "queued" }) as const),
        };
        const deps = dependencies(adapter);
        const queued = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "hidden-generation-key",
            deps,
        );

        await expect(
            pollArtBoxVideoGeneration(database.db, { userId, workspaceId: otherWorkspaceId }, queued.id, deps),
        ).rejects.toMatchObject({ code: "artbox_generation_not_found", statusCode: 404 });
        const updated = await withTenantTransaction(
            database.db,
            { userId, workspaceId: otherWorkspaceId },
            (tx) =>
                tx
                    .update(artboxVideoGenerations)
                    .set({ status: "failed", publicError: { code: "forbidden", message: "forbidden", retryable: false } })
                    .where(eq(artboxVideoGenerations.id, queued.id))
                    .returning(),
        );
        expect(updated).toEqual([]);
        expect(adapter.poll).not.toHaveBeenCalled();
    }, 90_000);

    it("rejects illegal remote-id, lease, terminal-state, and result-Asset mutations through app_api", async () => {
        const adapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({ kind: "submitted", remoteTaskId: "remote-immutable" }) as const),
            poll: vi.fn(),
        };
        const deps = dependencies(adapter);
        const queued = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "illegal-mutation-key",
            deps,
        );
        const mutate = (values: Parameters<ReturnType<AppDatabase["update"]>["set"]>[0]) =>
            withTenantTransaction(database.db, { userId, workspaceId }, (tx) =>
                tx.update(artboxVideoGenerations).set(values).where(eq(artboxVideoGenerations.id, queued.id)),
            );

        await expect(mutate({ remoteTaskId: "changed-remote" })).rejects.toSatisfy(
            (error: unknown) => postgresCode(error) === "23514",
        );
        await expect(
            mutate({ pollLeaseEpoch: sql`${artboxVideoGenerations.pollLeaseEpoch} + 2` }),
        ).rejects.toSatisfy((error: unknown) => postgresCode(error) === "23514");
        await expect(mutate({ status: "succeeded", resultAssetId: readyImageId })).rejects.toSatisfy(
            (error: unknown) => postgresCode(error) === "23514",
        );
        await expect(mutate({ status: "succeeded", resultAssetId: otherReadyVideoId })).rejects.toSatisfy(
            (error: unknown) => postgresCode(error) === "23514",
        );

        const uncertainAdapter: ArtBoxAdapter = {
            create: vi.fn(async () => ({
                kind: "reconciling",
                error: { code: "provider_submission_uncertain", message: "uncertain", retryable: false },
            }) as const),
            poll: vi.fn(),
        };
        const terminal = await createArtBoxVideoGeneration(
            database.db,
            { userId, workspaceId },
            body(),
            "terminal-mutation-key",
            dependencies(uncertainAdapter),
        );
        await expect(
            withTenantTransaction(database.db, { userId, workspaceId }, (tx) =>
                tx
                    .update(artboxVideoGenerations)
                    .set({ status: "processing", remoteTaskId: "late-remote" })
                    .where(eq(artboxVideoGenerations.id, terminal.id)),
            ),
        ).rejects.toSatisfy((error: unknown) => postgresCode(error) === "23514");
    }, 90_000);
});

function postgresCode(error: unknown): string | undefined {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const candidate = current as Record<string, unknown>;
        if (typeof candidate.code === "string") return candidate.code;
        current = candidate.cause;
    }
    return undefined;
}
