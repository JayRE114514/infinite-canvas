import { boolean, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// 表名映射到应用语义（workspaces 等），列名沿用 Better Auth 默认字段名，
// 只有应用自有列使用 snake_case，避免与生成器/适配器解析不一致。
// 索引名沿用 Better Auth 1.7.1 解析规则 `${表名}_${列名}_idx|uidx`，
// 与官方生成器输出保持一致，另外保留应用自有约束。

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
        activeOrganizationId: text("activeOrganizationId"),
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

export const workspaces = pgTable(
    "workspaces",
    {
        id: text("id").primaryKey(),
        name: text("name").notNull(),
        slug: text("slug").notNull(),
        logo: text("logo"),
        createdAt: timestamp("createdAt").notNull().defaultNow(),
        metadata: text("metadata"),
        workspaceType: text("workspace_type").notNull().default("team"),
        status: text("status").notNull().default("active"),
        ownerUserId: text("owner_user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
    },
    (table) => [
        // slug 的唯一性由该索引承担，不再额外加 unique 约束，避免同一列出现两个唯一索引。
        uniqueIndex("workspaces_slug_uidx").on(table.slug),
        // Task 4 依赖该不变量：每个用户最多一个个人工作区。
        // 谓词写成不带表名限定的裸列，避免生成器输出 "workspaces"."workspace_type" 这种限定引用。
        uniqueIndex("workspaces_owner_personal_unique")
            .on(table.ownerUserId)
            .where(sql`workspace_type = 'personal'`),
        index("workspaces_owner_user_id_idx").on(table.ownerUserId),
    ],
);

export const workspaceMembers = pgTable(
    "workspace_members",
    {
        id: text("id").primaryKey(),
        organizationId: text("organizationId")
            .notNull()
            .references(() => workspaces.id, { onDelete: "cascade" }),
        userId: text("userId")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        role: text("role").notNull().default("member"),
        createdAt: timestamp("createdAt").notNull().defaultNow(),
    },
    (table) => [
        uniqueIndex("workspace_members_workspace_user_unique").on(table.organizationId, table.userId),
        index("workspace_members_organizationId_idx").on(table.organizationId),
        index("workspace_members_userId_idx").on(table.userId),
    ],
);

export const workspaceInvitations = pgTable(
    "workspace_invitations",
    {
        id: text("id").primaryKey(),
        organizationId: text("organizationId")
            .notNull()
            .references(() => workspaces.id, { onDelete: "cascade" }),
        email: text("email").notNull(),
        role: text("role"),
        status: text("status").notNull().default("pending"),
        expiresAt: timestamp("expiresAt").notNull(),
        createdAt: timestamp("createdAt").notNull().defaultNow(),
        inviterId: text("inviterId")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
    },
    (table) => [
        index("workspace_invitations_organizationId_idx").on(table.organizationId),
        index("workspace_invitations_email_idx").on(table.email),
    ],
);

/** Drizzle 适配器按解析后的模型名取表，键名必须与 modelName 一致。 */
export const authSchema = {
    users,
    sessions,
    accounts,
    verifications,
    workspaces,
    workspace_members: workspaceMembers,
    workspace_invitations: workspaceInvitations,
};
