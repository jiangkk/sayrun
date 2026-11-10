import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WireObject } from '../../contracts/wire.ts';

export const disabledFeatures = [
  'shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'runtime_agent_instances',
  'hooks', 'plugins', 'remote_plugin', 'apps', 'computer_use', 'image_generation',
  'code_mode', 'code_mode_only', 'skill_search', 'skill_mcp_dependency_install', 'goals',
  'memories', 'external_agent_memory_import', 'view_image', 'default_mode_request_user_input',
  'request_permissions_tool', 'tool_suggest',
];

export const serverArgs = [
  'app-server', '--listen', 'stdio://', '-c', 'web_search="disabled"', '-c', 'analytics.enabled=false', '-c', 'cli_auth_credentials_store="file"',
  ...disabledFeatures.flatMap((feature) => ['--disable', feature]),
  '--enable', 'skip_host_skill_discovery',
];

export function codexBinary(binary?: string) {
  return binary && (isAbsolute(binary) || binary.includes('/')) ? resolve(binary) : binary || 'codex';
}

export function object(value: unknown): value is WireObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const runFile = promisify(execFile);
export async function checkProtocol(binary: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'sayrun-codex-check-'));
  try {
    const options = { cwd, env: { ...process.env, CODEX_HOME: cwd }, timeout: 10000 };
    const { stdout } = await runFile(binary, ['--version'], options);
    await runFile(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', cwd], options);
    // Older app-servers can silently ignore unknown request fields. Verify that
    // the installed binary knows how to remove its execution environment.
    const schemas = await Promise.all([
      'v2/ThreadStartParams.json', 'v2/TurnStartParams.json', 'DynamicToolCallParams.json',
    ].map(async (file) => JSON.parse(await readFile(join(cwd, file), 'utf8')).properties));
    if (!schemas[0]?.environments || !schemas[0]?.dynamicTools || !schemas[0]?.ephemeral
      || !schemas[1]?.environments || !schemas[2]?.callId || !schemas[2]?.turnId) {
      throw new Error('缺少禁用执行环境、动态工具或临时会话接口');
    }
    return stdout.trim();
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
