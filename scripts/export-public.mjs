#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = ['.github', '.gitignore', '.npmignore', 'LICENSE', 'README.md', 'AGENTS.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'package.json', 'package-lock.json', 'tsconfig.json',
  'bin', 'src', 'scripts', 'shell', 'test', 'docs', 'website'];
const excluded = (name) => ['.git', '.runtime', '.dsh', 'node_modules', 'dist', '__pycache__', '.DS_Store', 'id_rsa', 'id_ed25519', '.terminal-agent.toml'].includes(name)
  || /^\.env(?:\.|$)/.test(name) && name !== '.env.example'
  || /^\.?credentials?(?:[.-]|$)/i.test(name)
  || /\.(?:pem|key|p12|pfx|tgz|log)$/i.test(name);
const inside = (parent, path) => {
  const rel = relative(parent, path);
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
};

export async function exportPublic(destination, { source = root } = {}) {
  if (!destination) throw new Error('用法：npm run export:public -- /absolute/path/to/new-directory');
  const sourceRoot = await realpath(source);
  const requested = resolve(destination);
  // Resolve the parent before checking containment so symlinks cannot redirect
  // an apparently external export into the source tree.
  const parent = await realpath(dirname(requested));
  const target = join(parent, basename(requested));
  if (inside(sourceRoot, target)) throw new Error('导出目录必须位于源码目录之外');
  try { await lstat(target); throw new Error('导出目录已存在，拒绝覆盖'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const required of ['package.json', 'README.md', 'LICENSE']) {
    const info = await lstat(join(sourceRoot, required));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`缺少可公开的普通文件：${required}`);
  }
  const staging = await mkdtemp(join(parent, '.sayrun-export-'));
  let count = 0;
  const copy = async (from, to) => {
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error(`拒绝导出符号链接：${relative(sourceRoot, from)}`);
    if (info.isDirectory()) {
      await mkdir(to);
      for (const name of (await readdir(from)).sort()) if (!excluded(name)) await copy(join(from, name), join(to, name));
    } else if (info.isFile()) {
      await copyFile(from, to); count++;
    } else throw new Error(`拒绝导出非普通文件：${relative(sourceRoot, from)}`);
  };
  try {
    for (const entry of entries) {
      const path = join(sourceRoot, entry);
      try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await copy(path, join(staging, entry));
    }
    // mkdir is exclusive: even if another process creates the target during
    // copying, its directory is never replaced by this export.
    await mkdir(target);
    try {
      for (const entry of await readdir(staging)) await rename(join(staging, entry), join(target, entry));
    } catch (error) {
      await rm(target, { recursive: true, force: true }); throw error;
    }
    return { path: target, files: count };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：npm run export:public -- /absolute/path/to/new-directory');
    const result = await exportPublic(process.argv[2]);
    console.log(`已导出 ${result.files} 个文件至 ${result.path}（不含 Git 历史和本地状态）。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
