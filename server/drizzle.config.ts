import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL?.trim();
if (!url) throw new Error("Missing required environment variable: DATABASE_URL");

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/infrastructure/database/schema.ts",
    out: "./migrations",
    dbCredentials: { url },
});
