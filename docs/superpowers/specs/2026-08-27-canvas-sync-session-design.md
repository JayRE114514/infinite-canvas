# 画布同步会话架构设计（Task 3 重构）

状态：已确认，待实施

基线提交：`aa498df84e84b9158cdb743b568320ad4c598c39`

上游文档：`docs/superpowers/specs/2026-08-26-backend-platform-architecture-design.md`、`docs/superpowers/plans/2026-08-26-cloud-canvases-assets.md`（Task 3）

适用范围：`web/` 侧画布同步边界。服务端 Canvas HTTP 契约、`packages/contracts`、数据库迁移与 `server/` 模块一律不改。

## 1. 背景与裁决

Task 3 已经把画布改成服务端权威存储，`fa7e297..aa498df` 共四次实现、三轮独立只读审查。功能面已经收敛，但每一轮审查都在同一类问题上给出新的 Critical/Important：迟到的异步结果改写当前画布、冲突入口丢失、"已保存"在仍有未保存编辑时成立、冲突重载窗口内一次拖动把旧内容写回服务端、拖动时每帧序列化整份快照并写一次 IndexedDB。

这些不是彼此独立的缺陷，而是同一个结构问题的不同表现：**同步算法的所有权、生命周期与状态被拆散在模块级可变量和 React effect 里**。

具体到 `aa498df`：

- 所有权隐式。`saveTimer`、`pendingSave`、`localTimer`、`pendingEdit`、`saveChain`、`draftChains`、`pendingDraftRecords`、`activeGeneration` 都是 `use-canvas-store.ts` 的模块级可变量。判断"这条异步结果是否仍属于当前画布"，要在每个函数里手写 `scopeToken`、`scope`、`canvasId`、`generation`、`saveRevision` 五重校验，漏掉任意一处就是一次静默覆盖。
- 生命周期隐式。计时器与 Promise 链是全局单例，一个画布挂起的本地写或网络保存会阻塞另一个画布的打开、新建与删除。
- 状态隐式。`saveState`、`conflict`、`recoveryError`、`saveRevision.block`、`saveRevision.dirty`、`saveRevision.latest` 是六份互相关联又各自可变的事实，没有单一真相，因此"已保存"可以在仍有未保存编辑时成立。
- 驱动方隐式。`project.tsx` 通过 `syncedContentRef`、`syncedViewportRef`、`reloadRunRef`、`projectLoaded` 直接参与同步决策，React 的重渲染顺序变成同步正确性的一部分。

裁决（方案 A）：把同步算法收敛为一个显式对象 `CanvasSyncSession`。一次打开创建一个实例，实例是所有权、生命周期与状态的唯一载体；`CanvasSyncManager` 负责作用域与实例更替；Zustand 退化为视图适配器；React 页面只负责补水与渲染。方案 B/C 的取舍见第 17 节。

## 2. 目标与非目标

### 2.1 目标

- 单一所有权：任何时刻只有一个已安装会话能改写画布内容与同步状态；迟到结果一律被会话令牌拒绝，不需要在调用点重复手写校验。
- 单一真相：保存状态、冲突状态、本地落盘健康度都由会话的一份不可变视图导出，UI 不再自行推断。
- 无静默覆盖：服务端内容只能被"用户显式动作 + 令牌校验通过的提交"替换，本地内容只能被同一会话推进。
- 无静默丢失：任何未成功保存到服务端的本地内容，都必须有一条可从界面导出的路径；确实无法落盘时必须显式告知，而不是假装成功。
- 有界资源：本地写、网络写、内存中的完整快照数量、detached 会话数量都有明确上限，慢速或永不返回的 IndexedDB 不能冻结云端保存。
- 可拆解交付：重构范围限定在画布同步边界，7 天上线目标不变。

### 2.2 非目标

- 不实现多人实时协同、CRDT、OT 或操作日志（协议边界仍留在后端架构文档中）。
- 不实现离线优先与跨会话操作队列；断网时只保证本地草稿与显式错误提示。
- 不改服务端契约、路由、迁移与保存条件更新语义。
- 不解决媒体跨设备可移植性，该问题属于 Task 4/5 的 Asset 切换。
- 不引入 Redis、WebSocket、Service Worker 与前端测试框架。会话被设计成可注入依赖（仓储、本地存储、时钟）的纯 TypeScript 对象，日后补测试无需再次改结构，但本次不加测试框架，验收依赖第 14 节的人工矩阵。

## 3. 组件边界

### 3.1 依赖方向

```text
React 页面 / 画布组件
  │  只调用 actions，只渲染 view model
  ▼
useCanvasStore（Zustand，视图适配器）
  │  订阅会话视图，转发调用
  ▼
CanvasSyncManager（作用域 + active session + 有界 detached sessions）
  │
  ├─► CanvasSyncSession（单画布状态机 + 本地/网络两个调度器）
  │        ├─► canvasRepository（纯 HTTP 映射）
  │        └─► canvasLocalRecovery（草稿 + 每画布冲突 marker）
  └─► canvasRepository（列表、新建、导入、删除、导出读取）
```

反向依赖一律禁止：`canvasRepository` 与 `canvasLocalRecovery` 不得 import store 或 manager；`CanvasSyncSession`/`CanvasSyncManager` 不得 import React 或任何组件；组件不得 import session 实现细节，只能通过 store 暴露的视图与动作访问。

### 3.2 职责与禁止事项

| 组件 | 职责 | 明确禁止 |
| --- | --- | --- |
| `CanvasSyncSession` | 一次打开的全部同步事实：内容、revision、编辑序号、阶段状态机、本地草稿调度、网络保存调度、冲突与恢复态、有界 detached flush | 不读全局 store；不感知路由；不做媒体补水；不持有 React 状态 |
| `CanvasSyncManager` | 作用域（userId + workspaceId）与作用域令牌；持有唯一 active session；prepare/commit 更替；detached 会话上限与生命周期；列表级操作编排 | 不实现保存/草稿算法；不直接改 React 状态；不越过 session 改写画布内容 |
| `canvasRepository` | 服务端契约与 `CanvasProject` 的双向映射、请求编排、超时、`revision_conflict` 分类 | 不引用 Zustand；不做重试策略；不感知会话与草稿 |
| `canvasLocalRecovery` | 草稿记录与每画布冲突 marker 的读写删、键构造、记录校验、过期草稿回收 | 不决定何时写；不判断冲突语义；不做防抖与串行调度 |
| `useCanvasStore` | 可渲染视图模型（作用域、列表、活动画布 ID、会话视图）与动作转发 | 不持有计时器、Promise 链、revision 算法与 lineage 判定 |
| 画布页面/组件 | 路由参数、媒体补水、渲染闸门、把用户操作转成 `update` 调用 | 不驱动同步算法；不自行判断"这次变更要不要保存"；不直接读写草稿 |
| Agent bridge | 在会话与 UI 同时就绪且 scope/route/canvasId 三者一致时发布画布上下文 | 未就绪时不得发布快照，也不得接受 `applyOps` |

## 4. 本地恢复数据模型

### 4.1 存储位置与键

项目尚未上线，不保留旧键兼容层。新模块使用新的 localforage store，并在模块初始化时对旧 store 做一次 best-effort 丢弃（失败忽略，不阻塞任何流程）：

