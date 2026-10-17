import { safeText, write } from '../terminal/display.ts';
import { renderMarkdown, wrapTerminal } from '../terminal/transcript.ts';
import type { SessionMeta } from '../contracts/history.ts';

export type Tone = 'text' | 'muted' | 'accent' | 'green' | 'amber' | 'red';
export interface ReportLine { text: string; tone?: Tone; heading?: boolean }
export interface Report { title: string; lines: ReportLine[]; tone?: Tone; logo?: boolean }
export interface Choice { name: string; description: string; value: string }
export interface CommandPresentation {
  report(report: Report): void;
  status(text: string): void;
  confirm(question: string): Promise<boolean>;
  input(question: string): Promise<string | null>;
  select(question: string, choices: Choice[]): Promise<string | null>;
  external<T>(action: () => T): Promise<T>;
  close(): Promise<void>;
}
let active: CommandPresentation | undefined;
export const presentation = () => active;
export function setPresentation(value: CommandPresentation) { active = value; }
export async function closePresentation() { const previous = active; active = undefined; await previous?.close(); }
export async function withExternalTerminal<T>(action: () => T): Promise<T> { return active ? active.external(action) : action(); }
export function status(text: string) { active?.status(safeText(text)); }
export function report(title: string, lines: ReportLine[], options: Pick<Report, 'tone' | 'logo'> = {}) {
  const content = { title: safeText(title), lines: lines.map((line) => ({ ...line, text: safeText(line.text) })), ...options };
  if (active) active.report(content);
  else write(`\n◆ ${content.title}\n${content.lines.map((line) => line.text ? `  ${line.text}` : '').join('\n')}\n\n`);
}
export function notice(text: string, tone: Tone = 'muted') { report(tone === 'red' ? '未能完成' : tone === 'green' ? '已完成' : '提示', [{ text, tone }], { tone }); }

