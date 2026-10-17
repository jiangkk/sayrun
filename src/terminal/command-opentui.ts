import { BoxRenderable, InputRenderable, ScrollBoxRenderable, SelectRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from '@opentui/core';
import type { CliRenderer, KeyEvent } from '@opentui/core';
import type { Choice, CommandPresentation, Report } from '../cli/presentation.ts';
import { reportRows } from '../cli/presentation.ts';
import { safeText } from './display.ts';
import { terminalPalette } from './theme.ts';

export async function createCommandPresentation(noColor = false) {
  const renderer = await createCliRenderer({ screenMode: 'split-footer', footerHeight: 3,
    externalOutputMode: 'capture-stdout', consoleMode: 'disabled', openConsoleOnError: false,
    exitOnCtrlC: false, exitSignals: [], useMouse: true, targetFps: 15, clearOnShutdown: true });
  try { return new OpenTuiCommands(renderer, noColor); }
  catch (error) { renderer.destroy(); await renderer.closed; throw error; }
}

export class OpenTuiCommands implements CommandPresentation {
  colors: ReturnType<typeof terminalPalette>;
  root: BoxRenderable;
  caption: TextRenderable;
  body: BoxRenderable;
  hint: TextRenderable;
  private phase = '正在准备';
  private frame = 0;
  private help = '';
  private pendingHeight = 3;
  private timer: ReturnType<typeof setInterval>;
  private cancel?: () => void;
  private closed = false;
  private keyListener: (key: KeyEvent) => void;
  private signalListener = () => { if (this.cancel) this.cancel(); else void this.close().then(() => process.exit(130)); };
  private resizeListener = () => { this.renderer.footerHeight = Math.min(this.pendingHeight, Math.max(3, this.renderer.terminalHeight - 2)); };
  constructor(readonly renderer: CliRenderer, noColor = false) {
    this.colors = terminalPalette(noColor);
    this.root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column',
      backgroundColor: this.colors.bg, paddingLeft: 2, paddingRight: 2 });
    renderer.root.add(this.root);
    this.caption = new TextRenderable(renderer, { content: '', height: 1, flexShrink: 0, fg: this.colors.accent });
    this.body = new BoxRenderable(renderer, { width: '100%', flexGrow: 1, minHeight: 0, flexDirection: 'column' });
    this.hint = new TextRenderable(renderer, { content: '', height: 1, flexShrink: 0, fg: this.colors.muted });
    this.root.add(this.caption); this.root.add(this.body); this.root.add(this.hint);
    this.keyListener = (key) => { if (key.name === 'escape') this.cancel?.();
      else if (key.ctrl && ['c', 'd'].includes(key.name)) this.signalListener(); };
    renderer.keyInput.on('keypress', this.keyListener);
    renderer.on('resize', this.resizeListener);
    process.on('SIGINT', this.signalListener); process.on('SIGTERM', this.signalListener);
    this.timer = setInterval(() => this.paint(), 160);
    this.paint();
  }
  private paint() {
    if (this.closed) return;
    this.caption.content = `${this.cancel ? '◇' : ['◐', '◓', '◑', '◒'][this.frame++ % 4]} ${this.phase}`;
    this.hint.content = this.cancel ? this.help || 'Enter 继续 · Esc / Ctrl-C 返回 shell' : 'Ctrl-C 取消';
  }
  status(text: string) { this.phase = safeText(text); this.paint(); }
  report(content: Report) {
    this.renderer.writeToScrollback(({ width, renderContext }) => {
      const rows = reportRows(content, width);
      const chunks = rows.flatMap((line, index) => [
        ...(line.heading ? [bold(fg(this.colors[line.tone ?? 'text'])(line.text))] : [fg(this.colors[line.tone ?? 'text'])(line.text)]),
        ...(index < rows.length - 1 ? [{ __isChunk: true as const, text: '\n' }] : []),
      ]);
      const root = new TextRenderable(renderContext, { width, height: rows.length, wrapMode: 'none', content: new StyledText(chunks) });
      return { root, width, height: rows.length, startOnNewLine: true, trailingNewline: true };
    });
  }
  private wait<T>(question: string, height: number, fallback: T, build: (finish: (value: T) => void) => () => void): Promise<T> {
    if (this.closed) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: T) => { if (done) return; done = true; cleanup(); this.cancel = undefined; this.help = ''; this.pendingHeight = 3; this.renderer.footerHeight = 3; this.status('准备就绪'); resolve(value); };
      this.pendingHeight = height; this.resizeListener();
      this.status(question);
      const cleanup = build(finish);
      this.cancel = () => finish(fallback);
      this.paint();
    });
  }
  confirm(question: string) {
    return this.wait(question, 6, false, (finish) => {
      const actions = new BoxRenderable(this.renderer, { width: '100%', height: 1, flexDirection: 'row', gap: 2, marginTop: 1 });
      let selected = false;
      const yes = new TextRenderable(this.renderer, { height: 1, content: '', onMouseDown: () => finish(true) });
      const no = new TextRenderable(this.renderer, { height: 1, content: '', onMouseDown: () => finish(false) });
      const paint = () => {
        yes.content = selected ? ' › 确认应用 [y] ' : '   确认应用 [y] ';
        no.content = !selected ? ' › 返回 shell [n] ' : '   返回 shell [n] ';
        yes.bg = selected ? this.colors.accent : this.colors.bg; yes.fg = selected ? this.colors.bg : this.colors.text;
        no.bg = !selected ? this.colors.edge : this.colors.bg; no.fg = this.colors.text;
      };
      const listener = (key: KeyEvent) => {
        if (key.eventType === 'release') return;
        if (['left', 'right', 'tab'].includes(key.name)) { selected = !selected; paint(); }
        else if (key.name === 'return') finish(selected);
        else if (key.name === 'y') finish(true);
        else if (key.name === 'n') finish(false);
      };
      // Bracketed paste is intentionally never handled as confirmation keys.
      actions.add(yes); actions.add(no); this.body.add(actions); paint();
      this.help = '← → / Tab 选择 · Enter 确认 · Esc 取消';
      this.renderer.keyInput.on('keypress', listener);
      return () => { this.renderer.keyInput.off('keypress', listener); actions.destroyRecursively(); };
    });
  }
  input(question: string) {
    return this.wait<string | null>(question, 6, null, (finish) => {
      const input = new InputRenderable(this.renderer, { width: '100%', marginTop: 1, placeholder: '输入内容，Enter 继续',
        backgroundColor: this.colors.panel, textColor: this.colors.text, focusedBackgroundColor: this.colors.panel,
        focusedTextColor: this.colors.text, cursorColor: this.colors.accent });
      input.on('enter', (value: string) => finish(value.trim()));
      this.body.add(input); input.focus();
      this.help = 'Enter 继续 · Esc / Ctrl-C 返回 shell';
      return () => input.destroyRecursively();
    });
  }
  select(question: string, choices: Choice[]) {
    return this.wait<string | null>(question, Math.min(16, choices.length * 2 + 4), null, (finish) => {
      const scroll = new ScrollBoxRenderable(this.renderer, { width: '100%', height: '100%', scrollX: false, scrollY: true });
      const select = new SelectRenderable(this.renderer, { width: '100%', height: '100%',
        options: choices.map((choice) => ({ ...choice, name: safeText(choice.name), description: safeText(choice.description) })),
        backgroundColor: this.colors.bg, textColor: this.colors.text, focusedBackgroundColor: this.colors.bg,
        focusedTextColor: this.colors.text, selectedBackgroundColor: this.colors.edge, selectedTextColor: this.colors.accent,
        descriptionColor: this.colors.muted, selectedDescriptionColor: this.colors.text, showScrollIndicator: true,
      });
      select.on('itemSelected', (_index: number, choice: Choice) => finish(choice.value));
      scroll.add(select); this.body.add(scroll); select.focus();
      this.help = '↑ ↓ 浏览 · Enter 查看 · Esc 返回 shell';
      return () => scroll.destroyRecursively();
    });
  }
  async external<T>(action: () => T): Promise<T> {
    await this.renderer.suspend();
    try { return action(); }
    finally { await this.renderer.resume(); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.cancel?.(); clearInterval(this.timer);
    process.off('SIGINT', this.signalListener); process.off('SIGTERM', this.signalListener);
    this.renderer.keyInput.off('keypress', this.keyListener);
    this.renderer.off('resize', this.resizeListener);
    this.renderer.destroy(); await this.renderer.closed;
  }
}