- 新 store：`localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_recovery" })`
- 旧 store：`localforage.dropInstance({ name: "infinite-canvas", storeName: "canvas_drafts" })`，只在新模块首次加载时执行一次。

键格式：

| 记录 | 键 | 数量 |
| --- | --- | --- |
| 草稿 | `canvas-draft:<userId>:<workspaceId>:<canvasId>:<draftId>` | 每会话一条 |
| 冲突 marker | `canvas-conflict:<userId>:<workspaceId>:<canvasId>` | 每画布一条 |

`userId`、`workspaceId`、`canvasId` 用 `encodeURIComponent` 编码。`draftId` 是会话创建时生成的 `nanoid()`，只在会话生命周期内固定不变。

把 revision 从键移到记录体，是这次结构调整的关键之一：会话在整个生命周期内只写同一个键，保存成功后原地更新 `baseRevision`，因此不再需要"新键写入 + 旧键删除"的交接顺序，也就不存在交接窗口被并发清理误删的问题。记录体自带 `baseRevision`，读取时校验，安全性与旧的键内 revision 等价。

### 4.2 记录结构

```ts
export type CanvasDraftRecord = {
  userId: string;
  workspaceId: string;
  canvasId: string;
  draftId: string;
  /** 该内容所基于的服务端 revision。 */
  baseRevision: number;
  /** pending：尚未确认保存到服务端；synced：内容已被服务端在 baseRevision 确认。 */
  state: "pending" | "synced";
  title: string;
  snapshot: CanvasSnapshot;
  savedAt: string;
};

export type CanvasConflictMarkerEntry = { draftKey: string; draftId: string; baseRevision: number; savedAt: string };

export type CanvasConflictMarker = {
  userId: string;
  workspaceId: string;
  canvasId: string;
  /** 最新在前，最多保留 2 条。 */
  entries: CanvasConflictMarkerEntry[];
};
```

读取时逐字段校验；作用域字段与请求作用域不一致、`baseRevision` 不是非负安全整数、`snapshot` 不是对象、`entries` 为空或超过 2 条，都判为"记录无效"。无效与"读不出来"是两种不同结果，见 4.4。

### 4.3 冲突的统一定义

**冲突 = 本地存在一份 `state === "pending"` 且 `baseRevision` 与服务端当前 revision 不一致的内容。**

它有两条产生路径，行为完全一致：

1. 在线路径：保存返回 `409 revision_conflict`。
2. 崩溃/离线路径：打开画布时发现一条未被 marker 引用、`state === "pending"` 且 `baseRevision !== serverRevision` 的草稿。此时把它提升为 marker 条目，并按冲突处理。

`state === "synced"` 的草稿永远不是冲突：它表示"这份内容已经被服务端确认"，打开时直接删除。这条字段消除了"服务端已确认但本地删除未完成"造成的假冲突。

### 4.4 打开画布时的本地恢复判定

按顺序判定，先命中先返回：

| 条件 | 结果阶段 | 画布内容 | 网络保存 |
| --- | --- | --- | --- |
| marker 或草稿读取超时/异常（重试一次后仍失败） | `recovery-blocked` | 服务端内容 | 阻断 |
| marker 有效且其首条 entry 指向的草稿有效 | `conflict` | 该草稿内容 | 阻断 |
| marker 有效但 `entries[0]` 指向的草稿缺失或校验失败 | 取 `entries` 中第一条指向有效草稿的条目作为冲突入口，并剔除无效条目后重写 marker | 该条目对应的草稿内容 | 阻断 |
| marker 的全部条目都无效 | 继续下一条判定，并 best-effort 删除该 marker | — | — |
| 无 marker，存在 `pending` 草稿且 `baseRevision === serverRevision` | `dirty` | 草稿内容，并立即安排一次保存 | 允许 |
| 无 marker，存在 `pending` 草稿且 `baseRevision !== serverRevision` | `conflict`（写入新 marker 指向它） | 该草稿内容 | 阻断 |
| 无 marker，存在 `synced` 草稿 | `clean`，删除该草稿 | 服务端内容 | 允许 |
| 无 marker、无草稿 | `clean` | 服务端内容 | 允许 |

冲突时显示本地草稿内容而不是服务端内容，是刻意选择：自动保存已经停止，屏幕上应当是用户自己那份未保存的工作，服务端副本通过冲突条的"载入服务端版本"显式取回。

### 4.5 草稿回收

每次打开画布成功提交后，异步执行一次有界回收（不阻塞任何交互）：删除该画布下同时满足以下三条的草稿键。

1. 不是当前会话的草稿键；
2. 不在 marker 的 `entries` 中；
3. 记录 `savedAt` 距今超过 6 小时。

第 3 条是为同源多标签页保留的安全边界：另一个标签页可能正持有一份活着的草稿，用年龄阈值避免删掉它。回收失败忽略，不影响画布可用性。

## 5. 会话状态机

### 5.1 阶段

| 阶段 | 含义 | 接受编辑 | 本地草稿写 | 网络保存 |
| --- | --- | --- | --- | --- |
| `loading` | 已 prepare、未 commit，尚未安装 | 否 | 否 | 否 |
| `clean` | 内容与服务端一致，无挂起工作 | 是 | 否 | 否 |
| `dirty` | 有未确认编辑，计时器已排程 | 是 | 是 | 是（400 ms 后） |
| `saving` | 一次保存请求在飞 | 是 | 是 | 单飞行中 |
| `save-error` | 上次保存失败（网络/超时/服务端/不变量） | 是 | 是 | 暂停，等下一次编辑或显式重试 |
| `conflict` | 版本冲突，等待用户显式解决 | 是 | 是（写冲突草稿） | 永久阻断，直到会话被替换 |
| `recovery-blocked` | 本地冲突事实未知 | 是 | 是（写普通草稿） | 阻断，直到恢复重试成功 |
| `disposing` | 已被替换，正在做有界收尾 | 否 | 最后一次 | 最多一次 |
| `disposed` | 终态 | 否 | 否 | 否 |

### 5.2 单调序号与不变量

每个会话持有：

- `sessionId`：进程内单调递增，用于日志与断言。
- `scopeToken` / `openToken`：来自 manager，用于所有权校验。
- `editSeq`：每接受一次真实编辑 +1。
- `materializedSeq`：已序列化进草稿候选的最大 `editSeq`。
- `persistedSeq`：已确认写入本地存储的最大 `editSeq`。
- `savedSeq`：已被服务端确认的最大 `editSeq`。
- `inflightSeq`：在飞请求捕获的 `editSeq`。
- `revision`：服务端权威版本，**只能由保存响应推进**。

不变量（违反即视为不变量事故，见 5.4）：

1. `savedSeq <= inflightSeq <= editSeq`，`materializedSeq <= editSeq`，`persistedSeq <= materializedSeq`。
2. `phase === "clean"` 当且仅当 `savedSeq === editSeq` 且无在飞请求、无已排程的网络计时器。UI 的"已保存"只由 `clean` 表达。
3. `revision` 单调不减；出现回退即事故。
4. `conflict` 与 `recovery-blocked` 期间，会话不得发出任何保存请求。
5. 已安装会话有且只有一个；`update` 只被已安装会话接受。

