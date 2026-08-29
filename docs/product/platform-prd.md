# 无限画布平台 PRD

状态：Approved baseline

本文定义平台长期稳定的产品边界。当前实现状态以[后端平台架构](../architecture/backend-platform.md)和[路线图](../architecture/platform-roadmap.md)为准；目标能力未通过对应 Gate 前，不得在公开说明中写成已上线。

## 产品目标

无限画布是一个以云端画布为创作权威、以平台统一模型额度为 AI 能力入口的个人与团队工作台。首个可用版本需要做到：

1. 用户以账号登录，在个人或团队 Workspace 中创建、编辑、恢复和删除 Canvas。
2. Canvas 快照由 PostgreSQL 权威保存；浏览器只保留本机视口、媒体缓存和未同步编辑的恢复草稿。
3. 图片、视频、音频和导出文件最终以 Asset ID 引用，元数据进入 PostgreSQL，字节进入 S3 兼容对象存储。
4. 平台提供模型与额度，用户消费 Workspace 积分调用；冻结、结算、释放和退款必须可审计且不能重复执行。
5. 图片、视频等长任务可查询、可恢复、可对账，进度事件可以从断点重放。
6. Provider 差异封装在平台所有者维护的适配器内，不把中转站条件分支扩散到画布 UI。

## 初始容量假设

- 1,000–10,000 名注册用户；峰值同时在线低于 200。
- 容量数字是压测输入，不是可用性承诺；上线声明必须由目标负载、恢复演练和故障测试支持。
- 当前采用单区域模块化单体、独立 API/Worker 进程和 PostgreSQL 持久队列。Redis、RabbitMQ、Kubernetes 或多区域部署只能由实际指标和恢复目标触发。

## 明确非目标

首个完整平台版本不包括：

- 真实支付、提现或复杂财务清算；
- Yjs/Hocuspocus 多人实时协同；
- Keycloak、RabbitMQ、Redis、Kubernetes 或自动跨区域故障转移作为前置条件；
- 任意用户上传、URL 安装或执行第三方插件、远程节点脚本、Provider Adapter；
- 无限自定义 RBAC、复杂审批流或企业目录同步；
- 未上线历史浏览器数据的兼容迁移；
- 在 API 请求进程内执行 CPU 密集型媒体处理。

## 身份、Workspace 与角色

Better Auth 只回答“当前是谁”和“会话是否有效”。成员关系、角色、邀请和业务授权由 Workspace 领域负责，不得把认证组织表当作业务租户权威。

- 每个 User 终身拥有一个个人 Workspace；恢复原个人 Workspace，不创建替代品。
- 团队 Workspace 支持邀请和成员管理。
- 固定角色为 `owner`、`admin`、`member`；邀请只能授予 `admin` 或 `member`。
- 活跃 Workspace 必须恰有一个活跃 Owner，且与 `owner_user_id` 一致。
- 个人 Workspace 不能邀请成员、转移 Owner 或由本人自助停用。
- Workspace 生命周期为 `active | suspended | deactivated`；只有 `deactivated` 设置 `deletedAt`。
- `deactivated` 禁止创建新 AI Task，但保留历史；已接受的任务仍需完成或进入对账。
- 平台管理员跨租户操作必须走窄口数据库函数，并在同一事务内留下不可变审计。

身份注销只停用或匿名化身份引用，不得破坏 Workspace、账本、任务和审计历史。

## 核心资源与流程

### Canvas

- 服务端 `snapshot + revision` 是云端权威；客户端按 revision 条件保存，冲突不能静默覆盖。
- 本地恢复只保护未同步编辑，不是第二个业务权威。
- 删除必须收到并精确验证服务端 Deletion Receipt 后，客户端才可墓碑化和清理本地恢复状态。

详细契约见[原生画布恢复](../architecture/native-canvas-recovery.md)。

### Asset

- Asset 先取得稳定 ID，再上传字节；对象键由服务端生成且创建后不可变。
- 生命周期为 `staging -> ready | failed -> deleted`。
- 云端 Canvas 只保存结构化 `assetId`，不能保存 `blob:` URL、本地 `storageKey`、base64 或上游临时 URL。
- 清理只能作用于已确认无引用且超过保留期的对象。

