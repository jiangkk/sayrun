import type { CliRenderer, KeyEvent, Renderable } from '@opentui/core';
import type { CommandProposal } from '../contracts/execution.ts';
import type { DisplayResult, TerminalUi, TranscriptRows, UiOptions } from '../contracts/ui.ts';
import { BoxRenderable, TextRenderable, ScrollBoxRenderable, TextareaRenderable, StyledText, createCliRenderer, t, bold, fg } from '@opentui/core';
import { safeText } from './display.ts';
import { hostname } from 'node:os';
import { StepTranscript } from './transcript.ts';

const C = {
  bg: '#12161d', panel: '#191f29', edge: '#344152', text: '#e3e9f2',
  muted: '#90a0b5', accent: '#82c9c1', amber: '#edc77b', red: '#f08c91', green: '#9cd5ac',
};
const frames = ['◐', '◓', '◑', '◒'];
const approvalActions: ('approve' | 'reject' | 'edit')[] = ['approve', 'reject', 'edit'];
const editorKeyBindings: NonNullable<ConstructorParameters<typeof TextareaRenderable>[1]['keyBindings']> = [
  { name: 'return', action: 'submit' },
  { name: 'return', shift: true, action: 'newline' },
  { name: 's', ctrl: true, action: 'submit' },
];

export async function createOpenTui(options: UiOptions) {
  const renderer = await createCliRenderer({
    stdin: options.input, stdout: options.output,
    screenMode: 'split-footer', footerHeight: Math.min(19, Math.max(12, (options.output.rows || 24) - 4)),
    externalOutputMode: 'capture-stdout', consoleMode: 'disabled',
    exitOnCtrlC: false, exitSignals: [], useMouse: true,
    targetFps: 15, maxFps: 30, clearOnShutdown: true, openConsoleOnError: false,
  });
  try { return new OpenTuiUi(renderer, options); }
  catch (error) { renderer.destroy(); await renderer.closed; throw error; }
}

