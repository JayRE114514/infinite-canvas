# Domain Context

本文档只定义跨模块稳定使用的领域词汇。实现约束与取舍见 `docs/architecture/` 和 `docs/adr/`。

- **User**：通过认证建立身份的人。认证系统回答“是谁”，不拥有业务成员关系。
- **Workspace**：个人或团队的租户与计费边界；业务数据归属、权限和积分账户均以此为主要作用域。
- **Canvas**：Workspace 内的创作资源。当前云端权威形式是带 `revision` 的完整快照。
- **Canvas Snapshot**：一次可被服务端版本控制的画布文档状态；不包含仅属于本机 UI 的视口状态。
- **Local Recovery Draft**：浏览器为防止未同步编辑丢失而保存的临时恢复副本，不是业务权威数据源。
- **Deletion Receipt**：服务端确认某个 Canvas 已删除的精确证明；客户端只有验证通过后才能清理或墓碑化本地恢复数据。
- **Asset**：图片、视频、音频或导出文件等媒体对象；元数据属于 PostgreSQL，文件字节属于对象存储。
- **Credit Account**：个人或团队的积分账户。余额必须由不可变账本推导，不能作为可任意改写的单列状态。
- **Credit Hold**：AI 任务开始前对预计费用的冻结；任务结算、释放或退款必须幂等。
- **AI Task**：一次可持久化、可查询、可重试但不能重复扣费的模型调用工作单元。
- **Provider Attempt**：AI Task 对某个上游 Route 的一次具体尝试；保存精确模型、适配器版本、远程任务标识和失败分类。
- **Task Event**：带任务内单调序号的持久事件；查询与 SSE 重放以它为权威。
- **Provider Adapter**：由项目所有者编写并随平台发布的上游协议适配器；普通用户不能安装任意第三方执行代码。
- **Executable Plugin**：会在浏览器、API 或 Worker 内执行代码的扩展，包括画布节点插件、远程节点脚本和 Provider Adapter；只能由项目所有者维护并发布。
