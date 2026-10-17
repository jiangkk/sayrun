import http from 'node:http';
import { randomUUID } from 'node:crypto';

export const name = 'sayrun-bridge';
export const inject = ['tools'];

function bridge(path: string, args: object, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = http.request({ socketPath: process.env.TERMINAL_AGENT_SOCKET, path, method: 'POST', signal,
      headers: { authorization: `Bearer ${process.env.TERMINAL_AGENT_TOKEN}`, 'content-type': 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error(body)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(args));
  });
}

interface Tool {
  name: string; description: string; parameters: object;
  output: { schema: object; render: (args: unknown, value: string) => { type: string; text: string }[] };
  execute: (args: Record<string, unknown>, execution: { toolCallId?: string; callId?: string; signal?: AbortSignal }) => Promise<string>;
}
export function apply(ctx: { tools: { register: (tool: Tool) => void } }) {
  ctx.tools.register({
    name: 'terminal_command',
    description: 'Propose a non-interactive zsh command to the user. Execution requires terminal approval. Each call starts a fresh shell; pass cwd explicitly. Read the actual output and exit code to verify the requested result. No background jobs or interactive programs.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Exact zsh command to request approval for.' },
        description: { type: 'string', description: 'Explain the purpose and effects in the user’s language.' },
        cwd: { type: 'string', description: 'Absolute working directory; defaults to the task directory.' },
      },
      required: ['command', 'description'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args, exec) => bridge('/execute', { ...args, requestId: exec.toolCallId ?? exec.callId ?? randomUUID() }, exec.signal),
  });
  ctx.tools.register({
    name: 'terminal_question',
    description: 'Ask the user for required information or resolve ambiguity, then continue using their answer. Does not execute commands or grant approval. Never request secrets.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      question: { type: 'string', description: 'A concise, self-contained question in the user’s language.' },
    }, required: ['question'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args, exec) => bridge('/question', { ...args, requestId: exec.toolCallId ?? exec.callId ?? randomUUID() }, exec.signal),
  });
}
