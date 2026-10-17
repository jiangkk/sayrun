export interface CommandInput { command: string; description: string; cwd?: string; targetId?: string; shell?: string; decisionSource?: string }
export interface CommandProposal extends CommandInput { cwd: string }
export interface ExecutionResult {
  exitCode: number | null; signal: string | null; timedOut: boolean;
  cancelled: boolean; truncated: boolean; output: string;
}
export interface ExecutionOptions {
  signal?: AbortSignal; onOutput?: (text: string) => void; timeoutMs?: number;
  maxBytes?: number; shell?: string; env?: NodeJS.ProcessEnv;
}
export interface Executor {
  targetId: string;
  normalize(input: CommandInput, cwd: string): Promise<Readonly<CommandProposal>>;
  execute(proposal: CommandProposal, options?: ExecutionOptions): Promise<ExecutionResult>;
}
