# 原生 Canvas 恢复契约

## 目的与权威

服务端 Canvas Snapshot 是业务权威。`infinite-canvas-recovery` 只保存浏览器中尚未安全同步的编辑和本机 UI 状态；它不能替代云端版本、普通缓存或未来 CRDT 文档。

恢复数据库固定使用原生 IndexedDB，版本 1 包含 `drafts`、`epochs`、`markers`。所有记录以不透明 Scope 隔离，Scope 由登录身份、Workspace 与 Canvas 推导。

## 唯一职责

| 模块 | 唯一职责 |
| --- | --- |
| Store | 在单个 IndexedDB 事务中读取、验证、判定并 CAS 写入 Draft/Epoch/Marker；遇到未知或损坏数据 fail-closed。 |
| Session | 持有当前标签页的 Draft Identity，按 `writeSeq` 单调持久化文档和 `localUi`；管理本地写调度与网络保存调度，但不做跨 Draft 协调。 |
| Manager | 打开时执行 prepare/commit、分配所有权、处理冲突、确认删除、清理冲突和触发 GC；只持有一个原生 Store。 |

运行时不得同时注入 legacy recovery 与 native Store，也不得恢复 `whenLocalSettled` 或 late-write compensation 双协议。

## 所有权与 prepare/commit

1. 每个标签页会话都铸造独立 `draftId`，不能复用另一会话或恢复来源行的 ID。
2. `prepare` 在一致快照上验证 Epoch、Draft 和 Marker，返回所有权候选、冲突和需要的 repair；它不修改 UI。
3. `commit` 只有在预期 `coordinationRevision` 与 `deletionGeneration` 仍匹配时才能应用所有权切换；否则重新读取和判定。
4. 恢复来源行只能用 `draftId + writeSeq` CAS 退役，防止删除另一个仍在工作的标签页行。
5. 渲染进程强杀后，恢复会话必须从来源内容铸造新的所有权行；来源行成功退役后不能继续接受迟到写入。

所有传入事务的可变对象必须先同步克隆；超时必须真实 `transaction.abort()`，不能只让 Promise 先返回。

## 调度与状态

本地持久化调度器与云端网络调度器互不等待。文档编辑立即排队写本地 Draft，并以有界合并减少序列化；云端保存按 revision 串行推进。

- `ok`：当前会话拥有可验证 Draft 行，允许云端保存。
- `recovery-blocked`：本地状态无法判定，必须暂停云端保存，避免覆盖未知草稿；编辑仍应尽可能进入本地队列。
- `conflict`：存在另一份未解决草稿，保留所有候选并要求用户载入服务端版本或导出本地草稿。
- `retry`：用户显式重试后重新 prepare/commit；只有新的所有权行被正面确认写入后才可解除阻断。
- `tombstoned`：服务器删除证明已验证；后续迟到写入按删除代次拒绝。

损坏 Epoch、非规范 Marker、重复记录、非法 Snapshot 或事务不可用都必须 fail-closed，不得猜测修复并继续云端写入。

## 删除、GC 与本机 UI

- Deletion Receipt 必须包含精确键集、匹配 Canvas ID、有效 UUID 回执和规范时间；传输层类型声明不是证明。
- 只有验证通过的回执才能在一个事务内推进 `deletionGeneration`、写墓碑并清除 Scope 下所有 Draft/Marker。
- 服务端已删除但本地清理失败属于 `localCleanupPending`，不能谎报服务端删除失败；没有证明则必须保留本地数据。
- GC 只能删除具有正向同步证明、未被保留、超过最小年龄且删除代次匹配的 Draft；`pending`、冲突候选和损坏记录不能按年龄回收。
- viewport 只写 `envelope.localUi.viewport`。它不得改变 Canvas Snapshot、推进 edit/revision 或触发云端保存。

## 已验证范围

Chrome 与 Firefox 已覆盖独立存储布局、每会话 CAS、损坏 fail-closed、删除证明、GC、viewport 隔离和渲染进程强杀恢复。Safari 由用户豁免，保持未验证。证据见 [Gate 0 前端验证](../content/docs/progress/gate-0-frontend-verification.mdx)。