### 5.3 转移表

| 起始 | 事件 | 守卫 | 目标 | 副作用 |
| --- | --- | --- | --- | --- |
| `loading` | `install` | 令牌匹配 | prepare 判定的 `clean`/`dirty`/`conflict`/`recovery-blocked` | 安装为 active；`dirty` 时立即排程本地与网络 |
| `loading` | `update` | — | `loading` | 拒绝并返回 `false`，不计 `editSeq` |
| `clean` | `update` | 至少一个字段引用不同 | `dirty` | `editSeq++`；排程本地 120 ms 与网络 400 ms |
| `clean` | `update` | 全部字段引用相同 | `clean` | 无操作，不计 `editSeq` |
| `dirty` | `localTick` | — | `dirty` | 序列化一次并投递到本地单槽 |
| `dirty` | `networkTick` | 无在飞请求 | `saving` | 捕获内容与 `baseRevision`，发请求 |
| `saving` | `update` | 同上 | `saving` | `editSeq++`；排程本地；标记请求后待发 |
| `saving` | `saveAck` | `editSeq === inflightSeq` | `clean` | `revision` 与 `savedSeq` 推进；草稿改写为 `synced` 后删除 |
| `saving` | `saveAck` | `editSeq > inflightSeq` | `dirty` | `revision` 与 `savedSeq` 推进；草稿原地改写为新 `baseRevision` 的 `pending`；按最后编辑时间补足 400 ms 重新排程 |
| `saving` | `saveConflict` | — | `conflict` | **同步**置冲突态；随后 best-effort 写 marker 与冲突草稿 |
| `saving` | `saveFail` | — | `save-error` | 记录失败类型；保留 `pending` 草稿；不自动重试 |
| `save-error` | `update` | — | `dirty` | 重新排程本地与网络 |
| `save-error` | `retrySave` | 无在飞请求 | `saving` | 重新捕获**当前**内容，跳过 400 ms 立即发请求 |
| `conflict` | `update` | — | `conflict` | `editSeq++`；只更新本会话冲突草稿；不排程网络 |
| `conflict` | `networkTick`/`retrySave` | — | `conflict` | 拒绝，不产生请求 |
| `recovery-blocked` | `update` | — | `recovery-blocked` | `editSeq++`；写普通草稿；不排程网络 |
| `recovery-blocked` | `retryRecovery` → 无 marker | `editSeq > savedSeq` | `dirty` | 解锁网络并立即排程一次保存 |
| `recovery-blocked` | `retryRecovery` → 无 marker | `editSeq === savedSeq` | `clean` | 解锁网络 |
| `recovery-blocked` | `retryRecovery` → 有效 marker | — | `conflict` | 见 8.3 的入口归属规则；内容不变 |
| `recovery-blocked` | `retryRecovery` → 仍读不出 | — | `recovery-blocked` | 返回 `failed`，UI 提示可再次重试 |
| 任意活动阶段 | `flush` | — | 不变 | 强制物化本地；若网络允许且 `editSeq > savedSeq` 则立即提交一次 |
| 任意阶段 | `dispose` | — | `disposing` → `disposed` | 见 7.4 |
| 任意阶段 | `invariantViolation` | — | `save-error`（`kind: "invariant"`） | 永久阻断网络；UI 提示重新载入画布 |

"内容替换"不是会话内部事件：`conflict` 的"载入服务端版本"通过 manager 的 prepare/commit 安装**新会话**完成（第 7 节），旧会话被 dispose。会话内部永远不会自己换掉画布内容。

### 5.4 非法转移处理

非法转移不允许静默忽略。会话内部所有转移都经过一个集中入口，非法组合抛出 `CanvasSyncInvariantError`，包含 `sessionId`、`canvasId`、`phase`、`event` 与相关序号。manager 捕获后：

1. 把该会话置为 `save-error`（`kind: "invariant"`）并永久阻断其网络保存；
2. 保留本地草稿写能力，使当前内容仍能落盘；
3. 通过会话视图向 UI 暴露"同步状态异常，请重新载入画布"，动作是重新打开画布（走标准 prepare/commit），不是静默恢复；
4. `import.meta.env.DEV` 下额外 `console.error` 完整上下文。

## 6. 两套调度器

两套调度器互不等待：本地草稿是崩溃安全网，网络保存是权威写入，任一侧变慢都不得拖住另一侧。

### 6.1 本地草稿调度器（每会话）

- `update()` 只做三件事：引用比较、`editSeq++`、记录 `pendingProject` 引用与 `lastEditAt`。**不序列化**。
- 若 120 ms 合并计时器未启动则启动；已启动则不重排（trailing 且不可饿死，连续编辑下每 120 ms 落盘一次）。
- 计时器触发 `materialize()`：序列化一次快照，写入**单槽** `pendingSlot`（直接覆盖旧值），记录 `materializedSeq`。
- 若 drain 未运行则启动 drain：取走槽内记录（置空槽），`await` 一次写入；写完后若槽内又有新记录则继续循环，否则结束。**全程只有一个 drain、一个槽**，不追加 Promise 链。
- 写入 reject：置 `localPersist = "degraded"`，丢弃该条（下一次 materialize 会带上更新的内容），继续 drain。
- 写入永不返回：drain 卡住，槽继续被覆盖，内存仍然只压一份完整快照；网络侧完全不受影响。`flushLocal()` 用 2 s 上界返回，超时置 `degraded`。
- `degraded` 必须在 UI 表达（第 9.5 节），冲突态下额外提示"本地草稿不可用，请立即导出"。

### 6.2 网络保存调度器（每会话）

- 每次编辑重排 400 ms trailing 计时器；同时保留 5 s `maxWait`：距首个未保存编辑超过 5 s 立即触发，避免长时间连续拖动完全不保存。
- 单飞行：同一会话任意时刻至多一个保存请求。计时器触发时若已有在飞请求，只标记"请求后待发"，不排队第二个请求。
- 请求内容：若 `materializedSeq === editSeq` 复用已序列化快照，否则立即序列化一次；捕获 `inflightSeq = editSeq` 与 `baseRevision = revision`。
- 超时：`AbortController` 20 s，超时按 `saveFail`（`kind: "timeout"`）处理。
- 成功：`revision = response.revision`，`savedSeq = inflightSeq`；随后按 5.3 决定 `clean` 或重新排程。重新排程按 `max(0, 400 - (now - lastEditAt))` 计算，保证"最后编辑后约 400 ms"不被提前。
- 成功后的草稿处理顺序固定为"先改写、后删除"：先把草稿原地改写为新的 `baseRevision`（无新编辑时 `state` 为 `synced`，有新编辑时为 `pending`），确认写入后若会话已 `clean` 再删除该草稿。顺序不可颠倒——中途崩溃时留下的必须是一条 `synced` 记录（下次打开直接删除），而不是一条会被误判为冲突的旧 `pending` 记录。
- 409：**同步**进入冲突态（内存），再异步 best-effort 写 marker 与冲突草稿，因此不存在"已冲突但 UI 还没冲突"的窗口。
- 其他失败：进入 `save-error`，不自动重试；下一次编辑或显式重试才再次发请求。

