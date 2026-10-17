export class AgentError extends Error {
  constructor(code, message, exitCode = 1) { super(message); this.code = code; this.exitCode = exitCode; }
}
export const invalid = (message) => new AgentError('invalid_argument', message, 2);
