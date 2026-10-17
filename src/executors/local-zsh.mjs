import { normalizeCommand, runCommand } from '../execute.mjs';
import { AgentError } from '../errors.mjs';

export class LocalZshExecutor {
  id = 'local-zsh'; targetId = 'local-zsh';
  constructor(config) { this.config = config; }
  async normalize(args, cwd) {
    const proposal = await normalizeCommand(args, cwd);
    return Object.freeze({ ...proposal, targetId: this.targetId, shell: this.config.shell });
  }
  execute(proposal, options) {
    return runCommand(proposal, { shell: this.config.shell, timeoutMs: this.config.timeout_seconds * 1000, maxBytes: this.config.max_output_bytes, ...options });
  }
}
export function createExecutor(config) {
  if (config.executor !== 'local-zsh') throw new AgentError('capability_missing', `执行器不可用：${config.executor}`, 5);
  return new LocalZshExecutor(config);
}
