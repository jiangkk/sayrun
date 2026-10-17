import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { EventQueue } from '../backend.mjs';
import { redactDiagnostics } from '../display.mjs';
import { AgentError, invalid } from '../errors.mjs';

export async function readManifest(path) {
  if (!isAbsolute(path)) throw invalid('manifest 必须是绝对路径');
  let value; try { value = JSON.parse(await readFile(path, 'utf8')); } catch (e) { throw invalid(`manifest 无法读取：${e.message}`); }
  if (!value || value.apiVersion !== 1 || typeof value.executable !== 'string' || !isAbsolute(value.executable) || !Array.isArray(value.args ?? []) || !(value.args ?? []).every((s) => typeof s === 'string') || !Array.isArray(value.env ?? []) || !(value.env ?? []).every((s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) throw invalid('适配器 manifest 无效（apiVersion / executable / args / env）');
  return value;
}
// Local process plugins are explicitly registered executable code. Their runtime
// hello result, rather than manifest claims, determines admission.
export class ProcessBackend {
  apiVersion = 1;
  constructor(id, config) { this.id = id; this.config = config; }
  async spawn() {
    const manifest = await readManifest(this.config.manifest);
    const child = spawn(manifest.executable, manifest.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', ...(manifest.env ?? [])].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) });
    return new PluginSession(child);
  }
  async probe() {
    let peer;
    try { peer = await this.spawn(); const value = await peer.request('hello', { apiVersion: 1 }); if (value.apiVersion !== 1 || !value.capabilities) throw new Error('协议版本或能力无效'); return { available: true, version: value.version, capabilities: value.capabilities, diagnostics: value.diagnostics ?? [] }; }
    catch (e) { return { available: false, capabilities: {}, diagnostics: [e.message] }; }
    finally { await peer?.close(); }
  }
  async classify(input, options) {
    const peer = await this.spawn();
    try { const hello = await peer.request('hello', { apiVersion: 1 }); if (!hello.capabilities?.classify) return 'ask'; const result = await peer.request('classify', { input, cwd: options.cwd, tools: [] }); return ['agent', 'shell'].includes(result.route) && result.confidence >= options.threshold && result.confidence <= 1 ? result.route : 'ask'; } finally { await peer.close(); }
  }
  async connect(options) {
    const peer = await this.spawn(), abort = () => { peer.close().catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const hello = await peer.request('hello', { apiVersion: 1 });
      const { admitBackend } = await import('../backend.mjs');
      if (hello.apiVersion !== 1) throw new Error('不兼容的插件协议');
      admitBackend({ available: true, ...hello, diagnostics: hello.diagnostics ?? [] }, options);
      const { signal, ...wireOptions } = options;
      const result = await peer.request('connect', wireOptions); peer.nativeRef = result?.nativeRef; return peer;
    } catch (e) { await peer.close(); throw e; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
}
class PluginSession {
  constructor(child) {
    this.child = child; this.pending = new Map(); this.counter = 0; this.events = new EventQueue(); this.stderr = '';
    this.lines = createInterface({ input: child.stdout });
    child.stderr.on('data', (s) => { this.stderr = (this.stderr + s).slice(-4096); });
    const fail = (e) => { this.events.end(e); this.failure = e; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); };
    child.on('error', fail); child.stdin.on('error', fail); child.on('close', () => { if (!this.closed) fail(new AgentError('protocol_error', `适配器退出：${redactDiagnostics(this.stderr)}`)); });
    this.lines.on('line', (line) => {
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('插件消息过长');
        const m = JSON.parse(line);
        if (m.method === 'event') { this.events.push(m.params); if (m.params.type === 'run.ended') this.events.end(); return; }
        const p = this.pending.get(m.id); if (!p) throw new Error('插件返回未知消息');
        this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } catch (e) { fail(e); }
    });
  }
  request(method, params) {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error('适配器已关闭'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 握手超时`)); }, 10000); this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  }
  run({ runId, prompt, signal }) { this.signal = signal; this.abort = () => this.interrupt(); signal.addEventListener('abort', this.abort, { once: true }); this.request('run', { runId, prompt }).catch((e) => this.events.end(e)); return this.events; }
  reply(value) { return this.request('reply', value); }
  async interrupt() { this.events.end(); await this.close(); }
  async close() {
    if (this.closed) return; this.closed = true;
    this.signal?.removeEventListener('abort', this.abort);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('适配器已关闭')); } this.pending.clear();
    this.lines.close();
    try { process.kill(-this.child.pid, 'SIGTERM'); } catch {}
    if (this.child.exitCode === null && this.child.signalCode === null) await new Promise((resolve) => { const timer = setTimeout(() => { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} resolve(); }, 1000); this.child.once('close', () => { clearTimeout(timer); resolve(); }); });
  }
}
