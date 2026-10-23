import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PendingReply, WireObject } from '../../contracts/wire.ts';
import { createInterface } from 'node:readline';
import { AgentError } from '../../errors.ts';

export class LineRpc {
  onFailure: (error: Error) => void;
  child: ChildProcessWithoutNullStreams;
  nextId: number;
  pending: Map<number, PendingReply<WireObject>>;
  lines: ReturnType<typeof createInterface>;
  failure?: Error;
  constructor(child: ChildProcessWithoutNullStreams, onNotification: (method: string, params: WireObject) => void, onFailure: (error: Error) => void = () => {}) {
    this.onFailure = onFailure;
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => {
      if (this.failure) return;
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error('DSH stdout 包含非 JSON-RPC 数据')); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail(new Error('DSH 消息不是 JSON-RPC 对象'));
      // Stream callbacks run outside the task's try/catch. Route malformed
      // messages and adapter failures through the same connection failure path.
      try {
        if (message.method !== undefined) {
          if (typeof message.method !== 'string' || !message.method) throw new Error('无效 method');
          const params = message.params === undefined ? {} : message.params;
          if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params 必须是对象');
          if (message.id !== undefined) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n');
          } else onNotification(message.method, params);
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (message.error && typeof message.error.message !== 'string') throw new Error('无效 error.message');
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } catch (error) {
        this.fail(new AgentError('protocol_error', `DSH 消息处理失败：${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.on('error', (e) => this.fail(e));
    child.on('close', (code, signal) => this.fail(new Error(`DSH 已退出 (${signal ?? code})`)));
    child.stdin.on('error', (e) => this.fail(e));
  }

  request(method: string, params: object, timeoutMs = 60000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<WireObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  fail(error: Error) {
    const first = !this.failure; this.failure ??= error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (first) this.onFailure(error);
  }

  close() { this.lines.close(); this.fail(new Error('连接已关闭')); }
}
