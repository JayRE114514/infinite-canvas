import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

export type StartedPostgres = { url: string; stop: () => Promise<void> };

/** 启动一次性 PostgreSQL 容器，供数据库集成测试使用。 */
export async function startPostgres(): Promise<StartedPostgres> {
    const container: StartedTestContainer = await new GenericContainer("postgres:18-alpine")
        .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "test" })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .withStartupTimeout(120_000)
        .start();

    const url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

    return { url, stop: () => container.stop() };
}