const labels: Record<string, string> = {
  config: '配置', sources: '配置来源', warnings: '提醒', diagnostics: '检查结果', auth: '认证',
  version: '版本', node: 'Node.js', bun: 'Bun', opentui: 'OpenTUI', protocol: '适配器协议', adapter: '当前适配器', backend: '后端',
  available: '可用', capabilities: '能力', path: '路径', backup: '备份', changed: '已更改', valid: '配置有效',
  key: '配置项', value: '值', source: '来源', status: '状态', note: '说明', default: '默认后端',
  userDefault: '用户默认后端', effective: '当前生效后端', trusted: '已信任', id: '名称', apiVersion: 'API 版本',
  nativeHome: '后端运行目录', probe: '后端信息', current: '当前版本', latest: '最新版本',
  title: '标题', sessionId: '会话 ID', project: '项目', cwd: '目录', model: '模型', commands: '命令数',
  createdAt: '创建时间', updatedAt: '更新时间', pinned: '置顶', archived: '已归档', resume: '恢复方式', readOnly: '只读',
  parentSessionId: '来源会话', context: '上下文', included: '已包含', total: '总计', bytes: '字节',
  candidates: '候选项', imported: '已导入', indexed: '已索引', deleted: '已删除', skipped: '已跳过', duplicate: '重复',
  schemaVersion: '数据格式', schema_version: '配置格式', agent: '任务', execution: '执行', ui: '界面', history: '历史', routing: '输入路由',
  profiles: '配置预设', backends: '后端设置', approval: '命令审批', disabled: '已禁用', binary: '可执行程序',
  hostTools: '宿主工具', commandEditing: '命令编辑', userQuestions: '追问', cancellation: '取消方式', ephemeral: '临时会话', classify: '意图识别', modelDiscovery: '模型发现', usage: '用量统计',
  change: '计划更改', storage: '存储位置', shell: 'Shell 集成', max_commands: '命令上限', max_steps: '步骤上限',
};
const values: Record<string, string> = {
  missing: '未配置', 'configured-unverified': '已设置，尚未在线验证', 'file-present-unverified': '凭证文件存在，尚未在线验证',
  'adapter-managed': '由适配器管理', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
  ready: '就绪', imported: '已导入', starting: '正在启动', thinking: '正在分析', executing: '正在执行',
  awaiting_approval: '等待审批', awaiting_input: '等待输入', limited: '达到限制', stopped: '已停止',
  native: '原生恢复', context: '可见上下文', 'context-only': '可见上下文', none: '不支持', checked: '已检查', unavailable: '不可用',
};
export function displayValue(value: unknown, translate = true): string {
  if (value === undefined || value === null) return '未设置';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return safeText(translate ? values[String(value)] ?? String(value) : String(value));
}
export function dataLines(data: unknown, depth = 0): ReportLine[] {
  if (Array.isArray(data)) return data.length ? data.flatMap((item, index) => typeof item === 'object' && item !== null
    ? [{ text: `${'  '.repeat(depth)}${String(index + 1).padStart(2, '0')}  ${safeText(item.title ?? item.id ?? item.name ?? '条目')}`, heading: true, tone: 'accent' as const }, ...dataLines(item, depth + 1)]
    : [{ text: `${'  '.repeat(depth)}• ${displayValue(item)}` }]) : [{ text: `${'  '.repeat(depth)}暂无`, tone: 'muted' }];
  if (data && typeof data === 'object') {
    // A successful history mutation should summarize the session, not dump its saved config.
    const session = 'sessionId' in data && 'title' in data;
    const entries = Object.entries(data).filter(([key]) => !session || !['config', 'nativeRef', 'nativeHome', 'nativeManaged', 'machineId', 'schemaVersion'].includes(key)).filter(([, value]) => value !== undefined);
    return entries.length ? entries.flatMap(([key, value]): ReportLine[] => {
      const label = labels[key] ?? key, prefix = '  '.repeat(depth);
      if (value && typeof value === 'object') return [
        { text: `${prefix}${label}`, heading: true, tone: 'muted' }, ...dataLines(value, depth + 1),
      ];
      return [{ text: `${prefix}${label}  ${displayValue(value, ['status', 'resume'].includes(key))}`, tone: value === false && key === 'available' ? 'amber' : 'text' }];
    }) : [{ text: '暂无配置', tone: 'muted' }];
  }
  return [{ text: displayValue(data) }];
}
export function sessionLines(rows: SessionMeta[]): ReportLine[] {
  if (!rows.length) return [{ text: '没有匹配的会话。运行 sayrun ask "任务" 开始第一次任务。', tone: 'muted' }];
  return rows.flatMap((m) => [
    { text: `${m.pinned ? '★ ' : ''}${m.title}`, heading: true, tone: 'accent' as const },
    { text: `${m.sessionId.slice(0, 8)} · ${displayValue(m.status)} · ${m.backend} · ${m.commands} 条命令` },
    { text: `${m.updatedAt} · ${m.project}`, tone: 'muted' as const },
    { text: `sayrun resume ${m.sessionId.slice(0, 8)}`, tone: 'muted' as const },
    { text: '' },
  ]);
}
export function markdownReport(title: string, markdown: string) {
  const width = Math.max(12, Math.min(process.stdout.columns || 80, 100) - 6);
  report(title, renderMarkdown(markdown, { width }).split('\n').map((text) => ({ text })));
}
export const logoLines = [
  '███████╗ █████╗ ██╗   ██╗██████╗ ██╗   ██╗███╗   ██╗',
  '██╔════╝██╔══██╗╚██╗ ██╔╝██╔══██╗██║   ██║████╗  ██║',
  '███████╗███████║ ╚████╔╝ ██████╔╝ ██║   ██║██╔██╗ ██║',
  '╚════██║██╔══██║  ╚██╔╝  ██╔══██╗██║   ██║██║╚██╗██║',
  '███████║██║  ██║   ██║   ██║  ██║╚██████╔╝██║ ╚████║',
  '╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝',
];
// Wrap before drawing so CJK, long paths, and pasted control codes cannot break a card.
export function reportRows(content: Report, width: number): ReportLine[] {
  const available = Math.max(4, Math.min(width, 100) - 6);
  return [
    { text: '', tone: 'muted' },
    ...(content.logo && width >= 60 ? logoLines.map((text): ReportLine => ({ text: `  ${text}`, tone: 'accent' })) : []),
    ...wrapTerminal(`◆ SAYRUN  /  ${safeText(content.title)}`, available).map((text): ReportLine => ({ text: `  ${text}`, heading: true, tone: content.tone ?? 'accent' })),
    { text: `  ${'─'.repeat(available)}`, tone: 'muted' },
    ...content.lines.flatMap((line) => wrapTerminal(safeText(line.text), available).map((text) => ({ ...line, text: `  ${text}` }))),
    { text: '' },
  ];
}
