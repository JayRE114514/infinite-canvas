import cors from "@fastify/cors";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { HealthResponseSchema } from "@infinite-canvas/contracts";
import Fastify, { type FastifyServerOptions } from "fastify";

import { registerErrorHandler } from "./error-handler.js";

const DEV_WEB_ORIGIN = "http://localhost:3000";

export type BuildAppOptions = Pick<FastifyServerOptions, "logger"> & {
    /** 允许的跨域来源；false 表示禁用跨域。默认生产禁用，开发只放行 Vite origin。 */
    corsOrigin?: readonly string[] | false;
};

function resolveCorsOrigin(corsOrigin: BuildAppOptions["corsOrigin"]): readonly string[] | false {
    if (corsOrigin !== undefined) return corsOrigin;
    return process.env.NODE_ENV === "production" ? false : [DEV_WEB_ORIGIN];
}

export async function buildApp(options: BuildAppOptions = {}) {
    const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<TypeBoxTypeProvider>();

    await app.register(cors, { origin: resolveCorsOrigin(options.corsOrigin) as string[] | false, credentials: true });

    registerErrorHandler(app);

    app.get("/api/v1/health/live", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: "ok" }) as const);

    return app;
}
