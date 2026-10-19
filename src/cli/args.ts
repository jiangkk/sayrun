import { invalid } from '../errors.ts';

export interface OptionSpec { values?: readonly string[]; flags?: readonly string[] }
export type CliOptions = Partial<
  Record<'zshrc' | 'backend' | 'profile' | 'model' | 'from' | 'manifest' | 'prompt' | 'format' | 'output' | 'days' | 'max-total-mb' | 'context' | 'status', string> &
  Record<'yes' | 'dry-run' | 'temporary' | 'no-shell' | 'live' | 'json' | 'check' | 'effective' | 'project' | 'all' | 'include-classifier' | 'archived' | 'full' | 'redact' | 'preview' | 'apply' | 'last' | 'context-only' | 'no-color' | 'ephemeral' | 'new', boolean>
>;
export function options(argv: string[], { values = [], flags = [] }: OptionSpec = {}): { opts: CliOptions; args: string[] } {
  const opts: Record<string, string | boolean> = {}, args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { args.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { args.push(arg); continue; }
    const key = arg.slice(2);
    if (!arg.startsWith('--') || !values.includes(key) && !flags.includes(key)) throw invalid(`未知选项：${arg}`);
    if (key in opts) throw invalid(`选项重复：${arg}`);
    if (flags.includes(key)) opts[key] = true;
    else { const next = argv[++i]; if (next === undefined || next.startsWith('--')) throw invalid(`${arg} 缺少值`); opts[key] = next; }
  }
  return { opts: opts as CliOptions, args };
}
export function arity(args: string[], min: number, max = min) { if (args.length < min || args.length > max) throw invalid('参数数量不正确；查看 sayrun --help'); }
