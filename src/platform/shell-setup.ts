import { readFile, copyFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { atomicWrite, privateDir } from './atomic-file.ts';
import { productPaths } from './paths.ts';
import { readConfig, saveConfig } from '../config/load.ts';
import { invalid } from '../errors.ts';
import { presentation, report, status } from '../cli/presentation.ts';
import { approvalMode, approvalModes } from '../config/approval.ts';
import { readAnswer } from '../cli/input.ts';

const begin = '# >>> sayrun >>>', end = '# <<< sayrun <<<';
export const shellBlock = `${begin}\nif command -v sayrun >/dev/null 2>&1; then\n  eval "$(sayrun shell init zsh)"\nfi\n${end}\n`;
export function editShellBlock(text: string, install: boolean) {
  const ranges: { start: number; end: number }[] = [];
  // Upgrade the previous product's managed block without touching other zsh setup.
  for (const [startMarker, endMarker] of [[begin, end], ['# >>> terminal-agent >>>', '# <<< terminal-agent <<<']]) {
    const starts = text.split(startMarker).length - 1, ends = text.split(endMarker).length - 1;
    const start = text.indexOf(startMarker), end = text.indexOf(endMarker);
    if (starts !== ends || starts > 1 || starts === 1 && end < start) throw invalid('shell 标记区块不完整或重复，请先修复；文件未修改');
    if (starts) ranges.push({ start, end: end + endMarker.length });
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) throw invalid('shell 标记区块相互嵌套，请先修复；文件未修改');
  for (const range of ranges.reverse()) text = text.slice(0, range.start) + text.slice(range.end + (text[range.end] === '\n' ? 1 : 0));
  return install ? text + (text && !text.endsWith('\n') ? '\n' : '') + shellBlock : text;
}
export async function shellPlan({ install = true, path = join(process.env.ZDOTDIR || homedir(), '.zshrc') } = {}) {
  let before = '';
  try { path = await realpath(path); before = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { path, before, after: editShellBlock(before, install) };
}
export async function applyShellPlan(plan: Awaited<ReturnType<typeof shellPlan>>) {
  if (plan.before === plan.after) return { changed: false, path: plan.path };
  let current = ''; try { current = await readFile(plan.path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (current !== plan.before) throw invalid('zshrc 已变化，请重新执行 setup；文件未修改');
  const backup = `${plan.path}.sayrun.${Date.now()}.bak`;
  if (current) await copyFile(plan.path, backup);
  await atomicWrite(plan.path, plan.after);
  return { changed: true, path: plan.path, backup: current ? backup : undefined };
}
export async function confirm(question: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw invalid('此操作需要确认；请在终端运行，或显式使用 --yes');
  if (presentation()) return presentation()!.confirm(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); process.stdin.pause(); }
}
export async function setup({ yes = false, dryRun = false, zshrc, backend = 'dsh', temporary = false, mode }: { yes?: boolean; dryRun?: boolean; zshrc?: string; backend?: string; temporary?: boolean; mode?: string } = {}) {
  if (backend !== 'dsh') throw invalid('当前内置后端为 dsh；外部适配器请使用 backend add');
  const paths = productPaths(), plan = temporary ? null : await shellPlan({ path: zshrc });
  const existing = await readConfig(paths.configFile);
  let selected = approvalMode(mode ?? existing.approval?.mode ?? 'ask');
  if (mode === undefined && !yes && !dryRun && process.stdin.isTTY && process.stdout.isTTY) {
    const choices = [...approvalModes].sort((a, b) => Number(b.value === selected) - Number(a.value === selected));
    let answer: string | null;
    if (presentation()) answer = await presentation()!.select('选择授权模式', choices.map((choice) => ({ ...choice })));
    else {
      report('选择授权模式', choices.map((choice, index) => ({ text: `${index + 1}. ${choice.name}：${choice.description}` })));
      answer = await readAnswer('授权模式 [1/2/3，默认 1]：');
      if (answer !== null) {
        answer ||= '1';
        if (!/^[123]$/.test(answer)) throw invalid('请选择授权模式 1 / 2 / 3');
        answer = choices[Number(answer) - 1].value;
      }
    }
    if (answer === null) return { applied: false };
    selected = approvalMode(answer);
  }
  report('欢迎使用 Sayrun', [
    { text: '把想做的事交给终端，按你选择的授权模式执行。', tone: 'muted' },
    { text: '' },
    { text: '01  安装预览', heading: true, tone: 'accent' },
    { text: `默认后端  ${backend}` },
    { text: `授权模式  ${approvalModes.find((choice) => choice.value === selected)!.name}（${selected}）` },
    { text: `配置  ${paths.configFile}` },
    { text: `历史  ${paths.data}` },
    { text: `状态  ${paths.state}` },
    { text: `缓存  ${paths.cache}` },
    { text: '' },
    { text: '02  连接你的 Shell', heading: true, tone: 'accent' },
    ...(plan ? [
      { text: `启动文件  ${plan.path}` },
      { text: plan.after === plan.before ? '标记区块已安装，无需更改。' : '更新 Sayrun 专属标记区块，写入前自动备份原文件。', tone: 'muted' as const },
    ] : [{ text: '临时配置，不写入 zsh 启动文件。', tone: 'muted' as const }]),
    { text: '' },
    { text: dryRun ? '预览模式 · 未修改任何文件。' : '确认后保存配置，并检查本地运行环境。', tone: 'amber' },
  ], { logo: true });
  if (dryRun) return { applied: false };
  if (!yes && !await confirm('应用以上配置？')) {
    report('已取消设置', [{ text: '未修改任何文件。随时运行 sayrun setup 重新开始。', tone: 'muted' }]);
    return { applied: false };
  }
  status('正在保存配置与 Shell 集成');
  const config = await readConfig(paths.configFile);
  config.agent ??= {}; config.agent.backend = backend;
  config.approval ??= {}; config.approval.mode = selected;
  await saveConfig(config);
  for (const path of [paths.data, paths.state, paths.cache]) await privateDir(path);
  if (plan) { const applied = await applyShellPlan(plan); if (applied.backup) report('已备份启动文件', [{ text: applied.backup, tone: 'muted' }]); }
  return { applied: true };
}
// Parse a user's EDITOR argv without evaluating shell substitutions or pipelines.
export function editorArgv(text: string) {
  const args = []; let word = '', quote = '', escape = false, active = false;
  for (const c of text) {
    if (escape) { word += c; escape = false; active = true; }
    else if (c === '\\' && quote !== "'") escape = true;
    else if (quote) { if (c === quote) quote = ''; else word += c; active = true; }
    else if (c === '"' || c === "'") { quote = c; active = true; }
    else if (/\s/.test(c)) { if (active) { args.push(word); word = ''; active = false; } }
    else { word += c; active = true; }
  }
  if (quote || escape) throw invalid('EDITOR 引号未闭合');
  if (active) args.push(word);
  if (!args.length) throw invalid('请设置 EDITOR，例如 EDITOR=vi');
  return args;
}
export function runEditor(path: string) {
  const [binary, ...args] = editorArgv(process.env.VISUAL || process.env.EDITOR || 'vi');
  const result = spawnSync(binary, [...args, path], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw invalid(`编辑器未成功退出：${result.error?.message ?? result.status}`);
}
