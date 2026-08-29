# AI Task 与 Provider 契约

## 领域记录

- **AI Task**：Workspace 范围的用户意图、规范化输入、能力、模型、状态、幂等键、请求哈希、结果引用、公开错误、租约代际与时间。
- **Provider Attempt**：一次具体上游尝试，记录 Attempt 序号、Route、Adapter 版本、精确上游模型、Provider 幂等键、远程任务 ID、状态、失败分类和脱敏元数据。
- **Task Event**：任务内单调序号的物化事件，供查询、审计和 SSE 重放。
- **Provider Adapter**：项目所有者维护的静态协议边界，声明能力 schema、提交、轮询、取消、结果解析和错误分类；不得动态执行数据库脚本、用户上传包或远程模块。

## 创建事务

`POST /ai/tasks` 使用调用方幂等键。一个 PostgreSQL 事务必须依次完成：

1. 验证 User 是目标 Workspace 的有效成员并具备能力权限；
2. 按 `idempotency_key + request_hash` 重放或拒绝冲突；
3. 创建 AI Task 与不可变价格快照/Billing Order；
4. 锁定 Wallet，创建 Credit Hold 和平衡分录；
5. 创建首个 Provider Attempt；
6. 写入持久队列 Job，或写入由 Outbox 投递的等价意图；载荷只包含稳定 ID 与协议版本；
7. 提交后返回 `202`、`taskId`、状态和预计积分。

任何 Provider 网络调用都在事务提交后执行。初始队列可使用与业务事务同库的 pg-boss；未来切换 RabbitMQ 时必须通过 Outbox 保持原子性，不能先发消息后写业务状态。

## 状态机与租约

```text
queued -> submitting -> processing -> storing -> succeeded
                     \-> failed
                     \-> reconciling -> processing | storing | succeeded | failed
```

- `storing` 只适用于可重新获取或已经持久化的输出；丢失的同步 base64 响应不能伪装为可存储结果，应进入 `reconciling`。
- Worker 领取任务时增加 `lease_epoch` 并写租约期限/Worker ID。所有状态、结果、事件和积分结算写入都必须携带当前代际；旧 Worker 的迟到写入被拒绝。
- 队列采用至少一次语义。消费者可以重复运行，但每个状态迁移、Asset 创建和账务变化必须幂等。

## 失败分类与重试

Adapter 必须把结果分类为：

- `safe_retry`：有证据证明上游未接受，可按预算重试；
- `provider_processing`：已获得远程任务 ID，继续轮询；
- `terminal`：明确失败，不再提交；
- `ambiguous`：提交后断线、超时、500/502 等可能已经被接受；
- `success`：输出和计费事实明确。

`ambiguous` 不能盲目再次提交。任务进入 `reconciling`，优先使用 Provider 幂等键、远程任务 ID、查询接口或人工对账确认。轮询请求可在有界退避下重试，但不得创建第二次上游任务。

## 结果、Asset 与结算

- 成功输出先下载/校验并写入 Asset；需要的 Asset 全部 `ready` 后，Task 才能 `succeeded`。
- 成功在一个事务中捕获实际费用、释放余量、关闭 Hold、写 Task Event，并以租约代际和结算幂等键防重。
- 明确失败在一个事务中释放 Hold、关闭 Order 并写失败事件。
- 不明确结果保持 Hold 和 `reconciling/review`，不能为了清理队列而自动退款或扣费。
- 管理员对账只能追加补偿与审计，不能修改历史 Attempt 或 Ledger Entry。

## 查询与 SSE

Task 查询返回当前物化状态、结果 Asset ID、公开错误和最近事件序号。SSE 以 Task Event 为权威：

- 每个 Task 的 `sequence` 唯一且单调；
- 客户端携带 `Last-Event-ID` 时，服务端先重放更大的已持久化事件，再切换实时流；
- 实时通知只用于唤醒读取，不能取代事件持久化；
- 重连、重复事件和 Worker 重投不得产生重复 UI 结果或重复结算。

## 浏览器退出边界

Gate 4 完成后，普通用户不再配置任意 Provider Base URL 或平台密钥。Web 端提交能力 ID、模型选择和业务输入，由服务端 Route 选择所有者维护的 Adapter。浏览器直连仅可作为明确隔离的个人开发模式，不得共享平台积分、托管任务或生产密钥。

