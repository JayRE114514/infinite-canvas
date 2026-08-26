import cors from "@fastify/cors";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { HealthResponseSchema } from "@infinite-canvas/contracts";
import Fastify, { type FastifyServerOptions } from "fastify";

import { registerErrorHandler } from "./error-handler.js";

const DEV_WEB_ORIGIN = "http://localhost:3000";

export type BuildAppOptions = Pick<FastifyServerOptions, "logger">;

/** 仅 development 放行 Vite origin，其余环境（含未设置）一律禁用跨域。 */
function resolveCorsOrigin(): string[] | false {
    return process.env.NODE_ENV === "development" ? [DEV_WEB_ORIGIN] : false;
}

export async function buildApp(options: BuildAppOptions = {}) {
    const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<TypeBoxTypeProvider>();

    await app.register(cors, { origin: resolveCorsOrigin(), credentials: true });

    registerErrorHandler(app);

    app.get("/api/v1/health/live", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: "ok" }) as const);

    return app;
}
