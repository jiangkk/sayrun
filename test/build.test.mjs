import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot } from '../src/platform/paths.ts';

const dist = join(packageRoot, 'dist');
const entrypoint = join(dist, 'sayrun.js');
const run = (args, env = process.env) => spawnSync(process.execPath, [entrypoint, ...args], { env, encoding: 'utf8', timeout: 15000 });

test('minified Node entry runs management without loading Bun-only OpenTUI', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'ta-bundle-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const env = { ...process.env, TA_HOME: temp, TERMINAL_AGENT_DSH_BIN: '/missing/dsh' };
  const help = run(['--help'], env); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /shell init zsh/);
  assert.equal(run(['--version'], env).status, 0);
  const save = run(['config', 'set', 'agent.max_commands', '4'], env); assert.equal(save.status, 0, save.stderr + save.stdout);
  const effective = run(['config', 'show', '--effective', '--json'], env); assert.equal(effective.status, 0, effective.stderr); assert.equal(JSON.parse(effective.stdout).config.agent.max_commands, 4);
  assert.deepEqual(JSON.parse(run(['sessions', 'list', '--json'], env).stdout), []);
});

test('release contains minified standalone assets without source maps, original modules, or developer paths', async () => {
  assert.deepEqual((await readdir(dist)).sort(), ['sayrun.js', 'sayrun.zsh', 'terminal-tool.js', 'ui-opentui.js']);
  for (const filename of ['sayrun.js', 'terminal-tool.js', 'ui-opentui.js']) {
    const code = await readFile(join(dist, filename), 'utf8');
    assert.ok(!code.includes('sourceMappingURL=')); assert.ok(!code.includes(packageRoot));
    assert.ok(!code.includes("from '../src"));
    // Executable statements must be compacted, allowing multiline prompt strings.
    assert.ok(code.split('\n').some((line) => line.length > 1000), filename);
  }
  assert.ok(!(await readFile(entrypoint, 'utf8')).includes('from"@opentui/core"'));
});

test('built DSH plugin preserves the public exports and registers both host tools', async () => {
  const { apply, inject, name } = await import('../dist/terminal-tool.js');
  assert.equal(name, 'sayrun-bridge'); assert.deepEqual(inject, ['tools']);
  const tools = []; apply({ tools: { register: (tool) => tools.push(tool) } });
  assert.deepEqual(tools.map((tool) => tool.name), ['terminal_command', 'terminal_question']);
  assert.ok(tools.every((tool) => typeof tool.execute === 'function'));
});

test('built shell integration targets the built CLI and supports paths resolved from installed assets', () => {
  const init = run(['shell', 'init', 'zsh']); assert.equal(init.status, 0, init.stderr);
  assert.ok(init.stdout.includes(join(dist, 'sayrun.zsh')));
  const result = spawnSync('/bin/zsh', ['-f', '-i', '-c', `${init.stdout}\nta --version\n`], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /0\.1\.0/);
});
