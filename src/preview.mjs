import { createTerminalUi } from './ui.mjs';
import { formatConclusion } from './transcript.mjs';

// A reviewable UI demo. No model request or shell command is executed.
export async function preview() {
  const controller = new AbortController();
  const onCancel = () => controller.abort();
  process.on('SIGINT', onCancel);
  process.on('SIGTERM', onCancel);
  const ui = await createTerminalUi({
    prompt: '找出当前目录最大的十个文件，只读取文件信息', cwd: process.cwd(),
    input: process.stdin, output: process.stdout, onCancel, signal: controller.signal,
  });
  let conclusion = '';
  try {
    ui.message('这是交互预览。你可以滚动命令、编辑内容，再选择批准或拒绝；预览不会执行命令。');
    const approved = await ui.approve(Object.freeze({
      command: "find . -type f -not -path './.git/*' -not -path './node_modules/*' \\\n  -exec stat -f '%z %N' {} + | sort -rn | head -n 10",
      description: '按实际字节大小列出最大的十个文件（只读）', cwd: process.cwd(),
    }), 1, 8);
    if (approved) {
      const output = '21870452  ./assets/demo.mov\n 8931041  ./data/sample.json\n 1248096  ./logs/example.log\n';
      ui.output(output);
      ui.result({ output, exitCode: 0 });
      conclusion = '**最大的文件是 assets/demo.mov，约 20.9 MiB。**\n\n### 示例结果\n- `assets/demo.mov`：20.9 MiB\n- `data/sample.json`：8.5 MiB\n- `logs/example.log`：1.2 MiB\n\n以上为模拟数据；本次预览没有调用模型，也没有执行命令。';
    } else ui.finish('预览结束：已拒绝，未执行命令');
  } catch (e) {
    if (!controller.signal.aborted) throw e;
    ui.finish('预览已取消');
  } finally {
    await ui.close();
    process.removeListener('SIGINT', onCancel);
    process.removeListener('SIGTERM', onCancel);
  }
  if (conclusion) process.stdout.write(formatConclusion(conclusion, { commands: 1 }));
}
