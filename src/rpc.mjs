import { createInterface } from 'node:readline';

export class LineRpc {
  constructor(child, onNotification, onFailure = () => {}) {
    this.onFailure = onFailure;
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error('DSH stdout 包含非 JSON-RPC 数据')); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail(new Error('DSH 消息不是 JSON-RPC 对象'));
      if (message.method) {
        if (message.id !== undefined) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported request' } }) + '\n');
        } else onNotification(message.method, message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    child.on('error', (e) => this.fail(e));
    child.on('close', (code, signal) => this.fail(new Error(`DSH 已退出 (${signal ?? code})`)));
    child.stdin.on('error', (e) => this.fail(e));
  }

  request(method, params, timeoutMs = 60000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DSH ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  fail(error) {
    const first = !this.failure; this.failure ??= error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    if (first) this.onFailure(error);
  }

  close() { this.lines.close(); this.fail(new Error('连接已关闭')); }
}