### 6.3 常量

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `LOCAL_COALESCE_MS` | 120 | 本地草稿合并窗口 |
| `NETWORK_DEBOUNCE_MS` | 400 | 最后一次编辑后的网络保存延迟 |
| `NETWORK_MAX_WAIT_MS` | 5000 | 连续编辑下的强制保存上界 |
| `SAVE_REQUEST_TIMEOUT_MS` | 20000 | 保存请求超时 |
| `LOAD_REQUEST_TIMEOUT_MS` | 20000 | 读取画布请求超时 |
| `LOCAL_READ_TIMEOUT_MS` | 2000 | 单次本地读取上界（失败自动重试一次） |
| `LOCAL_FLUSH_TIMEOUT_MS` | 2000 | 本地强制落盘等待上界 |
| `DETACHED_LOCAL_MS` | 2000 | detached 会话本地收尾上界 |
| `DETACHED_NETWORK_MS` | 10000 | detached 会话网络收尾上界 |
| `MAX_DETACHED_SESSIONS` | 2 | 同时存在的 detached 会话上限 |
| `EXPORT_BATCH_SIZE` | 3 | 导出并发批大小 |
| `DRAFT_GC_MIN_AGE_MS` | 6 h | 草稿回收最小年龄 |
| `CANVAS_TITLE_MAX_LENGTH` | 200 | 与服务端契约一致的标题上限 |

## 7. Prepare/Commit 两阶段

内容替换必须是原子的：画布内容、会话 lineage、UI 闸门三者要么一起换，要么一个都不换。所有替换路径都走同一套两阶段协议。

### 7.1 打开画布

```text
页面: projectId 或 scope 变化
  1. setReady(false)            → 渲染闸门关闭、Agent bridge 下线、编辑不可达
  2. manager.prepareOpen(id)    → 读服务端快照 + 读本地 marker/草稿 + 构造 loading 会话（不改 active）
  3. 媒体补水（图片/助手引用，失败降级为未补水内容）
  4. manager.commitPrepared(p)  → 校验 scopeToken/openToken/canvasId，安装会话，dispose 旧会话
  5. 同一回调内写入 React 状态 → setReady(true)
```

关键规则：

- 第 2 步全程不改 `active`，因此在补水这段时间里，旧会话仍是权威，任何迟到编辑都发不出属于新画布的保存。
- 第 2 步的非成功结局分三种，页面按结果处理，绝不 toast 成功：`cancelled`（被更新的打开取代或作用域已切换）保持安静，闸门交给新流程；`missing`（画布已删除或不属于当前 Workspace）跳转 `/canvas` 并提示画布不存在；`failed`（网络或服务端错误）停在闸门并显示带重试的错误。
- 第 4 步返回 `false` 一律按 `cancelled` 处理：说明在补水期间作用域、路由或打开令牌已经变化，页面直接结束本次流程，不写 React 状态、不导航、不提示。
- 第 3 步补水失败或超时，用未补水的服务端内容继续第 4、5 步；不允许永远停在闸门上。
- 会话安装时携带的 `content` 与页面写入 React 的对象引用**必须是同一批引用**。会话的 `update()` 对每个字段做引用比较，因此补水后首次 effect 回流是无操作，不会产生"打开即保存"。

### 7.2 冲突重载（载入服务端版本）

同样两阶段，但失败必须回到原冲突界面而不是空壳：

1. 页面 `setReady(false)`，记录本次 `reloadRun`。
2. `manager.prepareServerCopy(id)`：只取服务端快照并构造 `loading` 会话，不动 `active`。
3. 媒体补水。
4. `manager.commitServerCopy(prepared)`：令牌校验通过后一次性安装新的 `clean` 会话，dispose 旧的冲突会话，并清理该画布的 marker 与其引用的草稿。
5. 写入 React 状态，`setReady(true)`，仅此时提示"已载入服务端版本"。

返回值必须区分三种结局，UI 据此决定提示：`committed`（成功）、`cancelled`（被新的打开或重载取代，保持安静）、`failed`（真正失败，恢复旧的冲突会话与冲突条，`setReady(true)`）。

### 7.3 渲染闸门与 Agent bridge

- 渲染闸门条件：`ready && activeSession?.canvasId === routeCanvasId && sameScope(activeSession.scope, currentScope)`。任一不满足渲染 `CanvasRefreshShell`，不渲染画布内容。
- 闸门关闭期间，画布容器不挂载，因此不可交互，也不会产生编辑。
- Agent bridge 增加 `enabled` 参数，取值与闸门条件一致。`enabled === false` 时：发布 `null` 上下文；`applyOps` 直接拒绝并返回可翻译的"画布尚未就绪"错误，不改任何 React 状态。
- 作用域同步用 `useLayoutEffect`（已实现）在 paint 前生效；配合闸门条件里的 `sameScope`，切换 Workspace 后不会有任何一帧仍显示旧画布。

### 7.4 dispose 与有界 detached flush

会话被替换或作用域被清空时进入 `disposing`：

1. 取消所有计时器，拒绝后续 `update`。
2. 强制物化并等待本地落盘，上界 `DETACHED_LOCAL_MS`。
3. 若 `editSeq > savedSeq` 且阶段允许网络，发出**最多一次**最终保存，上界 `DETACHED_NETWORK_MS`。
4. 该保存若返回 409，写入该画布的冲突 marker 与冲突草稿（无 UI，下次打开该画布时呈现）。
5. 进入 `disposed`，从 manager 的 detached 集合移除。

manager 的 detached 集合上限为 `MAX_DETACHED_SESSIONS`。超限时，最老的一个立即硬收尾：中止在飞请求、跳过等待、直接 `disposed`。**打开新画布不等待 detached 收尾**，因此一次挂起的保存不会阻塞任何后续操作。

页面关闭只做 best-effort：`pagehide` 与 `visibilitychange(hidden)` 触发一次 `flush()`，但不承诺异步 fetch 或 IndexedDB 一定完成。真正的耐久性来自 120 ms 内已经排程的本地草稿，文档口径必须与此一致。

### 7.5 ResizeObserver 与视口

- 画布容器改用 callback ref：节点挂载时同时写入 `containerRef.current` 并触发一次测量与 `ResizeObserver` 安装，卸载时断开。不再使用空依赖 `useEffect`，因此闸门先关后开的挂载顺序不会导致 observer 永不安装。
- 服务端视口是权威：仅当提交的视口恰为 `{ x: 0, y: 0, k: 1 }` 时才执行一次初始居中，其余情况一律不覆盖。
- 删除页面里 75 ms 的视口二级防抖；视口变化直接调用 `update({ viewport })`，由会话的 120 ms/400 ms 统一合并，保证"最后编辑后约 400 ms"这一口径对平移缩放同样成立。

## 8. 多冲突与多标签页

### 8.1 每画布独立 marker

冲突事实持久化在 `canvas-conflict:<userId>:<workspaceId>:<canvasId>`，与内存无关。因此：刷新页面、切换 Workspace 再切回、A 冲突后去编辑 B 再冲突，每个画布都能各自恢复自己的冲突入口，互不覆盖。解决或删除某个画布只清理该画布的 marker 与其引用的草稿。

### 8.2 同源多标签页

marker 与草稿按 `user/workspace/canvas` 共享，不引入 `tabId`。取舍如下：

