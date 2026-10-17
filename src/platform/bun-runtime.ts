import { createRequire } from 'node:module';
import { accessSync, constants } from 'node:fs';

const require = createRequire(import.meta.url);

export function bunExecutable() {
  try {
    // npm can hoist dependencies outside this package; global installs need
    // not contain node_modules/.bin. Resolve the dependency itself instead.
    const executable = require.resolve('bun/bin/bun.exe');
    accessSync(executable, constants.X_OK);
    return executable;
  } catch {
    throw new Error('缺少 Bun 运行时，请重新安装 sayrun（不要使用 --ignore-scripts 或 --omit=optional）；也可设置 TERMINAL_AGENT_UI=plain');
  }
}
