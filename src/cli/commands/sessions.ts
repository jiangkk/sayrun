import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../../config/load.ts';
import { SessionStore } from '../../history/store.ts';
import { exportMarkdown, redactExport } from '../../history/export.ts';
import { visibleContext } from '../../history/context.ts';
import { createBackend } from '../../backends/registry.ts';
import { admitBackend } from '../../backends/protocol.ts';
import { confirm } from '../../platform/shell-setup.ts';
import { atomicWrite } from '../../platform/atomic-file.ts';
import { write, safeText } from '../../terminal/display.ts';
import { invalid } from '../../errors.ts';
import { options, arity } from '../args.ts';
import type { OptionSpec } from '../args.ts';
import { print, printJson } from '../output.ts';
import { readAnswer } from '../input.ts';

export async function sessionsCommand(argv: string[]) {
  const action = argv[0] ?? 'browse', tail = argv.slice(1);
  const specs: Record<string, OptionSpec> = { browse: {}, list: { flags: ['all', 'json', 'include-classifier', 'archived'], values: ['backend', 'status'] }, search: { flags: ['all', 'json', 'include-classifier', 'archived'], values: ['backend', 'status'] }, show: { flags: ['full', 'json'] }, export: { flags: ['json', 'full', 'redact', 'preview'], values: ['format', 'output'] }, rename: {}, pin: {}, unpin: {}, archive: {}, restore: {}, delete: { flags: ['yes', 'json'] }, gc: { flags: ['dry-run', 'apply', 'json'], values: ['days', 'max-total-mb'] }, reindex: { flags: ['json'] }, import: { flags: ['json'] }, fork: { flags: ['json'], values: ['backend', 'context'] } };
  if (!specs[action]) throw invalid(`未知历史命令：${action}`);
  const { opts, args } = options(tail, specs[action]), loaded = await loadConfig(), store = new SessionStore();
  const listing = { all: opts.all ?? loaded.config.history.default_scope === 'all', includeClassifier: opts['include-classifier'] ?? loaded.config.history.include_classifier, archived: opts.archived, backend: opts.backend, status: opts.status };
  if (['browse', 'list', 'search'].includes(action)) {
    arity(args, action === 'search' ? 1 : 0); const rows = action === 'search' ? await store.search(args[0], listing) : await store.list(listing);
    if (action === 'browse' && process.stdin.isTTY && process.stdout.isTTY) {
      rows.forEach((m, i) => write(`${i + 1}. ${m.title} · ${m.sessionId.slice(0, 8)} · ${m.status}\n`));
      if (!rows.length) { write('当前项目没有历史任务。\n'); return 0; }
      const answer = await readAnswer('输入编号查看；Enter 返回 shell：'); if (!answer) return 0;
      const row = rows[Number(answer) - 1]; if (!row) throw invalid('无效编号'); write(exportMarkdown(await store.read(row.sessionId), { full: false })); return 0;
    }
    if (opts.json) printJson(rows);
    else { for (const m of rows) write(`${m.sessionId.slice(0, 8)} ${m.pinned ? '★ ' : ''}${m.title}\n  ${m.updatedAt} · ${m.backend} · ${m.project} · ${m.status} · ${m.commands} 条命令 · resume=${m.resume}\n`); if (!rows.length) write('没有匹配的会话。\n'); }
    for (const w of store.warnings) process.stderr.write(safeText(w) + '\n'); return 0;
  }
  if (action === 'reindex') { arity(args, 0); print(await store.reindex(), opts.json); return 0; }
  if (action === 'gc') {
    arity(args, 0); if (opts.apply && opts['dry-run']) throw invalid('--apply 与 --dry-run 不能同时使用');
    const days = opts.days === undefined ? loaded.config.history.retention_days : Number(opts.days), mb = opts['max-total-mb'] === undefined ? loaded.config.history.max_total_mb : Number(opts['max-total-mb']);
    if (!(days > 0 && Number.isFinite(days) && mb > 0 && Number.isFinite(mb))) throw invalid('GC 天数与容量必须为正数');
    print(await store.gc({ retentionDays: days, maxTotalMb: mb, apply: !!opts.apply }), opts.json); return 0;
  }
  if (action === 'import') { arity(args, 1); print(await store.import(JSON.parse(await readFile(resolve(args[0]), 'utf8'))), opts.json); return 0; }
  arity(args, action === 'rename' ? 2 : 1); const meta = await store.resolve(args[0]);
  if (action === 'show' || action === 'export') {
    let data = await store.read(meta.sessionId); if (opts.redact) data = redactExport(data);
    const format = opts.json ? 'json' : opts.format ?? 'markdown'; if (!['json', 'markdown'].includes(format)) throw invalid('format 必须为 markdown / json');
    const content = format === 'json' ? JSON.stringify(data, null, 2) + '\n' : exportMarkdown(data, { full: action === 'export' || !!opts.full });
    if (opts.output && !opts.preview) { await atomicWrite(resolve(opts.output), content); write(`导出：${resolve(opts.output)}\n`); }
    else process.stdout.write(format === 'json' ? content : safeText(content)); return 0;
  }
  if (action === 'delete') { if (opts.yes || await confirm(`删除 ${meta.sessionId}（只删除本工具历史，后端原生数据保留）？`)) print(await store.delete(meta.sessionId), opts.json); return 0; }
  if (action === 'fork') {
    if (!opts.backend || opts.context && opts.context !== 'summary') throw invalid('用法：sessions fork <id> --backend <name> --context summary');
    const config = structuredClone(loaded.config); config.agent.backend = opts.backend; admitBackend(await createBackend(config).probe());
    const context = visibleContext(await store.read(meta.sessionId));
    const fork = await store.create({ prompt: meta.title, cwd: meta.cwd, backend: opts.backend, model: config.backends[opts.backend]?.model, config, parentSessionId: meta.sessionId });
    const writer = await store.begin(fork, { prompt: '显式创建可见上下文分支；尚未调用模型', config }); await writer.append('context.imported', context); await writer.finish('ready');
    print({ ...fork, note: '新分支已创建；resume 后输入新请求才调用模型', context: { included: context.included, total: context.total, bytes: context.bytes } }, opts.json); return 0;
  }
  const patch = action === 'rename' ? { title: safeText(args[1]).slice(0, 120) } : ['pin', 'unpin'].includes(action) ? { pinned: action === 'pin' } : { archived: action === 'archive' };
  if (patch.title === '') throw invalid('标题不能为空'); print(await store.update(meta.sessionId, patch)); return 0;
}