export class OpenTuiUi implements TerminalUi {
  renderer: CliRenderer;
  colors: typeof C;
  approvalConfig: NonNullable<UiOptions['approvalConfig']>;
  outputStream: UiOptions['output'];
  transcript: StepTranscript;
  onCancel: () => void;
  signal?: AbortSignal;
  started: number;
  phase: string;
  frame: number;
  commandCount: number;
  selection: 'approve' | 'reject' | 'edit';
  pending: { resolve: (value: CommandProposal | null) => void; reject: (error: Error) => void } | null;
  inputPending: { resolve: (value: string) => void; reject: (error: Error) => void } | null = null;
  editing: boolean;
  closed: boolean;
  proposal!: CommandProposal;
  draft = '';
  editSubmitted = false;
  root: BoxRenderable;
  badge: TextRenderable;
  taskText: TextRenderable;
  context: TextRenderable;
  caption: TextRenderable;
  card: BoxRenderable;
  scroll: ScrollBoxRenderable;
  commandText: TextRenderable;
  editor: TextareaRenderable;
  actions: BoxRenderable;
  approveButton: TextRenderable;
  rejectButton: TextRenderable;
  editButton: TextRenderable;
  hint: TextRenderable;
  keyListener: (key: KeyEvent) => void;
  abortListener: () => void;
  resizeListener: () => void;
  errorListener: (event: { error: Error }) => void;
  timer?: ReturnType<typeof setInterval>;
  constructor(renderer: CliRenderer, { prompt, cwd, output = process.stdout, onCancel = () => {}, signal, animate = true, uiConfig = {}, approvalConfig = {}, backendName = 'agent' }: Omit<UiOptions, 'input'>) {
    this.renderer = renderer;
    this.colors = uiConfig.color === 'never' || process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb' ? { ...C, accent: '#ffffff', green: '#ffffff', red: '#ffffff', amber: '#ffffff', muted: '#aaaaaa' } : C;
    this.approvalConfig = approvalConfig;
    this.outputStream = output;
    this.transcript = new StepTranscript({ get columns() { return renderer.width; } }, {
      writeRows: (rows) => this.writeStepRows(rows), previewLines: uiConfig.output_preview_lines,
    });
    this.onCancel = onCancel;
    this.signal = signal;
    this.started = Date.now();
    this.phase = `正在连接 ${backendName}`;
    this.frame = 0;
    this.commandCount = 0;
    this.selection = approvalConfig.default_selection ?? 'approve'; // Enter approves the selected command by default.
    this.pending = null;
    this.editing = false;
    this.closed = false;

    const box = (parent: Renderable, options: ConstructorParameters<typeof BoxRenderable>[1]) => {
      const child = new BoxRenderable(renderer, options);
      parent.add(child);
      return child;
    };
    const text = (parent: Renderable, options: ConstructorParameters<typeof TextRenderable>[1]) => {
      const child = new TextRenderable(renderer, { fg: this.colors.text, ...options });
      parent.add(child);
      return child;
    };
    this.root = box(renderer.root, { id: 'agent-panel', width: '100%', height: '100%',
      flexDirection: 'column', backgroundColor: this.colors.bg, paddingLeft: 2, paddingRight: 2, paddingTop: 1 });
    const header = box(this.root, { height: 1, flexShrink: 0, flexDirection: 'row', justifyContent: 'space-between' });
    text(header, { content: t`${bold(fg(this.colors.accent)('◆ SAYRUN'))}  ${fg(this.colors.muted)('自然语言任务')}`, height: 1 });
    this.badge = text(header, { content: '', height: 1 });
    this.taskText = text(this.root, { content: safeText(prompt), height: 2, flexShrink: 0, marginTop: 1, wrapMode: 'word' });
    this.context = text(this.root, { content: `${hostname()} · ${safeText(cwd)}`, height: 1, flexShrink: 0, fg: this.colors.muted });
    this.caption = text(this.root, { content: '正在准备任务，稍后会在这里展示需要审批的命令。', height: 1, marginTop: 1, flexShrink: 0, fg: this.colors.muted });
    this.card = box(this.root, { id: 'command-card', flexGrow: 1, minHeight: 3, border: true,
      borderStyle: 'rounded', borderColor: this.colors.edge, title: ' 任务状态 ', titleColor: this.colors.muted,
      backgroundColor: this.colors.panel, paddingLeft: 1, paddingRight: 1, marginTop: 1 });
    this.scroll = new ScrollBoxRenderable(renderer, { id: 'command-scroll', width: '100%', height: '100%',
      scrollY: true, scrollX: false, contentOptions: { flexDirection: 'column' } });
    this.card.add(this.scroll);
    this.commandText = text(this.scroll, { id: 'command-text', content: '等待 agent 提出下一步操作…',
      width: '100%', flexShrink: 0, wrapMode: 'word', fg: this.colors.muted });
    this.editor = new TextareaRenderable(renderer, { id: 'command-editor', width: '100%', height: '100%',
      visible: false, backgroundColor: this.colors.panel, textColor: this.colors.text,
      focusedBackgroundColor: this.colors.panel, focusedTextColor: this.colors.text,
      keyBindings: editorKeyBindings, onSubmit: () => this.submitEditor() });
    this.card.add(this.editor);
    this.actions = box(this.root, { height: 1, marginTop: 1, flexShrink: 0, flexDirection: 'row', gap: 2 });
    this.approveButton = text(this.actions, { content: '', onMouseDown: () => this.decide(true) });
    this.rejectButton = text(this.actions, { content: '', onMouseDown: () => this.decide(false) });
    this.editButton = text(this.actions, { content: '', onMouseDown: () => this.startEdit() });
    this.hint = text(this.root, { content: '', height: 1, marginTop: 1, flexShrink: 0, fg: this.colors.muted });
    this.keyListener = (key) => this.handleKey(key);
    renderer.keyInput.on('keypress', this.keyListener);
    this.abortListener = () => this.withdraw();
    signal?.addEventListener('abort', this.abortListener, { once: true });
    this.resizeListener = () => {
      if (renderer.screenMode === 'split-footer') renderer.footerHeight = Math.min(19, Math.max(12, renderer.terminalHeight - 4));
      this.paint();
    };
    renderer.on('resize', this.resizeListener);
    this.errorListener = ({ error }) => { this.log(`界面错误：${error.message}`); onCancel(); };
    renderer.on('render:error', this.errorListener);
    this.paint();
    if (animate) this.timer = setInterval(() => { this.frame++; this.paintBadge(); }, 180);
  }

