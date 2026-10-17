import type { SessionData } from '../contracts/history.ts';
import { safeText } from '../terminal/display.ts';

export function exportMarkdown(data: SessionData, { full = true } = {}) {
  const lines = [`# ${safeText(data.meta.title)}`, '', `会话：${data.meta.sessionId}`, `后端：${data.meta.backend} · 目录：${data.meta.cwd}`, ''];
  const fence = (text: string) => { const mark = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${mark}\n${safeText(text)}\n${mark}`; };
  for (const e of data.events) {
    if (e.type === 'run.started') lines.push('## 请求', '', safeText(e.prompt ?? ''), '');
    if (e.type === 'command.requested') lines.push(`### 命令提案 · ${e.cwd ?? data.meta.cwd}`, '', fence(e.proposedCommand ?? ''), '');
    if (e.type === 'command.decided') lines.push(`决策：${e.approved ? '批准' : '拒绝'} · ${e.source ?? 'user'}`, '');
    if (e.type === 'execution.started') lines.push(`### 命令 · ${e.cwd}`, '', fence(e.executedCommand ?? ''), '');
    if (e.type === 'execution.result') { lines.push(`退出码：${e.exitCode} · 超时：${e.timedOut} · 取消：${e.cancelled}`, ''); if (full && e.outputRef) lines.push(fence(data.outputs[e.outputRef] ?? ''), ''); }
    if (e.type === 'message' && e.final) lines.push('## 结论', '', safeText(e.text), '');
    if (e.type === 'question.answered') lines.push(`问：${safeText(e.question)}\n\n答：${safeText(e.text)}`, '');
    if (e.type === 'run.ended') lines.push(`状态：${e.status}${e.message ? ` · ${safeText(e.message)}` : ''}`, '');
  }
  return lines.join('\n');
}
export function redactExport(data: SessionData): SessionData {
  // Previewable best effort: patterns cannot recognize every possible secret.
  return JSON.parse(JSON.stringify(data).replace(/(?:sk-|sk_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s"\\]+)/gi, '$1[REDACTED]').replaceAll(data.meta.cwd, '[PROJECT]'));
}
