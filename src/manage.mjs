import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { loadConfig, readConfig, saveConfig, getKey, setKey, trustProject, projectRoot } from './config.mjs';
import { SessionStore, exportMarkdown, redactExport, visibleContext } from './sessions.mjs';
import { createBackend } from './backends/index.mjs';
import { readManifest } from './backends/process.mjs';
import { admitBackend, backendApiVersion } from './backend.mjs';
import { credentialsPath, runtimeHome, productPaths } from './paths.mjs';
import { bunExecutable } from './runtime.mjs';
import { confirm, setup, shellPlan, applyShellPlan, runEditor } from './setup.mjs';
import { write, safeText } from './display.mjs';
import { atomicWrite } from './storage.mjs';
import { invalid, AgentError } from './errors.mjs';

export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export function options(argv, { values = [], flags = [] } = {}) {
  const opts = {}, args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { args.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { args.push(arg); continue; }
    const key = arg.slice(2);
    if (!arg.startsWith('--') || !values.includes(key) && !flags.includes(key)) throw invalid(`未知选项：${arg}`);
    if (key in opts) throw invalid(`选项重复：${arg}`);
    if (flags.includes(key)) opts[key] = true;
    else { const next = argv[++i]; if (next === undefined || next.startsWith('--')) throw invalid(`${arg} 缺少值`); opts[key] = next; }
  }
  return { opts, args };
}
function arity(args, min, max = min) { if (args.length < min || args.length > max) throw invalid('参数数量不正确；查看 terminal-agent --help'); }
const printJson = (data) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');
const print = (data, json) => json ? printJson(data) : write(typeof data === 'string' ? data + '\n' : JSON.stringify(data, null, 2) + '\n');
export async function authStatus(config, backend = config.agent.backend) {
  const settings = config.backends[backend]; if (!settings) throw invalid(`未知后端：${backend}`);
  if (backend !== 'dsh') return { backend, status: 'adapter-managed', source: '请按适配器说明认证；不读取桌面 App 内部凭证' };
  const name = settings.api_key_env ?? 'DEEPSEEK_API_KEY';
  if (process.env[name]) return { backend, status: 'configured-unverified', source: `env:${name}` };
  const path = settings.credentials ?? credentialsPath();
  try { await access(path); return { backend, status: 'file-present-unverified', source: path, note: '文件存在不等于含有有效 API key；本地检查不读取或显示凭证内容' }; }
  catch { return { backend, status: 'missing', source: `设置 ${name} 或使用 DSH 官方凭证存储：${path}` }; }
}
export async function doctor({ live = false, json = false, backendId } = {}) {
  const loaded = await loadConfig({ cli: backendId ? { agent: { backend: backendId } } : {} }), { config, paths } = loaded, diagnostics = [];
  const check = (name, ok, message) => diagnostics.push({ name, ok, message });
  const zsh = spawnSync(config.execution.shell, ['--version'], { encoding: 'utf8', timeout: 5000 });
  check('zsh', zsh.status === 0, zsh.stdout?.trim() || zsh.error?.message || 'zsh 不可用');
  let probe;
  try { probe = await createBackend(config).probe(); admitBackend(probe); check('backend', true, `${config.agent.backend} ${probe.version}`); }
  catch (e) { check('backend', false, e.message); }
  try { check('ui', true, config.ui.mode === 'plain' ? 'plain' : bunExecutable()); } catch (e) { check('ui', false, e.message); }
  // Check nearest existing ancestors, without initializing state or touching credentials.
  for (const [name, path] of Object.entries(paths).filter(([name]) => name !== 'configFile')) {
    if (!path) continue;
    let parent = path;
    for (;;) { try { await access(parent, 2); check(`storage:${name}`, true, path); break; } catch (e) { if (e.code !== 'ENOENT' || parent === resolve(parent, '..')) { check(`storage:${name}`, false, `${path}: ${e.message}`); break; } parent = resolve(parent, '..'); } }
  }
  const shell = await shellPlan();
  check('shell-integration', true, shell.before.includes('# >>> terminal-agent >>>') ? `${shell.path}：已安装；当前 ZLE 状态请运行 ta shell status` : '未安装标记区块；可用 setup 或临时 shell init zsh');
  check('platform', true, `${process.platform}/${process.arch}${process.platform === 'darwin' && process.arch === 'arm64' ? '' : '（尚需实际发布测试）'}`);
  if (process.env.TERMINAL_AGENT_HOME) loaded.warnings.push('TERMINAL_AGENT_HOME 仅覆盖 DSH home；统一存储请使用 TA_HOME');
  const auth = await authStatus(config);
  if (live) {
    process.stderr.write('在线探测：将发送最小分类请求，可能产生模型用量。\n');
    try {
      const backend = createBackend(config);
      if (!backend.classify) throw new Error('后端没有无工具在线探测能力');
      const route = await backend.classify('echo probe', { cwd: process.cwd(), timeoutMs: config.routing.timeout_seconds * 1000, threshold: config.routing.confidence_threshold });
      check('live', route === 'shell', route === 'shell' ? '模型响应有效' : '探测失败或返回无效分类，请检查认证、模型与网络');
    } catch (e) { check('live', false, e.message); }
  }
  const result = { version, node: process.version, protocol: backendApiVersion, diagnostics, auth, warnings: loaded.warnings, nativeHome: runtimeHome(), probe };
  print(result, json); return diagnostics.every((d) => d.ok) ? 0 : 5;
}
export async function manage(mode, argv) {
  if (mode === 'setup') {
    const { opts, args } = options(argv, { values: ['zshrc', 'backend'], flags: ['yes', 'dry-run', 'temporary'] }); arity(args, 0);
    const result = await setup({ yes: opts.yes, dryRun: opts['dry-run'], zshrc: opts.zshrc, backend: opts.backend, temporary: opts.temporary });
    if (result.applied) return doctor(); return 0;
  }
  if (mode === 'doctor') { const { opts, args } = options(argv, { flags: ['live', 'json'] }); arity(args, 0); return doctor({ live: opts.live, json: opts.json }); }
  if (mode === 'shell') {
    const [action, ...tail] = argv;
    if (['on', 'off', 'status'].includes(action)) { arity(tail, 0); throw invalid('此操作需要已加载的父 shell wrapper：先 eval "$(terminal-agent shell init zsh)"；然后运行 ta shell ' + action); }
    if (action !== 'uninstall') throw invalid('用法：shell init zsh | on | off | status | uninstall');
    const { opts, args } = options(tail, { values: ['zshrc'], flags: ['yes', 'dry-run'] }); arity(args, 0);
    const plan = await shellPlan({ install: false, path: opts.zshrc });
    print({ path: plan.path, change: plan.before !== plan.after ? '仅移除 terminal-agent 标记区块；保留配置与历史' : '无需更改' });
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
    if (!opts.check) { write('请按原安装渠道更新。本地 tarball：npm install -g /absolute/path/terminal-agent-<version>.tgz\n配置 schema=1；修改配置前会创建 .bak。不会自动更新或发布。\n'); return 0; }
    const result = spawnSync('npm', ['view', 'terminal-agent', 'version', '--json', '--fetch-retries=0', '--fetch-timeout=10000'], { encoding: 'utf8', timeout: 12000 });
    print({ current: version, latest: result.status === 0 ? JSON.parse(result.stdout) : null, status: result.status === 0 ? 'checked' : 'unavailable', note: result.status === 0 ? '请确认发布来源后按原安装渠道更新' : '当前使用本地 tarball；registry 未发布或无法访问，未修改安装' }, opts.json); return 0;
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
  if (mode === 'migrate') { const { migrate } = await import('./migrate.mjs'); const { opts, args } = options(argv, { values: ['from'], flags: ['dry-run', 'apply', 'json'] }); arity(args, 0); if (!opts.from || opts.apply && opts['dry-run']) throw invalid('用法：migrate --from /absolute/path/.runtime/dsh --dry-run | --apply'); print(await migrate(opts.from, { apply: !!opts.apply }), opts.json); return 0; }
  throw invalid(`未知管理命令：${mode}`);
}
async function configCommand(argv) {
  const [action, ...tail] = argv;
  const allowed = { show: { flags: ['effective', 'json'], values: ['profile'] }, get: { flags: ['project', 'json'] }, set: { flags: ['project'] }, edit: { flags: ['project'] }, validate: {}, trust: {} };
  if (!allowed[action]) throw invalid('用法：config show/get/set/edit/validate/trust');
  const { opts, args } = options(tail, allowed[action]);
  const loaded = action === 'edit' ? { paths: productPaths(), root: await projectRoot() } : await loadConfig({ profile: opts.profile });
  if (action === 'show') { arity(args, 0); print(opts.effective ? { config: loaded.config, sources: loaded.sources, warnings: loaded.warnings } : await readConfig(loaded.paths.configFile), opts.json); }
  if (action === 'get') { arity(args, 1); const value = getKey(opts.project ? await readConfig(join(loaded.root, '.terminal-agent.toml')) : loaded.config, args[0]); if (value === undefined) throw invalid(`配置不存在：${args[0]}`); print({ key: args[0], value, source: loaded.sources[args[0]] }, opts.json); }
  if (action === 'set') {
    arity(args, 2); const path = opts.project ? join(loaded.root, '.terminal-agent.toml') : loaded.paths.configFile, data = await readConfig(path);
    let value; try { value = JSON.parse(args[1]); } catch { value = args[1]; }
    setKey(data, args[0], value); print(await saveConfig(data, { project: opts.project }));
  }
  if (action === 'validate') { arity(args, 0); print({ valid: true, warnings: loaded.warnings }); }
  if (action === 'trust') { arity(args, 1); print({ trusted: await trustProject(resolve(args[0])), note: '信任绑定 realpath 和配置摘要；改变配置后需要重新信任' }); }
  if (action === 'edit') {
    arity(args, 0); const path = opts.project ? join(loaded.root, '.terminal-agent.toml') : loaded.paths.configFile;
    const temp = await mkdtemp(join(tmpdir(), 'ta-config-edit-')), draft = join(temp, 'config.toml');
    try {
      let text = 'schema_version = 1\n'; try { text = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await atomicWrite(draft, text); runEditor(draft); const data = await readConfig(draft);
      print(await saveConfig(data, { project: opts.project }));
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  return 0;
}
async function backendCommand(argv) {
  const [action, ...tail] = argv;
  const specs = { list: { flags: ['json'] }, info: { flags: ['json'] }, check: { flags: ['json', 'live'] }, use: {}, add: { values: ['manifest'] }, remove: {} };
  if (!specs[action]) throw invalid('用法：backend list/info/check/use/add/remove');
  const { opts, args } = options(tail, specs[action]), loaded = await loadConfig(), { config } = loaded;
  if (action === 'list') { arity(args, 0); const rows = []; for (const [id, settings] of Object.entries(config.backends)) { let probe; try { probe = await createBackend({ ...config, agent: { ...config.agent, backend: id } }).probe(); } catch (e) { probe = { available: false, diagnostics: [e.message] }; } rows.push({ id, default: id === config.agent.backend, ...probe }); } print(rows, opts.json); return 0; }
  arity(args, 1); const id = args[0]; if (!/^[a-z][a-z0-9-]*$/.test(id)) throw invalid('后端名称无效');
  if (action === 'add') { if (['dsh', 'codex', 'claude'].includes(id)) throw invalid('保留的内置后端名称'); if (!opts.manifest) throw invalid('需要 --manifest /absolute/path/adapter.json'); await readManifest(opts.manifest); const data = await readConfig(loaded.paths.configFile); data.backends ??= {}; data.backends[id] = { manifest: opts.manifest, disabled: false }; print(await saveConfig(data)); return 0; }
  if (!config.backends[id]) throw invalid(`未知后端：${id}`);
  if (action === 'use') {
    const backend = createBackend({ ...config, agent: { ...config.agent, backend: id } }); admitBackend(await backend.probe());
    const data = await readConfig(loaded.paths.configFile); data.agent ??= {}; data.agent.backend = id; await saveConfig(data);
    const effective = await loadConfig(); print({ userDefault: id, effective: effective.config.agent.backend, source: effective.sources['agent.backend'] }); return 0;
  }
  if (action === 'remove') { const data = await readConfig(loaded.paths.configFile); if (id === 'dsh') { data.backends ??= {}; data.backends.dsh ??= {}; data.backends.dsh.disabled = true; } else { delete data.backends?.[id]; } print(await saveConfig(data)); return 0; }
  const backend = createBackend({ ...config, agent: { ...config.agent, backend: id } }), probe = await backend.probe();
  if (action === 'info') print({ id, apiVersion: backend.apiVersion, config: config.backends[id], auth: await authStatus(config, id), ...probe }, opts.json);
  if (action === 'check') { if (opts.live) return doctor({ live: true, json: opts.json, backendId: id }); print({ id, ...probe }, opts.json); try { admitBackend(probe); } catch { return 5; } }
  return 0;
}
async function sessionsCommand(argv) {
  const action = argv[0] ?? 'browse', tail = argv.slice(1);
  const specs = { browse: {}, list: { flags: ['all', 'json', 'include-classifier', 'archived'], values: ['backend', 'status'] }, search: { flags: ['all', 'json', 'include-classifier', 'archived'], values: ['backend', 'status'] }, show: { flags: ['full', 'json'] }, export: { flags: ['json', 'full', 'redact', 'preview'], values: ['format', 'output'] }, rename: {}, pin: {}, unpin: {}, archive: {}, restore: {}, delete: { flags: ['yes', 'json'] }, gc: { flags: ['dry-run', 'apply', 'json'], values: ['days', 'max-total-mb'] }, reindex: { flags: ['json'] }, import: { flags: ['json'] }, fork: { flags: ['json'], values: ['backend', 'context'] } };
  if (!specs[action]) throw invalid(`未知历史命令：${action}`);
  const { opts, args } = options(tail, specs[action]), loaded = await loadConfig(), store = new SessionStore();
  const listing = { all: opts.all ?? loaded.config.history.default_scope === 'all', includeClassifier: opts['include-classifier'] ?? loaded.config.history.include_classifier, archived: opts.archived, backend: opts.backend, status: opts.status };
  if (['browse', 'list', 'search'].includes(action)) {
    arity(args, action === 'search' ? 1 : 0); const rows = action === 'search' ? await store.search(args[0], listing) : await store.list(listing);
    if (action === 'browse' && process.stdin.isTTY && process.stdout.isTTY) {
      rows.forEach((m, i) => write(`${i + 1}. ${m.title} · ${m.sessionId.slice(0, 8)} · ${m.status}\n`));
      if (!rows.length) { write('当前项目没有历史任务。\n'); return 0; }
      const { readAnswer } = await import('./cli.mjs');
      const answer = await readAnswer('输入编号查看；Enter 返回 shell：'); if (!answer) return 0;
      const row = rows[Number(answer) - 1]; if (!row) throw invalid('无效编号'); write(exportMarkdown(await store.read(row.sessionId), { full: false })); return 0;
    }
    if (opts.json) printJson(rows);
    else { for (const m of rows) write(`${m.sessionId.slice(0, 8)} ${m.pinned ? '★ ' : ''}${m.title}\n  ${m.updatedAt} · ${m.backend} · ${m.project} · ${m.status} · ${m.commands} 条命令 · resume=${m.resume}\n`); if (!rows.length) write('没有匹配的会话。\n'); }
    for (const w of store.warnings) process.stderr.write(safeText(w) + '\n'); return 0;
  }
  if (action === 'reindex') { arity(args, 0); print(await store.reindex(), opts.json); return 0; }
  if (action === 'gc') {
    arity(args, 0); if (opts.apply && opts['dry-run']) throw invalid('--apply 与 --dry-run 不能同时使用');
    const days = opts.days === undefined ? loaded.config.history.retention_days : Number(opts.days), mb = opts['max-total-mb'] === undefined ? loaded.config.history.max_total_mb : Number(opts['max-total-mb']);
    if (!(days > 0 && Number.isFinite(days) && mb > 0 && Number.isFinite(mb))) throw invalid('GC 天数与容量必须为正数');
    print(await store.gc({ retentionDays: days, maxTotalMb: mb, apply: !!opts.apply }), opts.json); return 0;
  }
  if (action === 'import') { arity(args, 1); print(await store.import(JSON.parse(await readFile(resolve(args[0]), 'utf8'))), opts.json); return 0; }
  arity(args, action === 'rename' ? 2 : 1); const meta = await store.resolve(args[0]);
  if (action === 'show' || action === 'export') {
    let data = await store.read(meta.sessionId); if (opts.redact) data = redactExport(data);
    const format = opts.json ? 'json' : opts.format ?? 'markdown'; if (!['json', 'markdown'].includes(format)) throw invalid('format 必须为 markdown / json');
    const content = format === 'json' ? JSON.stringify(data, null, 2) + '\n' : exportMarkdown(data, { full: action === 'export' || opts.full });
    if (opts.output && !opts.preview) { await atomicWrite(resolve(opts.output), content); write(`导出：${resolve(opts.output)}\n`); }
    else process.stdout.write(format === 'json' ? content : safeText(content)); return 0;
  }
  if (action === 'delete') { if (opts.yes || await confirm(`删除 ${meta.sessionId}（只删除本工具历史，后端原生数据保留）？`)) print(await store.delete(meta.sessionId), opts.json); return 0; }
  if (action === 'fork') {
    if (!opts.backend || opts.context && opts.context !== 'summary') throw invalid('用法：sessions fork <id> --backend <name> --context summary');
    const config = structuredClone(loaded.config); config.agent.backend = opts.backend; admitBackend(await createBackend(config).probe());
    const context = visibleContext(await store.read(meta.sessionId));
    const fork = await store.create({ prompt: meta.title, cwd: meta.cwd, backend: opts.backend, model: config.backends[opts.backend]?.model, config, parentSessionId: meta.sessionId });
    const writer = await store.begin(fork, { prompt: '显式创建可见上下文分支；尚未调用模型', config }); await writer.append('context.imported', context); await writer.finish('ready');
    print({ ...fork, note: '新分支已创建；resume 后输入新请求才调用模型', context: { included: context.included, total: context.total, bytes: context.bytes } }, opts.json); return 0;
  }
  const patch = action === 'rename' ? { title: safeText(args[1]).slice(0, 120) } : ['pin', 'unpin'].includes(action) ? { pinned: action === 'pin' } : { archived: action === 'archive' };
  if (patch.title === '') throw invalid('标题不能为空'); print(await store.update(meta.sessionId, patch)); return 0;
}
