# 项目结构与职责

[文档索引](../README.md) · 分类：开发维护 · 状态：当前

本文面向修改 Sayrun 源码的开发者，记录当前模块职责、依赖约束与运行时结构。环境准备和测试命令见[构建与测试](testing.md)，后端传输细节见[后端协议参考](../reference/backend-protocol.md)。

生产源码和构建脚本使用 TypeScript，发布时由 Bun 转译为 JavaScript。源码按功能归类；当前实际结构如下。

## 目录概览

```text
bin/
  sayrun.ts               # 可执行入口
src/
  application/                    # 任务与分类编排、活动预算
  backends/
    dsh/                          # DSH adapter、composition、RPC、插件
    process/                      # 外部进程后端
    classification.ts             # 分类响应解析
    protocol.ts                   # 能力准入、事件队列、工具定义
    registry.ts                   # 后端选择
  cli/
    commands/                     # 配置、后端、历史、认证与诊断
    args.ts                       # 共享选项解析
    input.ts                      # 交互读取
    main.ts                       # CLI 主流程与任务 / 恢复入口
    manage.ts                     # 管理命令分派与简单命令
    output.ts                     # 人类可读报告 / 显式 JSON 输出
    presentation.ts               # 共用报告、状态、交互契约
    help.ts                       # 分组命令指南
    version.ts                    # 包版本读取
  config/                         # 默认值、校验、加载与保存
  contracts/                      # 共享类型接口
  execution/                      # 命令规范化、本地 zsh 执行
  history/                        # 会话存储、运行写入、上下文、导出、迁移
  platform/                       # 路径、文件、项目定位、运行时、shell 安装
  terminal/                       # UI 工厂、PlainUi、OpenTUI、展示与预览
  errors.ts                       # 跨模块错误码与退出码
  globals.d.ts                    # 构建标记声明
shell/
  sayrun.zsh
scripts/
  build.ts
docs/                             # guide、reference、development、archive 与文档索引
test/
  *.test.mjs                      # Node 测试，tsx 加载 TS 源码
  ui.test.ts                      # Bun / OpenTUI 测试
  fixture-*.mjs                    # 独立 Node 协议替身
  *.py                            # 真实终端与安装回归
```

`src/` 根目录只保留共享错误与构建声明。DSH 插件已从根目录 `dsh/` 归入 `src/backends/dsh/`，所有源码统一位于 `src/` 与薄入口 `bin/`。

## 程序主流程

```text
用户输入 / zsh accept-line
  → cli/main 解析命令、加载配置
  → application/run-task 协调任务
  → Backend 返回统一事件
  → TerminalUi 展示命令并等待审批
  → Executor 执行批准后的准确命令
  → RunWriter 保存实际结果
  → Backend 收到结果并继续
  → 关闭界面、打印结论
```

协调器掌握审批、执行、预算与持久化顺序。后端负责模型协议适配，不能直接读取宿主终端或绕过审批执行命令。回答问题与批准命令属于两种独立交互。

## 逐文件职责

### 应用与命令行

| 文件 | 内容与职责 |
| --- | --- |
| `bin/sayrun.ts` | 调用 CLI main，将返回值设为退出码。 |
| `src/application/run-task.ts` | 后端连接、统一事件消费、审批 / 回答、执行、落盘、去重、预算和取消；支持注入依赖进行测试。 |
| `src/application/classify-input.ts` | 按产品配置选择分类后端、记录分类历史，失败时返回 `ask`。 |
| `src/application/active-budget.ts` | 计算模型 / 执行活跃时间，等待用户时暂停。 |
| `src/cli/main.ts` | 顶层命令解析、任务 / 恢复入口、Bun UI 重新启动、错误与退出码映射。 |
| `src/cli/manage.ts` | 管理命令分派；处理安装、shell、认证入口、版本、更新、profile、迁移等简单分支。 |
| `src/cli/commands/config.ts` | 查看 / 设置 / 编辑 / 校验配置及项目信任。 |
| `src/cli/commands/backend.ts` | 后端列举、检查、注册、切换和移除。 |
| `src/cli/commands/sessions.ts` | 历史选择器、查询、导入导出、分支、GC 和索引命令。 |
| `src/cli/commands/auth.ts` | 查询后端认证来源与本地配置状态，不读取或打印密钥内容。 |
| `src/cli/commands/doctor.ts` | 检查 shell、后端、UI、存储、认证与平台；显式 live 时才发送模型探测。 |
| `src/cli/args.ts` | 管理命令共享的选项类型、解析、参数数量校验。 |
| `src/cli/input.ts` | 首次任务、历史选择等终端输入；统一 Ctrl-C / EOF 处理，避免历史选择器反向导入 main。 |
| `src/cli/output.ts` | 人类可读报告和显式 JSON 输出。 |
| `src/cli/presentation.ts` | 管理命令的报告结构、字段展示、历史摘要和终端交互契约；纯文本回退。 |
| `src/cli/help.ts` | 分组命令指南。 |
| `src/cli/version.ts` | 从安装包根目录读取版本，兼容源码与 bundle 的不同目录深度。 |

