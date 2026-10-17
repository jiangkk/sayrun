#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const staging = join(root, `.dist-${randomUUID()}`);
const previous = `${staging}-previous`;
await mkdir(staging);
try {
  for (const [entrypoint, target] of [
    ['bin/sayrun.ts', 'node'],
    ['src/terminal/ui-opentui.ts', 'bun'],
    ['src/backends/dsh/terminal-tool.ts', 'node'],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [join(root, entrypoint)], outdir: staging, naming: '[name].js',
      target, format: 'esm', packages: 'external',
      minify: { identifiers: true, syntax: true, whitespace: true },
      sourcemap: 'none', define: { __TERMINAL_AGENT_BUILD__: 'true' },
    });
    if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entrypoint}`);
  }
  const shell = (await readFile(join(root, 'shell/sayrun.zsh'), 'utf8'))
    .split('\n').filter((line) => line.trim() && !/^\s*#/.test(line)).join('\n') + '\n';
  await writeFile(join(staging, 'sayrun.zsh'), shell);
  await chmod(join(staging, 'sayrun.js'), 0o755);
  // Preserve the last successful build if compilation fails.
  let hadPrevious = false;
  try { await rename(dist, previous); hadPrevious = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await rename(staging, dist); }
  catch (e) { if (hadPrevious) await rename(previous, dist); throw e; }
  await rm(previous, { recursive: true, force: true });
  process.stderr.write('Built dist/: minified CLI, OpenTUI, DSH bridge and generated zsh integration (no source maps).\n');
} finally { await rm(staging, { recursive: true, force: true }); }
