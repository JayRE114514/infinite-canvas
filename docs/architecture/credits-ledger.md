# 积分账本契约

## 计量与权威

- 每个个人或团队 Workspace 拥有 Credit Account。
- 金额使用 `BIGINT` 最小整数单位；价格换算在边界完成，领域内不得使用浮点数。
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

赠送、充值占位、人工调整、退款和对账都必须记录 Actor、Workspace、目的、关联 Task/Order 和审计原因。平台管理员跨租户调整走窄口数据库函数并在同一事务内写不可变审计。

定期核对至少验证：账本交易平衡、Wallet 投影等于分录聚合、Hold 守恒、关闭 Order 没有活跃 Hold、成功 Task 恰有一次结算。超过阈值仍处于不明确状态的 Hold 默认进入 `review`；初始阈值为 24 小时，可通过受审配置调整。