- 收益：关闭产生冲突的那个标签页之后，草稿仍能被另一个标签页看到并导出，不会因为关标签页而丢失本地工作。
- 代价：标签页 A 的冲突会在标签页 B 打开同一画布时也表现为冲突，即使 B 自己没有产生过冲突；B 点"载入服务端版本"会清掉这份共享草稿。
- 结论：偏向保守恢复。丢失用户未保存的工作是不可逆损失，多显示一次冲突只是一次可逆的打扰。该行为在验收矩阵与 pending-test 文档中显式说明，不当作缺陷。
- 同理，4.5 的草稿回收带 6 小时年龄阈值，避免误删另一个标签页正在使用的活草稿。

### 8.3 恢复重试期间的入口归属

`recovery-blocked` 期间用户可以继续编辑，这些编辑写入**当前会话自己的草稿键**。重试成功且读到一条有效的旧 marker 时：

- 若当前会话 `editSeq > savedSeq`（恢复期间确实编辑过）：新 marker 的 `entries` 为 `[当前会话条目, 旧条目]`，当前会话条目在前。旧草稿保留在磁盘上，不删除。
- 若当前会话没有编辑过：marker 保持只有旧条目，会话进入 `conflict`，**内容不变**（仍是服务端副本），旧草稿通过导出取回。恢复重试只修正 lineage 状态，绝不自行替换画布内容——否则会重新引入 7.2 的补水窗口，并可能悄悄丢弃恢复期间的编辑。替换内容的路径只有冲突条上的两个显式动作。

核心规则：**旧 marker 永远不能夺回入口**。最新的本地内容始终排在 `entries[0]`，导出时最先给出。

### 8.4 导出语义

`exportConflictDrafts()` 返回最多 2 份 `CanvasProject`，顺序为"新→旧"：

1. 若当前会话 `editSeq > savedSeq`，第一份直接来自**内存中的当前内容**，不读磁盘。这保证即使本地存储完全不可用，冲突内容仍然可导出。
2. 其余来自 marker `entries` 中 `draftKey` 不等于当前会话草稿键的记录，逐条有界读取，读失败跳过。

两份一起打包进同一个 zip（`exportCanvasProjects` 本身支持多画布），UI 不新增第二个按钮。

## 9. 接口草案

以下为签名与类型草案，用于约束实现边界，不是实现代码。

### 9.1 共享类型

```ts
export type CanvasScope = { userId: string; workspaceId: string };

export type CanvasSyncPhase =
  | "loading" | "clean" | "dirty" | "saving"
  | "save-error" | "conflict" | "recovery-blocked"
  | "disposing" | "disposed";

export type CanvasSaveErrorKind = "network" | "timeout" | "server" | "invariant";

export type CanvasLocalPersistState = "ok" | "degraded";

/** 会话对外导出的唯一可渲染事实，不可变，每次变化整体替换。 */
export type CanvasSyncView = {
  canvasId: string;
  scope: CanvasScope;
  title: string;
  revision: number;
  phase: CanvasSyncPhase;
  hasUnsavedEdits: boolean;
  saveError: { kind: CanvasSaveErrorKind; messageKey: string } | null;
  localPersist: CanvasLocalPersistState;
  conflict: { baseRevision: number; source: "save" | "restored"; extraDraftCount: number } | null;
};

export type CanvasProjectPatch = Partial<
  Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">
>;
```

### 9.2 CanvasSyncSession

```ts
export interface CanvasSyncSession {
  readonly sessionId: number;
  readonly canvasId: string;
  readonly scope: CanvasScope;
  readonly scopeToken: number;
  readonly openToken: number;
  readonly view: CanvasSyncView;
  /** 当前权威的前端内容，引用稳定，供导出与素材引用判定使用。 */
  readonly content: CanvasProject;

  /** 由 manager 在 commit 时调用；loading -> 初始阶段。重复调用视为不变量事故。 */
  install(): void;
  /** 返回是否被记为一次真实编辑；引用相同或阶段不接受编辑时返回 false。 */
  update(patch: CanvasProjectPatch): boolean;
  /** 冲突/恢复阻断时返回 "local-only"，标题超长在调用前已截断。 */
  rename(title: string): "scheduled" | "local-only";
  /** 强制物化本地并在允许时提交一次；内部全部有界，永不无限等待。 */
  flush(): Promise<void>;
  retrySave(): Promise<void>;
  retryRecovery(): Promise<"unlocked" | "conflict" | "failed">;
  exportConflictDrafts(): Promise<CanvasProject[]>;
  dispose(reason: "replaced" | "scope-changed" | "deleted" | "forced"): Promise<void>;
  subscribe(listener: (view: CanvasSyncView) => void): () => void;
}
```

### 9.3 CanvasSyncManager

```ts
export type PreparedCanvasOpen =
  | { status: "ready"; canvasId: string; project: CanvasProject; session: CanvasSyncSession }
  | { status: "cancelled" }
  | { status: "missing" }
  | { status: "failed"; messageKey: string };

export type CanvasCreateResult =
  | { status: "created"; canvasId: string; summary: CanvasProjectSummary }
  | { status: "scope-changed" }
  | { status: "failed"; messageKey: string };

export type CanvasRenameResult = "scheduled" | "saved" | "local-only" | "scope-changed" | "failed";
export type CanvasDeleteResult = { deleted: string[]; failed: string[] };

export interface CanvasSyncManager {
  getScope(): CanvasScope | null;
  setScope(scope: CanvasScope | null): void;
  getActiveSession(): CanvasSyncSession | null;

  prepareOpen(canvasId: string): Promise<PreparedCanvasOpen>;
  commitPrepared(prepared: PreparedCanvasOpen): boolean;
  prepareServerCopy(canvasId: string): Promise<PreparedCanvasOpen>;
  commitServerCopy(prepared: PreparedCanvasOpen): "committed" | "cancelled" | "failed";

  listCanvases(): Promise<CanvasProjectSummary[]>;
  createCanvas(title: string): Promise<CanvasCreateResult>;
  importCanvas(source: Partial<CanvasProject>, fallbackTitle: string): Promise<CanvasCreateResult>;
  renameCanvas(canvasId: string, title: string): Promise<CanvasRenameResult>;
  deleteCanvases(canvasIds: string[]): Promise<CanvasDeleteResult>;
  loadForExport(canvasIds: string[]): Promise<CanvasProject[]>;

  subscribe(listener: () => void): () => void;
}
```

### 9.4 Zustand store

store 只保留可渲染状态与动作转发，不再持有任何计时器、Promise 链或 revision 算法：

```ts
type CanvasStore = {
  scope: CanvasScope | null;
  listStatus: "idle" | "loading" | "ready" | "error";
  listError: string | null;
  summaries: CanvasProjectSummary[];
  activeCanvasId: string | null;
  /** 由活动会话推送；无活动会话为 null。 */
  sync: CanvasSyncView | null;
  /** 活动画布内容，供列表导出与素材引用判定读取。 */
  activeProject: CanvasProject | null;

  setScope: (scope: CanvasScope | null) => void;
  refreshList: () => Promise<void>;
  createProject: (title: string) => Promise<CanvasCreateResult>;
  importProject: (source: Partial<CanvasProject>, fallbackTitle: string) => Promise<CanvasCreateResult>;
  renameProject: (canvasId: string, title: string) => Promise<CanvasRenameResult>;
  deleteProjects: (canvasIds: string[]) => Promise<CanvasDeleteResult>;
  loadProjectsForExport: (canvasIds: string[]) => Promise<CanvasProject[]>;
  updateProject: (canvasId: string, patch: CanvasProjectPatch) => void;
  flushProject: (canvasId: string) => Promise<void>;
  retrySave: (canvasId: string) => Promise<void>;
  retryRecovery: (canvasId: string) => Promise<"unlocked" | "conflict" | "failed">;
  exportConflictDrafts: (canvasId: string) => Promise<CanvasProject[]>;
};
```

