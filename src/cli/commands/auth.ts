import type { Config } from '../../contracts/config.ts';
import { access } from 'node:fs/promises';
import { credentialsPath } from '../../platform/paths.ts';
import { invalid } from '../../errors.ts';

export async function authStatus(config: Config, backend = config.agent.backend) {
  const settings = config.backends[backend]; if (!settings) throw invalid(`未知后端：${backend}`);
  if (backend !== 'dsh') return { backend, status: 'adapter-managed', source: '请按适配器说明认证；不读取桌面 App 内部凭证' };
  const name = settings.api_key_env ?? 'DEEPSEEK_API_KEY';
  if (process.env[name]) return { backend, status: 'configured-unverified', source: `env:${name}` };
  const path = settings.credentials ?? credentialsPath();
  try { await access(path); return { backend, status: 'file-present-unverified', source: path, note: '文件存在不等于含有有效 API key；本地检查不读取或显示凭证内容' }; }
  catch { return { backend, status: 'missing', source: `设置 ${name} 或使用 DSH 官方凭证存储：${path}` }; }
}
