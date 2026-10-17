import type { Route } from '../contracts/backend.ts';
import type { Config } from '../contracts/config.ts';
import type { RunWriter } from '../history/run-writer.ts';
import { loadConfig } from '../config/load.ts';
import { createBackend } from '../backends/registry.ts';
import { SessionStore } from '../history/store.ts';

export async function classifyInput(input: string, { cwd = process.cwd(), timeoutMs, signal, config }: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; config?: Config } = {}): Promise<Route> {
  let writer: RunWriter | null | undefined;
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