`updateProject`、`flushProject`、`retrySave`、`retryRecovery`、`exportConflictDrafts` 都带 `canvasId`，store 内先与 `activeCanvasId` 比对，不匹配直接忽略，避免组件在切换瞬间把动作打到别的画布上。

页面私有 hook `web/src/pages/canvas/hooks/use-canvas-project-sync.ts` 封装 7.1/7.2 的 prepare→补水→commit 流程与闸门状态，`project.tsx` 只消费它返回的 `{ ready, project, applyProject, reloadServerCopy }`。

### 9.5 保存状态与冲突条的视图映射

| `phase` | 状态位文案 | 动作 |
| --- | --- | --- |
| `clean` 且本会话保存过 | 已保存 | 无 |
| `clean` 且本会话从未保存过 | 不显示 | 无 |
| `dirty` | 未保存 | 无 |
| `saving` | 保存中 | 无 |
| `save-error`（network/timeout/server） | 保存失败 | 重试（重新捕获当前内容） |
| `save-error`（invariant） | 同步状态异常 | 重新载入画布 |
| `recovery-blocked` | 本地恢复失败 | 重试恢复 |
| `conflict` | 不显示（由冲突条表达） | 见下 |
| `localPersist === "degraded"` | 追加"本地草稿不可用" | 无 |

冲突条固定两个动作：载入服务端版本、导出本地草稿。`localPersist === "degraded"` 时冲突条追加一行“本地草稿不可用，请立即导出”。`extraDraftCount > 0` 时导出按钮文案说明会导出多份草稿。样式沿用当前扁平无边框风格与 `canvasThemes` token，所有图标按钮保留 `aria-label`。

### 9.6 本地恢复仓储

```ts
export type CanvasDraftScope = { userId: string; workspaceId: string; canvasId: string };

/** 每个方法自带单次调用上界（LOCAL_READ_TIMEOUT_MS / LOCAL_FLUSH_TIMEOUT_MS），只做存取与校验，不做调度。 */
export interface CanvasLocalRecovery {
  readMarker(scope: CanvasDraftScope): Promise<CanvasConflictMarker | null>;
  writeMarker(marker: CanvasConflictMarker): Promise<void>;
  deleteMarker(scope: CanvasDraftScope): Promise<void>;
  readDraftByKey(key: string): Promise<CanvasDraftRecord | null>;
  writeDraft(record: CanvasDraftRecord): Promise<void>;
  deleteDraftByKey(key: string): Promise<void>;
  /** 按键前缀枚举该画布的全部草稿，`savedAt` 新的在前；供 4.4 判定与 4.5 回收使用。 */
  listCanvasDrafts(scope: CanvasDraftScope): Promise<CanvasDraftRecord[]>;
  /** 删除该画布下不在 keepKeys 中且超过 DRAFT_GC_MIN_AGE_MS 的草稿；失败忽略。 */
  collectGarbage(scope: CanvasDraftScope, keepKeys: string[]): Promise<void>;
}
```

补充语义：草稿键含 `draftId`，因此 4.4 的“存在 pending 草稿”由 `listCanvasDrafts` 一次前缀枚举给出，而不是按 revision 直接构造键。枚举中校验失败的记录只跳过、不删除，删除只发生在 4.5 的回收路径。任一读取超时或异常且自动重试一次仍失败时，`prepareOpen` 返回 `recovery-blocked`，绝不允许把“读不出来”降级成“没有草稿”。

## 10. 列表级操作与会话协作

| 操作 | 与会话的关系 |
| --- | --- |
| `listCanvases` | 纯仓储读取，按 `scopeToken` 丢弃迟到结果；不触碰会话 |
| `createCanvas` | 不等待任何会话；服务端返回后校验 `scopeToken`，不匹配返回 `scope-changed` 且**不导航**。作用域切换后已创建的空画布保留在旧 Workspace，不做补偿删除 |
| `importCanvas` | 逐个创建、逐个记账，返回 `created`/`failed` 计数；遇到 `scope-changed` 停止剩余项，不计为失败 |
| `renameCanvas`（活动画布） | 走 `session.rename`：可保存时返回 `scheduled`（标题并入同一次防抖保存请求的 `title` 字段，此时尚未落库，UI 不提示成功，由状态位表达）；冲突或恢复阻断时返回 `local-only`，UI 提示"标题仅保存在本地草稿" |
| `renameCanvas`（列表项，非活动画布） | 读取→带 `baseRevision` 保存的两步操作；成功返回 `saved`（此时才可以提示重命名成功）；409 时返回 `failed` 并提示需要打开该画布处理冲突，不写任何 marker |
| `deleteCanvases` | 先对活动画布中被删的那个 `dispose("deleted")`（跳过网络收尾），再并发删除。`allSettled` 部分成功语义；只清理成功项的 marker/草稿与列表项；作用域已变时仍返回真实结果，只是不写 store |
| `loadForExport` | 活动画布直接用会话内存内容，其余按 `EXPORT_BATCH_SIZE` 分批读取；任一批失败抛出并由 UI 提示导出失败，不返回空包 |

标题输入在列表卡片与顶栏两处都加 `maxLength={200}`，与服务端契约一致，避免出现永远保存不成功的标题。

## 11. 故障与并发矩阵

