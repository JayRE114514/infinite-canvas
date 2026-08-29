import cors from "@fastify/cors";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { HealthResponseSchema, UnavailableResponseSchema } from "@infinite-canvas/contracts";
import Fastify, { type FastifyServerOptions } from "fastify";

import type { AppConfig } from "./config.js";
import { registerErrorHandler } from "./error-handler.js";
import { createDatabase } from "./infrastructure/database/client.js";
import { checkDatabaseReady, registerDatabase } from "./infrastructure/database/plugin.js";
import type { DatabaseHandle } from "./infrastructure/database/types.js";
import { createSmtpMailer, type Mailer } from "./infrastructure/email/mailer.js";
import { createTencentCosStorage } from "./infrastructure/object-storage/tencent-cos.js";
import type { ObjectStorage } from "./infrastructure/object-storage/types.js";
import { createArtBoxAdapter, type ArtBoxAdapter } from "./modules/artbox/adapter.js";
import { registerArtBoxRoutes } from "./modules/artbox/routes.js";
import { registerAssetRoutes } from "./modules/assets/routes.js";
import { registerCanvasRoutes } from "./modules/canvases/routes.js";
import { createAuth } from "./modules/identity/auth.js";
import { registerAuthRoutes } from "./modules/identity/routes.js";
import { registerPlatformAdminRoutes } from "./modules/platform-admin/routes.js";
import { registerWorkspaceRoutes } from "./modules/workspaces/routes.js";
import { provisionPersonalWorkspace } from "./modules/workspaces/service.js";

const DEV_WEB_ORIGIN = "http://localhost:3000";

export type BuildAppOptions = Pick<FastifyServerOptions, "logger"> & {
    /** 传入则挂载 appConfig；省略时保持纯应用构造，不读取环境变量。 */
    config?: AppConfig;
    /** 由测试注入的连接句柄，生命周期归调用方，应用关闭时不释放。 */
    database?: DatabaseHandle;
    /** 由测试注入的内存邮件发送器；省略且有 config 时使用 SMTP 实现。 */
    mailer?: Mailer;
    /** 测试可注入确定性对象存储；生产在 COS 配置完整时构造官方 SDK 适配器。 */
    objectStorage?: ObjectStorage;
    /** 测试可注入确定性的 ArtBox 协议边界与结果下载 fetch。 */
    artBoxAdapter?: ArtBoxAdapter;
    fetchImpl?: typeof fetch;
};

/** 仅 development 放行 Vite origin，其余环境（含未设置）一律禁用跨域。 */
function resolveCorsOrigin(): string[] | false {
    return process.env.NODE_ENV === "development" ? [DEV_WEB_ORIGIN] : false;
}

/** 注入优先；仅有 config 时由应用自建并持有连接池；两者都没有则完全不连接数据库。 */
function resolveDatabase(options: BuildAppOptions): { database: DatabaseHandle; ownsPool: boolean } | undefined {
    if (options.database) return { database: options.database, ownsPool: false };
    if (options.config) return { database: createDatabase(options.config.database), ownsPool: true };
    return undefined;
}

export async function buildApp(options: BuildAppOptions = {}) {
    const app = Fastify({
        logger: options.logger ?? true,
        ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    }).withTypeProvider<TypeBoxTypeProvider>();

    const resolved = resolveDatabase(options);

    // 连接池创建之后的任何构造失败都要释放自建连接池，避免启动失败仍占用连接。
    try {
        await app.register(cors, { origin: resolveCorsOrigin(), credentials: true });

        registerErrorHandler(app);

        if (options.config) app.decorate("appConfig", options.config);

        if (resolved) registerDatabase(app, resolved);

        // 认证需要配置与数据库同时存在；纯应用构造保持无数据库、无认证。
        if (options.config && resolved) {
            const mailer = options.mailer ?? createSmtpMailer(options.config);
            const onEmailVerified = async (user: { id: string; name: string; email: string }): Promise<void> => {
                await provisionPersonalWorkspace(resolved.database.db, user, {
                    source: "email_verification",
                    eventId: `personal-workspace:email-verification:${user.id}`,
                });
            };
            const auth = createAuth({
                db: resolved.database.db,
                config: options.config,
                mailer,
                onEmailVerified,
            });

            app.decorate("auth", auth);
            await registerAuthRoutes(app, auth);
            registerWorkspaceRoutes(app, mailer);
            registerCanvasRoutes(app);
            const objectStorage =
                options.objectStorage ?? (options.config.cos ? createTencentCosStorage(options.config.cos) : undefined);
            registerAssetRoutes(app, objectStorage);
            const fetchImpl = options.fetchImpl ?? fetch;
            const artBoxAdapter =
                options.artBoxAdapter ??
                (options.config.artbox ? createArtBoxAdapter(options.config.artbox, fetchImpl) : undefined);
            registerArtBoxRoutes(app, objectStorage, artBoxAdapter, fetchImpl);
            registerPlatformAdminRoutes(app);
        }

        app.get("/api/v1/health/live", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: "ok" }) as const);

        if (resolved) {
            app.get(
                "/api/v1/health/ready",
                { schema: { response: { 200: HealthResponseSchema, 503: UnavailableResponseSchema } } },
                async (_request, reply) => {
                    if (await checkDatabaseReady(resolved.database)) return { status: "ok" } as const;
                    return reply.status(503).send({ status: "unavailable" } as const);
                },
            );
        }

        return app;
    } catch (error) {
        if (resolved?.ownsPool) await resolved.database.pool.end().catch(() => {});
        throw error;
    }
}
