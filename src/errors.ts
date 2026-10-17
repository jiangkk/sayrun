export class AgentError extends Error {
  code: string;
  exitCode: number;
  constructor(code: string, message: string, exitCode = 1) { super(message); this.code = code; this.exitCode = exitCode; }
}
export const invalid = (message: string) => new AgentError('invalid_argument', message, 2);
