import { readFile, realpath, copyFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { productPaths } from './paths.mjs';
import { atomicWrite, readJson, writeJson } from './storage.mjs';
import { invalid } from './errors.mjs';

export const defaults = {
  schema_version: 1,
  agent: { backend: 'dsh', max_commands: 8, max_steps: 12, max_questions: 5, active_timeout_seconds: 180 },
  routing: { mode: 'auto', classifier: 'backend', confidence_threshold: 0.9, timeout_seconds: 12, on_ambiguous: 'ask' },
  ui: { mode: 'opentui', language: 'zh-CN', color: 'auto', output_preview_lines: 12 },
  approval: { default_selection: 'approve', editor_enter: 'execute' },
  execution: { executor: 'local-zsh', shell: '/bin/zsh', timeout_seconds: 30, max_output_bytes: 65536 },
  history: { enabled: true, default_scope: 'project', auto_gc: false, retention_days: 30, max_total_mb: 1024, store_command_output: true, include_classifier: false },
  backends: { dsh: { binary: 'dsh', model: 'deepseek-flash', api_key_env: 'DEEPSEEK_API_KEY', disabled: false } },
  context: { text: '' }, profiles: {},
};
const enums = {
  'routing.mode': ['auto', 'local', 'explicit'], 'routing.on_ambiguous': ['ask'],
  'ui.mode': ['opentui', 'plain'], 'ui.color': ['auto', 'always', 'never'],
  'approval.default_selection': ['approve', 'reject', 'edit'], 'approval.editor_enter': ['execute', 'save'],
  'execution.executor': ['local-zsh'], 'history.default_scope': ['project', 'all'],
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
export function flatten(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (object(child)) flatten(child, path, out); else out[path] = child;
  }
  return out;
}
export function getKey(value, key) { return key.split('.').reduce((v, k) => v?.[k], value); }
export function setKey(value, key, next) {
  const parts = key.split('.');
  if (parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p) || ['__proto__', 'prototype', 'constructor'].includes(p))) throw invalid('配置键无效');
  let ref = value;
  for (const part of parts.slice(0, -1)) { ref[part] ??= {}; if (!object(ref[part])) throw invalid(`配置路径冲突：${key}`); ref = ref[part]; }
  ref[parts.at(-1)] = next;
}
export function validateConfig(value, { profile = false } = {}) {
  if (!object(value)) throw invalid('配置必须是 TOML 对象');
  for (const [key, v] of Object.entries(flatten(value))) {
    if (key.split('.').some((p) => ['__proto__', 'prototype', 'constructor'].includes(p))) throw invalid('不安全的配置键');
    if (key.startsWith('profiles.') && !profile) continue;
    let expected = getKey(defaults, key);
    if (expected === undefined && /^backends\.[\w-]+\.(binary|model|api_key_env|credentials|manifest|version)$/.test(key)) expected = '';
    if (expected === undefined && /^backends\.[\w-]+\.disabled$/.test(key)) expected = false;
    if (expected === undefined) throw invalid(`未知配置项：${key}`);
    if (typeof v !== typeof expected || object(v)) throw invalid(`配置类型错误：${key}`);
    if (key === 'schema_version' && v !== 1) throw invalid(`不支持配置 schema ${v}；旧配置未修改`);
    if (enums[key] && !enums[key].includes(v)) throw invalid(`${key} 必须为 ${enums[key].join(' / ')}`);
    if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0 || (key !== 'routing.confidence_threshold' && !Number.isInteger(v)))) throw invalid(`${key} 必须为正数${key === 'routing.confidence_threshold' ? '' : '整数'}`);
    if (key === 'routing.confidence_threshold' && v > 1) throw invalid('confidence_threshold 不得超过 1');
    if (key === 'execution.shell' && !isAbsolute(v)) throw invalid('execution.shell 必须是绝对路径');
    if (key.endsWith('api_key_env') && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw invalid('api_key_env 必须是环境变量名');
    if (typeof v === 'string' && /[\x00-\x08\x0b-\x1f\x7f]/.test(v)) throw invalid(`配置含控制字符：${key}`);
  }
  if (value.profiles) for (const [name, config] of Object.entries(value.profiles)) {
    if (!/^[\w-]+$/.test(name) || !object(config) || config.profiles || config.schema_version) throw invalid(`profile 无效：${name}`);
    validateConfig(config, { profile: true });
  }
  return value;
}
export async function readConfig(path) {
  try { return validateConfig(parse(await readFile(path, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw invalid(`${path}：${e.message}`); }
}
export async function projectRoot(cwd = process.cwd()) {
  const path = await realpath(cwd);
  const result = spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 });
  return result.status === 0 ? realpath(result.stdout.trim()) : path;
}
const safeProject = (key) => key.startsWith('ui.') || key.startsWith('context.');
const trustedProject = (key) => /^(agent\.|execution\.(timeout_seconds|max_output_bytes)|routing\.|backends\.[\w-]+\.model$)/.test(key);
const digest = (value) => createHash('sha256').update(JSON.stringify(flatten(value))).digest('hex');
export async function trustProject(cwd = process.cwd(), env = process.env) {
  const root = await projectRoot(cwd), config = await readConfig(join(root, '.terminal-agent.toml'));
  const path = join(productPaths(env).config, 'trust.json');
  const trust = await readJson(path, {});
  trust[root] = digest(config); await writeJson(path, trust);
  return root;
}
export async function loadConfig({ cwd = process.cwd(), profile, cli = {}, env = process.env } = {}) {
  const paths = productPaths(env), root = await projectRoot(cwd);
  const user = await readConfig(paths.configFile), project = await readConfig(join(root, '.terminal-agent.toml'));
  const config = structuredClone(defaults), sources = {}, warnings = [];
  const merge = (value, source) => { for (const [key, v] of Object.entries(flatten(value))) { if (!key.startsWith('profiles.')) { setKey(config, key, v); sources[key] = source; } } };
  merge(defaults, 'default'); merge(user, paths.configFile);
  if (profile) {
    if (!user.profiles?.[profile]) throw invalid(`profile 不存在：${profile}`);
    merge(user.profiles[profile], `profile:${profile}`);
  }
  const trust = await readJson(join(paths.config, 'trust.json'), {});
  const trusted = trust[root] === digest(project);
  for (const [key, v] of Object.entries(flatten(project))) {
    if (safeProject(key) || trusted && trustedProject(key)) merge({ [key]: v }, `project:${root}`);
    else warnings.push(`忽略项目配置 ${key}${trustedProject(key) ? '（需要 config trust .）' : '（仅允许用户配置）'}`);
  }
  const overrides = {
    TERMINAL_AGENT_UI: 'ui.mode', TERMINAL_AGENT_DSH_BIN: 'backends.dsh.binary', TERMINAL_AGENT_MODEL: 'backends.dsh.model',
    TERMINAL_AGENT_CREDENTIALS: 'backends.dsh.credentials', TERMINAL_AGENT_CLASSIFY: 'routing.mode',
  };
  for (const [name, key] of Object.entries(overrides)) if (env[name]) merge({ [key]: name === 'TERMINAL_AGENT_UI' && env[name] === 'tui' ? 'opentui' : env[name] }, `env:${name}`);
  if ('NO_COLOR' in env || env.TERM === 'dumb') merge({ 'ui.color': 'never' }, 'terminal');
  merge(cli, 'cli'); validateConfig(config);
  config.profiles = user.profiles ?? {};
  return { config, sources, warnings, root, paths, trusted };
}
export async function saveConfig(value, { project = false, cwd = process.cwd(), env = process.env } = {}) {
  validateConfig(value);
  if (project) for (const key of Object.keys(flatten(value))) if (!safeProject(key) && !trustedProject(key) && key !== 'schema_version') throw invalid(`项目配置不允许 ${key}`);
  const path = project ? join(await projectRoot(cwd), '.terminal-agent.toml') : productPaths(env).configFile;
  try { await copyFile(path, `${path}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await atomicWrite(path, stringify({ schema_version: 1, ...value })); return path;
}
