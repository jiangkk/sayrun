# Sayrun 使用手册

[文档索引](../README.md) · 分类：使用指南 · 状态：当前

本文面向使用 Sayrun 的用户，说明安装、日常任务、配置、历史和故障处理。在现有 zsh 提示符输入自然语言，在同一个终端逐条审批命令、查看结果和最终结论。任务结束后返回 shell；启用集成后，同一 zsh 实例、项目和后端中的后续提问默认延续当前会话，未加载集成的独立调用默认新建会话。

目前内置 **DSH adapter**，使用 DSH 的 `sdk-minimal` profile，不限制版本号。审批、执行、配置和历史通过统一后端契约工作；没有接入 Codex、Claude，也没有实现自己的模型循环。

## 安装与首次使用

需要 Node.js >= 22、zsh，以及 PATH 中已完成认证的 DSH。Sayrun 复用 DSH 的凭证。npm 包固定安装 Bun 1.4.3、OpenTUI 0.6.6，不需要额外全局安装 Bun。

OpenTUI 当前声明 Node.js >= 26.4.0。Sayrun 在 Bun 中运行界面，Node.js 22 已通过安装与终端回归；npm 默认模式可能提示 `EBADENGINE`，开启 `engine-strict` 时则需要 Node.js 26.4.0+。

