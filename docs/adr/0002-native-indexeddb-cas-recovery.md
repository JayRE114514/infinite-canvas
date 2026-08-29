# ADR 0002：原生 IndexedDB CAS 仅承担本地恢复

状态：Accepted

画布未同步草稿使用独立原生 IndexedDB，读取、判定和写入在同一事务内按 CAS 提交；每个标签页会话拥有独立草稿行。该数据库只用于故障恢复，不能成为云画布权威、普通缓存仓库或未来 Yjs 文档存储。

Manager 负责跨 Draft 协调、删除和 GC，Session 负责本会话单调写入与本地/网络调度，Store 只负责单事务存储协议。打开与所有权切换使用 prepare/commit；进程强杀恢复后必须退役来源行并铸造新的会话所有权行。

后果：本机 viewport 可以进入恢复信封的 `localUi`，但不能推进云端文档版本；只有精确验证的服务端删除回执才能墓碑化并清理本地状态。损坏、未知或超时状态一律 fail-closed，只有用户重试并正面确认新所有权行写入后才能恢复云端保存。

完整不变量与状态转换见[原生 Canvas 恢复契约](../architecture/native-canvas-recovery.md)。
