// Installed Codex with a loopback Responses fixture and dummy credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/application/run-task.ts';
import { CodexBackend } from '../src/backends/codex/backend.ts';
import { defaults } from '../src/config/defaults.ts';
import { SessionStore } from '../src/history/store.ts';
import { codexHome } from '../src/platform/paths.ts';

const home = await realpath(await mkdtemp(join(tmpdir(), 'sayrun-codex-native-')));
const requests = [];
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  const n = requests.length;
  const item = n === 1
    ? { type: 'function_call', name: 'terminal_question', arguments: '{"question":"Which test label?"}', call_id: 'ask-label' }
    : n === 2
      ? { type: 'function_call', name: 'terminal_command', arguments: '{"command":"printf original","description":"Print the label"}', call_id: 'print-label' }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `offline-answer-${n}`, annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit('response.created', { response: { id: `test-response-${n}` } });
  emit('response.output_item.done', { item: { id: `test-item-${n}`, ...item }, output_index: 0 });
  emit('response.completed', { response: { id: `test-response-${n}`, status: 'completed',
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
  res.end();
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  Object.assign(process.env, { TA_HOME: home, SAYRUN_TEST_CODEX_KEY: 'offline-fixture-key' });
  await mkdir(codexHome(), { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome(), 'config.toml'), `model = "offline-smoke"
model_provider = "offline"
[model_providers.offline]
name = "Offline test"
base_url = "http://127.0.0.1:${server.address().port}"
env_key = "SAYRUN_TEST_CODEX_KEY"
wire_api = "responses"
supports_websockets = false
`);
  const config = structuredClone(defaults), store = new SessionStore();
  config.agent.engine = 'codex';
  let executions = 0;
  const run = (prompt, options = {}) => runAgent(prompt, { cwd: home, backend: new CodexBackend({}), store, config,
    shellId: 'codex-native-smoke', taskTimeoutMs: 15000, input: { isTTY: true }, output: { isTTY: true, write() {} },
    uiFactory: async () => ({
      status() {}, output() {}, result() {}, finish() {}, close: async () => {},
      approve: async (command) => ({ ...command, command: 'printf edited' }), requestInput: async () => 'offline-label',
    }),
    execute: async (proposal) => {
      executions++;
      assert.equal(proposal.command, 'printf edited');
      assert.equal(proposal.cwd, home);
      return { output: 'edited', exitCode: 0, signal: null, timedOut: false, cancelled: false, truncated: false };
    }, ...options });
  const first = await run('remember-offline-codex-first-turn');
  const second = await run('continue-offline-codex-second-turn');
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(executions, 1);
  assert.equal(requests.length, 4);
  for (const request of requests) {
    const callable = request.tools.filter((tool) => tool.type !== 'tool_search' && tool.name !== 'request_user_input');
    assert.deepEqual(callable.map((tool) => tool.name).sort(), ['terminal_command', 'terminal_question']);
    assert.ok(callable.every((tool) => tool.type === 'function'));
  }
  assert.match(JSON.stringify(requests[1].input), /offline-label/);
  assert.match(JSON.stringify(requests[2].input), /printf edited/);
  const resumed = JSON.stringify(requests[3].input);
  assert.match(resumed, /remember-offline-codex-first-turn/);
  assert.match(resumed, /offline-answer-3/);
  assert.match(resumed, /continue-offline-codex-second-turn/);
  const data = await store.read(first.sessionId);
  assert.equal(data.events.filter((event) => event.type === 'execution.result').length, 1);
  assert.equal(data.events.some((event) => event.type === 'context.imported'), false);
  console.log('PASS: installed Codex uses host tools and restores native context across processes; loopback model fixture only');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