DSH 安装与认证请参考 [官方安装说明](https://github.com/deepseek-ai/deepseek-harness#run) 和 [模型配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)。需要把命令放入 PATH 时，可运行 `npm install -g @deepseek-ai/dsh`，再用 `dsh --version` 验证。版本号不作为准入门槛；实际仍需兼容 `sdk-minimal`、JSON-RPC 和桥接工具接口。

```zsh
npm install -g sayrun-shell
sayrun setup --dry-run
sayrun setup
sayrun doctor
sayrun ask "找出当前目录最大的十个文件，只读取文件信息"
```

已发布到 npm。源码也可通过 `npm install`、`npm pack` 构建 tarball，再全局安装；暂未提供 Homebrew 安装。已在 macOS / arm64 验证；Linux 和其他架构仍需要实际发布测试。

`setup` 默认用 OpenTUI 展示品牌字标，以及配置、历史和 zshrc 的修改计划，经确认后创建备份，只管理自己的标记区块。重复执行不会添加多个区块。首次在交互式终端配置后，会自动进入已加载集成的新 zsh，可以直接输入自然语言；`exit` 返回原终端。已经加载集成时，会直接刷新当前 shell，不再嵌套新 shell。

`--yes` 可显式跳过确认；`--no-shell` 仅完成配置，不启用当前终端；`--zshrc /path/.zshrc` 指定文件；`--temporary` 只初始化配置和存储。非交互式调用和后两种选项均不会启动新 shell，会显示手动启用命令；已加载集成的终端仍会在成功配置后刷新，除非指定 `--no-shell`。取消确认时退出码为 130，不改变当前集成状态。

也可仅在当前交互式 zsh 中启用：

```zsh
eval "$(sayrun shell init zsh)"
```

初始化脚本不连接模型。明确命令、alias、函数、多行续行继续交给原有 zsh；歧义输入使用独立、无工具的分类请求，失败或置信度不足时询问用户。旧版 `ta` 简写仍保留兼容；若已被命令、alias 或函数占用则保留原定义，请使用 `sayrun`。

```zsh
sayrun shell off
sayrun shell on
sayrun shell status
# 兼容旧入口：terminal-agent-off
```

开关由父 shell wrapper 处理；未加载集成时，子进程会说明如何启用。关闭分流不删除其他 ZLE 插件仍可能引用的回调。`shell status` 展示启用状态与 accept-line 包装信息。

```zsh
sayrun shell uninstall --dry-run
sayrun shell uninstall
npm uninstall -g sayrun-shell
```

卸载集成只移除标记区块并备份 zshrc；配置与历史保留。旧版手工添加的无标记 source/eval 行需要自行删除。

## 日常任务与交互

```zsh
sayrun                        # 提示输入一次任务
sayrun ask "检查当前项目结构"
sayrun ask --new "开始一个新任务"
sayrun "帮我找最大的文件"     # 明确的自然语言快捷入口
sayrun -- "doctor"            # 强制任务文本，避免管理命令冲突
sayrun ask --profile ops "检查服务"
sayrun ask --backend dsh --model deepseek-flash "检查构建"
sayrun preview                # 无模型、无命令执行的 UI 预览
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

管理命令也使用 OpenTUI：`doctor` 显示环境检查清单，配置与后端显示分组结果，`sessions` 用 ↑/↓ 选择、Enter 查看、Esc 返回。setup 确认默认选中返回 shell，可用 ←/→ 或 Tab 切换；按 y 确认、n 取消。`--json` 与导出保留原始数据格式；非 TTY、`TERM=dumb` 和 `ui.mode=plain` 自动使用纯文本。

OpenTUI 的粘贴和换行不会触发执行。纯文本模式保留逐条审批、追问、输出和取消；输入 `e` 用 `$VISUAL` / `$EDITOR` 编辑命令，编辑器退出后重新展示并审批。方向键选择和内嵌多行编辑属于 OpenTUI 交互。

步骤保留命令、输出摘要和真实退出状态；最终结论渲染为终端 Markdown。默认摘要最多 12 行，完整有界输出仍回传模型；截断状态会标明。展示会过滤模型及命令提供的终端控制码。`NO_COLOR`、`TERM=dumb` 和 `ask --no-color` 关闭输出颜色，TUI 使用单色样式。

## 配置与 profile

```zsh
sayrun config show --effective --json
sayrun config get execution.timeout_seconds
sayrun config set agent.max_commands 20
sayrun config set ui.mode plain
sayrun config edit
sayrun config validate
sayrun profile list
sayrun config show --effective --profile ops
sayrun config set ui.output_preview_lines 8 --project
sayrun config trust .
```

配置采用 TOML schema 1，默认 `~/.config/terminal-agent/config.toml`，遵循 `XDG_CONFIG_HOME`。`config edit` 编辑临时副本，校验通过才原子替换原配置；修改前保存 `.bak`。`$EDITOR` 支持带引号的 argv，不执行 shell 替换。

生效顺序：默认 → 用户配置 → 显式 profile → 当前项目允许的字段 → 环境变量 → CLI。`show --effective` 展示每个值的来源与忽略项目字段的原因。

```toml
schema_version = 1

[agent]
backend = "dsh"
max_commands = 15
max_steps = 15
max_questions = 5
active_timeout_seconds = 600

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

配置、历史目录、`.terminal-agent.toml` 和 `TERMINAL_AGENT_*` / `TA_HOME` 环境变量沿用旧版命名，以兼容已有数据。`sayrun setup` 会自动替换旧版 zsh 标记区块。

未设置 `TA_HOME` 时，统一历史位于 `$XDG_DATA_HOME/terminal-agent`，状态与缓存分别遵循 `XDG_STATE_HOME`、`XDG_CACHE_HOME`。默认 DSH home 保留旧版 `~/.local/state/terminal-agent/dsh`；设置 `TA_HOME` 后使用其 `data/backends/dsh/default`。

## 后端、认证与诊断

```zsh
sayrun backend list --json
sayrun backend info dsh
sayrun backend check dsh
sayrun backend use dsh
sayrun auth status dsh
sayrun auth login dsh
sayrun doctor
sayrun doctor --live
sayrun version --json
sayrun update --check
```

本地 probe 检查后端可用性、报告版本和适配器声明的能力；DSH 不按版本号拦截，实际连接时仍需支持 `sdk-minimal` 和所用协议。不满足命令编辑、提问和取消能力的适配器在任务前拒绝运行，不自动换服务。只有 `--live` 才发送最小模型探测，并提示可能产生用量。

DSH 优先使用配置指定的 API key 环境变量，否则使用已有 DSH 凭证服务。`auth status` 只展示来源、环境变量是否设置、文件是否存在，不读取或显示密钥，也不将文件存在描述为认证有效。`auth login dsh` 给出 API key / 官方凭证配置说明，不读取桌面 App 内部 token。

`backend use` 只改变用户默认字段，当前项目仍有覆盖时会解释有效值与来源。内置 DSH 可通过 `config set backends.dsh.disabled true` 禁用，`backend remove dsh` 等价。重新启用设为 `false`。

`update --check` 仅查询 registry，不安装。通过 npm 全局安装的用户可运行 `npm install -g sayrun-shell@latest` 更新，其他渠道按原方式安装；不会在 shell 启动或任务中自动升级。

## 统一历史与恢复

```zsh
sayrun sessions
sayrun sessions list --all --backend dsh --status failed --json
sayrun sessions list --include-classifier
sayrun sessions show <id> --full
sayrun sessions search "NXDOMAIN" --all
sayrun sessions rename <id> "UAT 域名排查"
sayrun sessions pin <id>                  # unpin
sayrun sessions archive <id>              # restore；list --archived 查看含归档记录
sayrun sessions export <id> --format markdown --preview
sayrun sessions export <id> --format json --redact --output /tmp/task.json
sayrun sessions import /tmp/task.json
sayrun sessions delete <id>               # 交互确认；--yes 显式确认
sayrun sessions gc --dry-run --days 30 --max-total-mb 1024
sayrun sessions gc --apply
sayrun sessions reindex

sayrun resume <id>                         # 先查看，输入新请求后才调用模型
sayrun resume --last --prompt "再检查一次"
sayrun resume <id> --context-only --prompt "使用可见历史继续"
sayrun sessions fork <id> --backend dsh --context summary
```

逻辑 `sessionId`、每次请求的 `runId` 和厂商 `nativeRef` 分开记录。唯一短 ID 可用；前缀不唯一时明确列出候选。默认按本机稳定身份和项目 realpath 过滤，`--last` 不自动恢复其他项目。

`events.jsonl`、输出附件和原子 `meta.json` 是内容来源；SQLite 索引可以从文件重建，即使索引损坏也能查看、搜索和导出。搜索目前扫描统一文件，不依赖厂商格式或索引可用性。`reindex` 使用 Node 的 SQLite 支持（Node 22 会打印实验特性提示）或 Bun SQLite。

启用 zsh 集成后，同一 shell 实例、项目和后端中的提问默认延续当前会话，每次提问记录为独立 run。普通命令和重新加载集成不会切断对话；新终端或新启动的 zsh 使用独立会话。同一 Git 项目内切换子目录保留会话，切换项目会使用独立会话，切回来可继续。普通命令的输出不会自动发送给模型。使用 `sayrun ask --new "任务"` 主动开始新对话；关闭本工具历史时不自动续接。

DSH 使用 `session/resume` 恢复原生历史，保留其上下文压缩结果；每轮结束正常关闭后端并保存历史。恢复失败会明确报错，不会静默改为新会话。显式使用 `resume --context-only` 会创建基于可见历史的新分支，保留 `parentSessionId` 并展示将发送的事件范围。可见上下文包括用户请求、命令执行事实、有限输出、问题回答和结论，默认上限 32 KiB；不额外调用模型生成摘要。`fork --context summary` 同样表示这份本地可见事实摘要。恢复与分支都不会重放旧工具调用，后续命令仍需重新审批。

恢复沿用记录的后端、模型、目录和执行配置快照，当前更严格的预算、执行器、审批与保存策略优先。目录缺失时停止；更换后端要显式 fork。第三方适配器声明并实现 native resume 时可通过 `resumeRef` 复用；原生引用失效可显式使用 `resume --context-only`。

历史导入只保存为只读记录，不启动后端、不执行任何工具。恢复导入记录会创建新分支。JSON 导出包含版本、事件和受管理输出附件；Markdown 方便阅读。`--preview` 不写出文件；`--redact` 做常见凭证模式和项目路径的尽力脱敏，仍应自行检查导出内容。

删除与 GC 跳过活动会话，GC 排除固定会话；归档与固定独立。默认不自动 GC。删除只移除本工具统一历史，厂商原生会话保留并报告其位置，不遍历删除用户其他 DSH 会话。

`history.enabled=false` 关闭本工具的任务内容保存，仍保留最小运行状态；**DSH 可能继续保存原生记录**。DSH 不能验证关闭原生持久化，因此 `ask --ephemeral` 在连接前明确拒绝。

## 旧数据迁移

```zsh
sayrun migrate --from /absolute/path/.runtime/dsh --dry-run
sayrun migrate --from /absolute/path/.runtime/dsh --apply
```

只转换已验证的 DSH `session.v4.jsonl`。dry-run 不创建统一存储；apply 先备份源记录，再转换用户请求、工具结果与结论。按源文件 realpath 和内容摘要去重，重复导入同一内容不会重复创建会话。无法识别的记录列入 skipped，旧目录始终保留。迁移不意味着验证了原生恢复。

## 执行与异常

同一会话只允许一个写入进程。命令开始前追加并刷盘 `execution.started`，结果保存完成后才回传模型。写入失败会阻止执行；执行后保存失败会说明命令已执行、停止后续动作。崩溃只有开始而没有结果的执行标为 `interrupted / unknown`，不自动重试。

重复 `requestId` 复用已记录结果，内容不同的重复 ID、过期请求、切换目标请求会被拒绝；多个请求按队列逐条审批。后端断线会撤回等待中的交互并停止任务。后端完成不能跳过尚未结束的 host 执行。

默认每次任务最多 15 条命令、15 个模型步骤、5 次问题、600 秒活动时间，等待审批、编辑或回答时暂停活动时间。预算按单次请求（run）计算，同一会话的后续提问重新计数，不限制会话累计提问次数。命令、模型步骤或追问预算用完后，进入收尾阶段：不再执行命令或追问，要求模型总结已做的事、哪些结果得到验证、具体卡点及证据、下一步或缺少的信息。额外收尾最多两个模型步骤、15 秒；后端断开、不遵守收尾要求或超时时，根据已记录的执行事实生成汇总，不把退出码为 0 当作任务完成证明。活动时间用完时先中断正在运行的命令、保存可获得的实际结果，再由本地汇总；这些情况保留 limited 状态和退出码 4，不只显示轮次上限。

需要较长任务时，可在终端调整用户配置后再次提问；以下示例会写入配置，不调用模型：

```zsh
sayrun config set agent.max_commands 20
sayrun config set agent.max_steps 40
sayrun config set agent.active_timeout_seconds 600
sayrun config show --effective
```

已有用户配置中的显式旧值保持有效，不会自动改写；项目配置或 profile 也可能覆盖用户值，以 `show --effective` 为准。`resume` 还会保留历史配置快照中更严格的限制；要使用调高后的预算，可在已启用集成的同一 shell 中直接再次提问。模型输出上限是后端限制，与宿主命令次数、步骤预算分开。

每条命令独立限时 30 秒、输出最多 64 KiB。取消、超时和命令结束会清理普通进程组；自行脱离进程组的进程不在该保证内。命令环境过滤常见凭证变量；这是审批执行器，没有实现 OS 沙箱。DSH 消息处理或命令输出展示失败时会停止任务并关闭界面；展示失败会取消正在运行的命令，先保存可获得的实际结果，不自动重试命令。

退出码：`0` 完成，`1` 运行失败，`2` 参数/配置错误，`3` 拒绝，`4` 预算/模型输出上限，`5` 后端能力/认证不可用，`130` 取消。命令自己的失败状态独立记录，后续修复成功不一定意味着整个任务失败。

## 外部后端

外部插件需要显式注册；不提供插件市场或自动安装任意包。适配器作者请阅读[后端协议参考](../reference/backend-protocol.md)。

```zsh
sayrun backend add custom --manifest /absolute/path/adapter.json
sayrun backend check custom
sayrun ask --backend custom "任务"
sayrun backend remove custom
```

开发 Sayrun 本身请从[贡献指南](../../CONTRIBUTING.md)开始；构建与测试见[开发文档](../development/testing.md)。
