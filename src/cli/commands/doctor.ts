import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from '../../config/load.ts';
import { createBackend } from '../../backends/registry.ts';
import { admitBackend, backendApiVersion } from '../../backends/protocol.ts';
import { runtimeHome } from '../../platform/paths.ts';
import { bunExecutable } from '../../platform/bun-runtime.ts';
import { shellPlan } from '../../platform/shell-setup.ts';
import { authStatus } from './auth.ts';
import { version } from '../version.ts';
import { printJson } from '../output.ts';
import { displayValue, report, status } from '../presentation.ts';
import type { ReportLine } from '../presentation.ts';

export async function doctor({ live = false, json = false, backendId }: { live?: boolean; json?: boolean; backendId?: string } = {}) {
  status('正在检查本地运行环境');
  const loaded = await loadConfig({ cli: backendId ? { agent: { backend: backendId } } : {} }), { config, paths } = loaded, diagnostics: { name: string; ok: boolean; message: string }[] = [];
  const check = (name: string, ok: boolean, message: string) => diagnostics.push({ name, ok, message });
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
  check('shell-integration', true, shell.before.includes('# >>> sayrun >>>') ? `${shell.path}：已安装；当前 ZLE 状态请运行 sayrun shell status`
    : shell.before.includes('# >>> terminal-agent >>>') ? `${shell.path}：检测到旧版集成，请运行 sayrun setup 更新`
    : '未安装标记区块；可用 sayrun setup 或临时 shell init zsh');
  check('platform', true, `${process.platform}/${process.arch}${process.platform === 'darwin' && process.arch === 'arm64' ? '' : '（尚需实际发布测试）'}`);
  if (process.env.TERMINAL_AGENT_HOME) loaded.warnings.push('TERMINAL_AGENT_HOME 仅覆盖 DSH home；统一存储请使用 TA_HOME');
  const auth = await authStatus(config);
  if (live) {
    if (json) process.stderr.write('在线探测：将发送最小分类请求，可能产生模型用量。\n');
    else report('在线探测', [{ text: '将发送最小分类请求，可能产生模型用量。', tone: 'amber' }]);
    status('正在等待模型探测响应');
    try {
      const backend = createBackend(config);
      if (!backend.classify) throw new Error('后端没有无工具在线探测能力');
      const route = await backend.classify('echo probe', { cwd: process.cwd(), timeoutMs: config.routing.timeout_seconds * 1000, threshold: config.routing.confidence_threshold });
      check('live', route === 'shell', route === 'shell' ? '模型响应有效' : '探测失败或返回无效分类，请检查认证、模型与网络');
    } catch (e) { check('live', false, e.message); }
  }
  const result = { version, node: process.version, protocol: backendApiVersion, diagnostics, auth, warnings: loaded.warnings, nativeHome: runtimeHome(), probe };
  const healthy = diagnostics.every((d) => d.ok);
  if (json) printJson(result);
  else {
    const names: Record<string, string> = { zsh: 'Zsh', backend: '模型后端', ui: '终端界面', 'shell-integration': 'Shell 集成', platform: '运行平台', live: '在线模型探测', 'storage:config': '配置目录', 'storage:data': '历史目录', 'storage:state': '状态目录', 'storage:cache': '缓存目录', 'storage:runtime': '运行目录' };
    const lines: ReportLine[] = [
      { text: `${diagnostics.filter((d) => d.ok).length}/${diagnostics.length} 项通过 · ${live ? '包含在线模型探测' : '仅本地检查，未调用模型'}`, tone: 'muted' },
      { text: '' },
      ...diagnostics.flatMap((d): ReportLine[] => [
        { text: `${d.ok ? '✓' : '✗'} ${names[d.name] ?? d.name}`, tone: d.ok ? 'green' : 'red', heading: true },
        { text: `  ${d.message}`, tone: d.ok ? 'muted' : 'red' },
      ]),
      { text: '' },
      { text: `◇ 认证 · ${displayValue(auth.status)}`, tone: auth.status === 'missing' ? 'amber' : 'accent', heading: true },
      { text: auth.source, tone: 'muted' },
      ...('note' in auth && auth.note ? [{ text: auth.note, tone: 'muted' as const }] : []),
      ...loaded.warnings.map((text): ReportLine => ({ text: `! ${text}`, tone: 'amber' })),
      ...(diagnostics.some((d) => d.name === 'backend' && !d.ok) ? [{ text: '下一步：sayrun backend check dsh', tone: 'accent' as const }] : []),
      ...(auth.status === 'missing' ? [{ text: '下一步：sayrun auth login dsh', tone: 'accent' as const }] : []),
    ];
    report(healthy ? '环境检查通过' : '环境检查 · 需要处理', lines, { tone: healthy ? 'green' : 'amber' });
  }
  return healthy ? 0 : 5;
}
