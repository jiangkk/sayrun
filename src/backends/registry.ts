import type { Config } from '../contracts/config.ts';
import type { AgentBackend } from '../contracts/backend.ts';
import { CodexBackend } from './codex/backend.ts';
import { DshBackend } from './dsh/backend.ts';
import { ProcessBackend } from './process/backend.ts';
import { AgentError } from '../errors.ts';

export function createBackend(config: Config): AgentBackend {
  const id = config.agent.engine, settings = config.backends[id];
  if (!settings || settings.disabled) throw new AgentError('backend_missing', `Agent 未配置或已禁用：${id}。运行 sayrun setup 重新检测，或检查 agent.engine 和 backends.${id}`, 5);
  if (id === 'codex') return new CodexBackend(settings);
  if (id === 'dsh') return new DshBackend(settings);
  if (settings.manifest) return new ProcessBackend(id, settings);
  throw new AgentError('backend_missing', `后端没有适配器：${id}`, 5);
}
