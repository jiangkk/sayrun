import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Assets belong to the installed package; mutable state belongs to the user.
export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const built = typeof __TERMINAL_AGENT_BUILD__ !== 'undefined' && __TERMINAL_AGENT_BUILD__;
export const cliEntrypoint = join(packageRoot, built ? 'dist/terminal-agent.mjs' : 'bin/terminal-agent.mjs');
export const shellIntegration = join(packageRoot, built ? 'dist/terminal-agent.zsh' : 'shell/terminal-agent.zsh');
export const dshBridge = join(packageRoot, built ? 'dist/terminal-tool.mjs' : 'dsh/terminal-tool.mjs');

export function runtimeHome(env = process.env) {
  return resolve(env.TERMINAL_AGENT_HOME || (env.TA_HOME ? join(resolve(env.TA_HOME), 'data/backends/dsh/default') : '') || join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'terminal-agent/dsh'));
}

export function credentialsPath(env = process.env) {
  return resolve(env.TERMINAL_AGENT_CREDENTIALS || join(env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml'));
}

export function productPaths(env = process.env) {
  const base = env.TA_HOME && resolve(env.TA_HOME);
  const home = homedir();
  const config = base ? join(base, 'config') : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'terminal-agent');
  const data = base ? join(base, 'data') : join(env.XDG_DATA_HOME || join(home, '.local/share'), 'terminal-agent');
  const state = base ? join(base, 'state') : join(env.XDG_STATE_HOME || join(home, '.local/state'), 'terminal-agent');
  return { config, configFile: join(config, 'config.toml'), data, state,
    cache: base ? join(base, 'cache') : join(env.XDG_CACHE_HOME || join(home, '.cache'), 'terminal-agent'),
    runtime: base ? join(base, 'runtime') : env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'terminal-agent') : undefined };
}
