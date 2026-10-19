# Sayrun 文档

这里按使用目的组织项目文档。当前使用方式、接口和开发流程分别维护；历史设计保留用于追溯，不作为当前功能说明。

## 从这里开始

| 你要做什么 | 阅读入口 |
| --- | --- |
| 了解项目、安装并尝试第一次任务 | [项目首页](../README.md) |
| 查找命令、配置、会话恢复和执行限制 | [使用手册](guide/usage.md) |
| 编写外部后端适配器 | [后端协议参考](reference/backend-protocol.md) |
| 理解源码结构与模块职责 | [项目结构与职责](development/architecture.md) |
| 准备开发环境、构建和选择测试 | [构建与测试](development/testing.md) |
| 贡献代码与提交变更 | [贡献指南](../CONTRIBUTING.md) |
| 使用开发 Agent 修改仓库 | [Agent 开发约定](../AGENTS.md) |
| 发布 npm 包、导出源码或部署官网 | [发布与公开源码](development/releasing.md) |
| 新增、修改或移动文档 | [文档维护规范](development/documentation.md) |

## 目录分类

| 位置 | 内容与维护方式 |
| --- | --- |
| `guide/` | 面向用户的操作指南，描述当前可用行为 |
| `reference/` | 面向集成作者的接口、字段与协议约束 |
| `development/` | 面向贡献者和维护者的架构、验证与发布流程 |
| `archive/` | 有日期的历史设计快照，不跟随实现更新 |
| `images/` | 文档图片；保留发布包与 CDN 使用的现有路径 |

根目录保留 GitHub 与 npm 的常用入口：[README](../README.md)、[贡献指南](../CONTRIBUTING.md)、[安全策略](../SECURITY.md)、[更新记录](../CHANGELOG.md)和 [LICENSE](../LICENSE)。官网开发说明保留在 [website/README.md](../website/README.md)。

## 历史资料

- [可插拔后端与产品化设计](archive/product-and-backend-design.md)：2026-10-19 归档，包含早期决策依据、迁移记录与未实现提案。

## 文档之间的关系

使用手册维护完整操作说明；首页和官网提供简明入口，并与它保持一致。后端协议维护集成约束，架构文档维护实现职责，构建与测试文档维护验证方法，发布文档维护发布操作。发现文档与实现或测试冲突时，核实后在同一变更中修正文档；归档资料仅补充指向当前文档的说明。
