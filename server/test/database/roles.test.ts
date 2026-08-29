import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { createDatabase } from "../../src/infrastructure/database/client.js";
import { checkDatabaseReady } from "../../src/infrastructure/database/plugin.js";
import { inspectDatabaseRole } from "../../src/infrastructure/database/role-assertions.js";
import type { DatabaseHandle } from "../../src/infrastructure/database/types.js";
import { runMigrations } from "../helpers/database.js";
import { startRoleDatabase, type StartedRoleDatabase } from "../helpers/postgres.js";

const REQUIRED_LOGIN_ROLES = ["app_api", "app_maintenance", "app_worker", "schema_owner"];
const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_PATH = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));

let postgres: StartedRoleDatabase | undefined;
const openPools: Pool[] = [];
const openHandles: DatabaseHandle[] = [];
const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];

function postgresUrl(): string {
    if (!postgres) throw new Error("PostgreSQL container is not started");
    return postgres.admin;
}

function roles(): StartedRoleDatabase {
    if (!postgres) throw new Error("PostgreSQL container is not started");
    return postgres;
}

/** 先登记再返回，保证断言失败时 afterEach 仍能释放连接池。 */
function openPool(connectionString: string, max = 1): Pool {
    const pool = new Pool({ connectionString, max });
    openPools.push(pool);
    return pool;
}

/** 同样先登记再返回，避免断言失败时连接池泄漏。 */
function openHandle(handle: DatabaseHandle): DatabaseHandle {
    openHandles.push(handle);
    return handle;
}

async function openApp(database: DatabaseHandle) {
    const app = await buildApp({ logger: false, database });
    openApps.push(app);
    return app;
}

/** 运行真实 Worker 入口；看到启动标记后终止测试进程，启动失败则保留真实退出信息。 */
function runWorkerProcess(connectionString: string): Promise<{
    started: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
}> {
    return new Promise((resolve, reject) => {
        const child = spawn(TSX_PATH, ["src/worker.ts"], {
            cwd: SERVER_ROOT,
            env: { ...process.env, DATABASE_URL_WORKER: connectionString },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let started = false;
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`worker process did not settle: ${stdout}${stderr}`));
        }, 15_000);

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            if (!started && stdout.includes("worker process started")) {
                started = true;
                child.kill("SIGTERM");
            }
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("close", (exitCode) => {
            clearTimeout(timeout);
            resolve({ started, exitCode, stdout, stderr });
        });
    });
}

beforeAll(async () => {
    postgres = await startRoleDatabase();
    await runMigrations(postgres.schemaOwner);
}, 180_000);

afterEach(async () => {
    for (const app of openApps.splice(0)) await app.close().catch(() => {});
    for (const pool of openPools.splice(0)) {
        if (pool.ending || pool.ended) continue;
        await pool.end().catch(() => {});
    }
    for (const handle of openHandles.splice(0)) {
        if (handle.pool.ending || handle.pool.ended) continue;
        await handle.pool.end().catch(() => {});
    }
}, 30_000);

afterAll(async () => {
    await postgres?.stop().catch(() => {});
    postgres = undefined;
}, 60_000);

