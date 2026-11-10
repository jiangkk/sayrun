import { stringify } from 'smol-toml';
import type { ConfigPatch } from '../contracts/config.ts';
import { defaults } from './defaults.ts';
import { flatten, setKey, validateConfig } from './schema.ts';

const descriptions: Record<string, string> = {
  schema_version: '配置格式版本，当前仅支持 1。',
  'agent.engine': '默认 Agent 工具，可选 dsh、codex 或已配置的外部适配器。',
  'agent.max_commands': '每次任务最多执行的命令数（正整数）。',
  'agent.max_steps': '每次任务最多使用的模型步骤数（正整数）。',
  'agent.max_questions': '每次任务最多向用户追问的次数（正整数）。',
  'agent.active_timeout_seconds': '任务活动时间上限（秒）；等待用户输入时暂停计时。',
  'routing.mode': 'auto：后端分类；local：歧义人工选择；explicit：仅通过 ask 发起任务。',
  'routing.classifier': 'backend：使用当前任务后端分类；也可填写已注册的后端名称。',
  'routing.confidence_threshold': '自动分类置信度阈值，大于 0 且不超过 1。',
  'routing.timeout_seconds': '后端分类超时（秒，正整数）。',
  'routing.on_ambiguous': '歧义处理方式，当前仅支持 ask（询问用户）。',
  'ui.mode': 'opentui：终端界面；plain：纯文本。',
  'ui.language': '传给模型的回答语言；当前管理界面为中文。',
  'ui.color': 'auto：自动判断；always：启用颜色；never：禁用颜色。',
  'ui.output_preview_lines': '命令输出预览行数（正整数）。',
  'approval.mode': 'ask：一律询问（默认）；normal：非 sudo 命令自动执行；full：验证并维持 sudo 后自动执行。命令保留原有身份。',
  'approval.default_selection': '审批默认选项：approve（批准）| reject（拒绝）| edit（编辑）。',
  'approval.editor_enter': '命令编辑器回车行为：execute（执行）| save（保存后返回审批）。',
  'execution.executor': '执行器，当前仅支持 local-zsh（本机执行）。',
  'execution.shell': '执行命令的 shell 绝对路径；每条命令使用独立的 zsh -f -c。',
  'execution.timeout_seconds': '单条命令超时（秒，正整数）。',
  'execution.max_output_bytes': '单条命令输出上限（字节，正整数）。',
  'history.enabled': '是否保存 Sayrun 历史；不控制后端自身的历史。',
  'history.default_scope': '历史默认查询范围：project（当前项目）| all（全部项目）。',
  'history.auto_gc': '是否在任务结束后自动清理历史。',
  'history.retention_days': '历史保留天数（正整数）；用于自动清理或 sessions gc。',
  'history.max_total_mb': '历史总大小上限（MB，正整数）；用于自动清理或 sessions gc。',
  'history.store_command_output': '是否在 Sayrun 历史中保存命令输出。',
  'history.include_classifier': '历史列表默认是否包含分类记录。',
  'backends.dsh.binary': 'DSH 可执行文件名或路径。',
  'backends.dsh.model': 'DSH 模型名称。',
  'backends.dsh.api_key_env': '存放 API key 的环境变量名称；不要填写密钥本身。',
  'backends.dsh.disabled': '是否禁用该后端。',
  'backends.dsh.credentials': '可选凭证文件路径；未设置时复用 DSH_HOME/.credentials.yaml，DSH_HOME 默认 ~/.dsh。',
  'backends.codex.binary': 'Codex CLI 可执行文件名或路径。',
  'backends.codex.disabled': '是否禁用 Codex 后端。',
  'backends.codex.model': '可选 Codex 模型；未设置时沿用 Codex 默认模型。',
  'context.text': '附加任务上下文，默认空字符串；不构成命令执行授权。',
};

// Never persist effective project, profile or environment overrides as user defaults.
export function userConfigTemplate(value: ConfigPatch = {}) {
  validateConfig(value);
  const config = structuredClone(defaults);
  for (const [key, child] of Object.entries(flatten(value))) setKey(config, key, child);
  config.profiles = value.profiles ?? {};
  const lines = [
    '# Sayrun 用户配置：列出当前支持的配置及默认值；已有设置会保留。',
    '# 修改：sayrun config edit 或 sayrun config set <key> <value>。',
    '# 生效值与来源：sayrun config show --effective；检查：sayrun config validate。',
    '# 环境变量和项目配置可能覆盖此文件；不要在此填写明文 API key。',
    '',
  ];
  function section(data: object, path: string[] = []) {
    if (path.length) lines.push(`[${path.join('.')}]`);
    const entries = Object.entries(data);
    for (const [key, child] of entries) {
      if (child && typeof child === 'object') continue;
      const description = descriptions[[...path, key].join('.')];
      if (description) lines.push(`# ${description}`);
      lines.push(stringify({ [key]: child }).trimEnd());
    }
    if (path.join('.') === 'backends.dsh' && !('credentials' in data)) lines.push(
      `# ${descriptions['backends.dsh.credentials']}`,
      '# credentials = "/absolute/path/.credentials.yaml"',
    );
    if (path.join('.') === 'backends.codex' && !('model' in data)) lines.push(
      `# ${descriptions['backends.codex.model']}`,
      '# model = "your-model"',
    );
    lines.push('');
    for (const [key, child] of entries) if (child && typeof child === 'object') section(child, [...path, key]);
  }
  section(config);
  lines.push(
    '# 外部适配器：sayrun config set backends.example.manifest /absolute/path/adapter.json。',
    '# 以下均为注释示例，没有通用默认值；不要直接取消整段注释。',
    '# [backends.example]',
    '# manifest = "/absolute/path/adapter.json" # 外部适配器 manifest；内置后端不需要。',
    '# disabled = false                       # 是否禁用后端。',
    '# model = "your-model"                   # 可选模型，由适配器解释。',
    '# binary = "/absolute/path/backend"      # DSH 使用；当前外部进程入口由 manifest 定义，此字段不生效。',
    '# api_key_env = "EXAMPLE_API_KEY"         # DSH 使用；外部进程的环境变量白名单由 manifest 定义。',
    '# credentials = "/absolute/path/credentials" # DSH 使用；当前不传给外部进程。',
    '# version = "your-version"               # 保留的版本元数据，当前不参与版本校验。',
    '',
    '# profile 默认没有条目；可覆盖上述字段（不能嵌套 profiles 或设置 schema_version）。',
    '# 启用：sayrun ask --profile ops "任务"。',
    '# [profiles.ops.agent]',
    '# max_commands = 20',
    '# [profiles.ops.execution]',
    '# timeout_seconds = 60',
    '',
  );
  return lines.join('\n');
}
