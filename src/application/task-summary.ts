import type { ExecutionResult } from '../contracts/execution.ts';
import { safeText } from '../terminal/display.ts';

export type ExecutionFact = { command: string; description: string; result: ExecutionResult };

// This fallback reports observed facts only; it cannot infer a root cause or
// treat a successful exit code as proof that the user's task was completed.
export function taskSummary({ facts, blocked, modelText = '', interrupted = false }: {
  facts: ExecutionFact[]; blocked?: string; modelText?: string; interrupted?: boolean;
}) {
  const lead = '**本次任务尚未完成确认，先汇总当前情况。**';
  if (modelText.trim() && !interrupted) return `${lead}\n\n${safeText(modelText)}`;
  const quote = (text: string) => safeText(text).slice(-1200).split('\n').map((line) => `> ${line}`).join('\n');
  const status = ({ result }: ExecutionFact) => result.timedOut ? '执行超时' : result.cancelled ? '执行已中断'
    : result.signal ? `被信号 ${result.signal} 终止` : `退出码 ${result.exitCode ?? '未知'}`;
  const recent = facts.slice(-3);
  const latest = recent.at(-1);
  const failed = facts.findLast((fact) => fact.result.exitCode !== 0 || fact.result.timedOut || fact.result.cancelled);
  const done = recent.length ? `已执行 ${facts.length} 条命令，最近的检查 / 操作：\n\n${recent.map((fact) => `- ${safeText(fact.description)}（${status(fact)}）\n\n${quote(fact.command)}`).join('\n\n')}`
    : '尚未执行命令，当前没有可用于确认任务完成的执行结果。';
  const blocker = [
    failed ? `最近一次未成功的操作（${status(failed)}）：\n\n${quote(failed.command)}\n\n${quote(failed.result.output || '未返回输出，尚不能确定失败原因。')}`
      : `${latest?.result.output ? `最近一次检查返回：\n\n${quote(latest.result.output)}\n\n` : ''}已有结果尚不足以确认任务完成，具体原因仍需进一步核实。`,
    blocked ? `继续处理还需要以下动作，本次未执行或未获得回答：\n\n${quote(blocked)}` : '',
    interrupted ? '后端未能完成收尾说明，以上按实际执行记录整理。' : '',
  ].filter(Boolean).join('\n\n');
  const partial = modelText.trim() ? `\n\n**后端已有说明（可能不完整）**\n\n${safeText(modelText)}` : '';
  return `${lead}${partial}\n\n**已做的事**\n\n${done}\n\n**当前卡点**\n\n${blocker}\n\n**下一步**\n\n请先核实上述未解决的问题或补充所需信息，再继续处理；后续命令按当前授权模式处理。`;
}
