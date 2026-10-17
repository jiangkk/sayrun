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

export async function manage(mode: string, argv: string[]) {
  if (mode === 'setup') {
    const { opts, args } = options(argv, { values: ['zshrc', 'backend'], flags: ['yes', 'dry-run', 'temporary'] }); arity(args, 0);
    const result = await setup({ yes: opts.yes, dryRun: opts['dry-run'], zshrc: opts.zshrc, backend: opts.backend, temporary: opts.temporary });
    if (result.applied) return doctor(); return 0;
  }
  if (mode === 'doctor') { const { opts, args } = options(argv, { flags: ['live', 'json'] }); arity(args, 0); return doctor({ live: opts.live, json: opts.json }); }
  if (mode === 'shell') {
    const [action, ...tail] = argv;
    if (['on', 'off', 'status'].includes(action)) { arity(tail, 0); throw invalid('此操作需要已加载的父 shell wrapper：先 eval "$(sayrun shell init zsh)"；然后运行 sayrun shell ' + action); }
    if (action !== 'uninstall') throw invalid('用法：shell init zsh | on | off | status | uninstall');
    const { opts, args } = options(tail, { values: ['zshrc'], flags: ['yes', 'dry-run'] }); arity(args, 0);
    const plan = await shellPlan({ install: false, path: opts.zshrc });
    print({ path: plan.path, change: plan.before !== plan.after ? '仅移除 sayrun 标记区块；保留配置与历史' : '无需更改' });
    if (!opts['dry-run'] && (opts.yes || await confirm('应用以上更改？'))) print(await applyShellPlan(plan)); return 0;
  }
  if (mode === 'route-mode') { arity(argv, 0); write((await loadConfig()).config.routing.mode + '\n'); return 0; }
  if (mode === 'version') {
    const { opts, args } = options(argv, { flags: ['json'] }); arity(args, 0);
    const loaded = await loadConfig(); let backend; try { backend = await createBackend(loaded.config).probe(); } catch (e) { backend = { available: false, diagnostics: [e.message] }; }
    print({ version, node: process.version, bun: JSON.parse(readFileSync(createRequire(import.meta.url).resolve('bun/package.json'), 'utf8')).version, opentui: '0.6.6', protocol: backendApiVersion, adapter: loaded.config.agent.backend, backend }, opts.json); return 0;
  }
  if (mode === 'update') {
    const { opts, args } = options(argv, { flags: ['check', 'json'] }); arity(args, 0);
    if (!opts.check) { write('更新：npm install -g sayrun-shell@latest\n配置 schema=1；修改配置前会创建 .bak。不会自动更新或发布。\n'); return 0; }
    const result = spawnSync('npm', ['view', 'sayrun-shell', 'version', '--registry=https://registry.npmjs.org/', '--json', '--fetch-retries=0', '--fetch-timeout=10000'], { encoding: 'utf8', timeout: 12000 });
    print({ current: version, latest: result.status === 0 ? JSON.parse(result.stdout) : null, status: result.status === 0 ? 'checked' : 'unavailable', note: result.status === 0 ? '使用 npm install -g sayrun-shell@latest 更新' : 'registry 未发布或无法访问，未修改安装' }, opts.json); return 0;
  }
  if (mode === 'config') return configCommand(argv);
  if (mode === 'profile') { const { opts, args } = options(argv, { flags: ['json'] }); if (args.join(' ') !== 'list') throw invalid('用法：profile list'); const { config } = await loadConfig(); print(config.profiles, opts.json); return 0; }
  if (mode === 'backend') return backendCommand(argv);
  if (mode === 'auth') {
    const { opts, args } = options(argv, { flags: ['json'] }); const [action, id] = args; arity(args, 1, 2);
    const { config } = await loadConfig();
    if (action === 'status') print(await authStatus(config, id), opts.json);
    else if (action === 'login') { if (!id || !config.backends[id]) throw invalid('用法：auth login <已注册后端>'); print(id === 'dsh' ? `DSH 适配器使用 API key：请在 shell 中设置 ${config.backends.dsh.api_key_env}，或通过 DSH 官方流程配置 ${config.backends.dsh.credentials ?? credentialsPath()}。本工具不接收或打印密钥。` : '此插件未声明官方交互登录入口；请按适配器文档配置环境变量。'); }
    else throw invalid('用法：auth status [backend] | auth login <backend>'); return 0;
  }
  if (mode === 'sessions') return sessionsCommand(argv);
  if (mode === 'migrate') { const { migrate } = await import('../history/migrate-dsh.ts'); const { opts, args } = options(argv, { values: ['from'], flags: ['dry-run', 'apply', 'json'] }); arity(args, 0); if (!opts.from || opts.apply && opts['dry-run']) throw invalid('用法：migrate --from /absolute/path/.runtime/dsh --dry-run | --apply'); print(await migrate(opts.from, { apply: !!opts.apply }), opts.json); return 0; }
  throw invalid(`未知管理命令：${mode}`);
}
