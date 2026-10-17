import { readdir, readFile, mkdir, rm, lstat, open, realpath, rename, chmod, link } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { productPaths } from './paths.mjs';
import { projectRoot } from './config.mjs';
import { privateDir, atomicWrite, writeJson, readJson, processAlive } from './storage.mjs';
import { safeText } from './display.mjs';
import { AgentError, invalid } from './errors.mjs';

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{3,100}$/;
const activeStates = ['starting', 'thinking', 'awaiting_approval', 'awaiting_input', 'executing'];
const hash = (s) => createHash('sha256').update(s).digest('hex');
export class SessionStore {
  constructor({ env = process.env } = {}) { this.paths = productPaths(env); this.base = join(this.paths.data, 'sessions'); this.warnings = []; }
  async init() {
    await privateDir(this.base); this.base = await realpath(this.base);
    const path = join(this.paths.data, 'installation.json');
    let installation = await readJson(path, null);
    if (!installation) {
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeJson(temp, { schemaVersion: 1, machineId: randomUUID() });
      try { await link(temp, path); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      finally { await rm(temp, { force: true }); }
      installation = await readJson(path);
    }
    if (installation.schemaVersion !== 1 || typeof installation.machineId !== 'string') throw new AgentError('storage_error', 'installation.json 身份格式无效');
    this.machineId = installation.machineId;
    return this;
  }
  path(id) { if (!idPattern.test(id)) throw invalid(`无效会话 ID：${id}`); return join(this.base, id); }
  async owned(id) {
    const path = this.path(id);
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw invalid('拒绝访问历史目录符号链接');
    return path;
  }
  async lock(id) {
    const path = join(await this.owned(id), 'lock'), token = randomUUID(), temp = `${path}.${token}.tmp`, gate = `${path}.recovery`;
    await writeJson(temp, { pid: process.pid, token });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Publish a complete owner record atomically; no ownerless mkdir gap.
          await link(temp, path);
          return async () => { const owner = await readJson(path, null); if (owner?.token === token) await rm(path, { force: true }); };
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          let recovery = false;
          try {
            // Serialize stale-owner recovery, then re-read the current owner.
            await mkdir(gate, { mode: 0o700 }); recovery = true;
            const owner = await readJson(path, null);
            if (!owner || !Number.isInteger(owner.pid) || processAlive(owner.pid)) throw new AgentError('session_locked', `会话 ${id} 正在使用或锁尚未就绪`);
            await rm(path);
          } catch (error) {
            if (error.code === 'EEXIST') throw new AgentError('session_locked', `会话 ${id} 的锁正在恢复，请稍后重试`);
            if (error.code !== 'ENOENT') throw error;
          } finally { if (recovery) await rm(gate, { recursive: true, force: true }); }
        }
      }
    } finally { await rm(temp, { force: true }); }
    throw new AgentError('session_locked', `无法锁定 ${id}`);
  }
  async active(id) {
    const owner = await readJson(join(this.path(id), 'lock'), null);
    return owner ? !Number.isInteger(owner.pid) || processAlive(owner.pid) : false;
  }
  async create({ prompt, cwd, backend, model, config, kind = 'task', parentSessionId, source, readOnly = false }) {
    await this.init();
    const id = randomUUID(), path = this.path(id), now = new Date().toISOString();
    await privateDir(path);
    const meta = { schemaVersion: 1, sessionId: id, machineId: this.machineId, project: await projectRoot(cwd), cwd,
      title: safeText(prompt).slice(0, 120), backend, model, config, kind, status: 'starting', createdAt: now, updatedAt: now,
      pinned: false, archived: false, commands: 0, resume: 'context-only', readOnly,
      ...(parentSessionId ? { parentSessionId } : {}), ...(source ? { source } : {}) };
    await writeJson(join(path, 'meta.json'), meta);
    await atomicWrite(join(path, 'events.jsonl'), '');
    return meta;
  }
  async resolve(id) {
    const rows = await this.list({ all: true, includeClassifier: true, archived: true });
    const matches = rows.filter((m) => m.sessionId.startsWith(id));
    if (!matches.length) throw new AgentError('session_not_found', `会话不存在：${id}`);
    if (matches.length > 1) throw invalid(`短 ID 不唯一：${matches.map((m) => m.sessionId).join(', ')}`);
    return matches[0];
  }
  async list({ cwd = process.cwd(), all = false, includeClassifier = false, backend, status, archived = false } = {}) {
    await this.init(); const root = all ? null : await projectRoot(cwd), rows = [];
    for (const entry of await readdir(this.base, { withFileTypes: true })) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
      try {
        const path = await this.owned(entry.name), meta = await readJson(join(path, 'meta.json'));
        if (meta.schemaVersion !== 1 || meta.sessionId !== entry.name) throw new Error('schema / ID 不匹配');
        if (!all && (meta.project !== root || meta.machineId !== this.machineId) || !includeClassifier && meta.kind === 'classifier' || !archived && meta.archived || backend && meta.backend !== backend) continue;
        if (activeStates.includes(meta.status) && !await this.active(meta.sessionId)) meta.status = 'interrupted';
        if (!status || meta.status === status) rows.push(meta);
      } catch (e) { this.warnings.push(`${entry.name}: ${e.message}`); }
    }
    return rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }
  async read(id) {
    const meta = await this.resolve(id), path = await this.owned(meta.sessionId);
    const content = await readFile(join(path, 'events.jsonl'), 'utf8'), lines = content.split('\n'), events = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        const event = JSON.parse(lines[i]);
        if (event.schemaVersion !== 1 || event.sessionId !== meta.sessionId || event.seq !== events.length + 1) throw new Error('事件序号或 schema 无效');
        events.push(event);
      } catch (e) { if (i === lines.length - 1 && !content.endsWith('\n')) break; throw new AgentError('storage_error', `历史损坏 ${meta.sessionId}:${i + 1}：${e.message}`); }
    }
    const outputs = {};
    for (const event of events) if (event.outputRef) {
      if (!/^outputs\/[\w-]+\.txt$/.test(event.outputRef)) throw new Error('历史输出引用不安全');
      const file = join(path, event.outputRef);
      if ((await lstat(file)).isSymbolicLink()) throw new Error('历史输出不允许符号链接');
      outputs[event.outputRef] = await readFile(file, 'utf8');
    }
    return { schemaVersion: 1, meta, events, outputs };
  }
  async begin(meta, { runId = randomUUID(), prompt, config, resume = false } = {}) {
    const release = await this.lock(meta.sessionId);
    try {
      const existing = await this.read(meta.sessionId), path = this.path(meta.sessionId);
      // An incomplete last write is never replayed. Drop only a torn tail while holding the lock.
      await atomicWrite(join(path, 'events.jsonl'), existing.events.map((e) => JSON.stringify(e) + '\n').join(''));
      const writer = new RunWriter(this, { ...meta, config, status: 'starting', updatedAt: new Date().toISOString() }, runId, existing.events.length, release);
      for (const event of existing.events.filter((e) => e.type === 'execution.started')) {
        if (!existing.events.some((r) => r.executionId === event.executionId && r.type === 'execution.result')) await writer.append('execution.interrupted', { executionId: event.executionId, outcome: 'unknown', originalRunId: event.runId });
      }
      await writer.append('run.started', { prompt: safeText(prompt), config, resume });
      await writer.update(); return writer;
    } catch (e) { await release(); throw e; }
  }
  async update(id, patch) {
    const meta = await this.resolve(id), release = await this.lock(meta.sessionId);
    try { Object.assign(meta, patch); await writeJson(join(this.path(meta.sessionId), 'meta.json'), meta); return meta; }
    finally { await release(); }
  }
  async delete(id) {
    const meta = await this.resolve(id), release = await this.lock(meta.sessionId);
    try { await rm(await this.owned(meta.sessionId), { recursive: true }); }
    finally { await release(); }
    return { sessionId: meta.sessionId, nativeDataRetained: meta.nativeRef ? meta.nativeHome ?? '后端原生会话目录（仅断开引用）' : null };
  }
  async search(query, options) {
    const rows = await this.list(options), found = [];
    for (const meta of rows) {
      const data = await this.read(meta.sessionId), haystack = JSON.stringify(data).toLocaleLowerCase();
      if (haystack.includes(query.toLocaleLowerCase())) found.push(meta);
    }
    return found;
  }
  async gc({ retentionDays = 30, maxTotalMb = 1024, apply = false, now = Date.now() } = {}) {
    const rows = await this.list({ all: true, includeClassifier: true, archived: true }), sized = [];
    const size = async (path) => { let bytes = 0; for (const ent of await readdir(path, { withFileTypes: true })) { const p = join(path, ent.name); if (ent.isFile()) bytes += (await lstat(p)).size; else if (ent.isDirectory()) bytes += await size(p); } return bytes; };
    for (const meta of rows) sized.push({ ...meta, bytes: await size(this.path(meta.sessionId)), active: await this.active(meta.sessionId) });
    let total = sized.reduce((n, m) => n + m.bytes, 0); const candidates = [];
    for (const meta of sized.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      if (meta.active || meta.pinned) continue;
      if (now - Date.parse(meta.updatedAt) > retentionDays * 86400000 || total > maxTotalMb * 1024 * 1024) { candidates.push(meta); total -= meta.bytes; }
    }
    const deleted = [];
    if (apply) for (const meta of candidates) {
      // Recheck pin and activity after obtaining the session lock.
      const release = await this.lock(meta.sessionId);
      try { const current = await readJson(join(this.path(meta.sessionId), 'meta.json')); if (!current.pinned) { await rm(await this.owned(meta.sessionId), { recursive: true }); deleted.push(meta.sessionId); } }
      finally { await release(); }
    }
    return { dryRun: !apply, candidates: candidates.map(({ sessionId, title, bytes }) => ({ sessionId, title, bytes })), deleted };
  }
  async reindex() {
    await this.init();
    let Database;
    if (process.versions.bun) Database = (await import('bun:sqlite')).Database;
    else Database = (await import('node:sqlite')).DatabaseSync;
    const index = join(this.paths.data, 'index.sqlite'), temp = `${index}.${randomUUID()}.tmp`;
    const db = new Database(temp); let succeeded = false;
    try {
      db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, project TEXT, backend TEXT, status TEXT, updated TEXT, content TEXT)');
      const rows = await this.list({ all: true, includeClassifier: true, archived: true });
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM sessions');
        const put = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const m of rows) { const data = await this.read(m.sessionId); put.run(m.sessionId, m.title, m.project, m.backend, m.status, m.updatedAt, JSON.stringify(data)); }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      succeeded = true; return { indexed: rows.length, warnings: this.warnings };
    } finally { db.close(); if (succeeded) { await chmod(temp, 0o600); await rename(temp, index); } else await rm(temp, { force: true }); }
  }
  async import(data, { source } = {}) {
    if (data?.schemaVersion !== 1 || !data.meta || !Array.isArray(data.events) || !data.outputs || data.events.length > 100000) throw invalid('导出格式或 schema 无效');
    if (typeof data.meta.cwd !== 'string' || !isAbsolute(data.meta.cwd) || typeof data.meta.title !== 'string' || typeof data.meta.backend !== 'string') throw invalid('导入元数据无效');
    let seq = 0;
    for (const e of data.events) if (e.schemaVersion !== 1 || e.seq !== ++seq || e.sessionId !== data.meta.sessionId || typeof e.type !== 'string') throw invalid('导入事件格式无效');
    for (const [key, value] of Object.entries(data.outputs)) if (!/^outputs\/[\w-]+\.txt$/.test(key) || typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024 * 1024) throw invalid('导入输出无效');
    for (const event of data.events) {
      if (event.outputRef && (!/^outputs\/[\w-]+\.txt$/.test(event.outputRef) || typeof data.outputs[event.outputRef] !== 'string')) throw invalid('导入输出引用无效');
      if (event.type === 'execution.started' && typeof event.executedCommand !== 'string' || event.type === 'message' && typeof event.text !== 'string') throw invalid('导入执行事实或消息无效');
    }
    await this.init();
    const fingerprint = source ?? `export:${hash(JSON.stringify(data))}`;
    const duplicate = (await this.list({ all: true, includeClassifier: true, archived: true })).find((m) => m.source === fingerprint);
    if (duplicate) return { ...duplicate, duplicate: true };
    // Import can reference an old, absent project; it never starts an agent or a tool.
    const meta = await this.create({ prompt: data.meta.title, cwd: process.cwd(), backend: data.meta.backend, model: data.meta.model, config: data.meta.config, source: fingerprint, readOnly: true });
    meta.cwd = data.meta.cwd; meta.project = data.meta.project ?? data.meta.cwd; meta.status = 'imported'; meta.parentSessionId = data.meta.sessionId;
    const path = this.path(meta.sessionId);
    try {
      for (const [name, content] of Object.entries(data.outputs)) await atomicWrite(join(path, name), safeText(content));
      await atomicWrite(join(path, 'events.jsonl'), data.events.map((e) => JSON.stringify({ ...e, sessionId: meta.sessionId }) + '\n').join(''));
      await writeJson(join(path, 'meta.json'), meta);
    } catch (e) { await rm(path, { recursive: true, force: true }); throw e; }
    return meta;
  }
}
class RunWriter {
  constructor(store, meta, runId, seq, release) { Object.assign(this, { store, meta, runId, seq, release }); this.queue = Promise.resolve(); }
  async update() { await writeJson(join(this.store.path(this.meta.sessionId), 'meta.json'), this.meta); }
  append(type, detail = {}) {
    const work = this.queue.then(async () => {
      const event = { ...detail, schemaVersion: 1, sessionId: this.meta.sessionId, runId: this.runId, seq: this.seq + 1, timestamp: new Date().toISOString(), type };
      const f = await open(join(this.store.path(this.meta.sessionId), 'events.jsonl'), 'a', 0o600);
      try { await f.writeFile(JSON.stringify(event) + '\n'); await f.sync(); this.seq++; } finally { await f.close(); }
      return event;
    });
    this.queue = work; return work;
  }
  async state(status) { this.meta.status = status; await this.append('run.status', { status }); }
  async result(executionId, result, saveOutput = true) {
    let outputRef;
    if (saveOutput) { outputRef = `outputs/${executionId}.txt`; await atomicWrite(join(this.store.path(this.meta.sessionId), outputRef), safeText(result.output)); }
    const { output, ...rest } = result;
    await this.append('execution.result', { executionId, ...rest, ...(outputRef ? { outputRef } : {}) });
    this.meta.commands++; await this.update();
  }
  async context(detail) { await writeJson(join(this.store.path(this.meta.sessionId), `context/${this.runId}.json`), { schemaVersion: 1, runId: this.runId, ...detail }); }
  async finish(status, detail = {}) {
    try {
      this.meta.status = status; this.meta.updatedAt = new Date().toISOString();
      await this.append('run.ended', { status, ...detail }); await this.update();
    } finally { await this.release(); }
  }
}
export function visibleContext(data, { maxBytes = 32768 } = {}) {
  const relevant = data.events.filter((e) => ['run.started', 'message', 'execution.started', 'execution.result', 'question.answered', 'run.ended', 'context.imported'].includes(e.type));
  const chunks = relevant.map((event) => {
    const { config, outputRef, ...visible } = event;
    if (outputRef && data.outputs[outputRef]) { visible.output = data.outputs[outputRef].slice(-4096); visible.contextOutputTruncated = data.outputs[outputRef].length > 4096; }
    return JSON.stringify(visible);
  });
  const chosen = []; let bytes = 0;
  for (const chunk of chunks.reverse()) { const n = Buffer.byteLength(chunk); if (bytes + n > maxBytes) continue; chosen.unshift(chunk); bytes += n; }
  return { text: chosen.join('\n'), included: chosen.length, total: relevant.length, bytes };
}
export function exportMarkdown(data, { full = true } = {}) {
  const lines = [`# ${safeText(data.meta.title)}`, '', `会话：${data.meta.sessionId}`, `后端：${data.meta.backend} · 目录：${data.meta.cwd}`, ''];
  const fence = (text) => { const mark = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${mark}\n${safeText(text)}\n${mark}`; };
  for (const e of data.events) {
    if (e.type === 'run.started') lines.push('## 请求', '', safeText(e.prompt ?? ''), '');
    if (e.type === 'command.requested') lines.push(`### 命令提案 · ${e.cwd ?? data.meta.cwd}`, '', fence(e.proposedCommand ?? ''), '');
    if (e.type === 'command.decided') lines.push(`决策：${e.approved ? '批准' : '拒绝'} · ${e.source ?? 'user'}`, '');
    if (e.type === 'execution.started') lines.push(`### 命令 · ${e.cwd}`, '', fence(e.executedCommand), '');
    if (e.type === 'execution.result') { lines.push(`退出码：${e.exitCode} · 超时：${e.timedOut} · 取消：${e.cancelled}`, ''); if (full && e.outputRef) lines.push(fence(data.outputs[e.outputRef] ?? ''), ''); }
    if (e.type === 'message' && e.final) lines.push('## 结论', '', safeText(e.text), '');
    if (e.type === 'question.answered') lines.push(`问：${safeText(e.question)}\n\n答：${safeText(e.text)}`, '');
    if (e.type === 'run.ended') lines.push(`状态：${e.status}${e.message ? ` · ${safeText(e.message)}` : ''}`, '');
  }
  return lines.join('\n');
}
export function redactExport(data) {
  // Previewable best effort: patterns cannot recognize every possible secret.
  return JSON.parse(JSON.stringify(data).replace(/(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s"\\]+)/gi, '$1[REDACTED]').replaceAll(data.meta.cwd, '[PROJECT]'));
}
