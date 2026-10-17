import type { WireObject } from '../contracts/wire.ts';
import { isAbsolute } from 'node:path';
import { invalid } from '../errors.ts';
import { defaults } from './defaults.ts';

const enums: Record<string, readonly unknown[]> = {
  'routing.mode': ['auto', 'local', 'explicit'], 'routing.on_ambiguous': ['ask'],
  'ui.mode': ['opentui', 'plain'], 'ui.color': ['auto', 'always', 'never'],
  'approval.default_selection': ['approve', 'reject', 'edit'], 'approval.editor_enter': ['execute', 'save'],
  'execution.executor': ['local-zsh'], 'history.default_scope': ['project', 'all'],
};
const object = (value: unknown): value is WireObject => !!value && typeof value === 'object' && !Array.isArray(value);
export function flatten(value: object, prefix = '', out: Record<string, unknown> = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (object(child)) flatten(child, path, out); else out[path] = child;
  }
  return out;
}
export function getKey(value: object, key: string): unknown {
  let current: unknown = value;
  for (const part of key.split('.')) { if (!object(current)) return undefined; current = current[part]; }
  return current;
}
export function setKey(value: object, key: string, next: unknown) {
  const parts = key.split('.');
  if (parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p) || ['__proto__', 'prototype', 'constructor'].includes(p))) throw invalid('配置键无效');
  let ref = value as WireObject;
  for (const part of parts.slice(0, -1)) { ref[part] ??= {}; if (!object(ref[part])) throw invalid(`配置路径冲突：${key}`); ref = ref[part]; }
  ref[parts.at(-1)!] = next;
}
export function validateConfig(value: unknown, { profile = false } = {}) {
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
    if (key === 'routing.confidence_threshold' && Number(v) > 1) throw invalid('confidence_threshold 不得超过 1');
    if (key === 'execution.shell' && (typeof v !== 'string' || !isAbsolute(v))) throw invalid('execution.shell 必须是绝对路径');
    if (key.endsWith('api_key_env') && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(v))) throw invalid('api_key_env 必须是环境变量名');
    if (typeof v === 'string' && /[\x00-\x08\x0b-\x1f\x7f]/.test(v)) throw invalid(`配置含控制字符：${key}`);
  }
  if (value.profiles) for (const [name, config] of Object.entries(value.profiles)) {
    if (!/^[\w-]+$/.test(name) || !object(config) || config.profiles || config.schema_version) throw invalid(`profile 无效：${name}`);
    validateConfig(config, { profile: true });
  }
  return value;
}
