import { defineConfig } from "drizzle-kit";

// 迁移作业只使用 schema_owner 凭据，运行期角色不得执行迁移。
const url = process.env.DATABASE_URL_SCHEMA_OWNER?.trim();
if (!url) throw new Error("Missing required environment variable: DATABASE_URL_SCHEMA_OWNER");

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/infrastructure/database/schema.ts",
    out: "./migrations",
    dbCredentials: { url },
});
