import { createBackend } from '../../backends/registry.ts';
import { admitBackend } from '../../backends/protocol.ts';
import { loadConfig, readConfig } from '../../config/load.ts';
import { invalid } from '../../errors.ts';
import { redactDiagnostics } from '../../terminal/display.ts';
import { readAnswer } from '../input.ts';
import { displayValue, presentation, report, status } from '../presentation.ts';
import type { Choice } from '../presentation.ts';
import { authStatus } from './auth.ts';

const agents = {
  dsh: { name: 'DSH', install: '安装 DSH：npm install -g @deepseek-ai/dsh', docs: 'https://github.com/deepseek-ai/deepseek-harness#run' },
  codex: { name: 'Codex', install: '按官方说明安装或更新 Codex CLI', docs: 'https://developers.openai.com/codex/cli' },
};
type AgentId = keyof typeof agents;
const builtInAgents: AgentId[] = ['dsh', 'codex'];
const isBuiltIn = (id?: string): id is AgentId => builtInAgents.some((agent) => agent === id);

async function choose(title: string, choices: Choice[]) {
  const ui = presentation();
  if (ui) return ui.select(title, choices);
  report(title, choices.map((choice, i) => ({ text: `${i + 1}. ${choice.name} · ${choice.description}` })));
  for (;;) {
    const answer = await readAnswer('选择编号（默认 1，Ctrl-C 退出）：');
    if (answer === null) return null;
    const choice = choices[Number(answer || '1') - 1];
    if (choice) return choice.value;
  }
}

export async function chooseSetupAgent(requested: string | undefined, interactive: boolean) {
  if (requested !== undefined && !isBuiltIn(requested)) throw invalid('setup --engine 可选 dsh 或 codex');
  const candidates = requested ? [requested] : builtInAgents;
  for (;;) {
    const { config, paths } = await loadConfig();
    const saved = (await readConfig(paths.configFile)).agent?.engine;
    const preferred = requested ?? (isBuiltIn(saved) ? saved : undefined);
    status('正在检测本机 Agent 工具');
    const rows = await Promise.all(candidates.map(async (id) => {
      const settings = config.backends[id];
      if (settings.disabled) return { id, problem: `已禁用。重新启用可运行 sayrun config set backends.${id}.disabled false` };
      const backend = createBackend({ ...config, agent: { ...config.agent, engine: id } });
      try {
        const probe = await backend.probe();
        admitBackend(probe);
        const auth = await authStatus(config, id);
        return { id, version: probe.version, auth };
      } catch (error) {
        return { id, problem: redactDiagnostics(error.message) };
      }
    }));
    const available = rows.filter((row) => row.auth !== undefined);
    const blocked = !available.length || (!interactive && preferred && !available.some((row) => row.id === preferred));
    const summary = rows.map((row) => ({
      text: row.auth ? `${agents[row.id].name} · 本地检查通过 · 认证${displayValue(row.auth.status)}`
        : `${agents[row.id].name} · 不可用 · ${row.problem}`,
      tone: row.auth ? 'green' as const : 'amber' as const,
    }));
    if (blocked) {
      report(available.length ? '指定的 Agent 不可用' : '未找到可用的 Agent', [
        ...summary,
        ...rows.filter((row) => !row.auth && !config.backends[row.id].disabled).flatMap(({ id }) => [
          { text: agents[id].install }, { text: agents[id].docs, tone: 'accent' as const },
        ]),
        { text: '安装后请确认命令位于 PATH。如果安装更新了 PATH，请打开新终端再运行 sayrun setup。', tone: 'muted' },
        ...(available.length ? [{ text: '可使用 sayrun setup --engine <dsh|codex> 显式选择可用的 Agent。', tone: 'muted' as const }] : []),
      ], { tone: 'amber' });
      if (!interactive) return { exitCode: 5 } as const;
      const action = await choose('安装 Agent 后重新检测', [
        { name: '重新检测', description: '在另一个终端完成安装后继续', value: 'retry' },
        { name: '退出设置', description: '安装后可再次运行 sayrun setup', value: 'exit' },
      ]);
      if (action === 'retry') continue;
      return { exitCode: action === null ? 130 : 5 } as const;
    }

    report('Agent 检测结果', summary);
    const ordered = available.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred)
      || Number(a.auth?.status === 'missing') - Number(b.auth?.status === 'missing'));
    const selected = interactive && ordered.length > 1
      ? await choose('选择默认 Agent', ordered.map((row) => ({
        name: agents[row.id].name, description: `认证${displayValue(row.auth?.status)}`, value: row.id,
      })))
      : ordered[0].id;
    if (selected === null || !isBuiltIn(selected)) return { exitCode: 130 } as const;
    const authMissing = ordered.find((row) => row.id === selected)?.auth?.status === 'missing';
    if (authMissing) report('配置 Agent 认证', [
      { text: `尚未检测到 ${agents[selected].name} 的认证。首次任务前运行 sayrun auth login ${selected} 查看配置指引。`, tone: 'amber' },
    ]);
    return { id: selected, authMissing };
  }
}
