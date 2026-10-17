#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bunExecutable } from '../src/runtime.mjs';

// Use the pinned package runtime; a global Bun installation is not required.
if (!process.versions.bun) {
  const result = spawnSync(bunExecutable(), [fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const staging = join(root, `.dist-${randomUUID()}`);
const previous = `${staging}-previous`;
await mkdir(staging);
try {
  for (const [entrypoint, target] of [
    ['bin/terminal-agent.mjs', 'node'],
    ['src/ui-opentui.mjs', 'bun'],
    ['dsh/terminal-tool.mjs', 'node'],
  ]) {
    const result = await Bun.build({
      entrypoints: [join(root, entrypoint)], outdir: staging, naming: '[name].mjs',
      target, format: 'esm', packages: 'external',
      minify: { identifiers: true, syntax: true, whitespace: true },
      sourcemap: 'none', define: { __TERMINAL_AGENT_BUILD__: 'true' },
    });
    if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entrypoint}`);
  }
  const shell = (await readFile(join(root, 'shell/terminal-agent.zsh'), 'utf8'))
    .replaceAll('bin/terminal-agent.mjs', 'dist/terminal-agent.mjs')
    .split('\n').filter((line) => line.trim() && !/^\s*#/.test(line)).join('\n') + '\n';
  await writeFile(join(staging, 'terminal-agent.zsh'), shell);
  await chmod(join(staging, 'terminal-agent.mjs'), 0o755);
  // Preserve the last successful build if compilation fails.
  let hadPrevious = false;
  try { await rename(dist, previous); hadPrevious = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await rename(staging, dist); }
  catch (e) { if (hadPrevious) await rename(previous, dist); throw e; }
  await rm(previous, { recursive: true, force: true });
  process.stderr.write('Built dist/: minified CLI, OpenTUI, DSH bridge and generated zsh integration (no source maps).\n');
} finally { await rm(staging, { recursive: true, force: true }); }
