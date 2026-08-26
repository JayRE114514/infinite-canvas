import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";

import { AppError } from "../../errors.js";
import type { Auth } from "./auth.js";
import type { RequestContext } from "./types.js";

function requireAuth(server: { auth?: Auth }): Auth {
    const { auth } = server;
    if (!auth) throw new Error("This app was built without auth; pass config to buildApp");
    return auth;
}

/** 会话缺失统一抛出稳定的未认证错误，业务路由后续再复查数据库成员身份。 */
export async function requireSession(request: FastifyRequest): Promise<RequestContext> {
    const auth = requireAuth(request.server);
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) throw new AppError("unauthenticated", 401, "请先登录");
    return { requestId: request.id, userId: session.user.id };
}