describe("database login roles", () => {
    it("defines every required login as NOSUPERUSER NOBYPASSRLS", async () => {
        const pool = openPool(postgresUrl());

        const result = await pool.query(
            `
            select rolname, rolsuper, rolbypassrls, rolcanlogin
            from pg_roles
            where rolname = any($1::text[])
            order by rolname
        `,
            [REQUIRED_LOGIN_ROLES],
        );

        expect(result.rows).toEqual([
            { rolname: "app_api", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
            { rolname: "app_maintenance", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
            { rolname: "app_worker", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
            { rolname: "schema_owner", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
        ]);
    });

    it("rejects a superuser handle marked for app_api readiness", async () => {
        const superuser = openHandle(
            createDatabase({ url: postgresUrl(), poolMax: 1, expectedRole: "app_api" }),
        );

        await expect(checkDatabaseReady(superuser)).resolves.toBe(false);
    });

    it("accepts the exact post-migration runtime privilege matrix", async () => {
        const inspections = await Promise.all([
            inspectDatabaseRole(openPool(roles().api), "app_api"),
            inspectDatabaseRole(openPool(roles().worker), "app_worker"),
            inspectDatabaseRole(openPool(roles().maintenance), "app_maintenance"),
        ]);

        expect(inspections.map((inspection) => inspection.violations)).toEqual([[], [], []]);
    });

    it("rejects schema CREATE, role membership, extra business grants and missing function ACLs", async () => {
        const admin = openPool(roles().admin);
        const apiPool = openPool(roles().api);
        const workerPool = openPool(roles().worker);
        const maintenancePool = openPool(roles().maintenance);

        await admin.query("grant create on schema public to app_api");
        try {
            await expect(inspectDatabaseRole(apiPool, "app_api")).resolves.toMatchObject({
                violations: expect.arrayContaining([expect.stringContaining("CREATE")]),
            });
        } finally {
            await admin.query("revoke create on schema public from app_api");
        }

        await admin.query("grant app_worker to app_api");
        try {
            await expect(inspectDatabaseRole(apiPool, "app_api")).resolves.toMatchObject({
                violations: expect.arrayContaining([expect.stringContaining("member")]),
            });
        } finally {
            await admin.query("revoke app_worker from app_api");
        }

        await admin.query("grant select on public.canvases to app_worker");
        try {
            await expect(inspectDatabaseRole(workerPool, "app_worker")).resolves.toMatchObject({
                violations: expect.arrayContaining([expect.stringContaining("canvases")]),
            });
        } finally {
            await admin.query("revoke select on public.canvases from app_worker");
        }

        await admin.query("grant select (name) on public.workspaces to app_maintenance");
        try {
            await expect(inspectDatabaseRole(maintenancePool, "app_maintenance")).resolves.toMatchObject({
                violations: expect.arrayContaining([expect.stringContaining("name")]),
            });
        } finally {
            await admin.query("revoke select (name) on public.workspaces from app_maintenance");
        }

        await admin.query(
            "revoke execute on function public.begin_admin_operation(text, text, text, text) from app_api",
        );
        try {
            await expect(inspectDatabaseRole(apiPool, "app_api")).resolves.toMatchObject({
                violations: expect.arrayContaining([expect.stringContaining("begin_admin_operation")]),
            });
        } finally {
            await admin.query(
                "grant execute on function public.begin_admin_operation(text, text, text, text) to app_api",
            );
        }
    });

    it("fails closed on extra and missing app_api business UPDATE columns", async () => {
        const admin = openPool(roles().admin);
        const apiPool = openPool(roles().api);

        await admin.query("grant update (type) on public.workspaces to app_api");
        try {
            await expect(inspectDatabaseRole(apiPool, "app_api")).resolves.toMatchObject({
                violations: expect.arrayContaining([
                    "app_api UPDATE privilege on public.workspaces.type must be false",
                ]),
            });
        } finally {
            await admin.query("revoke update (type) on public.workspaces from app_api");
        }

        await admin.query("revoke update (status) on public.workspace_invitations from app_api");
        try {
            await expect(inspectDatabaseRole(apiPool, "app_api")).resolves.toMatchObject({
                violations: expect.arrayContaining([
                    "app_api UPDATE privilege on public.workspace_invitations.status must be true",
                ]),
            });
        } finally {
            await admin.query("grant update (status) on public.workspace_invitations to app_api");
        }
    });

    it("fails API readiness and Worker startup on unexpected relation column SELECT grants, then recovers", async () => {
        const admin = openPool(roles().admin);
        const database = openHandle(createDatabase({ url: roles().api, poolMax: 1, expectedRole: "app_api" }));
        const workerPool = openPool(roles().worker);
        const app = await openApp(database);

        await admin.query("create table public.runtime_column_readiness_probe (secret text not null)");
        try {
            await admin.query("alter table public.runtime_column_readiness_probe owner to schema_owner");
            await admin.query(
                "grant select (secret) on public.runtime_column_readiness_probe to app_api, app_worker",
            );
            const [apiInspection, workerInspection, readiness, failedWorker] = await Promise.all([
                inspectDatabaseRole(database.pool, "app_api"),
                inspectDatabaseRole(workerPool, "app_worker"),
                app.inject({ method: "GET", url: "/api/v1/health/ready" }),
                runWorkerProcess(roles().worker),
            ]);

            expect(apiInspection.violations).toContain(
                "app_api SELECT privilege on public.runtime_column_readiness_probe.secret must be false",
            );
            expect(workerInspection.violations).toContain(
                "app_worker SELECT privilege on public.runtime_column_readiness_probe.secret must be false",
            );
            expect(readiness.statusCode).toBe(503);
            expect(readiness.json()).toEqual({ status: "unavailable" });
            expect(failedWorker.started).toBe(false);
            expect(failedWorker.exitCode).not.toBe(0);
            expect(failedWorker.stderr).toContain(
                "app_worker SELECT privilege on public.runtime_column_readiness_probe.secret must be false",
            );
        } finally {
            await admin.query("drop table if exists public.runtime_column_readiness_probe");
        }

        const [apiRecovered, workerRecovered, readinessRecovered, workerRestarted] = await Promise.all([
            inspectDatabaseRole(database.pool, "app_api"),
            inspectDatabaseRole(workerPool, "app_worker"),
            app.inject({ method: "GET", url: "/api/v1/health/ready" }),
            runWorkerProcess(roles().worker),
        ]);
        expect(apiRecovered.violations).toEqual([]);
        expect(workerRecovered.violations).toEqual([]);
        expect(readinessRecovered.statusCode).toBe(200);
        expect(readinessRecovered.json()).toEqual({ status: "ok" });
        expect(workerRestarted.started).toBe(true);
        expect(workerRestarted.stdout).toContain("worker process started");
    }, 60_000);

    it("rejects direct and PUBLIC effective column grants on known and unexpected relations", async () => {
        const admin = openPool(roles().admin);
        const apiPool = openPool(roles().api);
        const workerPool = openPool(roles().worker);
        const maintenancePool = openPool(roles().maintenance);

        await admin.query("create table public.runtime_column_matrix_probe (secret text not null, payload text not null)");
        try {
            await admin.query("alter table public.runtime_column_matrix_probe owner to schema_owner");
            await admin.query("grant select (secret) on public.runtime_column_matrix_probe to app_api");
            await admin.query("grant insert (name) on public.workspaces to app_worker");
            await admin.query("grant update (secret) on public.runtime_column_matrix_probe to app_worker");
            await admin.query("grant select (payload) on public.runtime_column_matrix_probe to app_maintenance");
            await admin.query("grant references (id) on public.canvases to app_maintenance");
            await admin.query("grant references (payload) on public.runtime_column_matrix_probe to public");
            const [apiInspection, workerInspection, maintenanceInspection] = await Promise.all([
                inspectDatabaseRole(apiPool, "app_api"),
                inspectDatabaseRole(workerPool, "app_worker"),
                inspectDatabaseRole(maintenancePool, "app_maintenance"),
            ]);

            expect(apiInspection.violations).toEqual(
                expect.arrayContaining([
                    "app_api SELECT privilege on public.runtime_column_matrix_probe.secret must be false",
                    "app_api REFERENCES privilege on public.runtime_column_matrix_probe.payload must be false",
                ]),
            );
            expect(workerInspection.violations).toEqual(
                expect.arrayContaining([
                    "app_worker INSERT privilege on public.workspaces.name must be false",
                    "app_worker UPDATE privilege on public.runtime_column_matrix_probe.secret must be false",
                    "app_worker REFERENCES privilege on public.runtime_column_matrix_probe.payload must be false",
                ]),
            );
            expect(maintenanceInspection.violations).toEqual(
                expect.arrayContaining([
                    "app_maintenance SELECT privilege on public.runtime_column_matrix_probe.payload must be false",
                    "app_maintenance REFERENCES privilege on public.canvases.id must be false",
                    "app_maintenance REFERENCES privilege on public.runtime_column_matrix_probe.payload must be false",
                ]),
            );
        } finally {
            await admin.query("revoke insert (name) on public.workspaces from app_worker").catch(() => {});
            await admin.query("revoke references (id) on public.canvases from app_maintenance").catch(() => {});
            await admin.query("drop table if exists public.runtime_column_matrix_probe");
        }

        const recovered = await Promise.all([
            inspectDatabaseRole(apiPool, "app_api"),
            inspectDatabaseRole(workerPool, "app_worker"),
            inspectDatabaseRole(maintenancePool, "app_maintenance"),
        ]);
        expect(recovered.map((inspection) => inspection.violations)).toEqual([[], [], []]);
    });

    it("does not mistake all-column SELECT grants for an approved table-level grant", async () => {
        const admin = openPool(roles().admin);
        const apiPool = openPool(roles().api);
        const columns = "id, name, slug, created_at, type, status, owner_user_id, updated_at, deleted_at";

        await admin.query("revoke select on public.workspaces from app_api");
        try {
            await admin.query(`grant select (${columns}) on public.workspaces to app_api`);
            const inspection = await inspectDatabaseRole(apiPool, "app_api");
            expect(inspection.violations).toContain(
                "app_api SELECT privilege on public.workspaces must be true",
            );
            expect(inspection.violations).not.toEqual(
                expect.arrayContaining([expect.stringContaining("SELECT privilege on public.workspaces.")]),
            );
        } finally {
            await admin.query(`revoke select (${columns}) on public.workspaces from app_api`).catch(() => {});
            await admin.query("grant select on public.workspaces to app_api");
        }
    });

    it("makes API readiness fail on app_api TRUNCATE drift and recover after revoke", async () => {
        const admin = openPool(roles().admin);
        const database = openHandle(createDatabase({ url: roles().api, poolMax: 1, expectedRole: "app_api" }));
        const app = await openApp(database);

        await admin.query("grant truncate on public.canvases to app_api");
        try {
            const inspection = await inspectDatabaseRole(database.pool, "app_api");
            const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });

            expect(inspection.violations).toContain(
                "app_api TRUNCATE privilege on public.canvases must be false",
            );
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ status: "unavailable" });
        } finally {
            await admin.query("revoke truncate on public.canvases from app_api");
        }

        await expect(inspectDatabaseRole(database.pool, "app_api")).resolves.toMatchObject({ violations: [] });
        const recovered = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json()).toEqual({ status: "ok" });
    });

    it("makes Worker startup fail on app_worker TRUNCATE drift and recover after revoke", async () => {
        const admin = openPool(roles().admin);
        const workerPool = openPool(roles().worker);

        await admin.query("grant truncate on public.canvases to app_worker");
        try {
            const inspection = await inspectDatabaseRole(workerPool, "app_worker");
            const failed = await runWorkerProcess(roles().worker);

            expect(inspection.violations).toContain(
                "app_worker TRUNCATE privilege on public.canvases must be false",
            );
            expect(failed.started).toBe(false);
            expect(failed.exitCode).not.toBe(0);
            expect(failed.stderr).toContain("app_worker TRUNCATE privilege on public.canvases must be false");
        } finally {
            await admin.query("revoke truncate on public.canvases from app_worker");
        }

        await expect(inspectDatabaseRole(workerPool, "app_worker")).resolves.toMatchObject({ violations: [] });
        const recovered = await runWorkerProcess(roles().worker);
        expect(recovered.started).toBe(true);
        expect(recovered.stdout).toContain("worker process started");
    }, 60_000);

    it("rejects matrix-external REFERENCES, TRIGGER and PostgreSQL 18 MAINTAIN table privileges", async () => {
        const admin = openPool(roles().admin);
        const apiPool = openPool(roles().api);
        const workerPool = openPool(roles().worker);
        const maintenancePool = openPool(roles().maintenance);

        await admin.query("grant references on public.canvases to app_api");
        await admin.query("grant trigger on public.canvases to app_maintenance");
        await admin.query("grant maintain on public.canvases to app_worker");
        try {
            const [apiInspection, workerInspection, maintenanceInspection] = await Promise.all([
                inspectDatabaseRole(apiPool, "app_api"),
                inspectDatabaseRole(workerPool, "app_worker"),
                inspectDatabaseRole(maintenancePool, "app_maintenance"),
            ]);

            expect(apiInspection.violations).toContain(
                "app_api REFERENCES privilege on public.canvases must be false",
            );
            expect(maintenanceInspection.violations).toContain(
                "app_maintenance TRIGGER privilege on public.canvases must be false",
            );
            expect(workerInspection.violations).toContain(
                "app_worker MAINTAIN privilege on public.canvases must be false",
            );
        } finally {
            await admin.query("revoke references on public.canvases from app_api");
            await admin.query("revoke trigger on public.canvases from app_maintenance");
            await admin.query("revoke maintain on public.canvases from app_worker");
        }
    });

    it("rejects every public sequence privilege across runtime roles and recovers cleanly", async () => {
        const admin = openPool(roles().admin);
        const apiPool = openPool(roles().api);
        const workerPool = openPool(roles().worker);
        const maintenancePool = openPool(roles().maintenance);
        const sequence = "public.runtime_privilege_probe_sequence";

        await admin.query(`create sequence ${sequence}`);
        await admin.query(`alter sequence ${sequence} owner to schema_owner`);
        await admin.query(`grant usage on sequence ${sequence} to app_api`);
        await admin.query(`grant select on sequence ${sequence} to app_worker`);
        await admin.query(`grant update on sequence ${sequence} to app_maintenance`);
        try {
            const inspections = await Promise.all([
                inspectDatabaseRole(apiPool, "app_api"),
                inspectDatabaseRole(workerPool, "app_worker"),
                inspectDatabaseRole(maintenancePool, "app_maintenance"),
            ]);

            expect(inspections[0]!.violations).toContain(
                `app_api USAGE privilege on sequence ${sequence} must be false`,
            );
            expect(inspections[1]!.violations).toContain(
                `app_worker SELECT privilege on sequence ${sequence} must be false`,
            );
            expect(inspections[2]!.violations).toContain(
                `app_maintenance UPDATE privilege on sequence ${sequence} must be false`,
            );
        } finally {
            await admin.query(`revoke all on sequence ${sequence} from app_api, app_worker, app_maintenance`);
            await admin.query(`drop sequence ${sequence}`);
        }

        const recovered = await Promise.all([
            inspectDatabaseRole(apiPool, "app_api"),
            inspectDatabaseRole(workerPool, "app_worker"),
            inspectDatabaseRole(maintenancePool, "app_maintenance"),
        ]);
        expect(recovered.map((inspection) => inspection.violations)).toEqual([[], [], []]);
    });
});