### 后端与执行

| 文件 | 内容与职责 |
| --- | --- |
| `src/backends/registry.ts` | 根据配置创建 DSH 或外部进程后端。 |
| `src/backends/protocol.ts` | 能力准入、协议版本、异步事件队列、事件元数据与宿主工具定义。 |
| `src/backends/classification.ts` | 校验分类响应的路由和置信度；不依赖应用层或具体后端。 |
| `src/backends/dsh/backend.ts` | DSH 兼容性探测、session、socket 服务、请求回复关联、统一事件转换与关闭。 |
| `src/backends/dsh/classifier.ts` | 无工具 DSH 分类会话；限制时间和步数，拒绝工具调用等越界行为。 |
| `src/backends/dsh/composition.ts` | persona、composition patch、凭证路径引用、进程启动及诊断。 |
| `src/backends/dsh/rpc.ts` | DSH 逐行 JSON-RPC 的请求关联、通知、超时与连接清理。 |
| `src/backends/dsh/terminal-tool.ts` | 独立构建的 DSH 插件，注册命令 / 问题工具，通过带令牌的 Unix socket 交回宿主。 |
| `src/backends/process/backend.ts` | manifest、环境白名单、外部后端握手、消息关联、事件流和子进程回收。 |
| `src/execution/local-zsh.ts` | Executor 的本地实现，绑定 targetId、shell、超时和输出限制。 |
| `src/execution/process-runner.ts` | 校验并冻结命令、规范化 cwd、过滤敏感环境变量、采集输出、超时、取消与进程组终止。 |

### 配置与历史

| 文件 | 内容与职责 |
| --- | --- |
| `src/config/defaults.ts` | 完整有效配置的默认值。 |
| `src/config/schema.ts` | 字段 / 类型 / 枚举 / profile 校验，配置路径读取、更新与 flatten。 |
| `src/config/load.ts` | TOML 读写、用户 / profile / 项目 / 环境 / CLI 合并、来源记录、摘要信任和保存备份。 |
| `src/history/store.ts` | 安装身份、会话元数据、文件锁、事件读取、查询、导入、GC 和 SQLite 索引重建。 |
| `src/history/run-writer.ts` | 单次运行的状态、事件追加、fsync、命令输出、结果与最终状态写入。 |
| `src/history/shell-session.ts` | 按 shell 实例、项目与后端绑定当前原生会话；排除归档、导入和只读记录。 |
| `src/history/context.ts` | 选择可见历史，裁剪继续任务时发送的上下文。 |
| `src/history/export.ts` | Markdown 导出与可预览的敏感信息遮盖。 |
| `src/history/migrate-dsh.ts` | 验证 DSH v4、转换执行事实、备份原始字节、去重导入，保留旧数据。 |

### 终端与平台支持