| 场景 | 预期行为 |
| --- | --- |
| 打开 A 慢、打开 B 快，A 后返回 | A 的 prepare 结果 commit 时令牌不匹配，返回 `cancelled`；不改 `active`、不改 React、不提示 |
| A 保存在飞时切到 B 编辑 | A 被 dispose，做有界收尾（最多一次最终保存）；B 是全新会话，两者序号与 revision 互不干扰 |
| 同一画布保存在飞时继续编辑 | 不排队第二个请求，只标记“请求后待发”；`saveAck` 后按 `max(0, 400 - (now - lastEditAt))` 重新排程，并以刚返回的 revision 作为下一次 `baseRevision`；`editSeq > savedSeq` 期间状态位不显示“已保存” |
| 编辑 A 后立即新建 B | 新建不等待 A 的收尾；A 的最后一次编辑由 dispose 收尾负责，失败时写 A 自己的 marker |
| 409 后 2 秒内继续编辑 | 冲突态在 409 返回时**同步**建立，期间的编辑直接写入本会话冲突草稿，导出得到最新内容 |
| 冲突后刷新页面 | marker 已持久化，重开后仍是冲突态，显示本地草稿内容，自动保存保持阻断 |
| A、B 各自冲突 | 两条独立 marker，互不覆盖；A→B→A 往返后各自恢复自己的冲突入口 |
| 恢复重试期间已编辑 | 最新内容排在 `entries[0]`，旧草稿降为第二条并一起导出；旧 marker 不夺回入口 |
| localforage reject | `localPersist = "degraded"`，网络保存不受影响；冲突导出改用内存内容；UI 显式提示 |
| localforage 永不返回 | drain 卡住但内存有界（1 槽 + 1 在写）；所有等待点有 2 s 上界；云端保存与打开画布不冻结 |
| 保存 20 s 超时后再编辑 | 请求 abort → `save-error`；下一次编辑重新排程；显式重试重新捕获当前内容 |
| 切换 Workspace 后旧 409 返回 | 旧会话已 detached，仍按其自身作用域写 marker/草稿；不写入新作用域的任何状态与 UI |
| 重载补水耗时 5 s | 闸门关闭、画布不可交互、Agent 下线；补水完成后一次性提交；失败恢复原冲突界面 |
| 部分删除失败 | 只有成功项离开列表与选中态；失败项保留并可重试；失败项的待保存编辑不被丢弃 |
| `mode=new` 期间切换 Workspace | 旧结果返回 `scope-changed`，不导航；新作用域按自己的 key 重新执行一次自动打开，不停在"正在打开" |
| `pagehide`/隐藏 | 触发一次 best-effort `flush()`；耐久性由 120 ms 内已排程的本地草稿保证，文档不承诺关闭浏览器后网络请求一定完成 |
| Agent 上下文 | 闸门关闭时发布 `null`，`applyOps` 拒绝；切画布/切作用域瞬间不会把 A 的内容发布成 B 的上下文 |
| ResizeObserver | callback ref 在真实容器挂载时安装；仅零视口时初始居中，不覆盖服务端视口 |

## 12. 性能与内存不变量

以 3 秒 60 fps 连续拖动节点（约 180 次 `update`）为基准：

| 指标 | 上界 | 说明 |
| --- | --- | --- |
| `update` 单次成本 | O(字段数) 引用比较 + 序号自增 | 不序列化、不写盘、不发请求 |
| 全量快照序列化次数 | ≤ 25 次（3000 ms ÷ 120 ms） | 由本地合并窗口决定 |
| 待写草稿记录数 | ≤ 1（单槽覆盖） | 慢速 IndexedDB 下也不堆积 |
| 并行本地写 | ≤ 1（单 drain） | 不追加 Promise 链 |
| 网络请求数 | 拖动期间 ≤ 1（5 s `maxWait`），结束后 400 ms 再 1 次 | 单飞行 |
| 会话内同时存在的完整快照 | ≤ 3（槽内 1 + 在写 1 + 请求负载 1） | |
| detached 会话 | ≤ 2，每个生命周期 ≤ 10 s | 超限最老者硬收尾 |
| 全局同时存在的完整快照 | ≤ 9（3 会话 × 3） | |

其他持久化不变量：

- 服务端快照与本地草稿都不得包含 `blob:` 临时地址与签名 URL；内置图片/视频/音频节点的主媒体、备选图片、生成参考与助手引用统一按 `storageKey` 归一。
- 文本节点与插件节点的 `metadata.content` 一律原样保留，即使以 `blob:` 开头，因为其媒体归属未知。
- 单次保存请求体受服务端 10 MiB 限制约束；超限返回的 `canvas_snapshot_too_large` 按 `save-error`（`kind: "server"`）处理并提示画布过大，不当作冲突。
- `revision_conflict` 是唯一触发冲突态的错误码；`canvas_revision_limit_reached` 等其他 409 一律按 `save-error` 处理。

## 13. 迁移与文件计划

### 13.1 原则

- 一次性替换，不保留双路径：旧的模块级计时器/Promise 链/lineage 判定全部删除，不留"开关"或"兼容模式"。
- 不写任何旧本地存储兼容层：旧 store 一次性丢弃（4.1）。
- 服务端与契约零改动，重构可独立回滚（第 16 节）。
- 建议分三个提交，便于人工审查与回滚，但都在同一分支上顺序完成：
  1. `refactor: extract canvas sync session`（新增 services/canvas-sync 与本地恢复模块，store 改为适配器）
  2. `refactor: drive canvas page by prepare/commit`（页面、Agent bridge、ResizeObserver、视口）
  3. `fix: align canvas sync ui and docs`（状态位、冲突条、列表操作结果、i18n、文档）

### 13.2 文件清单

新增：

| 文件 | 内容 |
| --- | --- |
| `web/src/services/canvas-sync/types.ts` | 阶段、事件、视图模型、结果类型、常量 |
| `web/src/services/canvas-sync/canvas-sync-session.ts` | 会话状态机、两套调度器、冲突与恢复、dispose |
| `web/src/services/canvas-sync/canvas-sync-manager.ts` | 作用域令牌、active/detached 会话、prepare/commit、列表级编排 |
| `web/src/services/canvas-local-recovery.ts` | 草稿与 marker 的键、读写删、校验、回收 |
| `web/src/pages/canvas/hooks/use-canvas-project-sync.ts` | 页面私有：prepare → 补水 → commit、渲染闸门、重载入口 |

修改：

| 文件 | 改动 |
| --- | --- |
| `web/src/stores/canvas/use-canvas-store.ts` | 退化为视图适配器；删除全部模块级可变量与同步算法 |
| `web/src/services/canvas-repository.ts` | 读取请求补 20 s 超时；错误分类集中到此处；其余不变 |
| `web/src/pages/canvas/project.tsx` | 改用页面 hook；删除 `syncedContentRef`/`syncedViewportRef`/`reloadRunRef` 与视口二级防抖；callback ref 安装 ResizeObserver；闸门条件收紧 |
| `web/src/pages/canvas/hooks/use-agent-bridge.ts` | 新增 `enabled`，未就绪时发布 `null` 并拒绝 `applyOps` |
| `web/src/pages/canvas/index.tsx` | 适配 `CanvasCreateResult`；自动打开按作用域 key 重置 |
| `web/src/components/canvas/canvas-save-status.tsx` | 按 9.5 映射；新增不变量事故与 `degraded` 表达 |
| `web/src/components/canvas/canvas-conflict-bar.tsx` | 导出改用会话内容 + 附加草稿；`degraded` 提示 |
| `web/src/components/canvas/canvas-project-card.tsx` | `maxLength={200}`；适配 `CanvasRenameResult` |
| `web/src/components/canvas/canvas-top-bar.tsx` | 标题输入 `maxLength={200}`；冲突时不提示重命名成功 |
| `web/src/components/canvas/canvas-delete-projects-dialog.tsx` | 适配新的删除结果类型 |
| `web/src/hooks/use-canvas-scope-sync.ts` | 调用 manager 的 `setScope` |
| `web/src/lib/agent/agent-site-tools.ts` | 适配新的 store 字段与结果类型 |
| `web/src/stores/use-asset-store.ts` | 通过 `activeProject` 读取当前画布内容 |
| `web/src/i18n/locales/zh-CN.ts`、`en-US.ts` | 新增状态位、不变量事故、`degraded`、重命名仅本地等文案 |

删除：

| 文件 | 原因 |
| --- | --- |
| `web/src/services/canvas-drafts.ts` | 由 `canvas-local-recovery.ts` 完整替代，键与记录结构均改变 |

