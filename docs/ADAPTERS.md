# AgentBackend v1

Coordinator、执行器、历史和 UI 不读取 DSH 原始事件；新后端实现 `src/contracts/backend.ts` 即可复用相同流程。目前内置 DSH，没有内置模型循环。

适配器必须运行在 host-tools 模式：工具请求只提出命令，host 审批、编辑、执行并返回真实结果。不能限制原生执行、文件写入、其他 MCP 或委派工具的后端必须将 `hostTools` 报为 false。仅提示词约束不构成能力证明。此契约不是 OS 沙箱。

## 进程插件

仅显式 `backend add <name> --manifest /absolute/path/adapter.json` 注册用户信任的本机代码：

```json
{
  "apiVersion": 1,
  "executable": "/absolute/path/adapter",
  "args": ["--stdio"],
  "env": ["CUSTOM_API_KEY"]
}
```

可执行文件必须为绝对路径；argv 不经过 shell。只继承 PATH、HOME、LANG、TMPDIR 和显式环境变量白名单。stdout 只传 JSONL，诊断写 stderr。不要在 stdout 打印欢迎语或模型日志。静态 manifest 中的能力声明不作为准入依据。

host 请求格式：`{"id":1,"method":"hello","params":{"apiVersion":1}}`。
响应格式：`{"id":1,"result":{...}}` 或 `{"id":1,"error":{"message":"原因"}}`。所有请求需要在 10 秒内确认；长时间模型工作通过事件流返回。

| 方法 | params / result |
| --- | --- |
| `hello` | 返回 `apiVersion:1`、`version`、`capabilities`、可选 `diagnostics` |
| `connect` | 接收 cwd、targetId、model、initialContext、resumeRef、ephemeral；返回可选 nativeRef |
| `run` | 接收 runId、prompt；立即确认，随后发事件 |
| `reply` | 接收 HostReply；确认后继续模型循环 |
| `classify` | 仅声明 classify 时；接收 input、cwd、tools:[]，返回 route、confidence |

能力字段：hostTools、commandEditing、userQuestions、cancellation (`native` / `process`)、resume (`native` / `context-only` / `none`)、ephemeral、classify、modelDiscovery、usage。缺少必需 host-tools 能力时，任务不会开始。

本地管理的 `probe` 只启动进程并 hello，不能调用模型或执行工具。插件自己必须保证 hello / connect 不发模型请求；用户开始 run 后才执行推理。`--ephemeral` 需要后端确实关闭原生持久化。

事件通知：

```json
{"method":"event","params":{"id":"unique-event-id","runId":"host-run-id","timestamp":"2026-10-17T00:00:00.000Z","type":"command.requested","requestId":"stable-tool-call-id","command":"pwd","description":"检查目录","cwd":"/absolute/project","targetId":"local-zsh"}}
```

`id` 每个事件唯一。`requestId` 在一次 run 内稳定：重发必须完全相同，不能把另一条命令复用同一 ID。host 顺序处理多个请求并缓存结果。重复事件不会重复执行；后端断线也不意味着命令可以重试。

问题使用 `question.requested` + requestId / question，答案返回 `kind:answer` / text / `commandApproval:false`。问题答案永远不能作为命令批准。

命令响应 `kind:command`：拒绝时 approved:false / reason；批准时返回 approved:true、executionId、实际 command、cwd、targetId、output、exitCode、signal、timedOut、cancelled、truncated。后端必须使用编辑后的实际执行值，不能继续声称原提案已执行。

其他事件为 status (`thinking` / `checking`)、message (text / final)、usage（未知字段省略）、run.ended (`completed` / `cancelled` / `limit` / `failed`)。message 只包含可见说明和结论，不包含隐藏推理。发生每个模型步骤时发送一次 status，以参与预算。

执行目标由 host 固定，当前仅 local-zsh。不得自行改换目标。完成事件必须在工具得到回复后发送；host 也会保证先记录正在执行工具的实际结果再结束。

中断时 host 终止插件进程组并清理待处理请求；插件应捕获 SIGTERM 中断原生 harness，并让子进程留在同一进程组。每个任务连接独立插件进程。原生恢复失败应明确报错；用户可显式选择 `resume --context-only` 创建可见上下文分支，禁止重放旧命令。

可参考 `test/fixture-backend.mjs` 的确定性协议替身，以及 `test/product.test.mjs` 中同一 Coordinator 的准入、编辑、持久化和执行用例。
