// Optional offline integration check against an installed DSH binary. All model
// requests go to a loopback fixture with a dummy key, never to a live provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgent } from '../src/application/run-task.ts';
import { DshBackend } from '../src/backends/dsh/backend.ts';
import { defaults } from '../src/config/defaults.ts';
import { SessionStore } from '../src/history/store.ts';

const home = await mkdtemp('/tmp/sayrun-dsh-native-'), requests = [];
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); requests.push(request);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('message_start', { message: { id: 'offline-native-smoke', type: 'message', role: 'assistant', model: request.model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
  emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `native-smoke-answer-${requests.length}` } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  emit('message_stop', {}); res.end();
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  Object.assign(process.env, { TA_HOME: home, TERMINAL_AGENT_HOME: join(home, 'dsh'),
    DEEPSEEK_API_KEY: 'offline-fixture-dummy-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` });
  const config = structuredClone(defaults);
  config.backends.dsh.credentials = join(home, 'missing-credentials');
  const backend = new DshBackend(config.backends.dsh), store = new SessionStore();
  const run = (prompt) => runAgent(prompt, { backend, store, config, shellId: 'native-smoke-shell',
    taskTimeoutMs: 15000, input: { isTTY: true }, output: { isTTY: true, write() {} },
    uiFactory: async () => ({ status() {}, output() {}, result() {}, finish() {}, close: async () => {},
      approve: async () => { throw new Error('offline smoke must not execute commands'); }, requestInput: async () => '' }) });
  const first = await run('remember-native-smoke-first-turn');
  const second = await run('continue-native-smoke-second-turn');
  assert.equal(first.sessionId, second.sessionId); assert.notEqual(first.runId, second.runId);
  assert.equal(requests.length, 2);
  const history = JSON.stringify(requests[1].messages);
  assert.match(history, /remember-native-smoke-first-turn/);
  assert.match(history, /native-smoke-answer-1/);
  assert.match(history, /continue-native-smoke-second-turn/);
  const data = await store.read(first.sessionId);
  assert.equal(data.events.filter((e) => e.type === 'run.started').length, 2);
  assert.equal(data.events.some((e) => e.type === 'context.imported'), false);
  console.log('PASS: installed DSH restores prior user and assistant messages across backend restarts; no live model requests');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
