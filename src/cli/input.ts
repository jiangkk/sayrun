import { createInterface } from 'node:readline';
import { AgentError } from '../errors.ts';
import { write } from '../terminal/display.ts';
import { presentation, report } from './presentation.ts';

export function readAnswer(question = 'sayrun> ') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AgentError('tty_required', '交互需要终端，请直接运行 sayrun；查看帮助请使用 --help');
  if (presentation()) return presentation()!.input(question);
  return new Promise<string | null>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout }); let settled = false;
    const finish = (value: string | null) => { if (settled) return; settled = true; rl.close(); process.stdin.pause(); resolve(value); };
    rl.on('SIGINT', () => { write('\n'); finish(null); }); rl.on('close', () => finish(null));
    rl.question(question, (answer) => finish(answer.trim()));
  });
}
export async function readTask() {
  report('开始一个任务', [{ text: '用自然语言描述你想做的事。命令按配置的授权模式执行，默认逐条确认。' }, { text: '例如：找出当前目录最大的十个文件', tone: 'muted' }, { text: 'Ctrl-C / Ctrl-D 退出 · 每次任务使用独立会话', tone: 'muted' }]);
  for (;;) { const answer = await readAnswer(); if (answer === null || answer) return answer; }
}
