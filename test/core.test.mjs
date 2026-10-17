import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCommand, runCommand } from '../src/execution/process-runner.ts';
import { LineRpc } from '../src/backends/dsh/rpc.ts';
import { prepareDsh, projectRoot } from '../src/backends/dsh/composition.ts';
import { safeText } from '../src/terminal/display.ts';
import { parseClassification } from '../src/backends/classification.ts';
import { classifyInput } from '../src/application/classify-input.ts';
import { ActiveBudget } from '../src/application/active-budget.ts';

test('execution pins cwd, reports failure and withholds credentials from shell', async () => {
  const proposal = await normalizeCommand({ command: 'printf "%s\\n" "$PWD" "${DEEPSEEK_API_KEY-unset}"; exit 7', description: 'test' }, projectRoot);
  const result = await runCommand(proposal, { env: { ...process.env, DEEPSEEK_API_KEY: 'never-print-this' } });
  assert.equal(result.exitCode, 7);
  assert.equal(result.output, `${projectRoot.replace(/\/$/, '')}\nunset\n`);
  assert.ok(Object.isFrozen(proposal));
});

test('timeout and cancellation terminate a command promptly', async () => {
  const proposal = await normalizeCommand({ command: 'sleep 30', description: 'test' }, projectRoot);
  const start = Date.now();
  const timed = await runCommand(proposal, { timeoutMs: 50 });
  assert.equal(timed.timedOut, true);
  const controller = new AbortController();
  const waiting = runCommand(proposal, { signal: controller.signal });
  controller.abort();
  assert.equal((await waiting).cancelled, true);
  assert.ok(Date.now() - start < 4000);
});

test('invalid cwd/control characters are rejected and output is bounded', async () => {
  await assert.rejects(normalizeCommand({ command: 'ls', description: 'test', cwd: 'relative' }, projectRoot));
  await assert.rejects(normalizeCommand({ command: 'echo \x1b[2Jhidden', description: 'test' }, projectRoot));
  const proposal = await normalizeCommand({ command: 'printf 1234567890', description: 'test' }, projectRoot);
  const result = await runCommand(proposal, { maxBytes: 5 });
  assert.equal(result.output, '12345');
  assert.equal(result.truncated, true);
  assert.equal(safeText('\x1b[2Jtext\x07'), 'text');
});

test('JSON-RPC correlates concurrent requests and propagates process exit', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createInterface } from 'node:readline';
    const rl = createInterface({input:process.stdin});
    rl.on('line', line => { const m=JSON.parse(line); if(m.method==='exit')process.exit(1);
      setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.params})),m.params.delay); });
  `]);
  const rpc = new LineRpc(child, () => {});
  try {
    const [a, b] = await Promise.all([rpc.request('a', { delay: 40 }), rpc.request('b', { delay: 1 })]);
    assert.equal(a.delay, 40); assert.equal(b.delay, 1);
    await assert.rejects(rpc.request('exit', {}), /DSH 已退出/);
  } finally { child.kill(); rpc.close(); }
});

test('DSH composition exposes only the approval-gated terminal tool', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-config-'));
  try {
    const config = await prepareDsh({ home, credentialsPath: join(home, 'missing') });
    const patch = JSON.parse(await readFile(config.patchPath, 'utf8'));
    assert.ok(patch.find((r) => r.id === 'persistent-bash').disabled);
    assert.ok(patch.find((r) => r.id === 'persistent-pwsh').disabled);
    assert.equal(patch.find((r) => r.insert).insert.length, 1);
    const { apply } = await import('../src/backends/dsh/terminal-tool.ts');
    const tools = [];
    apply({ tools: { register: (tool) => tools.push(tool) } });
    assert.deepEqual(tools.map((t) => t.name), ['terminal_command', 'terminal_question']);
    const classifier = await prepareDsh({ home, credentialsPath: join(home, 'missing'), mode: 'classify' });
    const classifierPatch = JSON.parse(await readFile(classifier.patchPath, 'utf8'));
    assert.deepEqual(classifierPatch.find((r) => r.insert).insert, []);
    assert.notEqual(config.patchPath, classifier.patchPath);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('zsh routes native syntax, aliases, functions, Chinese args and natural language', () => {
  const cases = [
    ['ls -lah', 'shell'], ['echo 中文', 'shell'], ['X=1 echo hi', 'shell'],
    ['printf test | cat', 'shell'], ['echo "unterminated', 'shell'],
    ['if true; then', 'shell'], ['echo first\necho second', 'shell'],
    ['!123', 'shell'], ['$(echo pwd)', 'shell'], ['# comment', 'shell'],
    ['ll', 'shell'], ['myfunc arg', 'shell'], ['帮我找最大的文件', 'agent'],
    ['please find large files', 'agent'], ['find largest files', 'classify'], ['gti statsu', 'classify'],
    ['git 帮我撤销上一次提交', 'classify'], ['  git status', 'shell'], ['echo 帮我', 'shell'],
    ['echo "帮我"', 'shell'], ['grep 中文 file.txt', 'shell'],
  ];
  const script = `source ./shell/sayrun.zsh >/dev/null
