import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Auth } from "./auth.js";

/** Fastify 已解析过 body，这里回写成文本；GET 不带 body。 */
function toRequestBody(request: FastifyRequest): string | undefined {
    if (request.method === "GET") return undefined;
    if (request.body === undefined || request.body === null) return undefined;
    if (typeof request.body === "string") return request.body;
    return JSON.stringify(request.body);
}

async function handle(auth: Auth, request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const url = new URL(request.url, `${request.protocol}://${request.host}`);
    const headers = fromNodeHeaders(request.headers);
    const body = toRequestBody(request);

    // Fastify 解析后重新序列化，content-length 可能与原值不一致，交给 fetch 层重算。
    if (body !== undefined) {
        headers.delete("content-length");
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    const response = await auth.handler(new Request(url, { method: request.method, headers, body }));

    reply.status(response.status);

    // Set-Cookie 可能有多条，必须用 getSetCookie 逐条写回，不能被合并成一条。
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length > 0) reply.header("set-cookie", setCookie);

    for (const [key, value] of response.headers) {
        if (key.toLowerCase() === "set-cookie") continue;
        reply.header(key, value);
    }

    reply.send(await response.text());
}

const PUBLIC_IDENTITY_ROUTES = [
    { method: "POST", url: "/api/auth/sign-up/email" },
    { method: "POST", url: "/api/auth/sign-in/email" },
    { method: "GET", url: "/api/auth/get-session" },
    { method: "POST", url: "/api/auth/sign-out" },
    { method: "GET", url: "/api/auth/verify-email" },
    { method: "POST", url: "/api/auth/send-verification-email" },
] as const;

/** 只挂载前端身份会话所需的精确端点，Organization 业务面保持不可达。 */
export async function registerAuthRoutes(app: FastifyInstance, auth: Auth): Promise<void> {
    for (const route of PUBLIC_IDENTITY_ROUTES) {
        app.route({ ...route, handler: (request, reply) => handle(auth, request, reply) });
    }
}
