import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const MIGRATIONS_FOLDER = new URL("../../migrations/", import.meta.url);

/**
 * 0000/0001 是不可变历史迁移，这里固定它们的 SQL 摘要，
 * 升级路径用例因此无法悄悄跟随被改写过的历史 SQL。
 */
export const IMMUTABLE_MIGRATION_HASHES = {
    "0000_auth_and_workspaces": "796b413c3c3282bac9e34588731d6f8e970d30e6dcc4c66906fb70c0129bd529",
    "0001_canvases": "37a4c4c779a973cf24d6cd784abeca8080e461d4d24c121af3621f914aaa805f",
} as const;

export type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

export function migrationsFolderPath(): string {
    return new URL(".", MIGRATIONS_FOLDER).pathname.replace(/\/$/, "");
}

/** 读取 Drizzle 迁移日志，测试与生产共用同一份顺序定义。 */
export async function readJournal(): Promise<{ entries: JournalEntry[] }> {
    const raw = await readFile(new URL("meta/_journal.json", MIGRATIONS_FOLDER), "utf8");
    return JSON.parse(raw) as { entries: JournalEntry[] };
}

export async function readMigrationSql(tag: string): Promise<string> {
    return await readFile(new URL(`${tag}.sql`, MIGRATIONS_FOLDER), "utf8");
}

/** 与 Drizzle 迁移器一致：整份 SQL 文件的 sha256。 */
export function migrationHash(sql: string): string {
    return createHash("sha256").update(sql).digest("hex");
}

export async function journalEntries(): Promise<JournalEntry[]> {
    return (await readJournal()).entries;
}

export async function latestJournalEntry(): Promise<JournalEntry> {
    const entries = await journalEntries();
    const latest = entries[entries.length - 1];
    if (!latest) throw new Error("Migration journal has no entries");
    return latest;
}

/** 校验不可变历史迁移未被改写，避免升级路径断言失去意义。 */
export async function assertImmutableMigrationHashes(): Promise<void> {
    for (const [tag, expected] of Object.entries(IMMUTABLE_MIGRATION_HASHES)) {
        const actual = migrationHash(await readMigrationSql(tag));
        if (actual !== expected) {
            throw new Error(`Immutable migration ${tag}.sql changed: expected sha256 ${expected} but found ${actual}`);
        }
    }
}

/**
 * 按 _journal.json 顺序执行全部迁移，只允许 schema_owner 凭据调用。
 * 所有测试共用这一个入口，不再单独读取某个迁移文件。
 */
export async function runMigrations(connectionString: string): Promise<void> {
    const pool = new Pool({ connectionString, max: 1 });
    try {
        await migrate(drizzle(pool), { migrationsFolder: migrationsFolderPath() });
    } finally {
        await pool.end().catch(() => {});
    }
}

/** 只执行日志中前 N 个迁移，供“遗留库再升级”路径使用。 */
export async function runMigrationsAsRole(connectionString: string, tags: string[]): Promise<void> {
    const pool = new Pool({ connectionString, max: 1 });
    try {
        await pool.query("CREATE SCHEMA IF NOT EXISTS drizzle");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
                id SERIAL PRIMARY KEY,
                hash text NOT NULL,
                created_at bigint
            )
        `);

        const entries = await journalEntries();
        for (const tag of tags) {
            const entry = entries.find((item) => item.tag === tag);
            if (!entry) throw new Error(`Migration tag ${tag} is not journaled`);
            const sql = await readMigrationSql(tag);
            for (const statement of sql.split("--> statement-breakpoint")) {
                await pool.query(statement);
            }
            await pool.query('insert into drizzle."__drizzle_migrations" ("hash", "created_at") values($1, $2)', [
                migrationHash(sql),
                entry.when,
            ]);
        }
    } finally {
        await pool.end().catch(() => {});
    }
}