alias ll='ls -l'
myfunc() { :; }
for line in "$@"; do _terminal_agent_route "$line"; print -r -- "$REPLY"; done`;
  const result = spawnSync('/bin/zsh', ['-f', '-i', '-c', script, 'route-test', ...cases.map(([line]) => line)], { cwd: projectRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), cases.map(([, route]) => route), result.stderr);
});

test('classification only accepts confident structured routing, never rewritten commands', () => {
  assert.equal(parseClassification('{"route":"agent","confidence":0.98}'), 'agent');
  assert.equal(parseClassification('{"route":"shell","confidence":1}'), 'shell');
  for (const value of ['shell', '{"route":"shell","confidence":0.4}', '{"route":"rm -rf .","confidence":1}', '{"route":"agent","confidence":2}', '{"route":"shell","confidence":"1"}']) {
    assert.equal(parseClassification(value), 'ask');
  }
});

test('active budget excludes human waiting time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let expired = false;
  const budget = new ActiveBudget(100, () => { expired = true; });
  budget.resume();
  t.mock.timers.tick(40);
  budget.pause();
  t.mock.timers.tick(1000);
  assert.equal(expired, false);
  budget.resume();
  t.mock.timers.tick(59);
  assert.equal(expired, false);
  t.mock.timers.tick(1);
  assert.equal(expired, true);
});

test('ambiguous input routes through a tool-free SDK session and fails closed on tool attempts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ta-classify-'));
  const keys = ['TA_HOME', 'TERMINAL_AGENT_HOME', 'TERMINAL_AGENT_DSH_BIN', 'TERMINAL_AGENT_FIXTURE_SCENARIO'];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.TA_HOME = join(home, 'product');
    process.env.TERMINAL_AGENT_HOME = home;
    process.env.TERMINAL_AGENT_DSH_BIN = join(projectRoot, 'test/fixture-dsh.mjs');
    assert.equal(await classifyInput('find largest files'), 'agent');
    assert.equal(await classifyInput('gti statsu'), 'shell');
    process.env.TERMINAL_AGENT_FIXTURE_SCENARIO = 'classifier-tool-attempt';
    assert.equal(await classifyInput('find largest files'), 'ask');
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    await rm(home, { recursive: true, force: true });
  }
});

test('UTF-8 output truncation never exceeds the configured byte bound', async () => {
  const proposal = await normalizeCommand({ command: "printf '中文'", description: 'unicode' }, projectRoot);
  const result = await runCommand(proposal, { maxBytes: 4 });
  assert.equal(result.output, '中'); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.output) <= 4);
});

test('malformed backend stdout is reported immediately even without pending RPC requests', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>console.log("invalid stdout"),10);setTimeout(()=>{},1000)']);
  let rpc;
  try {
    const failed = new Promise((resolve) => { rpc = new LineRpc(child, () => {}, resolve); });
    assert.match((await failed).message, /非 JSON-RPC/);
  } finally { child.kill(); rpc?.close(); }
});
