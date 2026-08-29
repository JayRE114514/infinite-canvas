import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Identity 模块的数据库定义入口：跨模块只允许引用这里的 users。
// 列名沿用 Better Auth 默认字段名，索引名沿用其解析规则 `${表名}_${列名}_idx|uidx`。
// 四张表都定义在本文件，供迁移生成器统一发现；auth-schema.ts 只负责组装适配器视图。

export const users = pgTable("users", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const sessions = pgTable(
    "sessions",
    {
        id: text("id").primaryKey(),
        expiresAt: timestamp("expiresAt").notNull(),
        token: text("token").notNull().unique(),
        createdAt: timestamp("createdAt").notNull().defaultNow(),
        updatedAt: timestamp("updatedAt").notNull().defaultNow(),
        ipAddress: text("ipAddress"),
        userAgent: text("userAgent"),
        userId: text("userId")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
    },
    (table) => [index("sessions_userId_idx").on(table.userId)],
);

export const accounts = pgTable(
    "accounts",
    {
        id: text("id").primaryKey(),
        issuer: text("issuer").notNull(),
        accountId: text("accountId").notNull(),
        providerId: text("providerId").notNull(),
        userId: text("userId")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        accessToken: text("accessToken"),
        refreshToken: text("refreshToken"),
        idToken: text("idToken"),
        accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
        refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
        scope: text("scope"),
        password: text("password"),
        createdAt: timestamp("createdAt").notNull().defaultNow(),
        updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    },
    (table) => [
        // Better Auth 内置表级唯一索引，阻止同一 provider 身份被重复绑定。
        uniqueIndex("accounts_issuer_accountId_uidx").on(table.issuer, table.accountId),
        index("accounts_userId_idx").on(table.userId),
    ],
);

export const verifications = pgTable(
    "verifications",
    {
        id: text("id").primaryKey(),
        identifier: text("identifier").notNull(),
        value: text("value").notNull(),
        expiresAt: timestamp("expiresAt").notNull(),
        createdAt: timestamp("createdAt").notNull().defaultNow(),
        updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    },
    (table) => [index("verifications_identifier_idx").on(table.identifier)],
);
