import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArguments } from '../src/cli.mjs';
import { runtimeHome, credentialsPath, packageRoot } from '../src/paths.mjs';
import { bunExecutable } from '../src/runtime.mjs';

test('CLI exposes interactive, explicit task, shorthand, and local management entrypoints', () => {
  assert.equal(parseArguments([]).mode, 'interactive');
  assert.deepEqual(parseArguments(['ask', 'find', 'files']), { mode: 'ask', args: ['find', 'files'] });
  assert.deepEqual(parseArguments(['帮我检查目录']), { mode: 'ask', args: ['帮我检查目录'] });
  assert.deepEqual(parseArguments(['--', 'doctor']), { mode: 'ask', args: ['doctor'] });
  assert.equal(parseArguments(['shell', 'init', 'zsh']).mode, 'shell');
  assert.equal(parseArguments(['--version']).mode, 'version');
  assert.equal(parseArguments(['doctor', '--live']).mode, 'doctor');
  for (const args of [['ask'], ['--'], ['doctro'], ['--unknown'], ['shell', 'init', 'bash'], ['preview', 'extra']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('runtime state and credentials use independent user paths with explicit overrides', () => {
  assert.equal(runtimeHome({}), join(homedir(), '.local/state/terminal-agent/dsh'));
  assert.equal(runtimeHome({ XDG_STATE_HOME: '/tmp/state' }), '/tmp/state/terminal-agent/dsh');
  assert.equal(runtimeHome({ XDG_STATE_HOME: '/tmp/state', TERMINAL_AGENT_HOME: '/tmp/custom' }), '/tmp/custom');
  assert.equal(credentialsPath({}), join(homedir(), '.dsh/.credentials.yaml'));
  assert.equal(credentialsPath({ DSH_HOME: '/tmp/existing-dsh' }), '/tmp/existing-dsh/.credentials.yaml');
  assert.equal(credentialsPath({ DSH_HOME: '/tmp/existing-dsh', TERMINAL_AGENT_CREDENTIALS: '/tmp/keys.yml' }), '/tmp/keys.yml');
  assert.ok(bunExecutable().endsWith('/bun/bin/bun.exe'));
});

test('help/version work without DSH and non-TTY input fails without starting a task', () => {
  const env = { ...process.env, TERMINAL_AGENT_DSH_BIN: '/missing/dsh' };
  const run = (...args) => spawnSync(process.execPath, [join(packageRoot, 'bin/terminal-agent.mjs'), ...args], { env, encoding: 'utf8' });
  assert.match(run('--help').stdout, /shell init zsh/);
  assert.equal(run('--version').status, 0);
  assert.equal(run().status, 1);
  assert.match(run().stdout, /交互需要终端/);
  assert.equal(run('doctor').status, 5);
  assert.match(run('doctor').stdout, /无法运行 dsh/);
});

test('zsh init is deterministic and preserves an existing ta function or alias', () => {
  const init = spawnSync(process.execPath, [join(packageRoot, 'bin/terminal-agent.mjs'), 'shell', 'init', 'zsh'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(init.stdout.split('\n').length, 2);
  for (const definition of ['ta() { print EXISTING_TA; }', "alias ta='print EXISTING_TA'"]) {
    const script = `${definition}\n${init.stdout}\neval ta\n`;
    const result = spawnSync('/bin/zsh', ['-f', '-i', '-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /EXISTING_TA/);
  }
});
