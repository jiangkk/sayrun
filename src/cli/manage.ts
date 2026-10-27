import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.ts';
import { createBackend } from '../backends/registry.ts';
import { backendApiVersion } from '../backends/protocol.ts';
import { credentialsPath } from '../platform/paths.ts';
import { confirm, setup, shellPlan, applyShellPlan } from '../platform/shell-setup.ts';
import { write } from '../terminal/display.ts';
import { invalid } from '../errors.ts';
import { options, arity } from './args.ts';
import { print } from './output.ts';
import { version } from './version.ts';
import { configCommand } from './commands/config.ts';
import { backendCommand } from './commands/backend.ts';
import { sessionsCommand } from './commands/sessions.ts';
import { authStatus } from './commands/auth.ts';
import { doctor } from './commands/doctor.ts';
import { closePresentation, notice, report, status } from './presentation.ts';

export async function manage(mode: string, argv: string[]) {
  if (mode === 'setup') {
    const { opts, args } = options(argv, { values: ['zshrc', 'backend', 'approval-mode'], flags: ['yes', 'dry-run', 'temporary', 'no-shell'] }); arity(args, 0);
    const result = await setup({ yes: opts.yes, dryRun: opts['dry-run'], zshrc: opts.zshrc, backend: opts.backend, temporary: opts.temporary, mode: opts['approval-mode'] });
    if (!result.applied) return opts['dry-run'] ? 0 : 130;
    status('正在检查本地运行环境');
    const doctorStatus = await doctor();
    report(doctorStatus === 0 ? 'Sayrun 已就绪' : '配置已保存 · 还有项目需要处理', [
      { text: doctorStatus === 0 ? '现在就可以在终端输入自然语言任务。' : '安装已完成，请根据上方检查结果补全环境。', tone: doctorStatus === 0 ? 'green' : 'amber' },
      { text: '试试看：sayrun ask "帮我检查当前目录"', tone: 'accent' },
    ], { tone: doctorStatus === 0 ? 'green' : 'amber' });
    if (process.env.TERMINAL_AGENT_SETUP_WRAPPER === '1' && !opts['no-shell']) return doctorStatus;
    if (process.stdin.isTTY && process.stdout.isTTY && !opts['no-shell'] && !opts.temporary && !opts.zshrc) {
      notice('配置完成，正在进入已启用 Sayrun 的新 zsh；可直接输入自然语言。exit 返回原终端。', 'green');
      await closePresentation();
      const shell = spawnSync('zsh', ['-i'], { stdio: 'inherit' });
      if (shell.error) throw invalid(`无法启动 zsh：${shell.error.message}。请执行 eval "$(sayrun shell init zsh)"`);
      return shell.status ?? 1;
    }
    report('下一步', [{ text: opts.temporary ? '临时配置完成，未写入 zsh 启动文件。' : opts.zshrc ? '配置已写入指定的 zshrc。' : '配置完成，新开的 zsh 会自动加载集成。' }, { text: '当前终端立即启用：eval "$(sayrun shell init zsh)"', tone: 'accent' }]);
    return doctorStatus;
  }
  if (mode === 'doctor') { const { opts, args } = options(argv, { flags: ['live', 'json'] }); arity(args, 0); return doctor({ live: opts.live, json: opts.json }); }
  if (mode === 'shell') {
    const [action, ...tail] = argv;
    if (['on', 'off', 'status'].includes(action)) { arity(tail, 0); throw invalid('此操作需要已加载的父 shell wrapper：先 eval "$(sayrun shell init zsh)"；然后运行 sayrun shell ' + action); }
    if (action !== 'uninstall') throw invalid('用法：shell init zsh | on | off | status | uninstall');
    const { opts, args } = options(tail, { values: ['zshrc'], flags: ['yes', 'dry-run'] }); arity(args, 0);
    const plan = await shellPlan({ install: false, path: opts.zshrc });
    print({ path: plan.path, change: plan.before !== plan.after ? '仅移除 sayrun 标记区块；保留配置与历史' : '无需更改' }, false, '卸载 Shell 集成');
    if (!opts['dry-run'] && (opts.yes || await confirm('应用以上更改？'))) print(await applyShellPlan(plan), false, '卸载结果'); return 0;
  }
  if (mode === 'route-mode') { arity(argv, 0); write((await loadConfig()).config.routing.mode + '\n'); return 0; }
  if (mode === 'version') {
    const { opts, args } = options(argv, { flags: ['json'] }); arity(args, 0);
    const loaded = await loadConfig(); let backend; try { backend = await createBackend(loaded.config).probe(); } catch (e) { backend = { available: false, diagnostics: [e.message] }; }
    print({ version, node: process.version, bun: JSON.parse(readFileSync(createRequire(import.meta.url).resolve('bun/package.json'), 'utf8')).version, opentui: '0.6.6', protocol: backendApiVersion, adapter: loaded.config.agent.backend, backend }, opts.json, '版本信息'); return 0;
  }
  if (mode === 'update') {
    const { opts, args } = options(argv, { flags: ['check', 'json'] }); arity(args, 0);
    if (!opts.check) { report('更新 Sayrun', [{ text: 'npm install -g sayrun-shell@latest', tone: 'accent' }, { text: '配置 schema=1；修改配置前会创建 .bak。', tone: 'muted' }]); return 0; }
    status('正在查询最新版本');
    const result = spawnSync('npm', ['view', 'sayrun-shell', 'version', '--registry=https://registry.npmjs.org/', '--json', '--fetch-retries=0', '--fetch-timeout=10000'], { encoding: 'utf8', timeout: 12000 });
    print({ current: version, latest: result.status === 0 ? JSON.parse(result.stdout) : null, status: result.status === 0 ? 'checked' : 'unavailable', note: result.status === 0 ? '使用 npm install -g sayrun-shell@latest 更新' : 'registry 未发布或无法访问，未修改安装' }, opts.json, '版本更新检查'); return 0;
  }
  if (mode === 'config') return configCommand(argv);
  if (mode === 'profile') { const { opts, args } = options(argv, { flags: ['json'] }); if (args.join(' ') !== 'list') throw invalid('用法：profile list'); const { config } = await loadConfig(); print(config.profiles, opts.json, '配置预设'); return 0; }
  if (mode === 'backend') return backendCommand(argv);
  if (mode === 'auth') {
    const { opts, args } = options(argv, { flags: ['json'] }); const [action, id] = args; arity(args, 1, 2);
    const { config } = await loadConfig();
    if (action === 'status') print(await authStatus(config, id), opts.json, '认证状态');
    else if (action === 'login') { if (!id || !config.backends[id]) throw invalid('用法：auth login <已注册后端>'); print(id === 'dsh' ? `DSH 适配器使用 API key：请在 shell 中设置 ${config.backends.dsh.api_key_env}，或通过 DSH 官方流程配置 ${config.backends.dsh.credentials ?? credentialsPath()}。本工具不接收或打印密钥。` : '此插件未声明官方交互登录入口；请按适配器文档配置环境变量。', false, '连接模型后端'); }
    else throw invalid('用法：auth status [backend] | auth login <backend>'); return 0;
  }
  if (mode === 'sessions') return sessionsCommand(argv);
  if (mode === 'migrate') { const { migrate } = await import('../history/migrate-dsh.ts'); const { opts, args } = options(argv, { values: ['from'], flags: ['dry-run', 'apply', 'json'] }); arity(args, 0); if (!opts.from || opts.apply && opts['dry-run']) throw invalid('用法：migrate --from /absolute/path/.runtime/dsh --dry-run | --apply'); print(await migrate(opts.from, { apply: !!opts.apply }), opts.json, opts.apply ? '迁移结果' : '迁移预览'); return 0; }
  throw invalid(`未知管理命令：${mode}`);
}
