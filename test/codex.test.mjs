import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, chmod, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { CodexBackend } from '../src/backends/codex/backend.ts';
import { runAgent } from '../src/application/run-task.ts';
import { defaults } from '../src/config/defaults.ts';
import { SessionStore } from '../src/history/store.ts';
import { saveConfig } from '../src/config/load.ts';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'sayrun-codex-fixture-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'codex'), cwd = join(dir, 'project');
  await mkdir(cwd);
  await copyFile(new URL('./fixture-codex.mjs', import.meta.url), binary);
  await chmod(binary, 0o700);
  const env = { TA_HOME: join(dir, 'home'), SAYRUN_TEST_PROJECT: cwd };
  const previous = { TA_HOME: process.env.TA_HOME, SAYRUN_TEST_PROJECT: process.env.SAYRUN_TEST_PROJECT, SAYRUN_TEST_CODEX_MODE: process.env.SAYRUN_TEST_CODEX_MODE };
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { binary, cwd, env };
}

test('Codex command duplicates use one host approval and return the actual saved result', async (t) => {
  const { binary, cwd } = await fixture(t);
  const backend = new CodexBackend({ binary }), config = structuredClone(defaults), store = new SessionStore();
  config.agent.engine = 'codex';
  let approvals = 0, executions = 0;
  const result = await runAgent('fixture task', {
    config, cwd, backend, store, input: { isTTY: true }, output: { isTTY: true, write() {} },
    uiFactory: async () => ({
      status() {}, finish() {}, result() {}, close() {},
      async approve(proposal) {
        approvals++;
        assert.equal(proposal.command, 'printf original');
        assert.equal(proposal.cwd, cwd);
        return { ...proposal, command: 'printf edited' };
      },
    }),
    async execute(proposal) {
      executions++;
      assert.equal(proposal.command, 'printf edited');
      return { output: 'edited', exitCode: 0, signal: null, timedOut: false, cancelled: false, truncated: false };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(approvals, 1);
  assert.equal(executions, 1);
  const saved = await store.read(result.sessionId);
  assert.equal(saved.meta.nativeRef, 'fixture-thread');
  assert.equal(saved.events.filter((event) => event.type === 'execution.result').length, 1);
});

test('Codex fails closed with older protocols, native execution environments or configured MCP', async (t) => {
  const { binary, cwd } = await fixture(t);
  const options = { cwd, targetId: 'local-zsh', ephemeral: true };
  process.env.SAYRUN_TEST_CODEX_MODE = 'old';
  const probe = await new CodexBackend({ binary }).probe();
  assert.equal(probe.available, false);
  assert.match(probe.diagnostics.join(' '), /缺少禁用执行环境/);
  process.env.SAYRUN_TEST_CODEX_MODE = 'mcp';
  await assert.rejects(new CodexBackend({ binary }).connect(options), /包含 MCP/);
  process.env.SAYRUN_TEST_CODEX_MODE = 'environment';
  await assert.rejects(new CodexBackend({ binary }).connect(options), /未确认线程、执行环境/);
});

test('Codex rejects stale requests and a call ID whose command changes', async (t) => {
  const { binary, cwd } = await fixture(t);
  const options = { cwd, targetId: 'local-zsh', ephemeral: true };
  for (const [mode, error] of [['stale', /过期的请求/], ['changed', /内容发生变化/]]) {
    process.env.SAYRUN_TEST_CODEX_MODE = mode;
    const session = await new CodexBackend({ binary }).connect(options);
    try {
      assert.equal(session.nativeRef, undefined);
      const stream = session.run({ runId: 'test', prompt: 'test', signal: new AbortController().signal });
      const proposals = [];
      await assert.rejects(async () => {
        for await (const event of stream) if (event.type === 'command.requested') proposals.push(event.command);
      }, error);
      assert.deepEqual(proposals, mode === 'stale' ? [] : ['printf original']);
    } finally { await session.close(); }
  }
});

test('Codex cancellation closes the active process and stream', async (t) => {
  const { binary, cwd } = await fixture(t);
  process.env.SAYRUN_TEST_CODEX_MODE = 'wait';
  const controller = new AbortController();
  const session = await new CodexBackend({ binary }).connect({ cwd, targetId: 'local-zsh', ephemeral: false });
  const stream = session.run({ runId: 'test', prompt: 'test', signal: controller.signal });
  await stream.next();
  controller.abort();
  await session.close();
  assert.deepEqual(await stream.next(), { done: true, value: undefined });
});

test('Codex is selectable, diagnosable and can be disabled through the built CLI', async (t) => {
  const { binary, cwd, env } = await fixture(t);
  await saveConfig({ backends: { codex: { binary } } }, { env });
  const cli = (...args) => spawnSync(process.execPath, [new URL('../dist/sayrun.js', import.meta.url).pathname, ...args], {
    env: { ...process.env, ...env }, cwd, encoding: 'utf8',
  });
  const initial = cli('config', 'get', 'agent.engine');
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);
  assert.match(initial.stdout, /dsh/);
  const check = cli('doctor', '--engine', 'codex', '--json');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(JSON.parse(check.stdout).probe.capabilities.hostTools, true);
  assert.equal(cli('config', 'set', 'agent.engine', 'codex').status, 0);
  const removed = cli('backend', 'check', 'codex', '--json');
  assert.equal(removed.status, 2);
  assert.match(removed.stdout + removed.stderr, /未知命令.*backend/);
  assert.doesNotMatch(cli('--help').stdout, /backend list/);
  assert.match(cli('config', 'get', 'agent.engine').stdout, /codex/);
  assert.match(cli('auth', 'login', 'codex').stdout, /CODEX_HOME=.*codex.* login/);
  assert.equal(cli('config', 'set', 'backends.codex.disabled', 'true').status, 0);
  assert.equal(cli('doctor', '--engine', 'codex', '--json').status, 5);
});
