import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPublic } from '../scripts/export-public.mjs';

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'sayrun-export-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source'), target = join(temp, 'public source');
  await mkdir(source);
  for (const file of ['package.json', 'README.md', 'LICENSE']) await writeFile(join(source, file), file);
  await mkdir(join(source, 'src'));
  await writeFile(join(source, 'src', 'main.ts'), 'export const version = 1;');
  return { temp, source, target };
}

test('public export includes current source but excludes history, local state and nested credentials', async (t) => {
  const { source, target } = await fixture(t);
  for (const dir of ['.git', '.runtime', 'node_modules', 'dist']) {
    await mkdir(join(source, dir)); await writeFile(join(source, dir, 'local'), 'private fixture');
  }
  for (const name of ['.env', '.env.local', '.credentials.yaml', 'private.key', 'private.pem', 'archive.tgz']) {
    await writeFile(join(source, 'src', name), 'private fixture');
  }
  await writeFile(join(source, '.npmrc'), 'private fixture');
  await writeFile(join(source, 'src', '.env.example'), 'PUBLIC_SETTING=example');
  await chmod(join(source, 'src', 'main.ts'), 0o755);
  const result = await exportPublic(target, { source });
  assert.equal(result.files, 5);
  assert.deepEqual((await readdir(target)).sort(), ['LICENSE', 'README.md', 'package.json', 'src']);
  assert.deepEqual((await readdir(join(target, 'src'))).sort(), ['.env.example', 'main.ts']);
  assert.equal(await readFile(join(target, 'src', 'main.ts'), 'utf8'), 'export const version = 1;');
  assert.ok((await stat(join(target, 'src', 'main.ts'))).mode & 0o100);
  assert.ok((await lstat(join(source, '.git'))).isDirectory());
});

test('public export refuses an existing destination without changing its contents', async (t) => {
  const { source, target } = await fixture(t);
  await mkdir(target); await writeFile(join(target, 'keep'), 'untouched');
  await assert.rejects(exportPublic(target, { source }), /拒绝覆盖/);
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'untouched');
});

test('public export rejects source containment, including a symlinked parent', async (t) => {
  const { temp, source } = await fixture(t);
  const alias = join(temp, 'alias'); await symlink(source, alias);
  await assert.rejects(exportPublic(join(source, 'export'), { source }), /源码目录之外/);
  await assert.rejects(exportPublic(join(alias, 'export'), { source }), /源码目录之外/);
  await assert.rejects(exportPublic(source, { source }), /源码目录之外/);
});

test('public export fails closed on source symlinks and removes its staging directory', async (t) => {
  const { temp, source, target } = await fixture(t);
  await writeFile(join(temp, 'private'), 'outside source');
  await symlink(join(temp, 'private'), join(source, 'src', 'linked.ts'));
  await assert.rejects(exportPublic(target, { source }), /符号链接/);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  assert.ok(!(await readdir(temp)).some((name) => name.startsWith('.sayrun-export-')));
});
