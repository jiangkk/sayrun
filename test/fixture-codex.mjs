#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2), mode = process.env.SAYRUN_TEST_CODEX_MODE;
if (argv[0] === '--version') {
  console.log('codex-cli fixture');
  process.exit();
}
if (argv[1] === 'generate-json-schema') {
  const out = argv[argv.indexOf('--out') + 1];
  mkdirSync(join(out, 'v2'));
  const schema = (file, keys) => writeFileSync(join(out, file), JSON.stringify({
    properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
  }));
  schema('v2/ThreadStartParams.json', ['environments', 'dynamicTools', 'ephemeral']);
  schema('v2/TurnStartParams.json', mode === 'old' ? [] : ['environments']);
  schema('DynamicToolCallParams.json', ['callId', 'turnId']);
  process.exit();
}
assert.equal(argv[0], 'app-server');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const threadId = 'fixture-thread', turnId = 'fixture-turn';
const notification = (method, params) => send({ method, params: { threadId, turnId, ...params } });
let replies = 0;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const { id, method, params, result } = JSON.parse(line);
  const reply = (result) => send({ id, result });
  if (method === 'initialize') {
    assert.equal(params.capabilities.experimentalApi, true);
    reply({ codexHome: process.env.CODEX_HOME });
  } else if (method === 'config/read') {
    const features = Object.fromEntries(argv.flatMap((value, i) => value === '--disable' ? [[argv[i + 1], false]] : []));
    assert.equal(features.shell_tool, false);
    features.skip_host_skill_discovery = true;
    reply({ config: { web_search: 'disabled', mcp_servers: mode === 'mcp' ? { unexpected: {} } : {}, features } });
  } else if (method === 'thread/start') {
    assert.notEqual(mode, 'mcp', 'must stop before creating a thread with MCP enabled');
    assert.notEqual(params.cwd, process.env.SAYRUN_TEST_PROJECT);
    assert.deepEqual(params.environments, []);
    assert.deepEqual(params.dynamicTools.map((tool) => tool.name), ['terminal_command', 'terminal_question']);
    reply({ thread: { id: threadId, ephemeral: params.ephemeral, environments: mode === 'environment' ? ['local'] : [] },
      sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
  } else if (method === 'turn/start') {
    assert.deepEqual(params.environments, []);
    assert.equal(params.threadId, threadId);
    notification('turn/started', { turn: { id: mode === 'stale' ? 'old-turn' : turnId } });
    if (mode !== 'stale') reply({ turn: { id: turnId } });
    if (mode === 'wait') continue;
    const request = { threadId, turnId, callId: 'call-command', tool: 'terminal_command',
      arguments: { command: 'printf original', description: 'fixture' } };
    if (mode === 'stale') request.turnId = 'old-turn';
    send({ id: 'first', method: 'item/tool/call', params: request });
    if (mode === 'changed') request.arguments.command = 'printf changed';
    send({ id: 'duplicate', method: 'item/tool/call', params: request });
    if (mode === 'stale') reply({ turn: { id: turnId } });
  } else if (!method) {
    const executed = JSON.parse(result.contentItems[0].text);
    const expected = mode === 'pty' ? 'original' : 'edited';
    assert.equal(executed.command, `printf ${expected}`);
    assert.equal(executed.output, expected);
    if (++replies === 2) {
      notification('item/completed', { item: { type: 'agentMessage', text: 'fixture done' } });
      notification('turn/completed', { turn: { id: turnId, status: 'completed' } });
    }
  } else {
    assert.equal(method, 'initialized');
  }
}
