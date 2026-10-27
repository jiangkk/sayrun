import type { ApprovalMode } from '../contracts/config.ts';
import { invalid } from '../errors.ts';

export const approvalModes = [
  { value: 'ask', name: '一律询问', description: '每条命令执行前都审批（默认）' },
  { value: 'normal', name: '普通授权', description: '非 sudo 命令自动执行，包含 sudo 的命令仍需审批' },
  { value: 'full', name: '完全授权', description: '进入任务时验证 sudo，之后所有命令自动执行' },
] as const;

export function approvalMode(value: string): ApprovalMode {
  if (value === 'ask' || value === 'normal' || value === 'full') return value;
  throw invalid('授权模式必须为 ask / normal / full');
}

// This is a conservative text check, not a shell interpreter or privilege
// boundary. Include quoted/escaped spellings and sudo inside nested commands.
export function mentionsSudo(command: string) {
  return /(?:^|[^\w])sudo(?:$|[^\w-])/.test(command.replace(/\\\n/g, '').replace(/[\\'"]/g, ''));
}

export function needsApproval(mode: ApprovalMode, command: string) {
  return mode !== 'full' && (mode !== 'normal' || mentionsSudo(command));
}
