import { randomUUID } from 'node:crypto';
import { AgentError } from './errors.mjs';

export const backendApiVersion = 1;
export const requiredCapabilities = ['hostTools', 'commandEditing', 'userQuestions'];
export function admitBackend(probe, { ephemeral = false } = {}) {
  if (!probe.available) throw new AgentError('backend_missing', probe.diagnostics.join('\n') || '后端不可用', 5);
  const missing = requiredCapabilities.filter((key) => probe.capabilities[key] !== true);
  if (missing.length) throw new AgentError('capability_missing', `后端不能进入 host-tools 模式：${missing.join(', ')}\n${probe.diagnostics.join('\n')}`, 5);
  if (ephemeral && !probe.capabilities.ephemeral) throw new AgentError('capability_missing', '此后端不能关闭原生持久化，不支持 --ephemeral', 5);
  if (!['native', 'process'].includes(probe.capabilities.cancellation)) throw new AgentError('capability_missing', '后端缺少取消能力', 5);
}
export class EventQueue {
  constructor() { this.items = []; this.waiters = []; this.ended = false; }
  push(value) { if (this.ended) return; const waiter = this.waiters.shift(); if (waiter) waiter.resolve({ value, done: false }); else this.items.push(value); }
  end(error) { if (this.ended) return; this.ended = true; this.error = error; for (const waiter of this.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ done: true }); }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve({ done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator]() { return this; }
}
export function backendEvent(runId, event) { return { ...event, id: randomUUID(), runId, timestamp: new Date().toISOString() }; }
export const hostToolDefinitions = [
  { name: 'terminal_command', description: 'Propose a non-interactive zsh command. Only the host may execute it after human approval. Each call starts a fresh shell.', inputSchema: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' }, description: { type: 'string' }, cwd: { type: 'string' } }, required: ['command', 'description'] } },
  { name: 'terminal_question', description: 'Ask for required information. An answer is text and never command approval.', inputSchema: { type: 'object', additionalProperties: false, properties: { question: { type: 'string' } }, required: ['question'] } },
];
