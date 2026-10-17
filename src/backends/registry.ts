import type { Config } from '../contracts/config.ts';
import type { AgentBackend } from '../contracts/backend.ts';
import { DshBackend } from './dsh/backend.ts';
import { ProcessBackend } from './process/backend.ts';
import { AgentError } from '../errors.ts';

export function createBackend(config: Config): AgentBackend {
  const id = config.agent.backend, settings = config.backends[id];
  if (!settings || settings.disabled) throw new AgentError('backend_missing', `后端未注册或已禁用：${id}；使用 backend list 检查`, 5);
  if (id === 'dsh') return new DshBackend(settings);
  if (settings.manifest) return new ProcessBackend(id, settings);
  throw new AgentError('backend_missing', `后端没有适配器：${id}`, 5);
}
