# 构建与测试

[文档索引](../README.md) · 分类：开发维护 · 状态：当前

本文面向开发者，说明本地环境、构建、测试选择与验证限制。模块职责见[架构文档](architecture.md)，发包操作见[发布文档](releasing.md)。除非单独说明，命令均在仓库根目录执行。

## 开发环境

需要 Node.js 22+、npm 和 zsh。Bun 与 OpenTUI 通过项目依赖安装，无需额外全局安装 Bun；PTY 与安装回归还需要 Python 3，测试只使用 Python 标准库。macOS 自带 zsh，Linux 需自行安装，CI 中已配置安装步骤。

OpenTUI 当前声明 Node.js >= 26.4.0。Sayrun 使用 Bun 运行界面，Node.js 22 的 CLI 与 Bun 界面已通过本地回归；npm 默认模式可能提示 `EBADENGINE`。启用 `engine-strict` 的环境需要 Node.js 26.4.0+。CI 配置了 Node.js 22 的 macOS/Linux 默认安装，以及 Node.js 26.4.0 的 Linux 严格安装；配置矩阵不等于每个平台都已验证通过。

```sh
npm ci --registry=https://registry.npmjs.org
npm test
```

常规测试使用确定性后端替身，无需安装 DSH、配置密钥或调用真实模型。替身验证宿主行为与协议交互，不代表真实 DSH 或模型已经通过兼容性验证。

## 构建与运行

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 使用 `tsc --noEmit` 检查 `src/`、`bin/`、`scripts/` |
| `npm run build` | 先类型检查，再用固定版本 Bun 构建 CLI、UI、DSH 插件和 zsh 资产 |
| `npm run preview` | 自动构建后展示离线审批界面，不调用模型或执行命令 |
| `node dist/sayrun.js --help` | 检查已构建的 CLI 入口；需先构建 |

源码测试通过开发依赖 `tsx` 加载 TypeScript，Bun 运行 OpenTUI 测试；消费者运行构建后的 JavaScript，不需要 TypeScript 或 tsx。构建产物及运行时边界见[架构文档](architecture.md#构建与运行时)。不要手工修改 `dist/`。

## 测试命令

| 命令 | 覆盖范围 | 额外条件 |
| --- | --- | --- |
| `npm test` | 自动构建，运行 Node 行为测试与 Bun UI 测试 | 不连接真实模型 |
| `npm run test:pty` | 自动构建，运行真实终端中的任务、历史与管理命令回归 | Python 3、zsh、可创建 PTY 和 Unix socket |
| `npm run test:build` | 构建后验证独立 JS 入口、DSH 插件和生成资产 | 不连接真实模型 |
| `npm run test:package` | 清理旧产物、打包、安装到临时 prefix，在仓库外和只读安装目录验证 CLI、UI 与 shell | Python 3、registry 或完整缓存 |
| `npm run test:dsh` | 使用本机 DSH 验证原生会话跨进程恢复 | PATH 中已有 DSH；请求发往本机临时服务，使用测试密钥 |

`test:package` 不覆盖用户的全局安装。完全离线时设置 `TERMINAL_AGENT_PACKAGE_TEST_OFFLINE=1`，可用 `TERMINAL_AGENT_PACKAGE_TEST_CACHE` 指定预热的 npm 缓存。缓存不完整时仍可能失败。

`test:dsh` 不连接真实模型，也不代表所有 DSH 版本已验证。手动运行真实模型任务或 `doctor --live` 可能产生模型用量，验证记录需明确区分替身、本机 DSH 和真实模型。

## 按改动选择验证

先运行对应行为测试；完成前按影响范围补充检查。仅调整文档排版或链接时检查路径、锚点和示例即可。

| 改动 | 验证重点 |
| --- | --- |
| 审批、执行、取消、预算、配置与持久化 | `npm test`；覆盖批准与拒绝、失败与清理、执行与保存顺序等受影响行为 |
| 终端布局、输入与 zsh 集成 | `npm test`、`npm run test:pty`；检查窄终端、Plain 与 OpenTUI、Ctrl-C 后恢复 |
| 入口、Bun 加载、构建或分发资产 | `npm run test:build`、`npm run test:package`；验证仓库外安装路径 |
| DSH 原生恢复与桥接 | 对应替身用例；有本机 DSH 时补 `npm run test:dsh` |
| 发布候选版本 | 按[发布验证清单](releasing.md#发布验证)执行 |

单独运行 Node 测试时使用项目加载器，例如 `node --import tsx --test test/product.test.mjs`。涉及构建产物的用例需先运行 `npm run build`；单独运行 OpenTUI 测试使用 `node_modules/.bin/bun test test/ui.test.ts`。

## 调试与验证记录

使用临时目录及 `TA_HOME` 隔离调试数据，shell 安装测试使用临时 zshrc。测试、截图和日志示例使用 `example.com`、`.invalid`、文档示例地址及虚构路径，不提交凭证或真实会话。

提交变更时记录实际运行的命令、结果和未验证范围。遇到网络、PTY 或运行时限制时说明具体原因；不要把未运行、跳过或仅使用替身的检查写成真实环境验证通过。
