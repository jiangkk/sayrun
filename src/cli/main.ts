import { readAnswer, readTask } from './input.ts';
import type { ConfigPatch } from '../contracts/config.ts';
import type { CliOptions } from './args.ts';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { runAgent } from '../application/run-task.ts';
import { write } from '../terminal/display.ts';
import { cliEntrypoint, shellIntegration } from '../platform/paths.ts';
import { bunExecutable } from '../platform/bun-runtime.ts';
import { options } from './args.ts';
import { manage } from './manage.ts';
import { version } from './version.ts';
import { loadConfig } from '../config/load.ts';
import { validateConfig } from '../config/schema.ts';
import { SessionStore } from '../history/store.ts';
import { exportMarkdown } from '../history/export.ts';
import { visibleContext } from '../history/context.ts';
import { createBackend } from '../backends/registry.ts';
import { admitBackend } from '../backends/protocol.ts';
import { AgentError, invalid } from '../errors.ts';

const management = ['setup', 'doctor', 'backend', 'auth', 'config', 'profile', 'sessions', 'resume', 'migrate', 'update', 'route-mode'];
const help = `Sayrun ${version}
用法：sayrun                         输入一次任务，完成即退出
      sayrun ask [--backend dsh] [--profile ops] "任务"
      sayrun -- "history"                       强制任务文本
      sayrun resume <id> | --last [--prompt "继续请求"]
      sayrun sessions                            当前项目历史选择器
      sayrun sessions list/search/show/export/rename/pin/unpin/archive/restore/delete/gc/reindex/import/fork
      sayrun backend list/info/check/use/add/remove
      sayrun auth status [backend] | auth login <backend>
      sayrun config show --effective [--profile ops] | get/set <key> [value] [--project]
      sayrun config edit/validate | trust .
      sayrun profile list
      sayrun setup [--dry-run | --yes] [--temporary] [--zshrc /path/.zshrc]
      sayrun shell init zsh | on | off | status | uninstall
      sayrun doctor [--live] [--json]             --live 才发送模型探测
      sayrun preview                              离线审批预览
      sayrun migrate --from /path/.runtime/dsh --dry-run | --apply
      sayrun version [--json] | --version | update --check

历史选项：list/search --all --backend dsh --status failed --include-classifier --json
          show <id> --full | --json
          export <id> --format markdown|json [--output /path] [--redact] [--preview]
          delete <id> --yes；gc --dry-run | --apply [--days 30] [--max-total-mb 1024]

在当前 zsh 启用：eval "$(sayrun shell init zsh)"
每条命令均需审批。非 TTY 只读管理可用，ask 不执行。\n`;
export function parseArguments(argv: string[]) {
  const [mode, ...args] = argv;
  if (!mode) return { mode: 'interactive', args: [] };
  if (['--help', '-h', 'help'].includes(mode)) { if (args.length) throw invalid('help 不接受额外参数'); return { mode: 'help', args: [] }; }
  if (['--version', '-v', 'version'].includes(mode)) { if (mode !== 'version' && args.length) throw invalid('version 不接受额外参数'); return { mode: 'version', args }; }
  if (mode === 'shell') {
    if (args[0] === 'init') { if (args.join(' ') !== 'init zsh') throw invalid('用法：sayrun shell init zsh'); return { mode: 'shell', args: [] }; }
    if (!['on', 'off', 'status', 'uninstall'].includes(args[0])) throw invalid('用法：shell init zsh | on | off | status | uninstall');
    return { mode, args };
  }
  if (management.includes(mode)) return { mode, args };
  if (mode === 'preview') { if (args.length) throw invalid('preview 不接受额外参数'); return { mode, args }; }
  if (['ask', 'classify', '--'].includes(mode)) {
    const task = args[0] === '--' ? args.slice(1) : args;
    if (!task.join(' ').trim()) throw invalid('请输入任务');
    return { mode: mode === 'classify' ? mode : 'ask', args: task };
  }
  if (mode.startsWith('-') || !/[一-龥]|\s/.test(mode) && !/^(please|help|show|check|list|explain|create|remove|delete|move|rename|why|how|what|can|could|fix)$/i.test(mode)) throw invalid(`未知命令或选项：${mode}。查看 sayrun --help；使用 ask 或 -- 显式指定任务。`);
  return { mode: 'ask', args: argv };
}
async function launchUi(argv: string[]): Promise<number> {
  const child = spawn(bunExecutable(), [cliEntrypoint, ...argv], { stdio: 'inherit' });
  const ignore = () => {}, terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', ignore); process.on('SIGTERM', terminate);
  try { return await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1))); }); }
  finally { process.removeListener('SIGINT', ignore); process.removeListener('SIGTERM', terminate); }
}
function taskOptions(args: string[], force = false) {
  const parsed = force ? { opts: {}, args } : options(args, { values: ['backend', 'profile', 'model'], flags: ['no-color', 'ephemeral'] });
  if (!parsed.args.join(' ').trim()) throw invalid('请输入任务'); return parsed;
}
async function effectiveTask(opts: CliOptions) {
  const cli: ConfigPatch = {};
  if (opts.backend) cli.agent = { backend: opts.backend };
  if (opts['no-color']) cli.ui = { color: 'never' };
  let loaded = await loadConfig({ profile: opts.profile, cli });
  if (opts.model) { const backend = loaded.config.agent.backend; cli.backends = { [backend]: { model: opts.model } }; loaded = await loadConfig({ profile: opts.profile, cli }); }
  return loaded;
}
async function resume(args: string[], originalArgv: string[]) {
  const { opts, args: ids } = options(args, { values: ['prompt', 'profile', 'backend', 'model'], flags: ['last', 'context-only', 'no-color'] });
  if (ids.length > 1 || opts.last && ids.length || !opts.last && ids.length !== 1) throw invalid('用法：resume <id> | --last [--prompt "继续请求"]');
  const loaded = await effectiveTask(opts);
  if (loaded.config.ui.mode !== 'plain' && !process.versions.bun && process.stdin.isTTY && process.stdout.isTTY) return launchUi(originalArgv);
  const store = new SessionStore();
  const rows = opts.last ? await store.list({ cwd: process.cwd() }) : null;
  const meta = opts.last ? [...rows!].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] : await store.resolve(ids[0]);
  if (!meta) { write('当前机器和项目没有可恢复任务。\n'); return manage('sessions', []); }
  if (await store.active(meta.sessionId)) throw new AgentError('session_locked', '会话正在运行，请结束后再恢复');
  if (meta.machineId !== store.machineId) throw invalid('此会话来自另一台机器；请先显式 fork 到本机');
  const data = await store.read(meta.sessionId);
  if (opts.backend && opts.backend !== meta.backend) throw invalid('更换后端请使用 sessions fork，不会静默发送到其他服务');
  const config = structuredClone(meta.config ?? loaded.config);
  config.agent.backend = meta.backend; config.backends ??= {}; config.backends[meta.backend] ??= {};
  // Executables and credential references always come from current user config.
  const model = opts.model ?? meta.model ?? config.backends[meta.backend]?.model;
  config.backends[meta.backend] = { ...loaded.config.backends[meta.backend], ...(model ? { model } : {}) };
  for (const key of ['max_commands', 'max_steps', 'max_questions', 'active_timeout_seconds'] as const) config.agent[key] = Math.min(config.agent[key], loaded.config.agent[key]);
  for (const key of ['timeout_seconds', 'max_output_bytes'] as const) config.execution[key] = Math.min(config.execution[key], loaded.config.execution[key]);
  config.execution.shell = loaded.config.execution.shell; config.execution.executor = loaded.config.execution.executor;
  config.history = loaded.config.history; config.ui = loaded.config.ui; config.approval = loaded.config.approval;
  validateConfig(config);
  const cwd = await realpath(meta.cwd).catch(() => { throw invalid(`旧任务目录不存在：${meta.cwd}。请先恢复该目录或显式创建新任务`); });
  if (!(await stat(cwd)).isDirectory()) throw invalid('旧任务目录不可用');
  const backend = createBackend(config), probe = await backend.probe(); admitBackend(probe);
  if (probe.capabilities.resume === 'none') throw new AgentError('capability_missing', '此后端不支持恢复或可见上下文继续', 5);
  const context = visibleContext(data);
  const native = !opts['context-only'] && !meta.readOnly && probe.capabilities.resume === 'native' && meta.nativeRef;
  write(exportMarkdown(data, { full: false }));
  if (!native) write(`原生恢复未验证或不可用；将新建可见上下文分支，来源 ${meta.sessionId}。\n上下文：${context.included}/${context.total} 条可见事件，${context.bytes} 字节；不会执行旧命令。\n`);
  let prompt: string | null | undefined = opts.prompt;
  if (prompt === undefined) { if (!process.stdin.isTTY) return 0; prompt = await readAnswer('继续请求（Enter 返回 shell）：'); }
  if (!prompt?.trim()) return 0;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AgentError('tty_required', '审批需要交互式终端');
  const target = native ? meta : await store.create({ prompt, cwd, backend: meta.backend, model, config, parentSessionId: meta.sessionId });
  const result = await runAgent(prompt, { cwd, config, backend, resumeMeta: target, initialContext: native ? '' : context.text, resumeRef: native ? meta.nativeRef : undefined, store });
  return result.exitCode;
}
export async function main(argv = process.argv.slice(2)) {
  try {
    let { mode, args } = parseArguments(argv);
    if (mode === 'help') { write(help); return 0; }
    if (mode === 'version') { if (argv[0] !== 'version') write(version + '\n'); else return await manage(mode, args); return 0; }
    if (mode === 'shell' && !args.length) { const path = shellIntegration; process.stdout.write(`source '${path.replaceAll("'", "'\\''")}'\n`); return 0; }
    if (mode === 'resume') return await resume(args, argv);
    if (management.includes(mode) || mode === 'shell') return await manage(mode, args);
    if (mode === 'classify') {
      const { classifyInput } = await import('../application/classify-input.ts'), controller = new AbortController(), cancel = () => controller.abort();
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      try { const route = await classifyInput(args.join(' '), { signal: controller.signal }); if (controller.signal.aborted) return 130; write(route + '\n'); }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); } return 0;
    }
    if (mode === 'interactive') { const task = await readTask(); if (task === null) return 0; mode = 'ask'; args = [task]; argv = ['ask', '--', task]; }
    if (mode === 'preview') {
      const { config } = await loadConfig();
      if (config.ui.mode !== 'plain' && !process.versions.bun) return await launchUi(['preview']);
      const { preview } = await import('../terminal/preview.ts'); await preview(); return 0;
    }
    const parsed = taskOptions(args, argv[0] === '--' || argv[1] === '--'), loaded = await effectiveTask(parsed.opts);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AgentError('tty_required', '审批需要交互式终端，请直接在终端运行');
    if (loaded.config.ui.mode !== 'plain' && !process.versions.bun) return await launchUi(argv);
    for (const warning of loaded.warnings) process.stderr.write(warning + '\n');
    if (!loaded.config.history.enabled && !parsed.opts.ephemeral) write('本工具历史已关闭；DSH 仍可能保存原生会话。\n');
    return (await runAgent(parsed.args.join(' '), { config: loaded.config, ephemeral: parsed.opts.ephemeral })).exitCode;
  } catch (error) { write(`\n[agent] ${error.code ? `${error.code}：` : ''}${error.message}\n`); return error.exitCode ?? 1; }
}
