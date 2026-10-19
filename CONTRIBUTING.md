# 参与开发

Sayrun 处于早期迭代阶段。目前内置 DSH 后端，自然语言输入集成支持 zsh。本文是贡献代码的起点；完整资料见[文档索引](docs/README.md)，模块职责见[架构文档](docs/development/architecture.md)，外部后端协议见[接口参考](docs/reference/backend-protocol.md)。

## 本地环境

需要 Node.js 22+、npm 和 zsh；Bun 与 OpenTUI 通过依赖安装，PTY 和安装回归还需要 Python 3。OpenTUI 的 Node 引擎声明会使 Node.js 22 的 npm 安装出现警告，严格安装需 Node.js 26.4.0+。具体要求见[开发环境](docs/development/testing.md#开发环境)。

```sh
git clone https://github.com/jiangkk/sayrun.git
cd sayrun
npm ci --registry=https://registry.npmjs.org
npm test
npm run test:pty
```

常规测试使用确定性的 DSH 替身，不连接真实模型。完整命令、离线安装测试、本机 DSH 恢复检查与验证限制统一见[构建与测试](docs/development/testing.md)。

## 调试与提交

`npm run build` 完成类型检查和构建，`npm run preview` 展示离线审批界面。调试真实任务时可用 `TA_HOME` 指向临时数据目录；使用真实后端可能产生模型用量。

提交变更时说明具体问题、变更后的行为，以及运行过的验证。涉及执行、审批、取消、持久化或协议边界的改动，应补对应行为测试。终端交互变更请运行真实 PTY 回归，并检查窄终端和纯文本模式。

测试和截图使用 `example.com`、`.invalid`、文档示例地址及虚构路径。请勿提交 `.env`、凭证、真实会话、业务域名、私人路径或本地运行目录。分享日志前先检查内容；导出脱敏只能尽力匹配常见模式。

贡献代码按本仓库的 [MIT 许可证](LICENSE) 提供。版本发布、公开源码导出和官网部署见 [发布说明](docs/development/releasing.md)。

## 提交信息规范

提交信息采用 Conventional Commits。标题格式为 `type: 中文摘要`，需要标明模块时使用 `type(scope): 中文摘要`；类型使用小写英文，冒号后留一个空格，作用域使用简短模块名，如 `history`、`terminal`、`backend`。摘要和正文使用中文，保留必要的技术标识符。

| 类型 | 用途 |
| --- | --- |
| `feat` | 新增用户可用功能 |
| `fix` | 修复错误或回归 |
| `docs` | 仅修改文档或开发约定 |
| `refactor` | 保持功能行为的代码重构 |
| `perf` | 性能优化 |
| `test` | 添加或调整测试 |
| `build` | 构建、依赖或打包配置 |
| `ci` | 持续集成工作流 |
| `style` | 不改变行为的代码格式调整 |
| `chore` | 其他维护工作，包括版本发布 |
| `revert` | 撤销已有提交 |

按变更的主要目的选择类型；功能或修复附带测试与文档时，仍使用 `feat` 或 `fix`。版本发布使用 `chore(release): 发布 <版本号>`，不使用裸版本号或省略类型的标题。

```text
fix(terminal): 修复取消任务后的终端状态恢复

清理待处理交互并恢复终端输入状态，避免取消后无法继续使用 shell。

验证：npm test、npm run test:pty
```

正文按需说明原因、行为变化与实际验证，和标题之间留一个空行。不兼容变更使用 `type(scope)!: 中文摘要`（无作用域时为 `type!: 中文摘要`），并在正文后空一行，使用 `BREAKING CHANGE: 中文说明` 交代影响与迁移方式。

由开发 Agent 执行提交时，先展示待提交文件范围和完整提交信息，用户确认后再执行。

## 文档变更

文档按使用指南、接口参考、开发维护与历史归档分类。新增、移动或修改内容时遵循[文档维护规范](docs/development/documentation.md)，更新文档索引与相关引用；用户行为变化还需同步核对 README、CLI 帮助和官网说明。
