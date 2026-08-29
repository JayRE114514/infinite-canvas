# 无限画布文档索引

## 项目介绍

- [快速开始](/zh-CN/docs/overview/quick-start)
- [功能介绍](/zh-CN/docs/overview/features)
- [Render 部署](/zh-CN/docs/overview/render)
- [Docker 部署](/zh-CN/docs/overview/docker)
- [第三方提示词来源](/zh-CN/docs/overview/third-party-prompt-repositories)

## 操作手册

- [画布节点操作手册](/zh-CN/docs/canvas/canvas-node-manual)
- [画布快捷键](/zh-CN/docs/canvas/canvas-shortcuts)

## 开发与数据

- [本地开发](/zh-CN/docs/development/local-development)
- [Agent 开发流程](./matt-pocock-skills.md)
- [画布数据结构](/zh-CN/docs/development/canvas-data-structure)
- [领域上下文](../CONTEXT.md)
- [平台 PRD](./product/platform-prd.md)
- [后端平台架构](./architecture/backend-platform.md)
- [后端平台路线图](./architecture/platform-roadmap.md)
- [需求追踪表](./architecture/requirements-traceability.md)
- [原生 Canvas 恢复契约](./architecture/native-canvas-recovery.md)
- [Asset 生命周期契约](./architecture/assets.md)
- [积分账本契约](./architecture/credits-ledger.md)
- [AI Task 与 Provider 契约](./architecture/ai-task-provider.md)
- [架构决策记录](./adr/README.md)

## 商务合作

- [开源协议](/zh-CN/docs/business/license)
- [商务合作](/zh-CN/docs/business/business)

## 支持与安全

- [漏洞提交](/zh-CN/docs/support/security)
- [赞助支持](/zh-CN/docs/support/sponsor)

## 项目进度

- [更新日志](/zh-CN/docs/progress/changelog)
- [Gate 0 后端验证记录](/zh-CN/docs/progress/gate-0-backend-verification)
- [Gate 0 前端验证记录](/zh-CN/docs/progress/gate-0-frontend-verification)
- [待测试](/zh-CN/docs/progress/pending-test)
- [TODO](/zh-CN/docs/progress/todo)

## 说明

- 登录后的 Canvas 快照与 revision 由服务端权威保存；原生 IndexedDB 只保存本地恢复草稿和 UI 状态，媒体字节与“我的素材”在 Asset 切换前仍保存在浏览器。
- AI API Key 保存在浏览器本地，并由前端直接请求 OpenAI 兼容接口。

## 原理说明

- [本地 Codex 连接画布原理](/zh-CN/docs/development/local-codex-canvas)