`web/src/services/api/canvases.ts`、`web/src/lib/canvas/canvas-snapshot.ts`、`web/src/stores/canvas/use-canvas-ui-store.ts`、`web/src/components/canvas/canvas-refresh-shell.tsx` 不变。

## 14. 手工验证矩阵

按顺序执行；任一阶段失败先修复再进入下一阶段。命令由用户自行运行，本规格不执行任何验证。

前置：`bun --cwd web run typecheck` 与 `bun --cwd web run build` 必须先通过，再开始交互验收。

阶段 A：基础闭环

1. 登录并选择 Workspace，新建、打开、重命名、删除画布，刷新后列表与内容均来自服务端。
2. 打开一个画布但不做任何操作，等待 5 秒，确认 revision 与 `updatedAt` 不变，状态位不显示"已保存"。
3. 拖动节点、连线、改背景、平移缩放，确认停止操作后约 400 ms 落一次保存，状态位依次为 未保存 → 保存中 → 已保存。
4. 保存进行中继续编辑，确认状态位不会提前显示"已保存"，且第二次保存使用第一次返回的 revision。

阶段 B：并发与所有权

5. 用网络面板把画布 A 的读取限速，打开 A 后立刻打开 B；确认 B 正常显示，A 的迟到结果不改变 B，也不提示任何失败。
6. 编辑 A 后立即新建 B；确认 A 的最后一次编辑最终落到 A，且新建不被阻塞。
7. 切换 Workspace 时故意让上一个请求延迟返回；确认旧作用域内容一帧都不出现，列表与画布均不被回写。
8. Agent `mode=new` 期间切换 Workspace；确认不停在"正在打开"，新作用域会自己发起一次。

阶段 C：冲突

9. 同一画布开两个标签页并都编辑；确认落败方停止自动保存、出现冲突条、内容是自己的本地版本。
10. 冲突后继续编辑节点、视口与标题，导出本地草稿；确认导出的是最新内容，期间没有任何保存请求。
11. 冲突后刷新页面；确认冲突条与本地内容都恢复，自动保存仍然阻断。
12. 制造 A、B 两个画布各自冲突，往返切换；确认互不覆盖。
13. 点"载入服务端版本"，在补水期间尝试拖动、平移、输入；确认全程不可交互、无保存请求，完成后内容为服务端版本且冲突条消失。
14. 让重载请求失败；确认回到原冲突界面而不是空壳，且不提示"已载入"。

阶段 D：本地存储与恢复

15. 用 DevTools 让 IndexedDB 写入 reject；确认状态位出现"本地草稿不可用"，云端保存仍然成功。
16. 让本地读取永不返回；确认画布仍能打开、进入"本地恢复失败"、网络保存被阻断，重试成功后自动补一次保存。
17. 在恢复阻断期间编辑，然后让重试读到一条旧 marker；确认导出的第一份是恢复期间的最新内容。
18. 检查 IndexedDB：`canvas_recovery` 中每个会话一条草稿（同源多标签页打开同一画布时同一画布可能有多条）、每画布至多一条 marker，旧 `canvas_drafts` 已消失。

阶段 E：故障与回归

19. 让保存请求挂起超过 20 秒；确认进入"保存失败"、可重试、其他画布的打开与新建不受影响。
20. 多选删除并让其中一个删除失败；确认只有成功项离开列表，失败项可重试且未丢失待保存编辑。
21. 输入 250 字符标题；确认被截断到 200 且保存成功。
22. 触发 `pagehide`（切标签页/关闭），重开确认最后一次编辑至少存在于本地草稿。
23. 检查保存到服务端的快照与本地草稿：无 `blob:`，文本与插件节点内容原样保留。
24. 拖动一个约 200 节点的画布 3 秒，观察性能面板：无持续主线程长任务，IndexedDB 写入次数约 25 次量级而不是每帧一次。
25. 中英文切换，确认新增文案与 `aria-label` 完整。

## 15. 文档与变更记录策略

- 本规格提交只新增本文件，不改代码、不改 `CHANGELOG.md`、不改进度文档。
- 实施提交按 AGENTS.md 执行：`docs/content/docs/progress/pending-test.mdx` 记录本次可测试变更（以第 14 节矩阵为准），`CHANGELOG.md` 的 `Unreleased` 只写版本级归纳。
- `docs/content/docs/overview/features.mdx` 在用户确认验收前不改。当前该文件仍写着画布保存在浏览器并可通过 WebDAV 同步、以及"复制画布"动作，这两处与服务端权威画布不一致，实施时以 todo 条目记录，等验收通过后再统一修正。
- `docs/content/docs/progress/todo.mdx` 追加两条明确待办：媒体仍为本地存储导致换设备缺图（Task 4/5 解决）；画布删除不回收本地媒体，本地存储会持续增长，需要在 Asset 切换后补引用计数与容量提示。
- `.superpowers/sdd/2026-08-26-cloud-canvases-assets/progress.md` 追加一条 Task 3 裁决记录，指向本规格，并说明后续审查以本规格为准。

## 16. 回滚边界

- 影响面仅 `web/`。服务端、契约、迁移与数据库不变，因此回滚不涉及数据迁移。
- 若阶段 A 或阶段 B 验收失败且当日无法收敛，直接 `git revert` 本次重构的三个提交回到 `aa498df`，功能退回当前已知状态（带三轮审查列出的缺陷，但可用）。
- 回滚后需要在浏览器手动删除 `canvas_recovery` store；`canvas_drafts` 已被丢弃，回滚后旧代码会重新创建空 store，不会读到脏数据。
- 冲突草稿是本地数据：回滚前若存在未导出的冲突草稿，先用冲突条导出 zip，再执行回滚。
- 阶段 C/D/E 的失败原则上就地修复，不回滚，因为这些路径在 `aa498df` 上同样有缺陷，回滚不能改善。

## 17. 方案对比与裁决

| 方案 | 描述 | 结论 |
| --- | --- | --- |
| A（采纳） | 抽出 `CanvasSyncSession` 状态机 + manager，Zustand 退化为视图层 | 消除所有权/生命周期/状态三类隐式，改动集中在同步边界，工期可控 |
| B | 继续在现有 store 上打补丁 | 三轮审查已证明单点修复会持续产生新的竞态：每次修复都要在新的位置手写五重令牌校验，缺陷密度不下降。放弃 |
| C | 直接做完整协同层（操作日志 + CRDT/OT + 实时通道） | 需要后端操作日志、快照压缩、Presence 与实时网关，工作量以周计，且当前非目标就是不做多人实时编辑。与 7 天上线冲突，放弃 |
| D | 引入 Yjs/Automerge 只为单人保存 | 单用户场景下 CRDT 只增加序列化体积与依赖，解决不了"何时保存、冲突如何呈现、本地存储何时可信"这三个真实问题。放弃 |

方案 A 与未来协同的关系：会话已经是"一个画布 + 一条 revision lineage + 一组本地恢复记录"的封装，日后接入操作日志时，只需在会话内把"整快照 + baseRevision"替换为"操作序列 + 服务端确认点"，manager、store、页面与 UI 的边界都不需要再改。这是选它而不是继续打补丁的长期理由。
