import type { ConfigPatch } from '../contracts/config.ts';
import { readFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'smol-toml';
import { productPaths } from '../platform/paths.ts';
import { projectRoot } from '../platform/project-root.ts';
import { atomicWrite, readJson, writeJson } from '../platform/atomic-file.ts';
import { invalid } from '../errors.ts';
import { defaults } from './defaults.ts';
import { flatten, setKey, validateConfig } from './schema.ts';

export async function readConfig(path: string): Promise<ConfigPatch> {
  try { return validateConfig(parse(await readFile(path, 'utf8'))) as ConfigPatch; }
  catch (e) { if (e.code === 'ENOENT') return {}; throw invalid(`${path}：${e.message}`); }
}
const safeProject = (key: string) => key.startsWith('ui.') || key.startsWith('context.');
const trustedProject = (key: string) => /^(agent\.|execution\.(timeout_seconds|max_output_bytes)|routing\.|backends\.[\w-]+\.model$)/.test(key);
const digest = (value: object) => createHash('sha256').update(JSON.stringify(flatten(value))).digest('hex');
export async function trustProject(cwd = process.cwd(), env = process.env) {
  const root = await projectRoot(cwd), config = await readConfig(join(root, '.terminal-agent.toml'));
  const path = join(productPaths(env).config, 'trust.json');
  const trust = await readJson<Record<string, string>>(path, {});
  trust[root] = digest(config); await writeJson(path, trust);
  return root;
}
export async function loadConfig({ cwd = process.cwd(), profile, cli = {}, env = process.env }: { cwd?: string; profile?: string; cli?: ConfigPatch; env?: NodeJS.ProcessEnv } = {}) {
  const paths = productPaths(env), root = await projectRoot(cwd);
  const user = await readConfig(paths.configFile), project = await readConfig(join(root, '.terminal-agent.toml'));
  const config = structuredClone(defaults), sources: Record<string, string> = {}, warnings: string[] = [];
  const merge = (value: object, source: string) => { for (const [key, v] of Object.entries(flatten(value))) { if (!key.startsWith('profiles.')) { setKey(config, key, v); sources[key] = source; } } };
  merge(defaults, 'default'); merge(user, paths.configFile);
  if (profile) {
    if (!user.profiles?.[profile]) throw invalid(`profile 不存在：${profile}`);
    merge(user.profiles[profile], `profile:${profile}`);
  }
  const trust = await readJson<Record<string, string>>(join(paths.config, 'trust.json'), {});
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
export async function saveConfig(value: ConfigPatch, { project = false, cwd = process.cwd(), env = process.env } = {}) {
  validateConfig(value);
  if (project) for (const key of Object.keys(flatten(value))) if (!safeProject(key) && !trustedProject(key) && key !== 'schema_version') throw invalid(`项目配置不允许 ${key}`);
  const path = project ? join(await projectRoot(cwd), '.terminal-agent.toml') : productPaths(env).configFile;
  try { await copyFile(path, `${path}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await atomicWrite(path, stringify({ schema_version: 1, ...value })); return path;
}
