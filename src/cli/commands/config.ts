import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, readConfig, saveConfig, trustProject } from '../../config/load.ts';
import { getKey, setKey } from '../../config/schema.ts';
import { productPaths } from '../../platform/paths.ts';
import { projectRoot } from '../../platform/project-root.ts';
import { atomicWrite } from '../../platform/atomic-file.ts';
import { runEditor } from '../../platform/shell-setup.ts';
import { invalid } from '../../errors.ts';
import { options, arity } from '../args.ts';
import type { OptionSpec } from '../args.ts';
import { print } from '../output.ts';

export async function configCommand(argv: string[]) {
  const [action, ...tail] = argv;
  const allowed: Record<string, OptionSpec> = { show: { flags: ['effective', 'json'], values: ['profile'] }, get: { flags: ['project', 'json'] }, set: { flags: ['project'] }, edit: { flags: ['project'] }, validate: {}, trust: {} };
  if (!allowed[action]) throw invalid('用法：config show/get/set/edit/validate/trust');
  const { opts, args } = options(tail, allowed[action]);
  const loaded = action === 'edit' ? { paths: productPaths(), root: await projectRoot(), config: undefined, sources: undefined, warnings: undefined } : await loadConfig({ profile: opts.profile });
  if (action === 'show') { arity(args, 0); print(opts.effective ? { config: loaded.config, sources: loaded.sources, warnings: loaded.warnings } : await readConfig(loaded.paths.configFile), opts.json); }
  if (action === 'get') { arity(args, 1); const value = getKey(opts.project ? await readConfig(join(loaded.root, '.terminal-agent.toml')) : loaded.config ?? {}, args[0]); if (value === undefined) throw invalid(`配置不存在：${args[0]}`); print({ key: args[0], value, source: loaded.sources?.[args[0]] }, opts.json); }
  if (action === 'set') {
    arity(args, 2); const path = opts.project ? join(loaded.root, '.terminal-agent.toml') : loaded.paths.configFile, data = await readConfig(path);
    let value; try { value = JSON.parse(args[1]); } catch { value = args[1]; }
    setKey(data, args[0], value); print(await saveConfig(data, { project: opts.project }));
  }
  if (action === 'validate') { arity(args, 0); print({ valid: true, warnings: loaded.warnings }); }
  if (action === 'trust') { arity(args, 1); print({ trusted: await trustProject(resolve(args[0])), note: '信任绑定 realpath 和配置摘要；改变配置后需要重新信任' }); }
  if (action === 'edit') {
    arity(args, 0); const path = opts.project ? join(loaded.root, '.terminal-agent.toml') : loaded.paths.configFile;
    const temp = await mkdtemp(join(tmpdir(), 'ta-config-edit-')), draft = join(temp, 'config.toml');
    try {
      let text = 'schema_version = 1\n'; try { text = await readFile(path, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await atomicWrite(draft, text); runEditor(draft); const data = await readConfig(draft);
      print(await saveConfig(data, { project: opts.project }));
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  return 0;
}
