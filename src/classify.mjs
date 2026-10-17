import { loadConfig } from './config.mjs';
import { createBackend } from './backends/index.mjs';
import { SessionStore } from './sessions.mjs';

export function parseClassification(text, threshold = 0.9) {
  try { const value = JSON.parse(text.trim()); return ['shell', 'agent'].includes(value.route) && typeof value.confidence === 'number' && value.confidence >= threshold && value.confidence <= 1 ? value.route : 'ask'; }
  catch { return 'ask'; }
}
export async function classifyInput(input, { cwd = process.cwd(), timeoutMs, signal, config } = {}) {
  let writer;
  try {
    config ??= (await loadConfig({ cwd })).config;
    if (signal?.aborted || config.routing.mode !== 'auto' || input.length > 8192) return 'ask';
    const classifierConfig = config.routing.classifier === 'backend' ? config : { ...config, agent: { ...config.agent, backend: config.routing.classifier } };
    const backend = createBackend(classifierConfig), probe = await backend.probe();
    if (!probe.available || !probe.capabilities.classify || !backend.classify) return 'ask';
    if (config.history.enabled) {
      const store = new SessionStore();
      const meta = await store.create({ prompt: input, cwd, backend: backend.id, model: config.backends[backend.id]?.model, config, kind: 'classifier' });
      writer = await store.begin(meta, { prompt: input, config });
    }
    const route = await backend.classify(input, { cwd, timeoutMs: timeoutMs ?? config.routing.timeout_seconds * 1000, threshold: config.routing.confidence_threshold, signal });
    await writer?.append('classification', { route }); await writer?.finish(signal?.aborted ? 'cancelled' : 'completed'); writer = null;
    return route;
  } catch { if (writer) await writer.finish('failed').catch(() => {}); return 'ask'; }
}
