export type NodeEnv = "development" | "test" | "production";

export type DatabaseConfig = { url: string; poolMax: number };

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

/** 解析并校验运行时环境变量，任何非法取值都直接抛错，避免带着坏配置启动。 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
    const required = (name: string): string => {
        const value = env[name]?.trim();
        if (!value) throw new Error(`Missing required environment variable: ${name}`);
        return value;
    };

    const integerInRange = (name: string, rawValue: string | undefined, fallback: number, min: number, max: number): number => {
        if (rawValue === undefined) return fallback;
        const value = Number(rawValue);
        if (rawValue.trim() === "" || !Number.isInteger(value) || value < min || value > max) {
            throw new Error(`${name} must be an integer between ${min} and ${max}`);
        }
        return value;
    };

    const nodeEnvValue = env.NODE_ENV;
    let nodeEnv: NodeEnv = "development";
    if (nodeEnvValue !== undefined) {
        if (!isNodeEnv(nodeEnvValue)) throw new Error(`NODE_ENV must be one of: ${NODE_ENVS.join(", ")}`);
        nodeEnv = nodeEnvValue;
    }

    const appOrigin = required("APP_ORIGIN");
    let appOriginUrl: URL;
    try {
        appOriginUrl = new URL(appOrigin);
    } catch {
        throw new Error("APP_ORIGIN must be an absolute http(s) URL");
    }
    if (appOriginUrl.protocol !== "http:" && appOriginUrl.protocol !== "https:") {
        throw new Error("APP_ORIGIN must be an absolute http(s) URL");
    }

    const betterAuthSecret = required("BETTER_AUTH_SECRET");
    if (betterAuthSecret.length < SECRET_MIN_LENGTH) {
        throw new Error(`BETTER_AUTH_SECRET must be at least ${SECRET_MIN_LENGTH} characters`);
    }

    return {
        nodeEnv,
        port: integerInRange("PORT", env.PORT, 4000, 1, 65535),
        appOrigin,
        betterAuthSecret,
        database: { url: required("DATABASE_URL"), poolMax: integerInRange("DB_POOL_MAX", env.DB_POOL_MAX, 10, 1, 50) },
        smtp: {
            host: required("SMTP_HOST"),
            port: integerInRange("SMTP_PORT", env.SMTP_PORT, 587, 1, 65535),
            user: env.SMTP_USER ?? "",
            password: env.SMTP_PASSWORD ?? "",
            from: required("SMTP_FROM"),
        },
    };
}
