import { test, expect } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { OpenTuiUi } from '../src/terminal/ui-opentui.ts';

const proposal = Object.freeze({ command: 'printf ORIGINAL', description: '展示原始命令', cwd: '/tmp' });

async function setup(width = 90, height = 19) {
  const s = await createTestRenderer({ width, height, screenMode: 'split-footer', footerHeight: height,
    externalOutputMode: 'capture-stdout', kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [] });
  const controller = new AbortController();
  const transcript: string[] = [];
  const ui = new OpenTuiUi(s.renderer, { prompt: '找出当前目录最大的十个文件，只读取文件信息', cwd: '/tmp',
    output: { write(text: string) { transcript.push(text); } }, signal: controller.signal,
    onCancel: () => controller.abort(), animate: false });
  return { ...s, ui, controller, transcript };
}

test('Enter approves by default; switching selection can still reject', async () => {
  const s = await setup();
  try {
    const first = s.ui.approve(proposal, 1, 8);
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('› 批准执行 [y]');
    s.mockInput.pressEnter();
    expect(await first).toMatchObject(proposal);
    const second = s.ui.approve(proposal, 2, 8);
    s.mockInput.pressTab();
    s.mockInput.pressEnter();
    expect(await second).toBeNull();
    expect(s.externalOutput.takeText()).toContain('printf ORIGINAL');
  } finally { await s.ui.close(); }
});

test('Enter in the editor approves the exact edited command; Shift-Enter only inserts a newline', async () => {
  const s = await setup();
  try {
    let settled = false;
    const approval = s.ui.approve(proposal, 1, 8).then((value) => { settled = true; return value; });
    s.mockInput.pressArrow('right');
    s.mockInput.pressArrow('right');
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('› 编辑命令 [e]');
    s.mockInput.pressEnter();
    expect(s.ui.editing).toBe(true);
    expect(s.ui.editor.plainText).toBe(proposal.command);
    await s.mockInput.pasteBracketedText('printf EDITED; ');
    s.mockInput.pressEnter({ shift: true });
    expect(s.ui.editing).toBe(true);
    expect(s.ui.editor.plainText).toContain('\n');
    expect(settled).toBe(false);
    const editedCommand = s.ui.editor.plainText;
    s.mockInput.pressEnter();
    const exact = await approval;
    expect(settled).toBe(true);
    expect(s.ui.pending).toBeNull();
    expect(exact.command).toBe(editedCommand);
    expect(exact.command).toContain('printf EDITED; ');
    expect(exact.command).toContain('printf ORIGINAL');
    expect(Object.isFrozen(exact)).toBe(true);
    const again = s.ui.approve(proposal, 2, 8);
    s.mockInput.pressKey('e');
    s.mockInput.pressKey('s', { ctrl: true });
    expect(s.ui.editing).toBe(false);
    expect(s.ui.pending).not.toBeNull(); // Ctrl-S retains the save-only shortcut.
    s.mockInput.pressEnter();
    expect(await again).toMatchObject(proposal);
  } finally { await s.ui.close(); }
});

test('Tab and Shift-Tab include editing; Escape discards changes and returns to approval', async () => {
  const s = await setup();
  try {
    const approval = s.ui.approve(proposal, 1, 8);
    s.mockInput.pressTab();
    s.mockInput.pressTab();
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('› 编辑命令 [e]');
    s.mockInput.pressTab();
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('› 批准执行 [y]');
    s.mockInput.pressTab({ shift: true });
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('› 编辑命令 [e]');
    s.mockInput.pressEnter();
    expect(s.ui.editing).toBe(true);
    await s.mockInput.pasteBracketedText('DISCARD_THIS');
    s.mockInput.pressEscape();
    await s.renderOnce();
    expect(s.ui.editing).toBe(false);
    expect(s.ui.draft).toBe(proposal.command);
    expect(s.ui.pending).not.toBeNull();
    s.mockInput.pressArrow('left');
    s.mockInput.pressEnter();
    expect(s.ui.editing).toBe(true);
    s.mockInput.pressEnter(); // Approves directly from the editor.
    expect(await approval).toMatchObject(proposal);
  } finally { await s.ui.close(); }
});

test('invalid edits cannot execute, and a pasted newline does not submit', async () => {
  const s = await setup();
  try {
    const approval = s.ui.approve(proposal, 1, 8);
    s.mockInput.pressKey('e');
    s.ui.editor.setText('   ');
    s.mockInput.pressEnter();
    expect(s.ui.editing).toBe(true);
    expect(s.ui.pending).not.toBeNull();
    s.ui.editor.setText('');
    await s.mockInput.pasteBracketedText('printf PASTED\n');
    expect(s.ui.editing).toBe(true);
    expect(s.ui.pending).not.toBeNull();
    s.mockInput.pressEnter();
    expect((await approval).command).toBe('printf PASTED\n');
  } finally { await s.ui.close(); }
});

