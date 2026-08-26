import type { AppConfig } from "../../config.js";
import type { Mailer } from "../../infrastructure/email/mailer.js";
import type { AppDatabase } from "../../infrastructure/database/types.js";

/** 认证依赖全部由外部注入，模块内不建连接池、不读环境变量。 */
export type AuthDependencies = { db: AppDatabase; config: AppConfig; mailer: Mailer };

/** 通过会话校验后传给业务逻辑的最小上下文。 */
export type RequestContext = { requestId: string; userId: string };