详细契约见[Asset 生命周期](../architecture/assets.md)。

### 积分

- Credit Account 属于 Workspace，金额使用最小整数单位，不使用浮点数。
- 余额是不可变双重记账分录的投影，不允许把单个 `balance` 字段作为账务真相。
- AI Task 创建前冻结预计上限；成功捕获实际费用并释放余量，明确失败全额释放，不明确结果保持 Hold 进入对账。
- `idempotency_key` 相同且请求哈希相同必须重放原结果；键相同而哈希不同返回 `409 idempotency_conflict`。

详细契约见[积分账本](../architecture/credits-ledger.md)。

### AI Task 与 Provider

一个端到端任务必须满足以下纵向契约：

1. API 在同一 PostgreSQL 事务中验证成员权限、创建 AI Task、写入不可变价格快照、冻结积分并写入持久任务/Outbox 意图。
2. 数据库事务提交后，Worker 才能调用 Provider；远程调用不得占用业务事务。
3. Worker 通过租约代际和幂等键更新 Attempt、Task 与事件。
4. 成功结果先进入 Asset，再且仅再结算一次；明确失败释放 Hold；不明确结果进入 `reconciling`，禁止盲目重试和重复扣费。
5. Task Event 具有任务内单调序号，SSE 使用 `Last-Event-ID` 重放遗漏进度。

详细契约见[AI Task 与 Provider](../architecture/ai-task-provider.md)。

## 可执行扩展政策

所有会在平台、浏览器页面或 Worker 内执行的扩展都只能由项目所有者编写、审查并随版本或所有者控制的注册表发布，包括 Provider Adapter、画布节点插件和远程节点脚本。

- 普通用户只能选择平台已经发布的能力和配置自己的非执行数据。
- 普通用户不能通过 URL、上传文件、npm 包、数据库脚本或远程模块安装任意第三方执行代码。
- 当前源码中的旧 URL 节点插件安装入口是发布前必须禁用或移除的未发布遗留能力，不构成支持承诺。
- Codex App / Canvas Agent 属于项目所有者发布的客户端集成，不改变上述政策。

该决策见 [ADR-0003](../adr/0003-owner-maintained-provider-adapters.md)。

## 浏览器直连的退出条件

当前 Web 端仍把 AI API Key 保存在浏览器并直连 OpenAI 兼容上游，这是过渡状态。Gate 4 完成后，普通用户应只选择平台发布的模型能力：

- 平台密钥只存在于服务端密钥管理边界；
- 浏览器不再提交任意 Base URL 或平台 Provider Key；
- 现有“渠道”概念迁移为管理员维护的 Provider Route 与 Model Capability；
- 个人开发模式如继续保留，必须与平台积分、托管任务和生产声明明确隔离。

## Gate 验收目标

| Gate | 端到端目标 |
| --- | --- |
| Gate 0 | 架构、租户隔离、云 Canvas revision/删除证明和原生 IndexedDB CAS 恢复边界成立。 |
| Gate 1 | 注册、验证、登录、个人/团队 Workspace、邀请、成员权限和退出登录形成闭环。 |
| Gate 2 | Canvas 与 Asset 跨设备可用；对象上传、引用、删除、导出和孤儿清理遵守生命周期。 |
| Gate 3 | 个人/团队积分账户、双重记账、Hold、结算/释放/退款和并发幂等通过故障验证。 |
| Gate 4 | 至少一个图片 Provider 完成 Task → Hold → Attempt → Worker → Asset → 单次结算/释放 → SSE 重放，并覆盖 `reconciling`。 |
| Gate 5 | 生产密钥、迁移、备份恢复、审计、限流、队列重放、Provider 冒烟、容量和故障演练通过。 |

## 首个完整版本范围

必须具备账号与个人 Workspace、基础团队成员管理、云 Canvas、对象存储 Asset、Workspace 积分、管理员调整、至少一个图片 Provider、任务幂等、浏览器恢复和 SSE 进度。真实支付、实时协同、任意插件、自动故障转移和复杂 RBAC 均延后。
