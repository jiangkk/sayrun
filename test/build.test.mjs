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
  assert.deepEqual((await readdir(dist)).sort(), ['command-opentui.js', 'sayrun.js', 'sayrun.zsh', 'terminal-tool.js', 'ui-opentui.js']);
  for (const filename of ['sayrun.js', 'terminal-tool.js', 'ui-opentui.js', 'command-opentui.js']) {
    const code = await readFile(join(dist, filename), 'utf8');
    assert.ok(!code.includes('sourceMappingURL=')); assert.ok(!code.includes(packageRoot));
    assert.ok(!code.includes("from '../src"));
    // Executable statements must be compacted, allowing multiline prompt strings.
    assert.ok(code.split('\n').some((line) => line.length > 1000), filename);
  }
  assert.ok(!(await readFile(entrypoint, 'utf8')).includes('from"@opentui/core"'));
});

test('published README images use public npm CDN URLs and are included in the tarball', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'sayrun-pack-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', temp], {
    cwd: packageRoot, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
  const { name } = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^\s)]+)\)/g)];
  assert.ok(images.length > 0);
  for (const [, src] of images) {
    const url = new URL(src);
    assert.equal(url.origin, 'https://cdn.jsdelivr.net');
    const prefix = `/npm/${name}@latest/`;
    assert.ok(url.pathname.startsWith(prefix));
    const asset = url.pathname.slice(prefix.length);
    assert.ok(files.includes(asset), `README image missing from npm package: ${asset}`);
    assert.equal((await readFile(join(packageRoot, asset))).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
  assert.deepEqual(files.filter((path) => path.startsWith('docs/')), ['docs/images/approval-preview.png']);
});

test('built DSH plugin preserves the public exports and registers both host tools', async () => {
  const { apply, inject, name } = await import('../dist/terminal-tool.js');
  assert.equal(name, 'sayrun-bridge'); assert.deepEqual(inject, ['tools']);
  const tools = []; apply({ tools: { register: (tool) => tools.push(tool) } });
  assert.deepEqual(tools.map((tool) => tool.name), ['terminal_command', 'terminal_question']);
  assert.ok(tools.every((tool) => typeof tool.execute === 'function'));
});

test('built shell integration targets the built CLI and supports paths resolved from installed assets', async () => {
  const init = run(['shell', 'init', 'zsh']); assert.equal(init.status, 0, init.stderr);
  assert.ok(init.stdout.includes(join(dist, 'sayrun.zsh')));
  const result = spawnSync('/bin/zsh', ['-f', '-i', '-c', `${init.stdout}\nta --version\n`], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, new RegExp(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version.replaceAll('.', '\\.')));
});
