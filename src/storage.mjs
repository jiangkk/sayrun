import { mkdir, open, rename, readFile, rm, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`拒绝使用符号链接目录：${path}`);
}
export async function atomicWrite(path, content) {
  await privateDir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(content); await file.sync(); await file.close(); file = null;
    await rename(temp, path);
  } finally { await file?.close(); await rm(temp, { force: true }); }
}
export const writeJson = (path, data) => atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
