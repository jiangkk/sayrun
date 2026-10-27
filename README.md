<div align="center">

# Sayrun

### 为终端工作流而生的即时 AI 助手

为用着 DSH、也习惯亲手敲命令的你，把 AI 帮助接进日常终端工作流。

**命令照常敲，AI 随时问。**

Sayrun (`sayrun-shell`) is an AI terminal assistant for zsh, powered by your installed DeepSeek Harness (DSH). Ask in natural language, choose how commands are authorized, and continue your existing shell workflow.

当前支持 zsh 集成 · 复用已认证的 DSH

[安装使用](#安装使用) · [快速开始](#快速开始) · [功能特性](#功能特性) · [常见问题](#常见问题) · [文档索引](docs/README.md)

</div>

操作到一半，想查一个命令、理解一段报错，或者让 AI 帮忙检查项目？Sayrun 让你在原来的 zsh 提示符中直接提问，无需先进入独立的 AI 对话界面。需要执行命令时，先查看、编辑或批准；获得结果后，接着做手头的事。

普通命令、别名、函数和多行输入照常交给 zsh。你可以自己敲命令，也可以随手用自然语言求助，在同一个终端里交替进行。

Sayrun 将你已有的 DSH 能力接入日常 shell 操作。当前内置 DSH 后端，复用已配置的认证，无需重复配置 API Key。

当前为 0.1.x 早期版本，已在 macOS / Apple Silicon 验证。欢迎试用和反馈；平台、后端及执行边界见下文和 [安全说明](SECURITY.md)。

## 效果预览

![命令审批界面：任务描述、命令预览，以及批准、拒绝和编辑操作](https://cdn.jsdelivr.net/npm/sayrun-shell@latest/docs/images/approval-preview.png)

*上图由项目实际的 OpenTUI 渲染器生成，使用演示任务和路径，未调用模型或执行命令。*

安装后可运行 `sayrun preview` 体验审批与编辑；预览无需配置模型凭证。

## 安装使用

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | 已在 macOS / Apple Silicon 验证；Linux 和其他架构待验证 |
| 终端 | 交互式终端；当前自然语言输入集成仅支持 zsh |
| Node.js | 22 或更高版本 |
| DSH | 已安装、完成认证且位于 `PATH`；使用 `sdk-minimal`，不限制版本号 |

**Windows 用户请注意：当前不支持 Windows 原生环境（PowerShell、CMD 等）。WSL 尚未验证，后续考虑支持。**

Bun 和 OpenTUI 由 npm 依赖安装，无需额外全局安装 Bun。日常使用不需要 Python。

当前 OpenTUI 依赖声明 Node.js >= 26.4.0。Sayrun 的界面在 Bun 中运行，Node.js 22 已通过安装与终端回归；npm 默认设置下安装可能出现 `EBADENGINE` 警告。若你的 npm 开启了 `engine-strict`，请使用 Node.js 26.4.0 或更高版本。

尚未安装 DSH 时，请先按 [DeepSeek Harness 官方说明](https://github.com/deepseek-ai/deepseek-harness#run) 安装并完成模型认证。Sayrun 需要 `dsh --version` 能在当前终端运行；只有 `npx` 启动记录、但 PATH 中没有 `dsh` 时，可全局安装官方包：

```zsh
npm install -g @deepseek-ai/dsh
dsh --version
```

DSH 仍在快速迭代。Sayrun 不按版本号拦截，实际运行需要 `sdk-minimal`、JSON-RPC 和桥接插件接口兼容；可用 `sayrun backend check dsh` 检查本地启动情况。认证设置见 [官方模型配置文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。

### 安装到本机

通过 npm 全局安装：

```zsh
npm install -g sayrun-shell
```

npm 包名为 `sayrun-shell`，安装后的终端命令为 `sayrun`。安装包包含构建后的 JavaScript，无需下载源码或手动构建。

### 启用终端集成

Sayrun 复用 DSH 已配置的凭证，无需重复配置 API Key。安装完成后执行：

```zsh
sayrun setup
```

`setup` 先选择授权模式，默认一律询问，再使用 OpenTUI 展示 Sayrun 字标、安装预览和确认选项，经确认后备份 zsh 配置文件，并写入终端集成。首次在交互式终端运行时，会自动进入已启用 Sayrun 的新 zsh，随后即可直接输入自然语言；`exit` 返回原终端。已经加载集成的终端运行 `setup` 会直接刷新当前集成。

脚本调用或使用 `--no-shell`、`--temporary`、`--zshrc` 时不会自动启动新 shell。也可以手动在当前交互式 zsh 中启用：

```zsh
eval "$(sayrun shell init zsh)"
sayrun doctor
```

终端集成只需配置一次，以后新开的 zsh 终端会自动加载。配置、历史和诊断等管理操作使用 `sayrun` 命令。

## 快速开始

### 直接输入需求

在原来的 zsh 提示符中直接输入，然后回车：

```text
帮我找出当前目录最大的十个文件，只读取文件信息
```

也可以尝试：

```text
检查这个项目的目录结构，并说明主要模块的职责
查看当前 Git 工作区的变更，帮我整理一份摘要
```

以上示例分别输入，每次发起一个任务。常规命令、别名、函数和多行命令继续交给 zsh；歧义输入会尝试分类，无法确定时询问你。

日常使用无需添加命令前缀。未启用终端集成，或希望明确发起任务时，也可以使用：

```zsh
sayrun ask "帮我找出当前目录最大的十个文件，只读取文件信息"
```

### 审批与查看结果

1. 查看任务、执行目录和完整命令。
2. 选择批准、拒绝，或先编辑命令；默认每条新命令都需要审批。
3. 查看命令输出和退出状态，必要时回答补充问题。
4. 阅读任务结论，回到提示符继续操作；启用集成后，同一 zsh 实例和项目中的后续提问默认延续当前会话。

| 按键 | 操作 |
| --- | --- |
| `y` / `n` | 批准 / 拒绝当前命令 |
| `←` `→` / `Tab`，再按 `Enter` | 切换并确认操作，默认选中批准 |
| `e` | 编辑命令；编辑后按 `Enter` 默认执行修改后的命令 |
| `Shift-Enter` / `Ctrl-S` | 编辑时换行 / 仅保存并返回审批 |
| `↑` `↓` / `PgUp` `PgDn` | 滚动命令预览 |
| `Ctrl-C` | 取消当前任务并恢复终端 |

## 功能特性

| 功能 | 能做什么 |
| --- | --- |
| 即用即问 | 在原有 zsh 提示符直接输入需求，普通命令与自然语言交替使用 |
| 逐条命令审批 | 展示执行目录和命令，支持批准、拒绝、编辑后执行 |
| 终端交互界面 | OpenTUI 提供键盘选择、多行编辑、追问和滚动；也可切换纯文本模式 |
| 执行反馈 | 展示输出摘要、退出状态和 Markdown 结论，支持取消与超时限制 |
| 统一任务历史 | 按项目查看、搜索、重命名、固定、归档、导入和导出会话 |
| 连续对话 | 同一 zsh 实例和项目复用 DSH 原生会话，上下文自动压缩由 DSH 管理 |
| 分层配置 | 支持用户配置、项目配置和命名配置组合，可查看生效值及其来源 |
| 后端扩展与诊断 | 内置 DSH，支持显式注册外部进程适配器，提供能力检查和环境诊断 |

### 回看与继续任务

```zsh
sayrun sessions
sayrun sessions search "构建失败"
sayrun sessions show <会话ID> --full
sayrun ask --new "开始一个新任务"
sayrun resume --last --prompt "根据刚才的结果，再检查一次"
sayrun resume <会话ID> --context-only --prompt "使用可见历史继续"
sayrun sessions export <会话ID> --format markdown --output /tmp/task.md
```

启用 zsh 集成后，同一 shell 实例、项目和后端中的提问默认延续当前会话，每次提问记录为独立 run。普通命令（如 `ls`、`git status`）和重新加载集成不会切断对话；新终端或新启动的 zsh 使用独立会话。同一 Git 项目内切换子目录保留会话，切换项目会使用独立会话，切回来可继续。普通命令的输出不会自动发送给模型，环境变化需在下一轮重新检查。使用 `sayrun ask --new "任务"` 主动开始新对话。

DSH 通过 `session/resume` 恢复原生历史，保留其上下文压缩结果；每轮结束正常关闭后端并保存历史。恢复失败会明确报错，不会静默丢失上下文；可显式使用 `--context-only` 将可见历史作为上下文创建新分支。旧命令不会自动重放，后续执行采用当前授权模式。关闭本工具历史时不自动续接会话；未加载 zsh 集成的独立调用仍默认新建，可用 `resume` 显式继续。

### 调整常用配置

```zsh
sayrun config show --effective       # 查看实际配置及来源
sayrun config set ui.mode plain      # 所有命令使用纯文本界面
sayrun config set ui.mode opentui    # 切回 OpenTUI
sayrun config set agent.max_commands 20
sayrun config set agent.max_steps 24
sayrun config set execution.timeout_seconds 60
sayrun backend list
sayrun backend check dsh
```

用户配置默认位于 `~/.config/terminal-agent/config.toml`，项目配置使用 `.terminal-agent.toml`；这些路径沿用旧版命名，以兼容已有配置和历史。涉及后端、模型、预算等字段时，需要先执行 `sayrun config trust .`。

默认每次任务最多 15 条命令、15 个模型步骤、5 次追问和 600 秒活动时间，等待人工输入时暂停计时；同一会话再次提问会重新计数。预算用完时先汇总进展、卡点和下一步；模型无法收尾时根据执行记录汇总。较长任务可调整预算。详见[执行与异常](docs/guide/usage.md#执行与异常)。

## 常见问题

### 已经在用 DSH，为什么还需要 Sayrun？

如果你用着 DSH，也习惯在 zsh 里自己敲命令，Sayrun 可以把两种操作接在一起。遇到临时问题，直接在当前提示符提问；需要执行命令时逐条确认，处理完回到提示符，继续手头的工作。模型调用沿用已认证的 DSH，无需为每次求助先进入独立的 AI 对话界面。

### 安装后为什么自然语言没有生效？

npm 安装提供命令行程序；直接输入自然语言需要 zsh 已加载终端集成。执行 `sayrun setup`，确认后会自动进入已启用的新 zsh；已加载集成时则刷新当前终端。通过 `sayrun shell status` 可以查看状态。使用 `--no-shell` 仅完成配置后，可打开新的 zsh 终端，或执行上面的 `shell init zsh` 命令立即启用。

`postinstall` 无法修改安装命令所在父 shell 的回车处理，因此自动配置和启用由 `sayrun setup` 完成。

管理命令共用 OpenTUI 的配色和展示方式：`doctor` 显示检查清单，配置、认证、后端和历史显示分组结果；`sessions` 支持方向键选择任务。默认输出面向阅读，显式 `--json`、历史导出和 `shell init zsh` 保留原始输出。窄终端会自动换行和收起大字标，`NO_COLOR` 禁用强调色，非 TTY、`TERM=dumb` 或 `ui.mode=plain` 使用纯文本。可以先运行 `sayrun setup --dry-run` 查看安装界面。

如果手动关闭过，可用 `sayrun shell on` 开启；如果配置过仅显式触发模式，使用 `sayrun config set routing.mode auto` 恢复自动识别。未加载终端集成时，也可以通过 `sayrun ask "任务"` 使用。

### 命令会自动执行吗？

默认“一律询问”，每条命令都需要你明确批准。可选“普通授权”（非 sudo 命令自动执行）或“完全授权”（进入任务先验证 sudo，之后自动执行；需要提权时仍显式写 sudo）。授权模式可在 `setup` 中选择，或通过 `sayrun config set approval.mode ask|normal|full` 修改。完整说明见[授权模式](docs/guide/usage.md#授权模式)。默认执行器在本机启动独立的 `zsh -f -c`，不加载别名、函数或启动配置；不同命令之间不保留 `cd` / `export`。当前不支持需要交互输入的命令或后台任务，也没有提供操作系统沙箱。

### 需要哪些运行时？

Node.js 运行命令行入口，npm 安装的 Bun 运行 OpenTUI 界面，DSH 提供模型后端。使用者运行构建后的 JavaScript；TypeScript 和 `tsx` 用于开发，Python 仅用于终端和安装回归测试。

### 如何排查环境或认证问题？

先执行 `sayrun doctor`、`sayrun backend check dsh` 和 `sayrun auth status dsh`。默认检查不发送模型请求；需要在线验证时使用 `sayrun doctor --live`，可能产生模型用量。

### 如何卸载？

```zsh
sayrun shell uninstall --dry-run
sayrun shell uninstall
npm uninstall -g sayrun-shell
```

卸载集成会备份 zsh 配置并移除标记区块，已有配置和历史保留。

## 开发与反馈

```sh
git clone https://github.com/jiangkk/sayrun.git
cd sayrun
npm ci --registry=https://registry.npmjs.org
npm test
```

常规测试使用离线 DSH 替身，无需模型密钥。完整资料从[文档索引](docs/README.md)进入；日常命令见[使用手册](docs/guide/usage.md)，参与开发见[贡献指南](CONTRIBUTING.md)，实现结构见[架构文档](docs/development/architecture.md)。

问题反馈请使用 [GitHub Issues](https://github.com/jiangkk/sayrun/issues)，并移除日志中的密钥、业务信息和私人路径。安全问题请按 [安全策略](SECURITY.md) 私密报告。

## 许可证

Sayrun 使用 [MIT 许可证](LICENSE)。DSH 及其他依赖遵循各自的许可证，DSH 由使用者单独安装。
