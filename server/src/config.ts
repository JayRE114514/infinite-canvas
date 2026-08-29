export type NodeEnv = "development" | "test" | "production";

/** 四个 PostgreSQL 登录角色；schema_owner 只用于迁移作业。 */
export type DatabaseLoginRole = "schema_owner" | "app_api" | "app_worker" | "app_maintenance";

export type DatabaseConfig = { url: string; poolMax: number; expectedRole: DatabaseLoginRole };

export type TencentCosConfig = {
    secretId: string;
    secretKey: string;
    bucket: string;
    region: string;
    signedUrlTtlSeconds: number;
};

export type ArtBoxConfig = {
    baseUrl: string;
    apiKey: string;
    videoModels: string[];
    requestTimeoutMs: number;
    resultMaxBytes: number;
    resultAllowedHosts: string[];
    pollLeaseSeconds: number;
};

export type RuntimeDatabaseUrlName = "DATABASE_URL_API" | "DATABASE_URL_WORKER" | "DATABASE_URL_MAINTENANCE";

export type AppConfig = {
    nodeEnv: NodeEnv;
    port: number;
    appOrigin: string;
    betterAuthSecret: string;
    database: DatabaseConfig;
    smtp: { host: string; port: number; user: string; password: string; from: string };
    cos?: TencentCosConfig;
    artbox?: ArtBoxConfig;
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

function loadTencentCosConfig(env: NodeJS.ProcessEnv): TencentCosConfig | undefined {
    const names = [
        "COS_SECRET_ID",
        "COS_SECRET_KEY",
        "COS_BUCKET",
        "COS_REGION",
        "COS_SIGNED_URL_TTL_SECONDS",
    ] as const;
    if (!names.some((name) => env[name] !== undefined)) return undefined;

    const values = names.map((name) => env[name]?.trim());
    const missing = names.filter((_name, index) => !values[index]);
    if (missing.length > 0) {
        throw new Error(`COS configuration requires all variables; missing: ${missing.join(", ")}`);
    }

    const ttlRaw = values[4]!;
    const signedUrlTtlSeconds = Number(ttlRaw);
    if (!Number.isSafeInteger(signedUrlTtlSeconds) || signedUrlTtlSeconds <= 0) {
        throw new Error("COS_SIGNED_URL_TTL_SECONDS must be a positive integer");
    }

    const bucket = values[2]!;
    if (!/^[a-z\d-]+-\d+$/.test(bucket)) {
        throw new Error('COS_BUCKET must use the "bucket-appid" format accepted by Tencent COS');
    }
    const region = values[3]!;
    if (region.includes("cos.") || !/^[a-z\d-]+$/.test(region)) {
        throw new Error("COS_REGION must use the Tencent COS region format");
    }

    return {
        secretId: values[0]!,
        secretKey: values[1]!,
        bucket,
        region,
        signedUrlTtlSeconds,
    };
}

function positiveSafeInteger(name: string, raw: string): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
    return value;
}

function commaSeparated(name: string, raw: string): string[] {
    const values = raw.split(",").map((value) => value.trim());
    if (values.length === 0 || values.some((value) => !value)) throw new Error(`${name} must be a non-empty comma-separated list`);
    return [...new Set(values)];
}

function loadArtBoxConfig(env: NodeJS.ProcessEnv, nodeEnv: NodeEnv): ArtBoxConfig | undefined {
    const names = [
        "ARTBOX_BASE_URL",
        "ARTBOX_API_KEY",
        "ARTBOX_VIDEO_MODELS",
        "ARTBOX_REQUEST_TIMEOUT_MS",
        "ARTBOX_RESULT_MAX_BYTES",
        "ARTBOX_RESULT_ALLOWED_HOSTS",
        "ARTBOX_POLL_LEASE_SECONDS",
    ] as const;
    if (!names.some((name) => env[name] !== undefined)) return undefined;

    const values = names.map((name) => env[name]?.trim());
    const missing = names.filter((_name, index) => !values[index]);
    if (missing.length > 0) {
        throw new Error(`ARTBOX configuration requires all variables; missing: ${missing.join(", ")}`);
    }

    const baseInput = values[0]!;
    let baseUrl: URL;
    try {
        baseUrl = new URL(baseInput);
    } catch {
        throw new Error("ARTBOX_BASE_URL must be an absolute http(s) origin");
    }
    if (
        (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
        baseUrl.username ||
        baseUrl.password ||
        baseUrl.search ||
        baseUrl.hash ||
        baseUrl.pathname !== "/"
    ) {
        throw new Error("ARTBOX_BASE_URL must be a credential-free http(s) origin");
    }
    if (nodeEnv === "production" && baseUrl.protocol !== "https:") {
        throw new Error("ARTBOX_BASE_URL must use HTTPS in production");
    }

    const videoModels = commaSeparated("ARTBOX_VIDEO_MODELS", values[2]!);
    const resultAllowedHosts = commaSeparated("ARTBOX_RESULT_ALLOWED_HOSTS", values[5]!).map((host) => {
        if (host.includes(":") || host.includes("/") || host.includes("@") || host.includes("*")) {
            throw new Error("ARTBOX_RESULT_ALLOWED_HOSTS must contain hostnames only");
        }
        let url: URL;
        try {
            url = new URL(`https://${host}`);
        } catch {
            throw new Error("ARTBOX_RESULT_ALLOWED_HOSTS must contain valid hostnames");
        }
        if (url.hostname !== host.toLowerCase() || !host.includes(".")) {
            throw new Error("ARTBOX_RESULT_ALLOWED_HOSTS must contain valid hostnames");
        }
        return url.hostname;
    });

    return {
        baseUrl: baseUrl.origin,
        apiKey: values[1]!,
        videoModels,
        requestTimeoutMs: positiveSafeInteger("ARTBOX_REQUEST_TIMEOUT_MS", values[3]!),
        resultMaxBytes: positiveSafeInteger("ARTBOX_RESULT_MAX_BYTES", values[4]!),
        resultAllowedHosts: [...new Set(resultAllowedHosts)],
        pollLeaseSeconds: positiveSafeInteger("ARTBOX_POLL_LEASE_SECONDS", values[6]!),
    };
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

    const cos = loadTencentCosConfig(env);
    const artbox = loadArtBoxConfig(env, nodeEnv);

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
        ...(cos ? { cos } : {}),
        ...(artbox ? { artbox } : {}),
    };
}
