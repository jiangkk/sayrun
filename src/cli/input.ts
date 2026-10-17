import { createInterface } from 'node:readline';
import { AgentError } from '../errors.ts';
import { write } from '../terminal/display.ts';

export function readAnswer(question = 'sayrun> ') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AgentError('tty_required', '交互需要终端，请直接运行 sayrun；查看帮助请使用 --help');
  return new Promise<string | null>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout }); let settled = false;
    const finish = (value: string | null) => { if (settled) return; settled = true; rl.close(); process.stdin.pause(); resolve(value); };
    rl.on('SIGINT', () => { write('\n'); finish(null); }); rl.on('close', () => finish(null));
    rl.question(question, (answer) => finish(answer.trim()));
  });
}
export async function readTask() {
  write('请输入任务；Ctrl-C / Ctrl-D 退出。每次任务使用独立会话。\n');
  for (;;) { const answer = await readAnswer(); if (answer === null || answer) return answer; }
}
