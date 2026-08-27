export type NodeEnv = "development" | "test" | "production";

/** 四个 PostgreSQL 登录角色；schema_owner 只用于迁移作业。 */
export type DatabaseLoginRole = "schema_owner" | "app_api" | "app_worker" | "app_maintenance";

export type DatabaseConfig = { url: string; poolMax: number; expectedRole: DatabaseLoginRole };

export type RuntimeDatabaseUrlName = "DATABASE_URL_API" | "DATABASE_URL_WORKER" | "DATABASE_URL_MAINTENANCE";

export type AppConfig = {
    nodeEnv: NodeEnv;
    port: number;
    appOrigin: string;
    betterAuthSecret: string;
    database: DatabaseConfig;
    smtp: { host: string; port: number; user: string; password: string; from: string };
};

const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];
const SECRET_MIN_LENGTH = 32;

function isNodeEnv(value: string): value is NodeEnv {
    return (NODE_ENVS as readonly string[]).includes(value);
}

/** 必填环境变量统一裁剪空白，空值视为缺失。 */
function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

function integerInRange(name: string, rawValue: string | undefined, fallback: number, min: number, max: number): number {
    if (rawValue === undefined) return fallback;
    const value = Number(rawValue);
    if (rawValue.trim() === "" || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
}

function boundedPool(rawValue: string | undefined): number {
    return integerInRange("DB_POOL_MAX", rawValue, 10, 1, 50);
}

/** 每个进程只解析自己那一份凭据，不接受 URL 列表。 */
export function loadDatabaseConfig(
    env: NodeJS.ProcessEnv,
    urlName: RuntimeDatabaseUrlName,
    expectedRole: Exclude<DatabaseLoginRole, "schema_owner">,
): DatabaseConfig {
    return { url: requiredEnv(env, urlName), poolMax: boundedPool(env.DB_POOL_MAX), expectedRole };
}

/** 解析并校验运行时环境变量，任何非法取值都直接抛错，避免带着坏配置启动。 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
    const required = (name: string): string => requiredEnv(env, name);

    const nodeEnvValue = env.NODE_ENV;
    let nodeEnv: NodeEnv = "development";
    if (nodeEnvValue !== undefined) {
        if (!isNodeEnv(nodeEnvValue)) throw new Error(`NODE_ENV must be one of: ${NODE_ENVS.join(", ")}`);
        nodeEnv = nodeEnvValue;
    }

    const appOriginInput = required("APP_ORIGIN");
    let appOriginUrl: URL;
    try {
        appOriginUrl = new URL(appOriginInput);
    } catch {
        throw new Error("APP_ORIGIN must be an absolute http(s) URL");
    }
    if (appOriginUrl.protocol !== "http:" && appOriginUrl.protocol !== "https:") {
        throw new Error("APP_ORIGIN must be an absolute http(s) URL");
    }
    if (nodeEnv === "production" && appOriginUrl.protocol !== "https:") {
        throw new Error("APP_ORIGIN must use HTTPS in production");
    }

    const betterAuthSecret = required("BETTER_AUTH_SECRET");
    if (betterAuthSecret.length < SECRET_MIN_LENGTH) {
        throw new Error(`BETTER_AUTH_SECRET must be at least ${SECRET_MIN_LENGTH} characters`);
    }

    return {
        nodeEnv,
        port: integerInRange("PORT", env.PORT, 4000, 1, 65535),
        appOrigin: appOriginUrl.origin,
        betterAuthSecret,
        database: loadDatabaseConfig(env, "DATABASE_URL_API", "app_api"),
        smtp: {
            host: required("SMTP_HOST"),
            port: integerInRange("SMTP_PORT", env.SMTP_PORT, 587, 1, 65535),
            user: env.SMTP_USER ?? "",
            password: env.SMTP_PASSWORD ?? "",
            from: required("SMTP_FROM"),
        },
    };
}
