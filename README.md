# Terminal Agent

在现有 zsh 提示符输入自然语言，在同一个终端逐条审批命令、查看结果和最终结论。任务结束后返回 shell，每次新请求默认使用新会话。

目前内置 **DSH adapter**，兼容已验证的 DSH `0.2.0-rc.2` / `sdk-minimal`。审批、执行、配置和历史通过统一后端契约工作；没有接入 Codex、Claude，也没有实现自己的模型循环。

## 安装与首次使用

需要 Node.js >= 22、zsh，以及 PATH 中已有的 DSH。npm 包固定安装 Bun 1.4.3、OpenTUI 0.6.6，不需要额外全局安装 Bun。

```zsh
npm install
npm pack                          # prepack 自动构建并压缩
npm install -g ./terminal-agent-0.1.0.tgz
terminal-agent setup --dry-run
terminal-agent setup
terminal-agent doctor
terminal-agent ask "找出当前目录最大的十个文件，只读取文件信息"
```

目前使用本地 tarball，未发布 registry / Homebrew。已在 macOS / arm64 验证；Linux 和其他架构仍需要实际发布测试。

`setup` 会先展示配置、历史和 zshrc 的修改计划，经确认后创建备份，只管理自己的标记区块。重复执行不会添加多个区块。`--yes` 可显式跳过确认；`--zshrc /path/.zshrc` 指定文件；`--temporary` 只初始化配置和存储并给出临时启用命令。

也可仅在当前交互式 zsh 中启用：

```zsh
eval "$(terminal-agent shell init zsh)"
```

初始化脚本不连接模型。明确命令、alias、函数、多行续行继续交给原有 zsh；歧义输入使用独立、无工具的分类请求，失败或置信度不足时询问用户。`ta` 已被命令、alias 或函数占用时会保留其定义，可用完整名称 `terminal-agent`。

```zsh
ta shell off
ta shell on
ta shell status
# 兼容旧入口：terminal-agent-off
```

开关由父 shell wrapper 处理；未加载集成时，子进程会说明如何启用。关闭分流不删除其他 ZLE 插件仍可能引用的回调。`shell status` 展示启用状态与 accept-line 包装信息。

```zsh
terminal-agent shell uninstall --dry-run
terminal-agent shell uninstall
npm uninstall -g terminal-agent
```

卸载集成只移除标记区块并备份 zshrc；配置与历史保留。旧版手工添加的无标记 source/eval 行需要自行删除。

## 日常任务与交互

```zsh
terminal-agent                        # 提示输入一次任务
terminal-agent ask "检查当前项目结构"
terminal-agent "帮我找最大的文件"     # 明确的自然语言快捷入口
terminal-agent -- "doctor"            # 强制任务文本，避免管理命令冲突
terminal-agent ask --profile ops "检查服务"
terminal-agent ask --backend dsh --model deepseek-flash "检查构建"
terminal-agent preview                # 无模型、无命令执行的 UI 预览
```

管理命令始终确定性解析。未知英文命令提示使用 `ask` / `--`，不会自动发送给模型。`ask` 要求 stdin 和 stdout 都是 TTY；只读管理支持管道。

每次批准只执行面板中的完整命令，面板展示本机主机名和绝对目录。每条命令使用独立 `zsh -f -c`，不加载 alias / 函数 / 启动配置，`cd` / `export` 不在命令之间持久化。命令 stdin 关闭，不支持交互程序或后台任务。

| 按键 | 操作 |
| --- | --- |
| `y` / `n` | 批准 / 拒绝当前命令；拒绝结束任务 |
| `←` `→` / `Tab` / `Shift-Tab` + `Enter` | 选择批准、拒绝或编辑；默认批准在最左侧、绿色背景 |
| `e` | 编辑完整命令 |
| 编辑框 `Enter` | 默认直接批准并执行修改后的命令 |
| 编辑框 `Shift-Enter` | 换行 |
| 编辑框 `Ctrl-S` | 仅保存并返回审批 |
| 编辑框 `Esc` | 放弃编辑并返回审批 |
| `↑` `↓` / `PgUp` `PgDn` / 滚轮 | 滚动命令预览 |
| 问题框 `Enter` / `Ctrl-S` | 发送文本回答；不会批准任何命令 |
| `Ctrl-C` | 取消任务并恢复终端 |

OpenTUI 的粘贴和换行不会触发执行。纯文本模式保留逐条审批、追问、输出和取消；输入 `e` 用 `$VISUAL` / `$EDITOR` 编辑命令，编辑器退出后重新展示并审批。方向键选择和内嵌多行编辑属于 OpenTUI 交互。

