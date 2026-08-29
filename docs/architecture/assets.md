# Asset 生命周期契约

## 权威与标识

Asset 表示图片、视频、音频、导出文件等媒体对象。PostgreSQL 保存身份、租户、状态、内容类型、字节数、校验值和引用元数据；S3 兼容对象存储保存字节。

- API 先创建稳定 Asset ID，再签发上传能力。
- 对象键由服务端生成，必须包含不可猜测标识且创建后不可变；客户端文件名只能作为展示元数据。
- Workspace 是 Asset 的租户边界。任何读取、上传完成、引用或删除都必须重新授权。
- 云端文档和任务结果只保存 `assetId`，不得保存本地 `storageKey`、`blob:` URL、base64 或上游临时 URL。

## 状态机

```text
staging ── upload verified ──▶ ready ── logical delete ──▶ deleted
   └──── verification/processing failure ───────────────▶ failed ──▶ deleted
```

- `staging`：ID 已存在，上传或校验尚未完成；Canvas 可暂时引用，但 UI 必须显示未就绪。
- `ready`：对象存在且服务端已验证类型、大小和必要校验值，可被读取与用于 Provider 输入。
- `failed`：上传、校验或处理明确失败；引用保留为受控的不可用资源，不能静默换成别的对象。
- `deleted`：业务层不可再新建引用；物理字节由保留期和引用清理决定，不要求请求内立即删除。

状态只能沿图中方向推进。重试上传创建新的上传会话，不改写 immutable object key。

## 引用与清理

- Canvas 可以在用户操作期间引用 `staging` 或 `ready` Asset；服务端发布/导出前必须确认所需 Asset 已 `ready`。
- AI Task 成功必须把可持久化输出写成 `ready` Asset 后，才能进入 `succeeded` 并结算积分。
- 删除 Canvas、任务或“我的素材”条目只释放对应引用，不直接删除可能被其他资源共享的字节。
- 孤儿清理必须同时满足：没有有效引用、超过保留期、没有活跃上传/任务租约，并以幂等操作删除对象和推进状态。
- 对象删除失败可重试；数据库不得因一次对象存储错误而伪造 `deleted` 物理完成。

## 当前过渡边界

当前云 Canvas 元数据已经由 PostgreSQL 权威保存，但部分媒体字节与“我的素材”仍在浏览器 `image_files` / `media_files`。恢复信封可暂存 `storageKey -> assetId/uploadState` 映射以恢复未完成上传，但该映射不是云端引用格式。Gate 2 完成后，本地媒体不再阻断跨设备打开 Canvas。

