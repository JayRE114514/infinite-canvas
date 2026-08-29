# Domain Context

本文档只定义跨模块稳定使用的领域词汇。实现约束与取舍见 `docs/architecture/` 和 `docs/adr/`。

- **User**：通过认证建立身份的人。认证系统回答“是谁”，不拥有业务成员关系。
- **Workspace**：个人或团队的租户与计费边界；业务数据归属、权限和积分账户均以此为主要作用域。
- **Canvas**：Workspace 内的创作资源。当前云端权威形式是带 `revision` 的完整快照。
- **Canvas Snapshot**：一次可被服务端版本控制的画布文档状态；不包含仅属于本机 UI 的视口状态。
- **Local Recovery Draft**：浏览器为防止未同步编辑丢失而保存的临时恢复副本，不是业务权威数据源。
- **Deletion Receipt**：服务端确认某个 Canvas 已删除的精确证明；客户端只有验证通过后才能清理或墓碑化本地恢复数据。
- **Asset**：图片、视频、音频或导出文件等媒体对象；元数据属于 PostgreSQL，文件字节属于对象存储。
- **Credit Amount**：以平台最小积分单位计数的精确整数；不存在小数、近似值或舍入后的等价表示。
- **Credit Account**：个人或团队的积分账户。余额必须由不可变账本推导，不能作为可任意改写的单列状态。
- **Wallet**：Credit Account 的可用金额与冻结金额投影；它便于事务检查，但不是账务历史权威。
- **Ledger Entry**：属于一笔平衡交易的不可变有符号金额记录；历史更正通过新交易完成。
- **Billing Order**：一次计费意图及其固定价格依据；它独立记录预留、结算、释放或人工复核状态。
- **Credit Hold**：Billing Order 对预计费用的冻结；结果未确认时继续保留，只有已确认结算或释放才能关闭。
- **Reconciliation**：在上游结果不明确时确认真实业务结果的过程；期间不得用自动扣费或退款代替事实确认。
- **Admin Operation**：平台管理员针对平台或 Workspace 发起的一次具名操作；actor、target、purpose 与唯一审计共同界定其身份。
- **AI Task**：一次可持久化、可查询、可重试但不能重复扣费的模型调用工作单元。
- **Provider Attempt**：AI Task 对某个上游 Route 的一次具体尝试；保存精确模型、适配器版本、远程任务标识和失败分类。
- **Task Event**：带任务内单调序号的持久事件；查询与 SSE 重放以它为权威。
- **Provider Adapter**：由项目所有者编写并随平台发布的上游协议适配器；普通用户不能安装任意第三方执行代码。
- **Executable Plugin**：会在浏览器、API 或 Worker 内执行代码的扩展，包括画布节点插件、远程节点脚本和 Provider Adapter；只能由项目所有者维护并发布。