步骤保留命令、输出摘要和真实退出状态；最终结论渲染为终端 Markdown。默认摘要最多 12 行，完整有界输出仍回传模型；截断状态会标明。展示会过滤模型及命令提供的终端控制码。`NO_COLOR`、`TERM=dumb` 和 `ask --no-color` 关闭输出颜色，TUI 使用单色样式。

## 配置与 profile

```zsh
ta config show --effective --json
ta config get execution.timeout_seconds
ta config set agent.max_commands 10
ta config set ui.mode plain
ta config edit
ta config validate
ta profile list
ta config show --effective --profile ops
ta config set ui.output_preview_lines 8 --project
ta config trust .
```

配置采用 TOML schema 1，默认 `~/.config/terminal-agent/config.toml`，遵循 `XDG_CONFIG_HOME`。`config edit` 编辑临时副本，校验通过才原子替换原配置；修改前保存 `.bak`。`$EDITOR` 支持带引号的 argv，不执行 shell 替换。

生效顺序：默认 → 用户配置 → 显式 profile → 当前项目允许的字段 → 环境变量 → CLI。`show --effective` 展示每个值的来源与忽略项目字段的原因。

```toml
schema_version = 1

[agent]
backend = "dsh"
max_commands = 8
max_steps = 12
max_questions = 5
active_timeout_seconds = 180

[routing]
mode = "auto"                 # auto | local（歧义人工选择）| explicit（只用 ask）
classifier = "backend"
confidence_threshold = 0.9
timeout_seconds = 12
on_ambiguous = "ask"

[ui]
mode = "opentui"               # opentui | plain
language = "zh-CN"             # 后端回答的语言；当前管理界面为中文
color = "auto"                 # auto | always | never
output_preview_lines = 12

[approval]
default_selection = "approve"  # approve | reject | edit
editor_enter = "execute"       # execute | save

[execution]
executor = "local-zsh"
shell = "/bin/zsh"
timeout_seconds = 30
max_output_bytes = 65536

[history]
enabled = true
default_scope = "project"       # project | all
auto_gc = false
retention_days = 30
max_total_mb = 1024
store_command_output = true
include_classifier = false

[backends.dsh]
binary = "dsh"
model = "deepseek-flash"
api_key_env = "DEEPSEEK_API_KEY"
disabled = false

[context]
text = "当前项目的说明；作为上下文数据，不构成命令执行授权。"

[profiles.ops.agent]
max_commands = 12

[profiles.ops.execution]
timeout_seconds = 60
```

项目配置是最近 Git 根目录的 `.terminal-agent.toml`；非 Git 项目只读取当前任务目录。默认允许 UI 和项目上下文。后端选择、预算、路由和后端模型需要 `config trust .`。信任绑定目录 realpath 和配置摘要，内容改变后需要重新信任。

可执行文件、外部插件 manifest、凭证引用、审批策略和自动清理不能由项目配置覆盖，信任项目也不会开放这些字段。配置不接收明文 API key，只接收环境变量名或已有凭证文件路径。

| 环境变量 | 用途 |
| --- | --- |
| `TA_HOME` | 统一搬迁到其 `config/ data/ state/ cache/ runtime/` |
| `TERMINAL_AGENT_HOME` | 仅覆盖旧版 DSH home，不改变统一历史位置 |
| `TERMINAL_AGENT_DSH_BIN` | DSH 可执行文件 |
| `TERMINAL_AGENT_MODEL` | 仅兼容 DSH 模型，不传给其他适配器 |
| `TERMINAL_AGENT_CREDENTIALS` | 已有 DSH 凭证文件路径 |
| `TERMINAL_AGENT_UI` | `plain` / `opentui`；兼容旧值 `tui` |
| `TERMINAL_AGENT_CLASSIFY` | `local` 禁止在线歧义分类 |
| `TERMINAL_AGENT_NODE` | shell wrapper 使用的 Node 路径 |
| `DEEPSEEK_API_KEY` | 默认模型凭证；不打印或复制 |

未设置 `TA_HOME` 时，统一历史位于 `$XDG_DATA_HOME/terminal-agent`，状态与缓存分别遵循 `XDG_STATE_HOME`、`XDG_CACHE_HOME`。默认 DSH home 保留旧版 `~/.local/state/terminal-agent/dsh`；设置 `TA_HOME` 后使用其 `data/backends/dsh/default`。

## 后端、认证与诊断

