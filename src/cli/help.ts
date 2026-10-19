import type { ReportLine } from './presentation.ts';

export function commandHelp(version: string): ReportLine[] {
  const section = (text: string): ReportLine => ({ text, heading: true, tone: 'accent' });
  const hint = (text: string): ReportLine => ({ text, tone: 'muted' });
  return [
    hint(`Sayrun ${version} · 把想做的事交给终端`),
    { text: '' }, section('开始任务'),
    { text: 'sayrun                           输入任务，完成即退出' },
    { text: 'sayrun ask "帮我检查当前目录"      直接开始一个任务' },
    { text: 'sayrun ask --backend dsh --profile ops "任务"' },
    { text: 'sayrun ask --new "新任务"          在当前 shell 开始新对话' },
    { text: 'sayrun -- "history"               强制作为任务文本' },
    { text: 'sayrun resume <id> | --last [--prompt "继续请求"]' },
    { text: '' }, section('环境与设置'),
    { text: 'sayrun setup [--dry-run | --yes] [--no-shell] [--temporary] [--zshrc /path/.zshrc]' },
    { text: 'sayrun doctor [--live] [--json]' },
    hint('默认仅检查本地环境；--live 才发送模型探测。'),
    { text: 'sayrun shell init zsh | on | off | status | uninstall' },
    { text: 'sayrun backend list/info/check/use/add/remove' },
    { text: 'sayrun auth status [backend] | auth login <backend>' },
    { text: 'sayrun config show --effective [--profile ops] | get/set <key> [value] [--project]' },
    { text: 'sayrun config edit/validate | trust .' },
    { text: 'sayrun profile list' },
    { text: '' }, section('任务历史'),
    { text: 'sayrun sessions                   用方向键选择历史任务' },
    { text: 'sayrun sessions list/search/show/export/rename/pin/unpin/archive/restore/delete/gc/reindex/import/fork' },
    hint('list/search：--all --backend dsh --status failed --include-classifier --json'),
    hint('show <id>：--full | --json'),
    hint('export <id>：--format markdown|json [--output /path] [--redact] [--preview]'),
    hint('delete <id> --yes；gc --dry-run | --apply [--days 30] [--max-total-mb 1024]'),
    { text: '' }, section('工具与版本'),
    { text: 'sayrun preview                    离线审批预览' },
    { text: 'sayrun migrate --from /path/.runtime/dsh --dry-run | --apply' },
    { text: 'sayrun version [--json] | --version | update --check' },
    { text: '' }, section('在当前 Zsh 启用'),
    { text: 'eval "$(sayrun shell init zsh)"' },
    hint('每条命令均需审批。非 TTY 只读管理可用，ask 不执行。'),
    hint('同一 shell 和项目延续会话；新 zsh 实例独立，普通 shell 命令不切断对话。'),
    hint('交互终端默认使用 OpenTUI；--json 输出原始数据，ui.mode=plain 使用纯文本。'),
  ];
}
