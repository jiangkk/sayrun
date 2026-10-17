import type { Config } from '../contracts/config.ts';
import type { CommandInput, CommandProposal, ExecutionOptions, Executor } from '../contracts/execution.ts';
import { normalizeCommand, runCommand } from './process-runner.ts';
import { AgentError } from '../errors.ts';

export class LocalZshExecutor implements Executor {
  config: Config['execution'];
  id = 'local-zsh'; targetId = 'local-zsh';
  constructor(config: Config['execution']) { this.config = config; }
  async normalize(args: CommandInput, cwd: string) {
    const proposal = await normalizeCommand(args, cwd);
    return Object.freeze({ ...proposal, targetId: this.targetId, shell: this.config.shell });
  }
  execute(proposal: CommandProposal, options?: ExecutionOptions) {
    return runCommand(proposal, { shell: this.config.shell, timeoutMs: this.config.timeout_seconds * 1000, maxBytes: this.config.max_output_bytes, ...options });
  }
}
export function createExecutor(config: Config['execution']) {
  if (config.executor !== 'local-zsh') throw new AgentError('capability_missing', `执行器不可用：${config.executor}`, 5);
  return new LocalZshExecutor(config);
}
