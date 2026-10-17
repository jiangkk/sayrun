import { readFile, copyFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { atomicWrite, privateDir } from './storage.mjs';
import { productPaths } from './paths.mjs';
import { readConfig, saveConfig } from './config.mjs';
import { invalid } from './errors.mjs';

const begin = '# >>> terminal-agent >>>', end = '# <<< terminal-agent <<<';
export const shellBlock = `${begin}\nif command -v terminal-agent >/dev/null 2>&1; then\n  eval "$(terminal-agent shell init zsh)"\nfi\n${end}\n`;
export function editShellBlock(text, install) {
  const starts = text.split(begin).length - 1, ends = text.split(end).length - 1;
  if (starts !== ends || starts > 1 || starts === 1 && text.indexOf(end) < text.indexOf(begin)) throw invalid('shell 标记区块不完整或重复，请先修复；文件未修改');
  if (starts) { const a = text.indexOf(begin), b = text.indexOf(end) + end.length; text = text.slice(0, a) + text.slice(b + (text[b] === '\n' ? 1 : 0)); }
  return install ? text + (text && !text.endsWith('\n') ? '\n' : '') + shellBlock : text;
}
export async function shellPlan({ install = true, path = join(process.env.ZDOTDIR || homedir(), '.zshrc') } = {}) {
  let before = '';
  try { path = await realpath(path); before = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { path, before, after: editShellBlock(before, install) };
}
export async function applyShellPlan(plan) {
  if (plan.before === plan.after) return { changed: false, path: plan.path };
  let current = ''; try { current = await readFile(plan.path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (current !== plan.before) throw invalid('zshrc 已变化，请重新执行 setup；文件未修改');
  const backup = `${plan.path}.terminal-agent.${Date.now()}.bak`;
  if (current) await copyFile(plan.path, backup);
  await atomicWrite(plan.path, plan.after);
  return { changed: true, path: plan.path, backup: current ? backup : undefined };
}
export async function confirm(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw invalid('此操作需要确认；请在终端运行，或显式使用 --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
  finally { rl.close(); process.stdin.pause(); }
}
export async function setup({ yes = false, dryRun = false, zshrc, backend = 'dsh', temporary = false } = {}) {
  if (backend !== 'dsh') throw invalid('当前内置后端为 dsh；外部适配器请使用 backend add');
  const paths = productPaths(), plan = temporary ? null : await shellPlan({ path: zshrc });
  const output = [`配置：${paths.configFile}`, `历史：${paths.data}`, `状态：${paths.state}`, `缓存：${paths.cache}`,
    ...(plan ? [`shell：${plan.path}`, plan.after === plan.before ? '标记区块已安装，无需更改' : `将只更新以下标记区块，并备份原文件：\n${shellBlock}`] : ['临时启用：eval "$(terminal-agent shell init zsh)"'])];
  process.stdout.write(output.join('\n') + '\n');
  if (dryRun || !yes && !await confirm('应用以上配置？')) return { applied: false };
  const config = await readConfig(paths.configFile); config.agent ??= {}; config.agent.backend = backend;
  await saveConfig(config);
  for (const path of [paths.data, paths.state, paths.cache]) await privateDir(path);
  if (plan) { const applied = await applyShellPlan(plan); if (applied.backup) process.stdout.write(`备份：${applied.backup}\n`); }
  return { applied: true };
}
// Parse a user's EDITOR argv without evaluating shell substitutions or pipelines.
export function editorArgv(text) {
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
export function runEditor(path) {
  const [binary, ...args] = editorArgv(process.env.VISUAL || process.env.EDITOR || 'vi');
  const result = spawnSync(binary, [...args, path], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw invalid(`编辑器未成功退出：${result.error?.message ?? result.status}`);
}