```zsh
ta backend list --json
ta backend info dsh
ta backend check dsh
ta backend use dsh
ta auth status dsh
ta auth login dsh
ta doctor
ta doctor --live
ta version --json
ta update --check
```

本地 probe 检查版本和 host-tools 能力；不满足命令编辑、提问和取消能力的适配器在任务前拒绝运行，不自动换服务。只有 `--live` 才发送最小模型探测，并提示可能产生用量。

DSH 优先使用配置指定的 API key 环境变量，否则使用已有 DSH 凭证服务。`auth status` 只展示来源、环境变量是否设置、文件是否存在，不读取或显示密钥，也不将文件存在描述为认证有效。`auth login dsh` 给出 API key / 官方凭证配置说明，不读取桌面 App 内部 token。

`backend use` 只改变用户默认字段，当前项目仍有覆盖时会解释有效值与来源。内置 DSH 可通过 `config set backends.dsh.disabled true` 禁用，`backend remove dsh` 等价。重新启用设为 `false`。

`update --check` 仅查询 registry，不安装。实际更新按原渠道重新安装 tarball；不会在 shell 启动或任务中自动升级，也不宣称已公开发布。

## 统一历史与恢复

```zsh
ta sessions
ta sessions list --all --backend dsh --status failed --json
ta sessions list --include-classifier
ta sessions show <id> --full
ta sessions search "NXDOMAIN" --all
ta sessions rename <id> "UAT 域名排查"
ta sessions pin <id>                  # unpin
ta sessions archive <id>              # restore；list --archived 查看含归档记录
ta sessions export <id> --format markdown --preview
ta sessions export <id> --format json --redact --output /tmp/task.json
ta sessions import /tmp/task.json
ta sessions delete <id>               # 交互确认；--yes 显式确认
ta sessions gc --dry-run --days 30 --max-total-mb 1024
ta sessions gc --apply
ta sessions reindex

ta resume <id>                         # 先查看，输入新请求后才调用模型
ta resume --last --prompt "再检查一次"
ta sessions fork <id> --backend dsh --context summary
```

逻辑 `sessionId`、每次请求的 `runId` 和厂商 `nativeRef` 分开记录。唯一短 ID 可用；前缀不唯一时明确列出候选。默认按本机稳定身份和项目 realpath 过滤，`--last` 不自动恢复其他项目。

`events.jsonl`、输出附件和原子 `meta.json` 是内容来源；SQLite 索引可以从文件重建，即使索引损坏也能查看、搜索和导出。搜索目前扫描统一文件，不依赖厂商格式或索引可用性。`reindex` 使用 Node 的 SQLite 支持（Node 22 会打印实验特性提示）或 Bun SQLite。

DSH 原生恢复尚未验证，因此 `resume` **明确创建基于可见历史的新分支**，保留 `parentSessionId` 并展示将发送的事件范围。可见上下文包括用户请求、命令执行事实、有限输出、问题回答和结论，默认上限 32 KiB；不额外调用模型生成摘要。`fork --context summary` 同样表示这份本地可见事实摘要。不会回放或执行旧工具调用。

恢复沿用记录的后端、模型、目录和执行配置快照，当前更严格的预算、执行器、审批与保存策略优先。目录缺失时停止；更换后端要显式 fork。第三方适配器声明并实现 native resume 时可通过 `resumeRef` 复用；原生引用失效可显式使用 `resume --context-only`。

历史导入只保存为只读记录，不启动后端、不执行任何工具。恢复导入记录会创建新分支。JSON 导出包含版本、事件和受管理输出附件；Markdown 方便阅读。`--preview` 不写出文件；`--redact` 做常见凭证模式和项目路径的尽力脱敏，仍应自行检查导出内容。

删除与 GC 跳过活动会话，GC 排除固定会话；归档与固定独立。默认不自动 GC。删除只移除本工具统一历史，厂商原生会话保留并报告其位置，不遍历删除用户其他 DSH 会话。

`history.enabled=false` 关闭本工具的任务内容保存，仍保留最小运行状态；**DSH 可能继续保存原生记录**。DSH 不能验证关闭原生持久化，因此 `ask --ephemeral` 在连接前明确拒绝。

## 旧数据迁移

```zsh
ta migrate --from /absolute/path/.runtime/dsh --dry-run
ta migrate --from /absolute/path/.runtime/dsh --apply
```

只转换已验证的 DSH `session.v4.jsonl`。dry-run 不创建统一存储；apply 先备份源记录，再转换用户请求、工具结果与结论。按源文件 realpath 和内容摘要去重，重复导入同一内容不会重复创建会话。无法识别的记录列入 skipped，旧目录始终保留。迁移不意味着验证了原生恢复。