  log(text: string) { this.outputStream.write(safeText(text)); }

  writeStepRows(rows: TranscriptRows) {
    // Captured stdout is plain text in OpenTUI, not an ANSI terminal. Commit
    // native styled cells so escape codes never become visible text or count
    // towards line width. Final answers still use ANSI after renderer teardown.
    this.renderer.writeToScrollback(({ width, renderContext }) => {
      const chunks = rows.flatMap((row, index) => [
        ...row.map(({ text, style }) => style === 'bold' ? bold(safeText(text))
          : style ? fg(this.colors[style])(safeText(text)) : { __isChunk: true as const, text: safeText(text) }),
        ...(index < rows.length - 1 ? [{ __isChunk: true as const, text: '\n' }] : []),
      ]);
      const root = new TextRenderable(renderContext, {
        width, height: rows.length, content: new StyledText(chunks), wrapMode: 'none',
      });
      return { root, width, height: rows.length, startOnNewLine: true, trailingNewline: true };
    });
  }

  paintBadge() {
    if (this.closed) return;
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    const waiting = !!(this.pending || this.inputPending);
    const color = waiting ? this.colors.amber : this.colors.accent;
    this.badge.content = t`${fg(color)(`${waiting ? '●' : frames[this.frame % frames.length]} ${this.phase}`)}  ${fg(this.colors.muted)(`${seconds}s`)}`;
  }

  paint() {
    const compact = this.renderer.height < 18;
    this.root.paddingTop = compact ? 0 : 1;
    this.taskText.height = compact ? 1 : 2;
    this.taskText.marginTop = compact ? 0 : 1;
    this.caption.marginTop = compact ? 0 : 1;
    this.card.marginTop = compact ? 0 : 1;
    this.actions.marginTop = compact ? 0 : 1;
    this.hint.marginTop = compact ? 0 : 1;
    this.paintBadge();
    const pending = !!this.pending;
    const narrow = this.renderer.width < 65;
    const choosing = pending && !this.editing;
    this.approveButton.content = choosing ? (this.selection === 'approve' ? ' › ' : '   ') + '批准执行 [y] ' : '';
    this.approveButton.bg = choosing && this.selection === 'approve' ? this.colors.green : this.colors.bg;
    this.approveButton.fg = choosing && this.selection === 'approve' ? this.colors.bg : this.colors.muted;
    this.rejectButton.content = choosing ? (this.selection === 'reject' ? ' › ' : '   ') + '拒绝 [n] ' : '';
    this.rejectButton.bg = choosing && this.selection === 'reject' ? this.colors.red : this.colors.bg;
    this.rejectButton.fg = choosing && this.selection === 'reject' ? this.colors.bg : this.colors.muted;
    this.editButton.content = choosing ? (this.selection === 'edit' ? ' › ' : '   ') + (narrow ? '编辑 [e] ' : '编辑命令 [e] ') : '';
    this.editButton.bg = choosing && this.selection === 'edit' ? this.colors.green : this.colors.bg;
    this.editButton.fg = choosing && this.selection === 'edit' ? this.colors.bg : this.colors.muted;
    this.hint.content = this.inputPending ? 'Enter 发送回答 · Shift-Enter 换行 · Ctrl-C 取消任务'
      : this.editing ? `Enter ${this.approvalConfig.editor_enter === 'save' ? '保存命令' : '执行命令'} · Shift-Enter 换行 · Esc 放弃编辑`
      : pending ? (narrow ? '← → 选择 · Enter 确认 · ↑ ↓ 滚动' : '← → / Tab 选择 · Enter 确认 · ↑ ↓ / PgUp PgDn 滚动 · Ctrl-C 取消')
      : '命令输出保留在上方历史中 · Ctrl-C 取消任务';
  }

  status(text: string) {
    if (this.closed || this.pending || this.inputPending) return;
    this.phase = safeText(text);
    this.caption.content = 'agent 正在分析任务与执行结果，下一条命令仍需你的审批。';
    this.card.title = ' 任务状态 ';
    this.card.borderColor = this.colors.edge;
    this.commandText.content = '正在准备下一步…';
    this.commandText.fg = this.colors.muted;
    this.paint();
  }

  message(text: string) { this.caption.content = safeText(text); }