| 文件 | 内容与职责 |
| --- | --- |
| `src/terminal/command-opentui.ts` | 管理命令共用的 OpenTUI 滚动历史、状态栏、确认按钮、输入和历史选择器。 |
| `src/terminal/theme.ts` | 任务 UI 与管理命令共用的配色和 NO_COLOR 处理。 |
| `src/terminal/factory.ts` | 选择 PlainUi 或按需加载 OpenTUI。 |
| `src/terminal/plain.ts` | readline 审批、问题输入和外部编辑器编辑。 |
| `src/terminal/ui-opentui.ts` | OpenTUI 布局、审批、编辑、追问、键盘鼠标、滚动、尺寸变化与关闭。 |
| `src/terminal/transcript.ts` | Markdown 转终端文本、ANSI-aware 换行、命令摘要与任务结论。 |
| `src/terminal/display.ts` | 清除不可信终端控制字符、输出文本、遮盖诊断中的凭证。 |
| `src/terminal/preview.ts` | 使用模拟数据展示 UI，不调用模型或执行命令。 |
| `src/platform/paths.ts` | 安装资产与用户配置 / 数据 / 状态 / 缓存 / runtime 路径，区分源码和 bundle 深度。 |
| `src/platform/project-root.ts` | 独立的项目 realpath / git root 定位，供配置与历史共同使用。 |
| `src/platform/atomic-file.ts` | 私有目录、原子文件 / JSON 写入、fsync、JSON 读取和进程存活检查。 |
| `src/platform/bun-runtime.ts` | 从安装依赖中定位固定版本的 Bun。 |
| `src/platform/shell-setup.ts` | `.zshrc` 标记区块计划、确认、备份与应用；EDITOR argv 解析和编辑器启动。 |
| `shell/sayrun.zsh` | ZLE widget、shell 输入路由、分类 / 任务调用、启停、sayrun wrapper 和父 shell 恢复。 |
| `src/errors.ts` | 产品错误码、消息、退出码和参数错误构造。 |
| `src/globals.d.ts` | 声明构建时注入的标记。 |

### 共享契约

| 文件 | 内容与职责 |
| --- | --- |
| `src/contracts/backend.ts` | 统一事件判别联合、能力、连接、分类、session 和宿主回复。 |
| `src/contracts/config.ts` | 完整配置、局部配置和后端设置。 |
| `src/contracts/execution.ts` | 命令输入、规范化提案、执行选项 / 结果和 Executor。 |
| `src/contracts/ui.ts` | UI 初始化、工厂、交互接口、显示结果与 transcript 样式行。 |
| `src/contracts/history.ts` | 会话元数据、持久化事件、运行状态、导入和查询选项。 |
| `src/contracts/wire.ts` | 外部 JSON 动态对象与待处理 RPC 回复类型；应用逻辑使用上述具体契约。 |

### 构建、测试与文档

| 文件 | 内容与职责 |
| --- | --- |
| `scripts/build.ts` | 分别构建 Node CLI、Bun UI、Node DSH 插件和 zsh 资产；使用暂存目录，失败时保留上次成功构建。 |
| `scripts/render-preview.ts` | 通过实际 OpenTUI 渲染器导出演示画面为 SVG，不调用模型或执行命令；图片保存在 docs/images。 |
| `package.json` / `package-lock.json` | 命令、发布白名单、CLI、平台、依赖与版本锁定。 |
| `tsconfig.json` | 检查 src、bin、scripts；strict、ESM、type-only import 和未使用声明检查，不生成 JS。 |
| `test/core.test.mjs` | 命令执行 / 校验、取消、输出上限、RPC、composition、shell 路由与预算。 |
| `test/product.test.mjs` | 配置、信任、安装、历史 / 锁 / GC、协调器顺序、外部插件和恢复。 |
| `test/cli.test.mjs` | CLI 解析、路径、非 TTY 行为和 zsh 接入。 |
| `test/transcript.test.mjs` | Markdown、换行、控制字符清理和输出摘要。 |
| `test/build.test.mjs` | 独立 JS 入口、构建资产、插件 exports 和生成的 shell 集成。 |
| `test/ui.test.ts` | Bun 下 OpenTUI 的渲染、审批、编辑、追问、管理交互、窄窗口和滚动。 |
| `test/commands-pty.py` | 构建后的管理界面、setup 写入/取消、任务输入交接和历史选择的真实终端回归。 |
| `test/dsh-native-smoke.mjs` | 使用本机 DSH 与本地模拟模型服务，验证原生会话跨进程恢复。 |
| `test/export.test.mjs` | 公开源码快照的白名单、排除项、目标路径和符号链接检查。 |
| `test/fixture-dsh.mjs` / `test/fixture-backend.mjs` | 可由普通 Node 执行的确定性协议替身，不调用外部模型。 |
| `test/terminal-pty.py` | 真实 PTY 中的 zsh 与 CLI，覆盖两种 UI、审批、拒绝、取消、问答、编辑与重新加载。 |
| `test/history-pty.py` | 真实终端中的历史查看、恢复与上下文分支。 |
| `test/package-install.py` | 清理旧 dist、重新打包、安装到临时 prefix，在仓库外与只读安装目录验证 CLI / UI / shell。 |
| `README.md` / `docs/README.md` | 项目首页与按用途分类的文档入口；详细说明按指南、参考、开发维护与历史归档组织。 |
| `docs/development/architecture.md` | 本文：实际目录、逐文件职责、依赖约束与后续建议。 |
| `.npmignore` / `package.json#files` | 排除开发文件；发布白名单保留 dist 和 README 预览 PNG，npm 自动附带根 README、许可证及 package.json。 |
| `.gitignore` | 忽略 dist、node_modules、运行状态、日志与 tarball。 |

