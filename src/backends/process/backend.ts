import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentBackend, BackendProbe, BackendSession, ClassifyOptions, ConnectOptions, HostReply, Route, RunInput } from '../../contracts/backend.ts';
import type { BackendSettings } from '../../contracts/config.ts';
import type { PendingReply, WireObject } from '../../contracts/wire.ts';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { EventQueue } from '../protocol.ts';
import { redactDiagnostics } from '../../terminal/display.ts';
import { AgentError, invalid } from '../../errors.ts';

export async function readManifest(path: string): Promise<Manifest> {
  if (!isAbsolute(path)) throw invalid('manifest 必须是绝对路径');
  let value; try { value = JSON.parse(await readFile(path, 'utf8')); } catch (e) { throw invalid(`manifest 无法读取：${e.message}`); }
  if (!value || value.apiVersion !== 1 || typeof value.executable !== 'string' || !isAbsolute(value.executable) || !Array.isArray(value.args ?? []) || !(value.args ?? []).every((s: unknown) => typeof s === 'string') || !Array.isArray(value.env ?? []) || !(value.env ?? []).every((s: unknown) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) throw invalid('适配器 manifest 无效（apiVersion / executable / args / env）');
  return value;
}
// Local process plugins are explicitly registered executable code. Their runtime
// hello result, rather than manifest claims, determines admission.
interface Manifest { apiVersion: 1; executable: string; args?: string[]; env?: string[] }
export class ProcessBackend implements AgentBackend {
  id: string;
  config: BackendSettings;
  apiVersion = 1 as const;
  constructor(id: string, config: BackendSettings) { this.id = id; this.config = config; }
  async spawn() {
    const manifest = await readManifest(this.config.manifest!);
    const child = spawn(manifest.executable, manifest.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      env: Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', ...(manifest.env ?? [])].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) });
    return new PluginSession(child);
  }
  async probe(): Promise<BackendProbe> {
    let peer;
    try { peer = await this.spawn(); const value = await peer.request('hello', { apiVersion: 1 }); if (value.apiVersion !== 1 || !value.capabilities) throw new Error('协议版本或能力无效'); return { available: true, version: value.version, capabilities: value.capabilities, diagnostics: value.diagnostics ?? [] }; }
    catch (e) { return { available: false, capabilities: {}, diagnostics: [e.message] }; }
    finally { await peer?.close(); }
  }
  async classify(input: string, options: ClassifyOptions): Promise<Route> {
    const peer = await this.spawn();
    try { const hello = await peer.request('hello', { apiVersion: 1 }); if (!hello.capabilities?.classify) return 'ask'; const result = await peer.request('classify', { input, cwd: options.cwd, tools: [] }); return ['agent', 'shell'].includes(result.route) && result.confidence >= options.threshold && result.confidence <= 1 ? result.route : 'ask'; } finally { await peer.close(); }
  }
  async connect(options: ConnectOptions) {
    const peer = await this.spawn(), abort = () => { peer.close().catch(() => {}); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      const hello = await peer.request('hello', { apiVersion: 1 });
      const { admitBackend } = await import('../protocol.ts');
      if (hello.apiVersion !== 1) throw new Error('不兼容的插件协议');
      admitBackend({ available: true, ...hello, capabilities: hello.capabilities, diagnostics: hello.diagnostics ?? [] }, options);
      const { signal, ...wireOptions } = options;
      const result = await peer.request('connect', wireOptions); peer.nativeRef = result?.nativeRef; return peer;
    } catch (e) { await peer.close(); throw e; }
    finally { options.signal?.removeEventListener('abort', abort); }
  }
}
class PluginSession implements BackendSession {
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, PendingReply<WireObject>>;
  counter: number;
  events: EventQueue;
  stderr: string;
  lines: ReturnType<typeof createInterface>;
  failure?: Error;
  closed = false;
  nativeRef?: string;
  signal?: AbortSignal;
  abort = () => {};
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child; this.pending = new Map(); this.counter = 0; this.events = new EventQueue(); this.stderr = '';
    this.lines = createInterface({ input: child.stdout });
    child.stderr.on('data', (s) => { this.stderr = (this.stderr + s).slice(-4096); });
    const fail = (e: Error) => { this.events.end(e); this.failure = e; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); };
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
  request(method: string, params: object): Promise<WireObject> {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error('适配器已关闭'));
    const id = ++this.counter;
    return new Promise<WireObject>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 握手超时`)); }, 10000); this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  }
  run({ runId, prompt, signal }: RunInput) { this.signal = signal; this.abort = () => this.interrupt(); signal.addEventListener('abort', this.abort, { once: true }); this.request('run', { runId, prompt }).catch((e) => this.events.end(e)); return this.events; }
  async reply(value: HostReply): Promise<void> { await this.request('reply', value); }
  async interrupt() { this.events.end(); await this.close(); }
  async close() {
    if (this.closed) return; this.closed = true;
    this.signal?.removeEventListener('abort', this.abort);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('适配器已关闭')); } this.pending.clear();
    this.lines.close();
    try { process.kill(-this.child.pid!, 'SIGTERM'); } catch {}
    if (this.child.exitCode === null && this.child.signalCode === null) await new Promise<void>((resolve) => { const timer = setTimeout(() => { try { process.kill(-this.child.pid!, 'SIGKILL'); } catch {} resolve(); }, 1000); this.child.once('close', () => { clearTimeout(timer); resolve(); }); });
  }
}
