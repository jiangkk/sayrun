import test from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import { formatConclusion, renderMarkdown, StepTranscript } from '../src/terminal/transcript.ts';
import { safeText } from '../src/terminal/display.ts';

test('final answers render Markdown with emphasis and preserve all content at narrow widths', () => {
  const text = '**该域名暂时无法解析。**\n\n### 关键证据\n- 本地 DNS 返回 `NXDOMAIN`。\n- 公共 DNS 没有返回 A 记录。\n\n```sh\nnslookup oneui-view-bridge.uat.ennew.com\n```\n\n' + '完整结论'.repeat(1200) + 'END_OF_ANSWER';
  const result = formatConclusion(text, { output: { columns: 44 }, color: true, commands: 2, elapsed: 12000 });
  assert.match(result, /\x1b\[1m该域名/);
  assert.match(result, /\x1b\[33mNXDOMAIN/);
  const plain = safeText(result);
  assert.ok(!plain.includes('**') && !plain.includes('```') && !plain.includes('###'));
  assert.ok(plain.replaceAll(/\s/g, '').includes('完整结论'.repeat(1200) + 'END_OF_ANSWER'));
  for (const line of plain.split('\n')) assert.ok(stringWidth(line) <= 43, line);
});

test('untrusted Markdown, links and command output cannot emit terminal control sequences', () => {
  const malicious = '\x1b[2J**可见** [链接](https://example.com/\x1b]52;c;secret\x07)\n\n```\n\x1b[?1000h代码\n```';
  const result = formatConclusion(malicious, { color: true });
  assert.equal(result.replaceAll(/\x1b\[[0-9;]*m/g, '').includes('\x1b'), false);
  assert.match(safeText(result), /可见/);
  assert.ok(!formatConclusion('**没有颜色**', { color: false }).includes('\x1b'));
});

test('nested lists, quotes, links and tables remain readable without raw Markdown', () => {
  const result = renderMarkdown('> 注意\n\n1. 第一项\n   - 子项\n2. [文档](https://example.com)\n\n| 项目 | 结果 |\n| --- | --- |\n| DNS | 无记录 |');
  assert.match(result, /│ 注意/);
  assert.match(result, /1\. 第一项\n   • 子项/);
  assert.match(result, /2\. 文档 \(https:\/\/example.com\)/);
  assert.match(result, /项目：DNS\n结果：无记录/);
  assert.match(renderMarkdown('```python\nif True:\n    print("keep indent")\n```'), /│     print\("keep indent"\)/);
});

test('step transcript shows commands and bounded output with failures; original output stays intact', () => {
  let text = '';
  const transcript = new StepTranscript({ columns: 48, write(value) { text += value; } });
  transcript.start({ command: 'dig +short example.com A', cwd: '/tmp', description: 'verbose description' }, 1);
  const original = Array.from({ length: 40 }, (_, i) => `result-${i}`).join('\n');
  const result = { output: original, exitCode: 7 };
  transcript.complete(result);
  assert.match(text, /01  \$ dig/);
  assert.match(text, /省略 28 行/);
  assert.match(text, /result-0\n/);
  assert.match(text, /result-39\n/);
  assert.match(text, /✗ 退出码：7/);
  assert.ok(!text.includes('/tmp') && !text.includes('verbose description'));
  assert.equal(result.output, original);
});

test('an output limit is visible and a successful command does not imply a verified conclusion', () => {
  const result = formatConclusion('**部分结果**', { color: false, incomplete: true });
  assert.match(result, /以上回答可能不完整/);
  assert.match(result, /任务结论/);
  assert.ok(!result.includes('任务成功'));
});

test('blank lines remain blank; no-output label only appears for an empty result', () => {
  let text = '';
  const transcript = new StepTranscript({ write(value) { text += value; } });
  transcript.complete({ output: 'line one\n\nline two\n', exitCode: 0 });
  assert.match(text, /│ line one\n  │ \n  │ line two/);
  assert.ok(!text.includes('无输出'));
  text = '';
  transcript.complete({ output: '', exitCode: 0 });
  assert.equal(text.match(/无输出/g).length, 1);
});