`dist/`、`node_modules/`、`.runtime/`、`*.tgz` 是构建 / 安装 / 运行产物。`docs/archive/product-and-backend-design.md` 保留历史设计依据与归档时的提案，不作为当前实现说明。实际范围以实现与测试为准。

## 依赖约束

- CLI 处理参数、交互入口、展示和退出码；任务协调位于 application。后端、执行器与 UI 使用 contracts 中的接口交互。
- DSH 的原始协议与 composition 留在 `backends/dsh/`。分类响应解析放在后端共享模块，避免 DSH 依赖应用层。
- 项目定位是 platform 能力，配置与历史直接复用，不再从配置模块借用项目定位。
- CLI 输入独立于 main，历史选择器直接引用 input，不再反向导入 CLI 主流程。
- `RunWriter` 只用 type-only import 引用 SessionStore，存储与写入器没有相互初始化的运行时依赖。
- 保持“明确审批 → 执行准确命令 → 保存结果 → 回复后端”的顺序。恢复历史不能将旧请求变成新授权。
- JSONL 和输出文件是权威事实，SQLite 是可重建索引。外部消息和旧历史仍需要运行时校验，TypeScript 不替代协议检查。
- Node CLI 与 Bun UI 独立构建、按需加载。源码测试与发布安装测试分别验证 TS 逻辑和 JS 分发路径。

## 演进原则

当前保留单 npm 包，不引入依赖注入框架或通用事件总线。以下是后续修改时的判断依据，不表示这些拆分已经实施：

1. 将 cli/main 中的恢复流程提取成独立应用用例，把具体依赖的创建集中到组合入口。
2. store 的锁、GC、索引继续增长时再独立；应用层可以只依赖开始 / 追加 / 保存结果 / 结束的小型历史接口。
3. UI 编辑与问答状态继续增长时再拆分组件；不为增加文件数而拆分。
4. 增加第二个真实后端前，统一后端契约测试，进一步完善外部 JSON 与历史事件的版本化解析。
5. 测试按领域归档，并维护随代码版本更新的设计文档。

## 构建与运行时

```text
tsc --noEmit       → 检查 TypeScript
Bun.build          → dist/sayrun.js          （Node）
                   → dist/ui-opentui.js      （Bun，任务交互）
                   → dist/command-opentui.js （Bun，管理命令）
                   → dist/terminal-tool.js   （Node / DSH 插件）
shell 源文件       → dist/sayrun.zsh
```

源码使用 `.ts` 相对导入；Bun 转译并压缩 JavaScript，不生成 source map。CLI、两类 UI 和 DSH 插件独立构建，zsh 集成作为运行资产生成并去除注释。构建使用暂存目录，失败时保留上次成功产物。

Node CLI 与 Bun UI 按需加载，非 TTY 管理命令和纯文本模式不会提前加载 Bun FFI。TypeScript、类型包和 tsx 属于开发依赖，消费者只运行构建后的 JavaScript。环境要求、构建入口和测试选择统一见[构建与测试](testing.md)，包内容与发布钩子见[发布文档](releasing.md#发布包内容)。
