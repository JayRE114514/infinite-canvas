# ADR 0001：模块化单体与 PostgreSQL 业务权威

状态：Accepted

平台使用 TypeScript + Fastify 模块化单体，API 与 Worker 共用领域模块但作为独立进程运行；PostgreSQL 是租户、权限、画布、积分和任务状态的唯一业务权威。相比全微服务或重新引入 Python/Go 服务，这一选择保留单事务边界和现有 TypeScript 维护收益，同时允许以后按已定义的进程与领域边界拆分。

后果：当前不引入 Keycloak、RabbitMQ、Redis 或 Kubernetes 来证明扩展性；只有可观测负载或恢复目标要求时才增加基础设施。