## 执行与异常

同一会话只允许一个写入进程。命令开始前追加并刷盘 `execution.started`，结果保存完成后才回传模型。写入失败会阻止执行；执行后保存失败会说明命令已执行、停止后续动作。崩溃只有开始而没有结果的执行标为 `interrupted / unknown`，不自动重试。

重复 `requestId` 复用已记录结果，内容不同的重复 ID、过期请求、切换目标请求会被拒绝；多个请求按队列逐条审批。后端断线会撤回等待中的交互并停止任务。后端完成不能跳过尚未结束的 host 执行。

默认最多 8 条命令、12 个模型步骤、5 次问题、180 秒活动时间，人工等待时暂停；每条命令独立限时 30 秒、输出最多 64 KiB。取消、超时和命令结束会清理普通进程组；自行脱离进程组的进程不在该保证内。命令环境过滤常见凭证变量；这是审批执行器，没有实现 OS 沙箱。

退出码：`0` 完成，`1` 运行失败，`2` 参数/配置错误，`3` 拒绝，`4` 预算/模型输出上限，`5` 后端能力/认证不可用，`130` 取消。命令自己的失败状态独立记录，后续修复成功不一定意味着整个任务失败。

## 适配器与开发

后端契约见 `src/backend.d.ts`，外部进程插件协议见 [ADAPTERS.md](ADAPTERS.md)。外部插件需要显式注册；不提供插件市场或自动安装任意包。

```zsh
ta backend add custom --manifest /absolute/path/adapter.json
ta backend check custom
ta ask --backend custom "任务"
ta backend remove custom
```

| 模块 | 职责 |
| --- | --- |
| `src/agent.mjs` | 后端无关的 Coordinator、审批、顺序、预算与取消 |
| `src/backend.mjs` / `backend.d.ts` | 统一事件、能力准入与契约 |
| `src/backends/` | DSH adapter、无工具分类及进程插件适配 |
| `src/dsh.mjs` / `rpc.mjs` / `dsh/` | DSH 专属组合配置、进程和桥接 |
| `src/config.mjs` / `setup.mjs` | TOML、来源、项目信任、安装与 shell 标记区块 |
| `src/sessions.mjs` / `storage.mjs` | 统一历史、锁、导入导出、GC、重建与刷盘 |
| `src/executors/local-zsh.mjs` / `src/execute.mjs` | local-zsh 执行、目录、超时、环境和输出上限 |
| `src/ui*.mjs` / `transcript.mjs` | 通用终端展示与交互 |
| `src/migrate.mjs` | 显式 DSH v4 迁移 |

```zsh
npm install
npm run build
npm test
npm run test:pty
npm run test:package
npm pack --dry-run
```

自动测试使用后端替身，不调用外部模型。PTY 需要创建伪终端和 Unix socket。打包测试在临时 prefix 实际全局安装，并在仓库外、安装目录只读的情况下验证 UI 和 shell；需要 registry 或完整 npm 缓存。离线用 `TERMINAL_AGENT_PACKAGE_TEST_OFFLINE=1`，可通过 `TERMINAL_AGENT_PACKAGE_TEST_CACHE` 指定缓存。

当前仍按设计后续阶段保留：Codex / Claude / 自建 harness、SSH executor、独立运行时安装包和 Homebrew / registry 发布。项目原始设计文档保留在 `docs/product-and-backend-design.md`，实际实现范围以本文和测试为准。

## 构建与发包

`npm run build` 使用项目固定版本的 Bun，将 CLI、OpenTUI 和 DSH bridge 分别打包到 `dist/`，执行语法压缩、空白压缩和标识符改名（minify / uglify），不生成 source map。OpenTUI 保留独立模块，Node 管理命令和纯文本模式不会提前加载 Bun FFI。zsh 集成作为必要的运行资产生成，去除注释并引用构建后的 CLI。构建失败保留上一次成功产物。

`prepack` 和 `prepublishOnly` 都调用构建，分别覆盖 `npm pack` 和 `npm publish`。发布包白名单只有 `dist/`、README、适配器说明以及 npm 必需的 package.json，不包含 `src/`、`bin/`、`shell/`、`dsh/`、构建脚本、测试或源码映射。`dist/` 不提交到 Git，消费者安装 tarball 不需要源码或执行构建。

```zsh
npm run build
npm run test:build
npm pack --dry-run
npm pack
# 确认发布目标和账号后再手动 npm publish；本仓库不会自动发布。
```
