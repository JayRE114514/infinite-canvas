import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { HealthResponseSchema } from "@infinite-canvas/contracts";
import Fastify, { type FastifyServerOptions } from "fastify";

import { registerErrorHandler } from "./error-handler.js";

export type BuildAppOptions = Pick<FastifyServerOptions, "logger">;

export async function buildApp(options: BuildAppOptions = {}) {
    const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<TypeBoxTypeProvider>();

    registerErrorHandler(app);

    app.get("/api/v1/health/live", { schema: { response: { 200: HealthResponseSchema } } }, async () => ({ status: "ok" }) as const);

    return app;
}
