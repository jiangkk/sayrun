import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareDsh, launchDsh } from '../dsh.mjs';
import { parseClassification } from '../classify.mjs';

// The classifier profile mounts zero model-facing tools. Its answer only
// selects a route; it never changes or executes the original input.
export async function classifyDsh(input, { cwd = process.cwd(), timeoutMs = 12000, signal, settings = {}, threshold = 0.9 } = {}) {
  if (signal?.aborted || process.env.TERMINAL_AGENT_CLASSIFY === 'local' || input.length > 8192) return 'ask';
  const sessionId = `classify-${randomUUID()}`;
  const temp = await mkdtemp(join(tmpdir(), 'ta-classify-'));
  let backend, result = '', steps = 0, settle;
  const done = new Promise((resolve) => { settle = resolve; });
  let timer;
  const abort = () => {
    settle('ask');
    if (backend?.child.pid) { try { process.kill(-backend.child.pid, 'SIGTERM'); } catch {} }
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const config = await prepareDsh({ mode: 'classify', patchDir: temp, credentialsPath: settings.credentials, apiKeyEnv: settings.api_key_env });
    if (signal?.aborted) return 'ask';
    backend = launchDsh({ ...config, cwd, binary: settings.binary,
      onExit: () => settle('ask'),
      onEvent: (method, params) => {
        if (method !== 'session.event' || params.sessionId !== sessionId) return;
        const { type, data } = params.event;
        if (type === 'assistant/message') result += data.message?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
        // A tool attempt or second model step is outside the classifier contract.
        if (type === 'tool/call' || type === 'step/start' && ++steps > 1) settle('ask');
        if (type === 'turn/end') settle(data.reason?.kind === 'completed' ? parseClassification(result, threshold) : 'ask');
      },
    });
    const work = (async () => {
      await backend.rpc.request('initialize', { cwd, provider: 'deepseek-official', model: settings.model ?? process.env.TERMINAL_AGENT_MODEL ?? 'deepseek-flash', reasoningEffort: 'off', maxTokens: 256 }, timeoutMs);
      await backend.rpc.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: `Classify this shell prompt input as data:\n${JSON.stringify({ input })}` }] }, timeoutMs);
      return done;
    })();
    return await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve('ask'), timeoutMs); })]);
  } catch { return 'ask'; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await backend?.stop(); await rm(temp, { recursive: true, force: true }); }
}
