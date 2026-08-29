# 积分账本契约

## 计量与权威

- 每个个人或团队 Workspace 拥有 Credit Account。
- PostgreSQL 金额列使用 `BIGINT` 最小整数单位。
- Drizzle 与领域模块中的金额一律使用 `bigint`。
- HTTP JSON 请求和响应中的金额一律使用规范十进制字符串，语法为 `0|-?[1-9][0-9]*`；正号、前导零、小数、指数、空白和空字符串均不规范。要求非负的字段在解析为 `bigint` 后继续验证非负不变量。
- HTTP Adapter 是金额表示的唯一转换 seam：入站规范字符串只解析一次，出站只由 `bigint` 生成规范字符串。领域模块、数据库 Adapter、日志参数和幂等请求规范化都不得把积分金额转换为 JavaScript `number`。
- 不可变 Ledger Entry 是账务权威；Wallet 的 `available_amount` 与 `held_amount` 只是事务内维护、可由账本核对的投影。
- 任何业务交易的所有分录总和必须为零，并由数据库延迟约束在提交时验证。
- 已提交分录不得更新或删除；更正只能追加引用原交易的补偿交易。

## 并发与幂等

影响余额的事务必须锁定目标 Wallet，并保证 `available_amount >= 0`、`held_amount >= 0`。所有外部可重试操作带：

- `operation_key`：调用方稳定提供的幂等键；
- `request_hash`：规范化业务输入的哈希。

同一键与同一哈希重放原结果；同一键与不同哈希返回 `409 idempotency_conflict`，不能覆盖旧操作或创建第二次账务变化。

## Billing Order 与 Hold

每个计费 AI Task 对应一个 Billing Order，创建后固定：模型能力、计价版本、价格快照、预计上限、实际金额和状态 `reserved | settled | released | review`。

Order 创建时由服务端时间确定 `reviewAfter = createdAt + 24 小时`。如果在 `now >= reviewAfter` 时仍无法确认上游结果，则 Order 从 `reserved` 进入 `review`，关联 AI Task 或处理流程进入 `reconciling`；Credit Hold 保持 `active`，`original_amount`、`captured_amount` 与 `released_amount` 均不得因到时而改变。24 小时只是人工/对账升级边界，不是自动 capture、release、退款或重试边界；调整该值前必须先更新领域契约并取得确认。

Credit Hold 保存 `original_amount`、`captured_amount`、`released_amount` 与 `active | closed`：

```text
captured_amount + released_amount <= original_amount
status = closed  =>  captured_amount + released_amount = original_amount
```

- 创建任务：从 available 转入 held，记录 Hold 和双向分录。
- 成功：捕获实际金额，释放剩余金额；一次事务关闭 Hold。
- 明确失败/取消：全额释放未捕获金额。
- 结果不明确：保持 Hold，Order 进入 `review`，由对账流程决定捕获或释放。
- 退款：追加补偿交易，不修改原捕获分录。

任何任务消息、Worker 重投或管理员重试都必须复用业务幂等键；至少一次消息投递不能造成第二次捕获或释放。

## 管理员与核对

管理员 purpose 使用 closed-world 完整性门槛。一个 purpose 只有在以下四层同时存在时才允许加入 `begin_admin_operation` 白名单并对应用层表现为可执行：

1. begin 阶段的精确 purpose 白名单；
2. 只处理该领域行为的窄口执行函数；
3. 对应审计存储的 action CHECK；
4. 只允许该 purpose、当前 actor、当前 target、当前 xid 与当前 operation 的审计 RLS 分支。

TypeScript purpose 联合类型只是该白名单的镜像，不能比数据库可执行集合更宽。所有管理员窄口固定 `search_path`，从当前 xid 绑定的 Admin Operation 推导 actor、target 与 purpose，保持默认拒绝 RLS，并在业务变更的同一事务内强制写入恰好一条不可变审计；不能依赖 TypeScript 先写审计再改余额的调用顺序。

现有 `execute_workspace_admin_operation()` 只承担已经完整实现的 `workspace_read | workspace_suspend | workspace_deactivate | workspace_restore`，不得扩展成支持所有积分操作的宽泛分派器。`wallet_adjust` 只能由独立的 `SECURITY DEFINER` 窄口执行，在一次事务中锁定目标 Wallet、追加平衡 Ledger Entry、更新 Wallet 投影并写入恰好一条管理员审计。

截至本契约形成时，`wallet_adjust` 尚未实现完整执行面，因此仍不可执行。`wallet_status_write`、`billing_confirm_charge`、`billing_confirm_no_charge`、其他 `billing_*`、`ledger_compensate`、`workspace_export` 以及平台级 purpose 也未实现，均不得出现在有效 begin 白名单、路由能力或“已支持”说明中。当前代码中提前列出的未来 purpose 只是待收紧的实现差距，不构成能力承诺。

赠送、充值占位、人工调整、退款和对账都必须记录 Actor、Workspace、purpose、关联 Task/Order 和审计原因。

定期核对至少验证：账本交易平衡、Wallet 投影等于分录聚合、Hold 守恒、关闭 Order 没有活跃 Hold、成功 Task 恰有一次结算，以及到达 `reviewAfter` 的不明确结果只升级为 `review/reconciling` 而没有金额变化。

## 模块与 seam

- **Credit Amount Adapter**：位于 HTTP seam，只负责规范十进制字符串与 `bigint` 的双向转换；调用方不接触第二套金额表示。
- **Credit Ledger Module**：以少量领域命令隐藏 Wallet 行锁、双重记账、投影维护、幂等冲突和 Hold 守恒；其 Interface 只接收和返回 `bigint` 金额。
- **Admin Execution Adapter**：每个可执行 purpose 使用独立数据库窄口；`wallet_adjust` 的审计与账务原子性位于该 seam 内，不向 TypeScript 暴露可拆分的“先调整、后审计” Interface。

## 后续最小实现切片

1. **收紧 purpose 集合**：从数据库 begin 白名单与 TypeScript 镜像中移除所有未实现 purpose，只保留执行函数、审计 CHECK 与审计 RLS 已完整覆盖的四个 Workspace 生命周期用途；验证未知和未来 purpose 均被拒绝。
2. **建立金额边界**：实现规范十进制字符串与 `bigint` 的唯一 HTTP Adapter，覆盖负号、前导零、指数、小数和超过 `Number.MAX_SAFE_INTEGER` 的输入；该切片不创建积分 schema。
3. **建立账本内核**：实现 Credit Account、Wallet、平衡交易与不可变 Ledger Entry 的 PostgreSQL/领域模块，先验证零和、非负投影、不可变与并发锁定，不接管理员或 AI Task 路由。
4. **接入 `wallet_adjust` 纵向切片**：在同一迁移中加入 begin purpose、独立执行窄口、审计 action CHECK 与审计 RLS，再接单一路由；验证同 xid 推导、平衡分录、投影更新和恰好一条不可变审计。
5. **实现 Billing Order 与 Hold 命令**：通过 Credit Ledger Module 加入 reserve、capture、release 和补偿命令，验证幂等冲突、并发与 Hold 守恒；不接 Provider 网络调用。
6. **实现 24 小时复核升级**：持久化 `createdAt/reviewAfter`，只把未确认结果推进到 `review/reconciling`，以故障路径证明 Hold 和所有金额未变化。后续其他管理员 purpose 必须各自重新通过 closed-world 完整性门槛。
