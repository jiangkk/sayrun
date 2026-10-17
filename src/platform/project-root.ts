import { realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

export async function projectRoot(cwd = process.cwd()) {
  const path = await realpath(cwd);
  const result = spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 2000 });
  return result.status === 0 ? realpath(result.stdout.trim()) : path;
}
