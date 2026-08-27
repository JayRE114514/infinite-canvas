import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

export type StartedPostgres = { url: string; stop: () => Promise<void> };

/** 四个固定登录角色的测试专用口令，仅用于一次性容器。 */
export const ROLE_TEST_PASSWORDS = {
    schema_owner: "test-schema-owner",
    app_api: "test-app-api",
    app_worker: "test-app-worker",
    app_maintenance: "test-app-maintenance",
} as const;

export type DatabaseRoleName = keyof typeof ROLE_TEST_PASSWORDS;

const ROLES_BOOTSTRAP_URL = new URL("../../database/bootstrap/roles.sql", import.meta.url);
const ADOPT_OWNERSHIP_URL = new URL("../../database/bootstrap/adopt-ownership.sql", import.meta.url);

/** 读取部署引导脚本，测试与生产执行同一份 SQL。 */
export function readRolesBootstrapSql(): Promise<string> {
    return readFile(ROLES_BOOTSTRAP_URL, "utf8");
}

export function readAdoptOwnershipSql(): Promise<string> {
    return readFile(ADOPT_OWNERSHIP_URL, "utf8");
}

/** 启动一次性 PostgreSQL 容器，并按部署脚本创建固定登录角色。 */
export async function startPostgres(): Promise<StartedPostgres> {
    const container: StartedTestContainer = await new GenericContainer("postgres:18-alpine")
        .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "test" })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .withStartupTimeout(120_000)
        .start();

    const url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

    // 角色引导属于部署动作，容器管理员执行一次即可供全部角色用例使用。
    const admin = new Pool({ connectionString: url, max: 1 });
    try {
        await admin.query(await readRolesBootstrapSql());
    } finally {
        await admin.end().catch(() => {});
    }

    return { url, stop: () => container.stop() };
}

export type StartedRoleDatabase = {
    admin: string;
    schemaOwner: string;
    api: string;
    worker: string;
    maintenance: string;
    stop: () => Promise<void>;
};

/** 按角色名拼装连接串；口令是静态字面量，不做参数绑定。 */
function roleUrl(adminUrl: string, role: DatabaseRoleName): string {
    const url = new URL(adminUrl);
    url.username = role;
    url.password = ROLE_TEST_PASSWORDS[role];
    return url.toString();
}

/**
 * 在一次性容器上准备生产等价的登录角色：赋口令、放开 CONNECT，
 * 并把 public 模式移交 schema_owner，仅该角色可以建对象。
 */
export async function startRoleDatabase(): Promise<StartedRoleDatabase> {
    const postgres = await startPostgres();
    const admin = new Pool({ connectionString: postgres.url, max: 1 });

    try {
        // ALTER ROLE 不支持参数绑定，这里只使用固定角色名与固定测试口令字面量。
        await admin.query(`ALTER ROLE schema_owner PASSWORD '${ROLE_TEST_PASSWORDS.schema_owner}'`);
        await admin.query(`ALTER ROLE app_api PASSWORD '${ROLE_TEST_PASSWORDS.app_api}'`);
        await admin.query(`ALTER ROLE app_worker PASSWORD '${ROLE_TEST_PASSWORDS.app_worker}'`);
        await admin.query(`ALTER ROLE app_maintenance PASSWORD '${ROLE_TEST_PASSWORDS.app_maintenance}'`);

        await admin.query("GRANT CONNECT ON DATABASE test TO schema_owner, app_api, app_worker, app_maintenance");
        // 迁移器会执行 CREATE SCHEMA drizzle，这需要库级 CREATE；只授予迁移角色。
        await admin.query("GRANT CREATE ON DATABASE test TO schema_owner");
        await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
        await admin.query("ALTER SCHEMA public OWNER TO schema_owner");
        await admin.query("GRANT CREATE, USAGE ON SCHEMA public TO schema_owner");
    } catch (error) {
        await admin.end().catch(() => {});
        await postgres.stop().catch(() => {});
        throw error;
    }

    await admin.end().catch(() => {});

    return {
        admin: postgres.url,
        schemaOwner: roleUrl(postgres.url, "schema_owner"),
        api: roleUrl(postgres.url, "app_api"),
        worker: roleUrl(postgres.url, "app_worker"),
        maintenance: roleUrl(postgres.url, "app_maintenance"),
        stop: postgres.stop,
    };
}
