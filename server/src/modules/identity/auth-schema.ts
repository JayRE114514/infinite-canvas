import { accounts, sessions, users, verifications } from "./schema.js";

// Better Auth 适配器视图：只包含身份四张表，Workspace 已由 Workspaces 模块自有。
// 本文件是 Identity 私有实现，其他模块一律不得导入；跨模块请用 identity/schema.ts。
export { accounts, sessions, verifications };

/** Drizzle 适配器按解析后的模型名取表，键名必须与 modelName 一致。 */
export const authSchema = { users, sessions, accounts, verifications };
