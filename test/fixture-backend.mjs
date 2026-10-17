import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let runId;
const event = (value) => send({ method: 'event', params: { ...value, id: crypto.randomUUID(), runId, timestamp: new Date().toISOString() } });
rl.on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'hello') return send({ id, result: { apiVersion: 1, version: '1', capabilities: { hostTools: !process.argv.includes('--restricted'), commandEditing: true, userQuestions: true, cancellation: 'process', resume: 'context-only', ephemeral: true, classify: false, modelDiscovery: false, usage: false } } });
  if (method === 'connect') return send({ id, result: { nativeRef: 'fixture-session' } });
  if (method === 'run') { runId = params.runId; send({ id, result: {} }); event({ type: 'command.requested', requestId: 'fixture-tool', command: 'printf proposed', description: 'test', cwd: process.cwd(), targetId: 'local-zsh' }); return; }
  if (method === 'reply') { send({ id, result: {} }); event({ type: 'message', text: `Executed exact: ${params.command}`, final: true }); event({ type: 'run.ended', reason: 'completed' }); return; }
  send({ id, error: { message: 'unknown method' } });
});
