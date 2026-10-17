import { loadConfig, readConfig, saveConfig } from '../../config/load.ts';
import { createBackend } from '../../backends/registry.ts';
import { readManifest } from '../../backends/process/backend.ts';
import { admitBackend } from '../../backends/protocol.ts';
import { invalid } from '../../errors.ts';
import { options, arity } from '../args.ts';
import type { OptionSpec } from '../args.ts';
import { print } from '../output.ts';
import { authStatus } from './auth.ts';
import { doctor } from './doctor.ts';
import { report, status } from '../presentation.ts';

export async function backendCommand(argv: string[]) {
  const [action, ...tail] = argv;
  const specs: Record<string, OptionSpec> = { list: { flags: ['json'] }, info: { flags: ['json'] }, check: { flags: ['json', 'live'] }, use: {}, add: { values: ['manifest'] }, remove: {} };
  if (!specs[action]) throw invalid('用法：backend list/info/check/use/add/remove');
  const { opts, args } = options(tail, specs[action]), loaded = await loadConfig(), { config } = loaded;
  status('正在检查后端');
  if (action === 'list') {
    arity(args, 0);
    const rows = [];
    for (const id of Object.keys(config.backends)) {
      let probe;
      try { probe = await createBackend({ ...config, agent: { ...config.agent, backend: id } }).probe(); }
      catch (e) { probe = { available: false, diagnostics: [e.message] }; }
      rows.push({ id, default: id === config.agent.backend, ...probe });
    }
    if (opts.json) print(rows, true);
    else report('已注册后端', rows.flatMap((row) => [
      { text: `${row.default ? '◆' : '◇'} ${row.id}${row.default ? ' · 默认' : ''}`, heading: true, tone: 'accent' as const },
      { text: row.available ? `✓ 可用 · ${'version' in row ? row.version ?? '未知版本' : '未知版本'}` : '✗ 不可用', tone: row.available ? 'green' as const : 'amber' as const },
      ...row.diagnostics.map((text: string) => ({ text, tone: 'muted' as const })),
      { text: `查看详情：sayrun backend info ${row.id}`, tone: 'muted' as const },
      { text: '' },
    ]));
    return 0;
  }
  arity(args, 1); const id = args[0]; if (!/^[a-z][a-z0-9-]*$/.test(id)) throw invalid('后端名称无效');
  if (action === 'add') { if (['dsh', 'codex', 'claude'].includes(id)) throw invalid('保留的内置后端名称'); if (!opts.manifest) throw invalid('需要 --manifest /absolute/path/adapter.json'); await readManifest(opts.manifest); const data = await readConfig(loaded.paths.configFile); data.backends ??= {}; data.backends[id] = { manifest: opts.manifest, disabled: false }; print(await saveConfig(data), false, '后端已添加'); return 0; }
  if (!config.backends[id]) throw invalid(`未知后端：${id}`);
  if (action === 'use') {
    const backend = createBackend({ ...config, agent: { ...config.agent, backend: id } }); admitBackend(await backend.probe());
    const data = await readConfig(loaded.paths.configFile); data.agent ??= {}; data.agent.backend = id; await saveConfig(data);
    const effective = await loadConfig(); print({ userDefault: id, effective: effective.config.agent.backend, source: effective.sources['agent.backend'] }, false, '默认后端已更新'); return 0;
  }
  if (action === 'remove') { const data = await readConfig(loaded.paths.configFile); if (id === 'dsh') { data.backends ??= {}; data.backends.dsh ??= {}; data.backends.dsh.disabled = true; } else { delete data.backends?.[id]; } print(await saveConfig(data), false, '后端已移除'); return 0; }
  const backend = createBackend({ ...config, agent: { ...config.agent, backend: id } }), probe = await backend.probe();
  if (action === 'info') print({ id, apiVersion: backend.apiVersion, config: config.backends[id], auth: await authStatus(config, id), ...probe }, opts.json, '后端详情');
  if (action === 'check') { if (opts.live) return doctor({ live: true, json: opts.json, backendId: id }); print({ id, ...probe }, opts.json, '后端详情'); try { admitBackend(probe); } catch { return 5; } }
  return 0;
}