  requestInput({ question }: { question: string }): Promise<string> {
    if (this.signal?.aborted || this.closed) return Promise.reject(new Error('任务已取消'));
    if (this.pending || this.inputPending) return Promise.reject(new Error('已有待处理交互'));
    this.phase = '等待补充';
    if (question) this.log(`\n◇ ${question}\n`);
    this.caption.content = safeText(question);
    this.card.title = ' 回答问题 ';
    this.card.borderColor = this.colors.accent;
    this.scroll.visible = false;
    this.editor.visible = true;
    this.editor.keyBindings = editorKeyBindings;
    this.editor.placeholder = '输入你的回答…';
    this.editor.setText('');
    const promise = new Promise<string>((resolve, reject) => { this.inputPending = { resolve, reject }; });
    this.editor.focus();
    this.paint();
    return promise;
  }

  submitEditor() {
    if (!this.inputPending) { this.saveEdit({ execute: this.approvalConfig.editor_enter !== 'save' }); return; }
    const value = this.editor.plainText.trim();
    if (!value) {
      this.caption.content = '请输入回答，或按 Ctrl-C 取消当前任务。';
      return;
    }
    if (value.length > 8192 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
      this.caption.content = '内容过长或包含控制字符，请调整后发送。';
      return;
    }
    this.completeInput(value);
  }

  completeInput(value: string) {
    if (!this.inputPending) return;
    const pending = this.inputPending;
    this.inputPending = null;
    this.editor.blur();
    this.editor.visible = false;
    this.scroll.visible = true;
    this.editor.placeholder = null;
    this.log(`\n› ${value}\n`);
    this.status('正在处理补充信息');
    pending.resolve(value);
  }

  approve(proposal: CommandProposal, count: number, max: number): Promise<CommandProposal | null> {
    if (this.signal?.aborted || this.closed) return Promise.reject(new Error('任务已取消'));
    if (this.pending || this.inputPending) return Promise.reject(new Error('已有待审批交互'));
    this.proposal = proposal;
    this.draft = proposal.command; this.editSubmitted = false;
    this.commandCount = count;
    this.selection = this.approvalConfig.default_selection ?? 'approve';
    this.phase = '等待审批';
    this.context.content = `${hostname()} · ${safeText(proposal.cwd)}`;
    this.caption.content = `${count}/${max}  ${safeText(proposal.description)}`;
    this.card.title = ' 命令预览 · zsh -f · 可滚动 ';
    this.card.borderColor = this.colors.amber;
    this.commandText.content = this.previewText(proposal.command);
    this.commandText.fg = this.colors.text;
    this.scroll.scrollTo(0);
    const promise = new Promise<CommandProposal | null>((resolve, reject) => { this.pending = { resolve, reject }; });
    this.paint();
    return promise;
  }

  decide(approved: boolean) {
    if (!this.pending || this.editing || this.signal?.aborted) return;
    const pending = this.pending;
    this.pending = null;
    if (approved) {
      const proposal = Object.freeze({ ...this.proposal, command: this.draft, decisionSource: this.editSubmitted ? 'edit-enter' : this.draft !== this.proposal.command ? 'edited-approve' : 'approve' });
      this.phase = '正在执行';
      this.transcript.start(proposal, this.commandCount);
      this.card.borderColor = this.colors.accent;
      this.caption.content = '已批准本条命令。执行结束后，agent 将检查结果。';
      this.card.title = ' 正在执行 ';
      pending.resolve(proposal);
    } else {
      this.phase = '已拒绝';
      this.log('\n已拒绝，命令未执行。\n');
      pending.resolve(null);
    }
    this.paint();
  }

  startEdit() {
    if (!this.pending || this.editing) return;
    this.editing = true;
    this.scroll.visible = false;
    this.editor.visible = true;
    this.editor.keyBindings = editorKeyBindings;
    this.editor.setText(this.draft);
    this.editor.focus();
    this.phase = '编辑命令';
    this.caption.content = this.approvalConfig.editor_enter === 'save' ? '修改完成后按 Enter 保存并返回审批，Shift-Enter 换行。' : '修改完成后按 Enter 直接执行此命令，Shift-Enter 换行。';
    this.card.title = this.approvalConfig.editor_enter === 'save' ? ' 编辑命令 · Enter 保存 ' : ' 编辑命令 · Enter 执行 ';
    this.paint();
  }

