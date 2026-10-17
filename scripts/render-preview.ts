import { writeFile, mkdir } from 'node:fs/promises';
import { createTestRenderer } from '@opentui/core/testing';
import stringWidth from 'string-width';
import { OpenTuiUi } from '../src/terminal/ui-opentui.ts';

// Capture the actual UI renderer with demonstration data, without a model or shell.
process.env.TERM = 'xterm-256color';
delete process.env.NO_COLOR;
const screen = await createTestRenderer({
  width: 100, height: 19, screenMode: 'split-footer', footerHeight: 19,
  externalOutputMode: 'capture-stdout', exitOnCtrlC: false, exitSignals: [],
});
const ui = new OpenTuiUi(screen.renderer, {
  prompt: '找出当前目录最大的十个文件，只读取文件信息', cwd: '/workspace/demo',
  output: process.stdout, onCancel: () => {}, animate: false,
});
try {
  const approval = ui.approve(Object.freeze({
    command: 'find . -type f -exec du -k {} + | sort -rn | head -n 10',
    description: '按磁盘占用列出最大的十个文件（只读）', cwd: '/workspace/demo',
  }), 1, 8);
  ui.context.content = '演示主机 · /workspace/demo';
  await screen.renderOnce();
  const frame = screen.captureSpans();
  const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const color = (rgba: { toInts(): [number, number, number, number] }) => '#' + rgba.toInts().slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('');
  const cellWidth = 10, cellHeight = 25, inset = 24, top = 64;
  const width = frame.cols * cellWidth + inset * 2, height = frame.rows * cellHeight + top + inset;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    '<title id="title">Sayrun 命令审批预览</title>',
    '<desc id="desc">实际 OpenTUI 渲染画面，使用演示数据，展示命令预览、批准、拒绝和编辑操作。未调用模型或执行命令。</desc>',
    `<rect width="${width}" height="${height}" rx="14" fill="#12161d"/>`,
    `<path d="M14 0H${width - 14}Q${width} 0 ${width} 14V44H0V14Q0 0 14 0" fill="#202733"/>`,
    '<circle cx="24" cy="22" r="5" fill="#f08c91"/><circle cx="42" cy="22" r="5" fill="#edc77b"/><circle cx="60" cy="22" r="5" fill="#9cd5ac"/>',
    `<text x="${width / 2}" y="28" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#90a0b5">sayrun · 离线交互预览</text>`,
    '<g font-family="Menlo,Consolas,monospace,\'PingFang SC\',\'Microsoft YaHei\'" font-size="17" xml:space="preserve">',
  ];
  const graphemes = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
  for (const [row, line] of frame.lines.entries()) {
    let column = 0;
    for (const span of line.spans) {
      const x = inset + column * cellWidth, y = top + row * cellHeight;
      parts.push(`<rect x="${x}" y="${y}" width="${span.width * cellWidth}" height="${cellHeight}" fill="${color(span.bg)}"/>`);
      let offset = 0;
      for (const { segment } of graphemes.segment(span.text)) {
        const cells = stringWidth(segment);
        if (segment.trim()) parts.push(`<text x="${x + offset * cellWidth}" y="${y + 19}" fill="${color(span.fg)}"${span.attributes & 1 ? ' font-weight="bold"' : ''}>${escape(segment)}</text>`);
        offset += cells;
      }
      column += span.width;
    }
  }
  parts.push('</g></svg>');
  const directory = new URL('../docs/images/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('approval-preview.svg', directory), parts.join('\n') + '\n');
  screen.mockInput.pressKey('n');
  await approval;
} finally {
  await ui.close();
}
