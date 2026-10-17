import type { CommandProposal } from '../contracts/execution.ts';
import type { DisplayResult, StyleName, TerminalOutput, TranscriptRows } from '../contracts/ui.ts';
import { marked } from 'marked';
import stringWidth from 'string-width';
import { safeText } from './display.ts';

const colors = { accent: 36, muted: 90, text: 37, green: 32, amber: 33, red: 31 };
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

// Only application-owned SGR sequences are emitted. Model and command content
// is sanitized before Markdown parsing, including links and code blocks.
export function terminalStyle({ output = process.stdout, color }: { output?: TerminalGeometry; color?: boolean } = {}): (name: StyleName, value: string) => string {
  const enabled = color ?? (!!output.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb');
  return (name, value) => enabled ? `\x1b[${name === 'bold' ? 1 : colors[name]}m${value}\x1b[${name === 'bold' ? 22 : 39}m` : String(value);
}

export function terminalWidth(output: TerminalGeometry = process.stdout) {
  return Math.max(12, Math.min(120, (output.columns || 80) - 1));
}

// ANSI-aware wrapping counts terminal cells, rather than UTF-16 characters.
// Keep words/URLs intact where possible; split long tokens by grapheme.
export function wrapTerminal(text: string, width: number) {
  const lines = [];
  let line = '', used = 0, softWrap = false;
  for (const part of text.split(/(\x1b\[[0-9;]*m|\n)/)) {
    if (!part) continue;
    if (part === '\n') { lines.push(line.trimEnd()); line = ''; used = 0; softWrap = false; continue; }
    if (part.startsWith('\x1b[')) { line += part; continue; }
    for (const { segment } of words.segment(part.replaceAll('\t', '    '))) {
      const size = stringWidth(segment);
      if (used && used + size > width && segment.trim()) { lines.push(line.trimEnd()); line = ''; used = 0; softWrap = true; }
      if (!used && !segment.trim() && softWrap) continue;
      for (const { segment: char } of graphemes.segment(segment)) {
        const cells = stringWidth(char);
        if (used + cells > width) { lines.push(line.trimEnd()); line = ''; used = 0; softWrap = true; }
        if (!used && !char.trim() && softWrap) continue;
        line += char; used += cells; softWrap = false;
      }
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

export function renderMarkdown(text: string, { width = 76, style = (_, value) => value }: { width?: number; style?: (name: StyleName, value: string) => string } = {}) {
  const inline = (tokens: MarkdownToken[] = []): string => tokens.map((token) => {
    const value = () => token.tokens ? inline(token.tokens ?? []) : token.text ?? '';
    switch (token.type) {
      case 'strong': return style('bold', value());
      case 'em': return style('accent', value());
      case 'del': return value();
      case 'codespan': return style('amber', token.text ?? '');
      case 'link': {
        const label = value();
        return style('accent', label === token.href ? label : `${label} (${token.href})`);
      }
      case 'image': return `[${token.text || '图片'}] (${token.href})`;
      case 'br': return '\n';
      default: return value();
    }
  }).join('');
  const blocks = (tokens: MarkdownToken[], available: number): string[] => tokens.flatMap((token) => {
    const wrapped = (text: string) => wrapTerminal(text, available);
    switch (token.type) {
      case 'space': case 'def': return [];
      case 'heading': return [...wrapped(style('bold', style('accent', inline(token.tokens ?? [])))), ''];
      case 'paragraph': case 'text': return [...wrapped(inline(token.tokens ?? [token])), ''];
      case 'code': return [
        ...(token.lang ? [style('muted', `  ${token.lang}`)] : []),
        ...wrapTerminal(token.text ?? '', Math.max(4, available - 2)).map((line) => `${style('muted', '│')} ${style('amber', line)}`), '',
      ];
      case 'blockquote': {
        const body = blocks(token.tokens ?? [], Math.max(4, available - 2));
        while (body.at(-1) === '') body.pop();
        return [...body.map((line) => `${style('accent', '│')} ${line}`), ''];
      }
      case 'list': return [...token.items!.flatMap((item, index) => {
        const prefix = token.ordered ? `${Number(token.start) + index}. ` : '• ';
        const check = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
        const body = blocks(item.tokens, Math.max(4, available - stringWidth(prefix) - stringWidth(check)));
        while (body.at(-1) === '') body.pop();
        return body.filter((line) => token.loose || line !== '').map((line, i) => `${i === 0 ? style('accent', prefix) + check : ' '.repeat(stringWidth(prefix) + stringWidth(check))}${line}`);
      }), ''];
      case 'table': return [...token.rows!.flatMap((row) => [
        ...row.flatMap((cell, index) => wrapped(`${style('bold', inline(token.header![index].tokens))}：${inline(cell.tokens)}`)), '',
      ])];
      case 'hr': return [style('muted', '─'.repeat(Math.min(available, 40))), ''];
      default: return [...wrapped(token.text ?? token.raw ?? ''), ''];
    }
  });
  const lines = blocks(marked.lexer(safeText(text)), width);
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

export function formatConclusion(text: string, { output = process.stdout, color, commands = 0, elapsed = 0, incomplete = false }: { output?: TerminalGeometry; color?: boolean; commands?: number; elapsed?: number; incomplete?: boolean } = {}) {
  const style = terminalStyle({ output, color });
  const width = terminalWidth(output);
  const meta = `${commands} 条命令 · ${Math.floor(elapsed / 1000)}s`;
  const title = `\n${style('bold', style('accent', '◆ 任务结论'))}  ${style('muted', meta)}\n${style('muted', '─'.repeat(width))}\n\n`;
  const body = renderMarkdown(text || '任务已完成。', { width: width - 2, style }).split('\n').map((line) => `  ${line}`).join('\n');
  const notice = incomplete ? `\n\n  ${style('amber', '⚠ 模型达到输出上限，以上回答可能不完整。')}` : '';
  return `${title}${body}${notice}\n\n`;
}

type TerminalGeometry = Partial<Pick<NodeJS.WriteStream, 'isTTY' | 'columns'>>;
// Markdown extension tokens share optional fields with marked's built-ins.
interface MarkdownToken {
  type: string; raw?: string; text?: string; tokens?: MarkdownToken[];
  href?: string; lang?: string; ordered?: boolean; start?: number | string; loose?: boolean;
  items?: { tokens: MarkdownToken[]; task?: boolean; checked?: boolean }[];
  rows?: { tokens: MarkdownToken[] }[][]; header?: { tokens: MarkdownToken[] }[];
}
export class StepTranscript {
  output: TerminalGeometry & { write?: TerminalOutput['write'] };
  style: ReturnType<typeof terminalStyle>;
  previewLines: number;
  writeRows?: (rows: TranscriptRows) => void;
  buffer: string;
  constructor(output: TerminalGeometry & { write?: TerminalOutput['write'] } = process.stdout, { writeRows, previewLines = 12, color }: { writeRows?: (rows: TranscriptRows) => void; previewLines?: number; color?: boolean } = {}) {
    this.output = output;
    this.style = terminalStyle({ output, color });
    this.previewLines = previewLines;
    this.writeRows = writeRows;
    this.buffer = '';
  }
  emit(rows: TranscriptRows) {
    if (this.writeRows) return this.writeRows(rows);
    this.output.write?.(rows.map((row) => row.map(({ text, style }) => style ? this.style(style, text) : text).join('')).join('\n') + '\n');
  }
  start(proposal: CommandProposal, count: number) {
    this.buffer = '';
    const prefix = `${String(count).padStart(2, '0')}  $ `;
    const lines = wrapTerminal(safeText(proposal.command), terminalWidth(this.output) - prefix.length);
    this.emit([[], ...lines.map((line, index) => [
      { text: index ? ' '.repeat(prefix.length) : prefix, style: 'accent' as const },
      { text: line, style: 'bold' as const },
    ])]);
  }
  append(text: string) { this.buffer = (this.buffer + safeText(text)).slice(0, 65536); }
  complete(result: DisplayResult) {
    // Wrap before choosing an excerpt, so one very long line cannot flood the
    // scrollback. This affects display only; the agent gets the original output.
    const output = safeText(result.output ?? this.buffer).trimEnd();
    const lines = wrapTerminal(output, terminalWidth(this.output) - 4);
    const count = this.previewLines, tail = Math.min(4, Math.floor(count / 3)), head = count - tail;
    const visible = lines.length > count ? [...lines.slice(0, head), `… 省略 ${lines.length - count} 行（仅精简显示）`, ...(tail ? lines.slice(-tail) : [])] : lines;
    const body: TranscriptRows = visible.map((line) => [
      { text: '  │ ', style: 'muted' as const },
      { text: output.trim() ? line : '（无输出）', style: output.trim() ? undefined : 'muted' },
    ]);
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const state = ok ? '✓ 完成' : `✗ ${result.timedOut ? '超时' : result.cancelled ? '已取消' : `退出码：${result.exitCode ?? result.signal}`}`;
    this.emit([...body, [
      { text: `  ${state}`, style: ok ? 'green' : 'red' },
      ...(result.truncated ? [{ text: ` · 输出达到 ${result.maxOutputBytes === undefined ? '64 KiB' : result.maxOutputBytes % 1024 === 0 ? `${result.maxOutputBytes / 1024} KiB` : `${result.maxOutputBytes} bytes`} 上限`, style: 'amber' as const }] : []),
    ]]);
    this.buffer = '';
  }
}
