# ADR 0004：积分金额与执行边界

状态：Accepted

平台积分采用端到端精确整数：PostgreSQL 使用 `BIGINT` 最小整数单位，Drizzle 与领域模块使用 `bigint`，HTTP JSON 只使用规范十进制字符串；积分金额在任何环节都不得转换为 JavaScript `number`。相比直接使用 JSON number，这会增加一层边界编解码，但能避免超过安全整数范围或序列化往返造成静默账务误差。

管理员 purpose 采用 closed-world：只有 begin 白名单、对应的独立窄口执行函数、审计 action CHECK 和审计 RLS 同时存在的 purpose 才可执行。`wallet_adjust` 必须使用独立的固定 `search_path` `SECURITY DEFINER` 窄口，从当前 xid 绑定操作推导 actor、target 与 purpose，并在同一事务内完成账务调整和恰好一条不可变审计；现有 `execute_workspace_admin_operation()` 不扩展为积分通用分派器。

Billing Order 创建时固定 `reviewAfter = createdAt + 24 小时`。到达 `now >= reviewAfter` 仍无法确认结果时，只把 Order 从 `reserved` 推进到 `review`、把关联任务或处理流程推进到 `reconciling`，Hold 与金额保持不变；时间到达本身不得触发 capture 或 release。

完整不变量、当前可执行范围和后续实现切片见[积分账本契约](../architecture/credits-ledger.md)。
