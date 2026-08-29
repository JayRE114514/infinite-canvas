export type NodeEnv = "development" | "test" | "production";

/** 四个 PostgreSQL 登录角色；schema_owner 只用于迁移作业。 */
export type DatabaseLoginRole = "schema_owner" | "app_api" | "app_worker" | "app_maintenance";

export type DatabaseConfig = { url: string; poolMax: number; expectedRole: DatabaseLoginRole };

export type PlatformImageConfig = {
    capabilityId: "image.generate";
    routeId: string;
    adapterId: string;
    adapterVersion: string;
    exactModelId: string;
    priceVersion: string;
    estimatedAmount: bigint;
    fixedAmount: bigint;
    s3: {
        endpoint: string;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
        requestTimeoutMs: number;
        maxAttempts: number;
    };
};

export type WorkerAiConfig = PlatformImageConfig & {
    providerBaseUrl: string;
    providerApiKey: string;
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
    providerTimeoutMs: number;
    safeRetryBudget: number;
    queueConcurrency: number;
    jobRetryCount: number;
};

export type RuntimeDatabaseUrlName = "DATABASE_URL_API" | "DATABASE_URL_WORKER" | "DATABASE_URL_MAINTENANCE";

export type AppConfig = {
    nodeEnv: NodeEnv;
    port: number;
    appOrigin: string;
    betterAuthSecret: string;
    database: DatabaseConfig;
    smtp: { host: string; port: number; user: string; password: string; from: string };
    platformImage?: PlatformImageConfig;
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

function explicitInteger(env: NodeJS.ProcessEnv, name: string, minimum: number): number {
    const raw = requiredEnv(env, name);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid configuration: ${name}`);
    return value;
}

function enabledPlatformImage(env: NodeJS.ProcessEnv): boolean {
    const value = env.PLATFORM_IMAGE_ENABLED?.trim();
    if (value === undefined || value === "false") return false;
    if (value === "true") return true;
    throw new Error("Invalid configuration: PLATFORM_IMAGE_ENABLED");
}

function requiredUrl(env: NodeJS.ProcessEnv, name: string): string {
    const value = requiredEnv(env, name);
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        return value;
    } catch {
        throw new Error(`Invalid configuration: ${name}`);
    }
}

function requiredCreditAmount(env: NodeJS.ProcessEnv, name: string): bigint {
    const raw = requiredEnv(env, name);
    if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`Invalid configuration: ${name}`);
    return BigInt(raw);
}

export function loadPlatformImageConfig(env: NodeJS.ProcessEnv): PlatformImageConfig | undefined {
    if (!enabledPlatformImage(env)) return undefined;
    const capabilityId = requiredEnv(env, "PLATFORM_IMAGE_CAPABILITY_ID");
    if (capabilityId !== "image.generate") throw new Error("Invalid configuration: PLATFORM_IMAGE_CAPABILITY_ID");
    const estimatedAmount = requiredCreditAmount(env, "PLATFORM_IMAGE_ESTIMATED_CREDITS");
    const fixedAmount = requiredCreditAmount(env, "PLATFORM_IMAGE_FIXED_CREDITS");
    if (estimatedAmount <= 0n || fixedAmount > estimatedAmount) {
        throw new Error("Invalid configuration: PLATFORM_IMAGE_FIXED_CREDITS");
    }
    return {
        capabilityId,
        routeId: requiredEnv(env, "PLATFORM_IMAGE_ROUTE_ID"),
        adapterId: requiredEnv(env, "PLATFORM_IMAGE_ADAPTER_ID"),
        adapterVersion: requiredEnv(env, "PLATFORM_IMAGE_ADAPTER_VERSION"),
        exactModelId: requiredEnv(env, "PLATFORM_IMAGE_EXACT_MODEL_ID"),
        priceVersion: requiredEnv(env, "PLATFORM_IMAGE_PRICE_VERSION"),
        estimatedAmount,
        fixedAmount,
        s3: {
            endpoint: requiredUrl(env, "S3_ENDPOINT"),
            region: requiredEnv(env, "S3_REGION"),
            bucket: requiredEnv(env, "S3_BUCKET"),
            accessKeyId: requiredEnv(env, "S3_ACCESS_KEY_ID"),
            secretAccessKey: requiredEnv(env, "S3_SECRET_ACCESS_KEY"),
            requestTimeoutMs: explicitInteger(env, "S3_REQUEST_TIMEOUT_MS", 1),
            maxAttempts: explicitInteger(env, "S3_MAX_ATTEMPTS", 1),
        },
    };
}

export function loadWorkerAiConfig(env: NodeJS.ProcessEnv): WorkerAiConfig | undefined {
    const common = loadPlatformImageConfig(env);
    if (!common) return undefined;
    const leaseDurationMs = explicitInteger(env, "AI_WORKER_LEASE_DURATION_MS", 1);
    const heartbeatIntervalMs = explicitInteger(env, "AI_WORKER_HEARTBEAT_INTERVAL_MS", 1);
    if (heartbeatIntervalMs >= leaseDurationMs) throw new Error("Invalid configuration: AI_WORKER_HEARTBEAT_INTERVAL_MS");
    return {
        ...common,
        providerBaseUrl: requiredUrl(env, "PLATFORM_IMAGE_PROVIDER_BASE_URL"),
        providerApiKey: requiredEnv(env, "PLATFORM_IMAGE_PROVIDER_API_KEY"),
        leaseDurationMs,
        heartbeatIntervalMs,
        providerTimeoutMs: explicitInteger(env, "AI_PROVIDER_HTTP_TIMEOUT_MS", 1),
        safeRetryBudget: explicitInteger(env, "AI_PROVIDER_SAFE_RETRY_BUDGET", 0),
        queueConcurrency: explicitInteger(env, "PG_BOSS_QUEUE_CONCURRENCY", 1),
        jobRetryCount: explicitInteger(env, "PG_BOSS_JOB_RETRY_COUNT", 0),
    };
}

/** pg-boss 部署引导只读取 schema_owner 凭据与显式队列重试次数，不复用运行期配置。 */
export function loadPgBossBootstrapConfig(env: NodeJS.ProcessEnv): {
    schemaOwnerUrl: string;
    jobRetryCount: number;
} {
    return {
        schemaOwnerUrl: requiredEnv(env, "DATABASE_URL_SCHEMA_OWNER"),
        jobRetryCount: explicitInteger(env, "PG_BOSS_JOB_RETRY_COUNT", 0),
    };
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

    const platformImage = loadPlatformImageConfig(env);
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
        ...(platformImage ? { platformImage } : {}),
    };
}
