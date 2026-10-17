import type { ExecutionResult } from '../contracts/execution.ts';
import type { EventDetail, RunStatus, SessionMeta } from '../contracts/history.ts';
import type { SessionStore } from './store.ts';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, writeJson } from '../platform/atomic-file.ts';
import { safeText } from '../terminal/display.ts';

export class RunWriter {
  store: SessionStore;
  meta: SessionMeta;
  runId: string;
  seq: number;
  release: () => Promise<void>;
  queue: Promise<unknown>;
  constructor(store: SessionStore, meta: SessionMeta, runId: string, seq: number, release: () => Promise<void>) { this.store = store; this.meta = meta; this.runId = runId; this.seq = seq; this.release = release; this.queue = Promise.resolve(); }
  async update() { await writeJson(join(this.store.path(this.meta.sessionId), 'meta.json'), this.meta); }
  append(type: string, detail: EventDetail = {}) {
    const work = this.queue.then(async () => {
      const event = { ...detail, schemaVersion: 1, sessionId: this.meta.sessionId, runId: this.runId, seq: this.seq + 1, timestamp: new Date().toISOString(), type };
      const f = await open(join(this.store.path(this.meta.sessionId), 'events.jsonl'), 'a', 0o600);
      try { await f.writeFile(JSON.stringify(event) + '\n'); await f.sync(); this.seq++; } finally { await f.close(); }
      return event;
    });
    this.queue = work; return work;
  }
  async state(status: RunStatus) { this.meta.status = status; await this.append('run.status', { status }); }
  async result(executionId: string, result: ExecutionResult, saveOutput = true) {
    let outputRef;
    if (saveOutput) { outputRef = `outputs/${executionId}.txt`; await atomicWrite(join(this.store.path(this.meta.sessionId), outputRef), safeText(result.output)); }
    const { output, ...rest } = result;
    await this.append('execution.result', { executionId, ...rest, ...(outputRef ? { outputRef } : {}) });
    this.meta.commands++; await this.update();
  }
  async context(detail: Record<string, unknown>) { await writeJson(join(this.store.path(this.meta.sessionId), `context/${this.runId}.json`), { schemaVersion: 1, runId: this.runId, ...detail }); }
  async finish(status: RunStatus, detail: EventDetail = {}) {
    try {
      this.meta.status = status; this.meta.updatedAt = new Date().toISOString();
      await this.append('run.ended', { status, ...detail }); await this.update();
    } finally { await this.release(); }
  }
}