test('Ctrl-C withdraws pending approval without execution; paste does not approve', async () => {
  const s = await setup();
  try {
    const approval = s.ui.approve(proposal, 1, 8);
    approval.catch(() => {});
    await s.mockInput.pasteBracketedText('y\n');
    expect(s.ui.pending).not.toBeNull();
    s.mockInput.pressCtrlC();
    await expect(approval).rejects.toThrow('任务已取消');
    expect(s.transcript.join('')).not.toContain('┌ 执行');
  } finally { await s.ui.close(); }
});

test('narrow layout preserves controls; long commands can be scrolled to the end after resize', async () => {
  const s = await setup(50, 12);
  try {
    const command = Array.from({ length: 50 }, (_, i) => `printf 'line-${i}'`).join('\n') + '\nprintf END_OF_COMMAND';
    const approval = s.ui.approve({ ...proposal, command }, 1, 8);
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('批准执行 [y]');
    expect(s.captureCharFrame()).not.toContain('END_OF_COMMAND');
    s.mockInput.pressKey('END');
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('END_OF_COMMAND');
    s.resize(80, 19);
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('批准执行 [y]');
    s.mockInput.pressKey('n');
    expect(await approval).toBeNull();
  } finally { await s.ui.close(); }
});

test('question answers are text, not approvals, and empty answers keep the question open', async () => {
  const s = await setup(50, 12);
  try {
    const answer = s.ui.requestInput({ question: '需要检查哪个目录？' });
    s.mockInput.pressEnter();
    expect(s.ui.inputPending).not.toBeNull();
    await s.mockInput.typeText('y');
    s.mockInput.pressEnter();
    expect(await answer).toBe('y');
    expect(s.transcript.join('')).not.toContain('┌ 执行');
    const approval = s.ui.approve(proposal, 1, 8);
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('› 批准执行 [y]');
    s.mockInput.pressKey('n');
    expect(await approval).toBeNull();
  } finally { await s.ui.close(); }
});

test('shell-looking answers remain text and Escape cancels an unanswered question', async () => {
  const s = await setup();
  try {
    const answer = s.ui.requestInput({ question: '需要执行什么检查？' });
    await s.mockInput.typeText('pwd');
    s.mockInput.pressEnter();
    expect(await answer).toBe('pwd');
    expect(s.transcript.join('')).not.toContain('┌ 执行');
    const escape = s.ui.requestInput({ question: '还需要什么信息？' });
    escape.catch(() => {});
    s.mockInput.pressEscape();
    await s.renderOnce();
    await expect(escape).rejects.toThrow('任务已取消');
  } finally { await s.ui.close(); }
});

test('intermediate narration stays out of history; command output is compact and styled', async () => {
  const s = await setup();
  try {
    s.ui.message('INTERNAL_PLAN');
    const approval = s.ui.approve(proposal, 1, 8);
    s.mockInput.pressEnter();
    await approval;
    s.ui.output('result\n');
    s.ui.result({ exitCode: 0, output: 'result\n' });
    const history = s.externalOutput.takeText();
    expect(history).not.toContain('INTERNAL_PLAN');
    expect(history).not.toContain('展示原始命令');
    expect(history).toContain('01  $ printf ORIGINAL');
    expect(history).toContain('│ result');
    expect(history).toContain('✓ 完成');
  } finally { await s.ui.close(); }
});

