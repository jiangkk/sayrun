import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SessionStore } from './sessions.mjs';
import { privateDir, atomicWrite } from './storage.mjs';
import { safeText } from './display.mjs';
import { invalid } from './errors.mjs';

const text = (blocks = []) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
export function convertDsh(content) {
  const rows = content.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s));
  const header = rows[0];
  if (header?.type !== 'session' || header.version !== 4 || typeof header.id !== 'string' || !isAbsolute(header.cwd)) throw invalid('只支持已验证的 DSH session v4 格式');
  const outputs = {}, events = [], calls = new Map(); let runId = randomUUID(), model, prompt = header.id;
  const add = (type, detail, time) => events.push({ ...detail, schemaVersion: 1, sessionId: header.id, runId, seq: events.length + 1, timestamp: new Date(time ?? header.createdAt ?? Date.now()).toISOString(), type });
  for (const row of rows.slice(1)) {
    const d = row.data ?? {};
    if (row.type === 'turn/start') runId = randomUUID();
    if (row.type === 'user/message') {
      const message = safeText(text(d.content));
      if (prompt === header.id) prompt = message.replace(/^Task directory:.*\nUser request: /s, '').slice(0, 120);
      add('run.started', { prompt: message }, row.time);
    }
    if (row.type === 'request/header') model ??= d.header?.config?.model;
    if (row.type === 'assistant/message') {
      const content = d.message?.content ?? [];
      if (!content.some((b) => b.type === 'tool-call')) add('message', { text: safeText(text(content)), final: true }, row.time);
    }
    if (row.type === 'tool/call' && ['terminal_command', 'terminal_question'].includes(d.name)) {
      const args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments;
      calls.set(d.callId, { name: d.name, args, time: row.time });
      add(d.name === 'terminal_command' ? 'command.requested' : 'question.requested', { requestId: d.callId, ...(d.name === 'terminal_command' ? { proposedCommand: args.command, cwd: args.cwd ?? header.cwd, targetId: 'local-zsh' } : { question: args.question }) }, row.time);
    }
    if (row.type === 'tool/result') {
      const callId = d.message?.toolCallId, call = calls.get(callId); if (!call) continue;
      let result; try { result = JSON.parse(text(d.message?.content)); } catch { continue; }
      if (call.name === 'terminal_question' && typeof result.answer === 'string') add('question.answered', { question: call.args.question, text: result.answer, commandApproval: false }, row.time);
      if (call.name === 'terminal_command') {
        if (result.approved === true && result.executed === true && typeof result.command === 'string') {
          const executionId = randomUUID(), outputRef = `outputs/${executionId}.txt`;
          add('execution.started', { requestId: callId, executionId, proposedCommand: call.args.command, executedCommand: result.command, cwd: result.cwd ?? header.cwd, targetId: 'local-zsh', decisionSource: 'legacy-record' }, call.time);
          outputs[outputRef] = safeText((result.output ?? '').slice(0, 65536));
          const { output, ...facts } = result;
          add('execution.result', { ...facts, executionId, outputRef }, row.time);
        } else add('command.decided', { requestId: callId, approved: false, source: 'legacy-record' }, row.time);
      }
    }
    if (row.type === 'turn/end') add('run.ended', { status: d.reason?.kind === 'completed' ? 'completed' : 'interrupted' }, row.time);
  }
  return { schemaVersion: 1, meta: { sessionId: header.id, title: prompt, cwd: header.cwd, project: header.cwd, backend: 'dsh', model, nativeRef: header.id }, events, outputs };
}
export async function migrate(path, { apply = false } = {}) {
  if (!isAbsolute(path)) throw invalid('--from 必须是绝对路径');
  path = await realpath(path); const root = join(path, 'sessions'), entries = [], skipped = [], store = new SessionStore();
  const walk = async (dir) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, ent.name);
      if (ent.isDirectory()) await walk(file);
      else if (ent.isFile() && /^session.*\.jsonl$/.test(ent.name)) {
        try { if ((await stat(file)).size > 64 * 1024 * 1024) throw new Error('记录超过 64 MiB，保留原文件'); const content = await readFile(file, 'utf8'), data = convertDsh(content); entries.push({ file, content, data, source: `${file}:${createHash('sha256').update(content).digest('hex')}` }); }
        catch (e) { skipped.push({ file, reason: e.message }); }
      }
    }
  };
  await walk(root);
  const imported = [];
  if (apply) {
    await store.init();
    const backup = join(store.paths.data, 'migration-backups', new Date().toISOString().replaceAll(':', '-')); await privateDir(backup);
    for (const entry of entries) {
      // Back up the exact source bytes before conversion; the legacy tree stays untouched.
      const name = createHash('sha256').update(entry.source).digest('hex');
      await atomicWrite(join(backup, `${name}.jsonl`), entry.content);
      const meta = await store.import(entry.data, { source: entry.source });
      await store.update(meta.sessionId, { nativeRef: entry.data.meta.nativeRef, nativeHome: path, nativeManaged: false, resume: 'context-only', kind: entry.data.meta.nativeRef.startsWith('classify-') ? 'classifier' : 'task', commands: entry.data.events.filter((e) => e.type === 'execution.result').length });
      imported.push({ sessionId: meta.sessionId, duplicate: !!meta.duplicate, source: entry.file });
    }
  }
  return { dryRun: !apply, source: path, candidates: entries.map((e) => ({ file: e.file, title: e.data.meta.title, events: e.data.events.length })), skipped, imported, note: '旧目录未删除；原生恢复未验证，导入记录仅供查看或显式上下文分支' };
}