  saveEdit({ execute = false } = {}) {
    if (!this.editing) return;
    const text = this.editor.plainText;
    if (!text.trim() || text.length > 32768 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
      this.caption.content = '命令为空、过长或包含控制字符，请修改后再提交。';
      return;
    }
    this.draft = text;
    this.endEdit();
    if (execute) { this.editSubmitted = true; this.decide(true); }
    else this.caption.content = '命令已保存。请选择批准执行，或继续编辑。';
  }

  endEdit() {
    this.editing = false;
    this.editor.blur();
    this.editor.visible = false;
    this.scroll.visible = true;
    this.commandText.content = this.previewText(this.draft);
    this.scroll.scrollTo(0);
    this.selection = this.approvalConfig.default_selection ?? 'approve';
    this.phase = '等待审批';
    this.card.title = ' 命令预览 · zsh -f · 可滚动 ';
    this.paint();
  }

  previewText(command: string) { return safeText(`目录：${this.proposal.cwd}\n执行器：${this.proposal.targetId ?? 'local-zsh'} · ${this.proposal.shell ?? 'zsh'} -f\n\n${command}`); }

  handleKey(key: KeyEvent) {
    if (key.repeated || this.closed) return;
    if (key.ctrl && key.name === 'c') { key.preventDefault(); this.onCancel(); return; }
    if (this.inputPending) {
      if (key.name === 'escape') {
        key.preventDefault();
        this.onCancel();
      }
      return;
    }
    if (this.editing) {
      if (key.name === 'escape') { key.preventDefault(); this.endEdit(); }
      else if (key.ctrl && key.name === 's') { key.preventDefault(); this.saveEdit(); }
      return;
    }
    if (key.name === 'escape' || key.name === 'q') { key.preventDefault(); this.onCancel(); return; }
    if (!this.pending) return;
    if (key.name === 'y') { key.preventDefault(); this.decide(true); }
    else if (key.name === 'n') { key.preventDefault(); this.decide(false); }
    else if (['tab', 'left', 'right'].includes(key.name)) {
      key.preventDefault();
      const direction = key.name === 'left' || key.name === 'tab' && key.shift ? -1 : 1;
      this.selection = approvalActions[(approvalActions.indexOf(this.selection) + direction + approvalActions.length) % approvalActions.length];
      this.paint();
    }
    else if (key.name === 'return') {
      key.preventDefault();
      if (this.selection === 'edit') this.startEdit();
      else this.decide(this.selection === 'approve');
    }
    else if (key.name === 'e') { key.preventDefault(); this.startEdit(); }
    else if (['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name)) {
      key.preventDefault();
      if (key.name === 'home') this.scroll.scrollTo(0);
      else if (key.name === 'end') this.scroll.scrollTo(this.scroll.scrollHeight);
      else this.scroll.scrollBy((['up', 'pageup'].includes(key.name) ? -1 : 1) * (key.name.startsWith('page') ? 5 : 1));
    }
  }

  output(text: string) {
    this.transcript.append(text);
    this.commandText.content = safeText(`${this.draft}\n\n${this.transcript.buffer.slice(-4000)}`);
    this.scroll.scrollTo(this.scroll.scrollHeight);
  }
  result(result: DisplayResult) {
    this.transcript.complete(result);
    this.status(result.exitCode === 0 ? '正在检查结果' : '正在分析执行问题');
  }
  finish(text: string) { this.log(`\n◆ ${text} · ${this.commandCount} 条命令 · ${Math.floor((Date.now() - this.started) / 1000)}s\n`); }
  withdraw() {
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(new Error('任务已取消')); }
    if (this.inputPending) { const p = this.inputPending; this.inputPending = null; p.reject(new Error('任务已取消')); }
  }
  async close() {
    if (this.closed) return;
    this.withdraw();
    this.closed = true;
    clearInterval(this.timer);
    this.signal?.removeEventListener('abort', this.abortListener);
    this.renderer.keyInput.off('keypress', this.keyListener);
    this.renderer.off('resize', this.resizeListener);
    this.renderer.off('render:error', this.errorListener);
    await this.renderer.idle();
    this.renderer.destroy();
    await this.renderer.closed;
  }
}