test('native scrollback contains styled text without literal ANSI codes or double wrapping', async () => {
  const s = await setup(90, 19);
  try {
    const command = 'dig @223.5.5.5 oneui-view-bridge.uat.ennew.com A +noall +comments +answer;\necho "---exit:$?"';
    const approval = s.ui.approve({ ...proposal, command }, 1, 8);
    s.mockInput.pressEnter();
    await approval;
    const output = 'Server: 192.168.43.1\n\nstatus: NXDOMAIN\n\n---exit:0\n';
    s.ui.output(output);
    s.ui.result({ exitCode: 0, output });
    await s.renderOnce();
    const commits = s.externalOutput.take();
    const history = commits.map((commit) => commit.text).join('\n');
    expect(history).toContain('01  $ dig @223.5.5.5');
    expect(history).toContain('│ status: NXDOMAIN');
    expect(history).not.toMatch(/\x1b|\[(?:36|39|1|22|90|32)m/);
    expect(history).not.toContain('无输出');
    expect(commits[0].height).toBe(3); // One blank row and two actual command lines.
    expect(commits[1].height).toBe(6); // Five output rows plus the status.
    const empty = s.ui.approve(proposal, 2, 8);
    s.mockInput.pressEnter();
    await empty;
    s.ui.result({ exitCode: 0, output: '' });
    expect(s.externalOutput.takeText().match(/无输出/g)?.length).toBe(1);
  } finally { await s.ui.close(); }
});

// Management commands share an OpenTUI footer, with reports committed to native
// scrollback so they remain visible after returning to the parent shell.
const { OpenTuiCommands } = await import('../src/terminal/command-opentui.ts');
const { reportRows } = await import('../src/cli/presentation.ts');
const stringWidth = (await import('string-width')).default;

async function commands(width = 90, height = 24) {
  const s = await createTestRenderer({ width, height, screenMode: 'split-footer', footerHeight: 3,
    externalOutputMode: 'capture-stdout', kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [] });
  return { ...s, ui: new OpenTuiCommands(s.renderer) };
}

test('setup confirmation defaults to cancel, requires an explicit choice, and ignores pasted approvals', async () => {
  const s = await commands();
  try {
    const cancel = s.ui.confirm('应用以上配置？');
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('› 返回 shell [n]');
    s.mockInput.pressEnter();
    expect(await cancel).toBe(false);
    let settled = false;
    const apply = s.ui.confirm('应用以上配置？').then((value) => { settled = true; return value; });
    await s.mockInput.pasteBracketedText('y\n');
    expect(settled).toBe(false);
    s.mockInput.pressArrow('left');
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('› 确认应用 [y]');
    s.mockInput.pressEnter();
    expect(await apply).toBe(true);
    const escape = s.ui.confirm('应用以上配置？');
    s.mockInput.pressEscape();
    expect(await escape).toBe(false);
    const interrupt = s.ui.confirm('应用以上配置？');
    s.mockInput.pressCtrlC();
    expect(await interrupt).toBe(false);
  } finally { await s.ui.close(); }
});

test('command inputs accept text and paste, return empty input, and release focus between prompts', async () => {
  const s = await commands();
  try {
    const answer = s.ui.input('请输入任务');
    await s.mockInput.pasteBracketedText('帮我检查目录');
    s.mockInput.pressEnter();
    expect(await answer).toBe('帮我检查目录');
    const empty = s.ui.input('继续请求');
    s.mockInput.pressEnter();
    expect(await empty).toBe('');
    const cancel = s.ui.input('继续请求');
    s.mockInput.pressCtrlC();
    expect(await cancel).toBeNull();
    const confirm = s.ui.confirm('应用以上配置？');
    s.mockInput.pressKey('y');
    expect(await confirm).toBe(true);
  } finally { await s.ui.close(); }
});

test('history selector supports arrows, scroll, resize, and cancellation', async () => {
  const s = await commands(50, 12);
  try {
    const choices = Array.from({ length: 30 }, (_, i) => ({ name: `任务 ${i}`, description: 'dsh · 已完成', value: String(i) }));
    const selected = s.ui.select('选择历史任务', choices);
    for (let i = 0; i < 29; i++) s.mockInput.pressArrow('down');
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('任务 29');
    s.resize(80, 24);
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('任务 29');
    s.mockInput.pressEnter();
    expect(await selected).toBe('29');
    const cancel = s.ui.select('选择历史任务', choices);
    s.mockInput.pressEscape();
    expect(await cancel).toBeNull();
  } finally { await s.ui.close(); }
});

test('branded reports survive shutdown, sanitize controls, and fit CJK and long paths in narrow terminals', async () => {
  const s = await commands();
  try {
    s.ui.report({ title: '安装预览', logo: true, lines: [{ text: '配置  /tmp/路径\x1b[2J' + '/long'.repeat(30) }] });
    await s.renderOnce();
    const history = s.externalOutput.takeText();
    expect(history).toContain('███████');
    expect(history).toContain('◆ SAYRUN  /  安装预览');
    expect(history).not.toContain('\x1b');
    const narrow = reportRows({ title: '安装预览', logo: true, lines: [{ text: '配置  /tmp/目录' + '/long'.repeat(30) }] }, 40);
    expect(narrow.some((line) => line.text.includes('████'))).toBe(false);
    expect(narrow.every((line) => stringWidth(line.text) <= 40)).toBe(true);
    s.ui.report({ title: '最后结果', lines: [{ text: '退出后仍保留此信息' }] });
    await s.ui.close();
    expect(s.externalOutput.takeText()).toContain('退出后仍保留此信息');
  } finally { await s.ui.close(); }
});
