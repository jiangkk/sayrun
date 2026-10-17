import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig, trustProject } from '../src/config/load.ts';
import { defaults } from '../src/config/defaults.ts';
import { validateConfig } from '../src/config/schema.ts';
import { SessionStore } from '../src/history/store.ts';
import { visibleContext } from '../src/history/context.ts';
import { exportMarkdown } from '../src/history/export.ts';
import { editShellBlock, shellBlock, shellPlan, applyShellPlan, editorArgv } from '../src/platform/shell-setup.ts';
import { runAgent } from '../src/application/run-task.ts';
import { backendEvent, admitBackend } from '../src/backends/protocol.ts';
import { dshCapabilities } from '../src/backends/dsh/backend.ts';
import { convertDsh, migrate } from '../src/history/migrate-dsh.ts';
import { productPaths, runtimeHome } from '../src/platform/paths.ts';

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ta-product-')), env = { TA_HOME: join(dir, 'home') }, cwd = join(dir, 'project'); await mkdir(cwd);
  t.after(() => rm(dir, { recursive: true, force: true })); return { dir, env, cwd };
}
const config = () => structuredClone(defaults);
const cliPath = new URL('../dist/sayrun.js', import.meta.url).pathname;
const cli = (s, ...args) => spawnSync(process.execPath, [cliPath, ...args], { env: { ...process.env, ...s.env }, cwd: s.cwd, encoding: 'utf8' });

test('TOML precedence, provenance, scoped trust, protected fields and profile limits', async (t) => {
  const s = await sandbox(t);
  await saveConfig({ agent: { max_commands: 5 }, backends: { dsh: { model: 'user' } }, profiles: { ops: { agent: { max_commands: 7 } } } }, { env: s.env });
  await saveConfig({ ui: { mode: 'plain' }, agent: { max_commands: 9, backend: 'registered' }, backends: { dsh: { model: 'project' } } }, { project: true, cwd: s.cwd, env: s.env });
  let loaded = await loadConfig({ cwd: s.cwd, env: s.env, profile: 'ops' });
  assert.equal(loaded.config.agent.max_commands, 7); assert.equal(loaded.config.ui.mode, 'plain'); assert.match(loaded.warnings.join(' '), /config trust/);
  await trustProject(s.cwd, s.env);
  loaded = await loadConfig({ cwd: s.cwd, env: { ...s.env, TERMINAL_AGENT_MODEL: 'env' }, profile: 'ops', cli: { agent: { max_commands: 3 } } });
  assert.equal(loaded.config.agent.max_commands, 3); assert.equal(loaded.config.backends.dsh.model, 'env'); assert.equal(loaded.sources['backends.dsh.model'], 'env:TERMINAL_AGENT_MODEL');
  await writeFile(join(s.cwd, '.terminal-agent.toml'), 'schema_version=1\n[agent]\nmax_commands=15\n[backends.dsh]\nbinary="/tmp/evil"\n[history]\nauto_gc=true\n');
  loaded = await loadConfig({ cwd: s.cwd, env: s.env });
  assert.equal(loaded.config.agent.max_commands, 5); assert.equal(loaded.config.backends.dsh.binary, 'dsh'); assert.equal(loaded.config.history.auto_gc, false);
  await trustProject(s.cwd, s.env); loaded = await loadConfig({ cwd: s.cwd, env: s.env });
  assert.equal(loaded.config.agent.max_commands, 15); assert.equal(loaded.config.backends.dsh.binary, 'dsh'); assert.equal(loaded.config.history.auto_gc, false);
  assert.throws(() => validateConfig({ history: { enabled: 'false' } }), /类型/);
  assert.throws(() => validateConfig({ backends: { dsh: { api_key: 'secret' } } }), /未知/);
  await assert.rejects(saveConfig({ approval: { editor_enter: 'save' } }, { project: true, cwd: s.cwd, env: s.env }), /不允许/);
  assert.throws(() => validateConfig({ profiles: { a: { execution: { timeout_seconds: -1 } } } }));
  assert.throws(() => validateConfig({ schema_version: 2 }));
});

test('project configuration comes only from nearest git root or current non-git directory', async (t) => {
  const s = await sandbox(t); await writeFile(join(s.dir, '.terminal-agent.toml'), '[ui]\nmode="plain"\n');
  assert.equal((await loadConfig({ cwd: s.cwd, env: s.env })).config.ui.mode, 'opentui');
  spawnSync('git', ['init', '-q', s.cwd]); const nested = join(s.cwd, 'nested'); await mkdir(nested);
  await saveConfig({ ui: { mode: 'plain' } }, { project: true, cwd: s.cwd, env: s.env });
  await writeFile(join(nested, '.terminal-agent.toml'), '[ui]\nmode="opentui"\n');
  assert.equal((await loadConfig({ cwd: nested, env: s.env })).config.ui.mode, 'plain');
  assert.equal(runtimeHome({ ...s.env, TERMINAL_AGENT_HOME: '/tmp/legacy' }), '/tmp/legacy');
  assert.equal(productPaths(s.env).data, join(s.env.TA_HOME, 'data'));
});

test('setup/uninstall manage only an idempotent marked block and refuse malformed/conflicting edits', async (t) => {
  const s = await sandbox(t), path = join(s.dir, 'zshrc');
  const original = '# custom\nsource other-plugin.zsh\n'; await writeFile(path, original);
  const plan = await shellPlan({ path }); await applyShellPlan(plan);
  const once = await readFile(path, 'utf8'); assert.equal(editShellBlock(once, true), once); assert.match(once, /source other-plugin/);
  const remove = await shellPlan({ path, install: false }); await applyShellPlan(remove); assert.equal(await readFile(path, 'utf8'), original);
  assert.throws(() => editShellBlock(shellBlock + shellBlock, false));
  await writeFile(path, 'changed'); await assert.rejects(applyShellPlan(plan), /已变化/);
  assert.deepEqual(editorArgv('code --wait "a b"'), ['code', '--wait', 'a b']);
  assert.throws(() => editorArgv('"bad'));
});

test('Sayrun upgrades and removes the legacy managed shell block without duplicating integration', () => {
  const custom = '# custom\nsource other-plugin.zsh\n';
  const legacy = '# >>> terminal-agent >>>\neval "$(terminal-agent shell init zsh)"\n# <<< terminal-agent <<<\n';
  const upgraded = editShellBlock(custom + legacy, true);
  assert.equal(upgraded, custom + shellBlock);
  assert.equal(editShellBlock(upgraded, true), upgraded);
  assert.equal(editShellBlock(custom + legacy, false), custom);
  assert.equal(editShellBlock(custom + legacy + shellBlock, true), custom + shellBlock);
  assert.throws(() => editShellBlock(custom + '# >>> terminal-agent >>>\n', true), /不完整/);
  assert.throws(() => editShellBlock('# >>> terminal-agent >>>\n' + shellBlock + '# <<< terminal-agent <<<\n', true), /嵌套/);
});

async function stored(s, fields = {}) {
  const store = new SessionStore({ env: s.env });
  const meta = await store.create({ prompt: '查 NXDOMAIN', cwd: s.cwd, backend: 'dsh', config: config(), ...fields });
  const writer = await store.begin(meta, { prompt: '查 NXDOMAIN', config: config() }); return { store, meta, writer };
}
test('session files remain authoritative: locks, scoped search, sanitized outputs, export, reindex corruption recovery', async (t) => {
  const s = await sandbox(t), { store, meta, writer } = await stored(s);
  await assert.rejects(store.begin(meta, { prompt: 'duplicate', config: config() }), /正在使用/);
  await writer.append('execution.started', { executionId: 'test-output', executedCommand: 'pwd', cwd: s.cwd });
  await writer.result('test-output', { output: '\x1b[2JNXDOMAIN\n', exitCode: 0, signal: null, timedOut: false, cancelled: false, truncated: false });
  await writer.append('message', { text: '验证完成', final: true }); await writer.finish('completed');
  assert.equal((await store.search('NXDOMAIN', { cwd: s.cwd })).length, 1);
  const data = await store.read(meta.sessionId.slice(0, 8)); assert.equal(data.outputs['outputs/test-output.txt'], 'NXDOMAIN\n');
  assert.match(exportMarkdown(data), /pwd/); assert.match(visibleContext(data).text, /NXDOMAIN/);
  assert.equal((await store.list({ cwd: s.dir })).length, 0);
  assert.equal((await store.list({ cwd: s.dir, all: true })).length, 1);
  assert.equal((await store.reindex()).indexed, 1);
  await writeFile(join(store.paths.data, 'index.sqlite'), 'corrupt index'); assert.equal((await store.reindex()).indexed, 1);
  await store.update(meta.sessionId, { archived: true, pinned: true }); assert.equal((await store.list({ cwd: s.cwd })).length, 0);
  assert.equal((await store.list({ cwd: s.cwd, archived: true })).length, 1);
});

test('GC and deletion skip active/pinned sessions, import is inert and deduplicated', async (t) => {
  const s = await sandbox(t), a = await stored(s), b = await stored(s), c = await stored(s);
  await a.writer.finish('completed'); await a.store.update(a.meta.sessionId, { pinned: true });
  await b.writer.finish('completed'); await b.store.update(b.meta.sessionId, { updatedAt: '2000-01-01T00:00:00Z' });
  await assert.rejects(c.store.delete(c.meta.sessionId), /正在使用/);
  const gc = await a.store.gc({ retentionDays: 1, maxTotalMb: 0.00001 });
  assert.deepEqual(gc.candidates.map((m) => m.sessionId), [b.meta.sessionId]); assert.equal((await a.store.list({ all: true })).length, 3);
  const data = await a.store.read(a.meta.sessionId), imported = await a.store.import(data);
  assert.equal(imported.readOnly, true); assert.equal((await a.store.import(data)).duplicate, true);
  await assert.rejects(a.store.import({ ...data, outputs: { '../outside': 'bad' } }), /输出/);
  await a.store.gc({ retentionDays: 1, maxTotalMb: 0.00001, apply: true }); await assert.rejects(a.store.resolve(b.meta.sessionId), /不存在/);
  await c.writer.finish('cancelled');
});

test('orphaned execution is marked unknown and never replayed; session symlinks are excluded', async (t) => {
  const s = await sandbox(t), { store, meta, writer } = await stored(s);
  await writer.append('execution.started', { executionId: 'orphan', executedCommand: 'never-repeat' });
  // Emulate a crash by releasing the lock without finishing the run.
  await writer.release(); assert.equal((await store.list({ all: true }))[0].status, 'interrupted');
  const next = await store.begin(meta, { prompt: 'new user request', config: config() }); await next.finish('completed');
  const data = await store.read(meta.sessionId); assert.equal(data.events.filter((e) => e.type === 'execution.started').length, 1);
  assert.equal(data.events.find((e) => e.type === 'execution.interrupted').outcome, 'unknown');
  await symlink(s.cwd, join(store.base, 'fake-session')); assert.equal((await store.list({ all: true })).length, 1);
});

function fixture(events, { capabilities = dshCapabilities, onReply = () => {}, endsWithoutEnding = false } = {}) {
  const replies = [], info = { closes: 0, replies };
  const backend = { id: 'fixture', apiVersion: 1, probe: async () => ({ available: true, capabilities, diagnostics: [] }),
    connect: async () => ({ nativeRef: 'fixture-native', async *run({ runId }) { for (const e of events) yield backendEvent(runId, e); if (!endsWithoutEnding && !events.some((e) => e.type === 'run.ended')) yield backendEvent(runId, { type: 'run.ended', reason: 'completed' }); },
      reply: async (reply) => { replies.push(reply); await onReply(reply); }, interrupt: async () => {}, close: async () => { info.closes++; } }) };
  return { backend, info };
}
const success = { output: 'ok', exitCode: 0, signal: null, timedOut: false, cancelled: false, truncated: false };
function ui({ approve = (p) => p, answer = () => 'y' } = {}) { return async () => ({ status() {}, output() {}, result() {}, finish() {}, close: async () => {}, approve, requestInput: answer }); }
async function coordinate(s, backend, extra = {}) {
  const conf = config(); conf.backends.fixture = { model: 'fixture' }; conf.agent.backend = 'fixture';
  return runAgent('test', { cwd: s.cwd, config: conf, backend, store: new SessionStore({ env: s.env }), uiFactory: ui(), execute: async () => success,
    input: { isTTY: true }, output: { isTTY: true, write() {} }, ...extra });
}
const command = { type: 'command.requested', requestId: 'one', command: 'printf original', description: 'purpose', cwd: process.cwd(), targetId: 'local-zsh' };

test('backend-independent Coordinator edits exact command, persists before reply, separates answers and deduplicates requests', async (t) => {
  const s = await sandbox(t), proposal = { ...command, cwd: s.cwd }; let executions = 0;
  const peer = fixture([{ type: 'question.requested', requestId: 'question', question: '范围？' }, proposal, proposal, { type: 'run.ended', reason: 'completed' }], {
    onReply: async (reply) => { if (reply.kind === 'command') { const store = new SessionStore({ env: s.env }), [meta] = await store.list({ all: true }); assert.ok((await store.read(meta.sessionId)).events.some((e) => e.type === 'execution.result')); } },
  });
  const result = await coordinate(s, peer.backend, { uiFactory: ui({ approve: (p) => ({ ...p, command: 'printf edited' }) }), execute: async (p) => { executions++; assert.equal(p.command, 'printf edited'); return success; } });
  assert.equal(result.exitCode, 0); assert.equal(executions, 1); assert.equal(peer.info.replies[0].commandApproval, false);
  assert.equal(peer.info.replies[1].command, 'printf edited'); assert.equal(peer.info.replies[1].executionId, peer.info.replies[2].executionId); assert.equal(peer.info.closes, 1);
});

test('Coordinator refuses capabilities/targets, rejects without execution, and stops on conflicting replay IDs', async (t) => {
  const s = await sandbox(t); let executions = 0;
  assert.throws(() => admitBackend({ available: true, capabilities: { ...dshCapabilities, commandEditing: false }, diagnostics: [] }), /commandEditing/);
  const denied = fixture([{ ...command, cwd: s.cwd }, { type: 'run.ended', reason: 'completed' }]);
  assert.equal((await coordinate(s, denied.backend, { uiFactory: ui({ approve: () => null }), execute: async () => { executions++; return success; } })).exitCode, 3); assert.equal(executions, 0);
  await assert.rejects(coordinate(s, fixture([{ ...command, targetId: 'remote' }]).backend), /不能切换/);
  await assert.rejects(coordinate(s, fixture([{ ...command, cwd: s.cwd }, { ...command, command: 'different', cwd: s.cwd }]).backend), /内容发生变化/);
  await assert.rejects(coordinate(s, fixture([], { endsWithoutEnding: true }).backend), /未发送/);
});

test('persistence errors prevent execution, and result-write failure stops before backend acknowledgement', async (t) => {
  const s = await sandbox(t); let executions = 0;
  const store = new SessionStore({ env: s.env }), begin = store.begin.bind(store);
  store.begin = async (...args) => { const w = await begin(...args), append = w.append.bind(w); w.append = (type, details) => { if (type === 'execution.started') throw new Error('disk full'); return append(type, details); }; return w; };
  const peer = fixture([{ ...command, cwd: s.cwd }]);
  await assert.rejects(coordinate(s, peer.backend, { store, execute: async () => { executions++; return success; } }), /历史写入失败/); assert.equal(executions, 0);
  const store2 = new SessionStore({ env: s.env }), begin2 = store2.begin.bind(store2);
  store2.begin = async (...args) => { const w = await begin2(...args); w.result = async () => { throw new Error('disk full after execute'); }; return w; };
  const second = fixture([{ ...command, cwd: s.cwd }, { ...command, requestId: 'two', cwd: s.cwd }]);
  await assert.rejects(coordinate(s, second.backend, { store: store2, execute: async () => { executions++; return success; } }), /命令已执行/);
  assert.equal(executions, 1); assert.equal(second.info.replies.length, 0);
});

test('Coordinator budgets and cancellation have distinct outcomes; history-disabled does not create task contents', async (t) => {
  const s = await sandbox(t), peer = fixture([{ ...command, cwd: s.cwd }, { ...command, requestId: 'two', cwd: s.cwd }]);
  await assert.rejects(coordinate(s, peer.backend, { maxCommands: 1 }), (e) => e.exitCode === 4);
  const cancel = new AbortController();
  await assert.rejects(coordinate(s, fixture([{ ...command, cwd: s.cwd }]).backend, { signal: cancel.signal, uiFactory: ui({ approve: () => { cancel.abort(); return command; } }) }), (e) => e.exitCode === 130);
  const conf = config(); conf.history.enabled = false;
  const done = fixture([{ type: 'run.ended', reason: 'completed' }]); const result = await coordinate(s, done.backend, { config: conf });
  assert.equal(result.sessionId, undefined);
  await assert.rejects(coordinate(s, fixture([]).backend, { ephemeral: true }), /ephemeral/);
});

test('migration validates DSH v4, converts execution facts, preserves originals and deduplicates repeats', async (t) => {
  const s = await sandbox(t), home = join(s.dir, 'legacy'), sessions = join(home, 'sessions/project/native'); await mkdir(sessions, { recursive: true });
  const rows = [{ type: 'session', version: 4, id: 'native-session', cwd: s.cwd, createdAt: Date.now() },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'check' }] } },
    { type: 'tool/call', data: { name: 'terminal_command', callId: 'call', arguments: JSON.stringify({ command: 'pwd', description: 'where' }) } },
    { type: 'tool/result', data: { message: { toolCallId: 'call', content: [{ type: 'text', text: JSON.stringify({ approved: true, executed: true, command: 'printf EDITED', output: 'FACT', exitCode: 0 }) }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } }];
  const content = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'; await writeFile(join(sessions, 'session.v4.jsonl'), content);
  const converted = convertDsh(content); assert.equal(converted.events.find((e) => e.type === 'execution.started').executedCommand, 'printf EDITED');
  assert.throws(() => convertDsh('{}'));
  const before = process.env.TA_HOME; process.env.TA_HOME = s.env.TA_HOME;
  try {
    assert.equal((await migrate(home)).candidates.length, 1); assert.equal((await migrate(home, { apply: true })).imported.length, 1);
    assert.equal((await migrate(home, { apply: true })).imported[0].duplicate, true);
    assert.equal(await readFile(join(sessions, 'session.v4.jsonl'), 'utf8'), content);
  } finally { if (before === undefined) delete process.env.TA_HOME; else process.env.TA_HOME = before; }
});

test('CLI deterministic management roundtrip works offline without a backend and JSON remains pipeable', async (t) => {
  const s = await sandbox(t);
  assert.equal(cli(s, 'config', 'set', 'agent.max_commands', '4').status, 0);
  const show = cli(s, 'config', 'show', '--effective', '--json'); assert.equal(show.status, 0, show.stdout); assert.equal(JSON.parse(show.stdout).config.agent.max_commands, 4);
  assert.equal(cli(s, 'config', 'set', 'agent.max_commands', '-1').status, 2);
  assert.equal(cli(s, 'sessions', 'list', '--json').stdout.trim(), '[]');
  assert.equal(cli(s, 'ask', 'test').status, 1);
  assert.equal(cli(s, 'sessions', 'delete', 'missing', '--yes').status, 1);
  assert.equal(cli(s, 'auth', 'status', 'dsh', '--json').status, 0);
  assert.equal(cli(s, 'config', 'set', 'backends.dsh.api_key', 'secret').status, 2);
  const version = cli(s, 'version', '--json'); assert.equal(version.status, 0, version.stdout); assert.equal(JSON.parse(version.stdout).protocol, 1);
});

test('registered process adapter uses argv/whitelisted environment and runtime capabilities; same Coordinator handles it', async (t) => {
  const s = await sandbox(t), manifest = join(s.dir, 'adapter.json');
  const worker = new URL('./fixture-backend.mjs', import.meta.url).pathname;
  await writeFile(manifest, JSON.stringify({ apiVersion: 1, executable: process.execPath, args: [worker], env: [] }));
  const { ProcessBackend } = await import('../src/backends/process/backend.ts');
  const backend = new ProcessBackend('fixture', { manifest });
  assert.equal((await backend.probe()).available, true);
  const result = await coordinate(s, backend, { uiFactory: ui({ approve: (p) => ({ ...p, command: 'printf host-edited' }) }) }); assert.equal(result.exitCode, 0);
  await writeFile(manifest, JSON.stringify({ apiVersion: 1, executable: process.execPath, args: [worker, '--restricted'], env: [], capabilities: { hostTools: true } }));
  const probe = await backend.probe(); assert.equal(probe.capabilities.hostTools, false); assert.throws(() => admitBackend(probe), /hostTools/);
});

test('backend disconnect cancels an outstanding approval before a command can execute', async (t) => {
  const s = await sandbox(t), { EventQueue } = await import('../src/backends/protocol.ts'); let executions = 0, closed = false;
  const events = new EventQueue();
  const backend = { id: 'fixture', apiVersion: 1, probe: async () => ({ available: true, capabilities: dshCapabilities, diagnostics: [] }),
    connect: async () => ({ run({ runId }) { events.push(backendEvent(runId, { ...command, cwd: s.cwd })); return events; }, reply: async () => {}, interrupt: async () => {}, close: async () => { closed = true; events.end(); } }) };
  const uiFactory = async ({ signal }) => ({ status() {}, output() {}, result() {}, close: async () => {},
    approve: async () => { setTimeout(() => events.end(new Error('disconnected')), 10); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('approval withdrawn')), { once: true })); } });
  await assert.rejects(coordinate(s, backend, { uiFactory, execute: async () => { executions++; return success; } }), /disconnected/);
  assert.equal(executions, 0); assert.equal(closed, true);
});

test('installation identity is stable under concurrent store initialization', async (t) => {
  const s = await sandbox(t); const stores = await Promise.all(Array.from({ length: 12 }, () => new SessionStore({ env: s.env }).init()));
  assert.equal(new Set(stores.map((store) => store.machineId)).size, 1);
});

test('setup CLI applies idempotently, uninstalls its block, and shell wrapper toggles the parent shell', async (t) => {
  const s = await sandbox(t), zshrc = join(s.dir, 'zshrc'); await writeFile(zshrc, '# original\n');
  const before = await readFile(zshrc, 'utf8'); assert.equal(cli(s, 'setup', '--dry-run', '--zshrc', zshrc).status, 0); assert.equal(await readFile(zshrc, 'utf8'), before);
  const first = cli(s, 'setup', '--yes', '--zshrc', zshrc); assert.equal(first.status, 0, first.stdout);
  assert.match(first.stdout, /当前终端立即启用：eval/);
  const once = await readFile(zshrc, 'utf8'); const second = cli(s, 'setup', '--yes', '--zshrc', zshrc); assert.equal(second.status, 0, second.stdout); assert.equal(await readFile(zshrc, 'utf8'), once);
  assert.equal(cli(s, 'shell', 'uninstall', '--yes', '--zshrc', zshrc).status, 0); assert.equal(await readFile(zshrc, 'utf8'), before);
  const source = new URL('../shell/sayrun.zsh', import.meta.url).pathname;
  const toggle = spawnSync('/bin/zsh', ['-f', '-i', '-c', 'source "$1" >/dev/null; ta shell off; ta shell status; sayrun shell on; sayrun shell status', 'test', source], { env: { ...process.env, ...s.env }, encoding: 'utf8' });
  assert.equal(toggle.status, 0, toggle.stderr); assert.match(toggle.stdout, /enabled=0/); assert.match(toggle.stdout, /enabled=1/);
  const refresh = spawnSync('/bin/zsh', ['-f', '-i', '-c', `source "$1" >/dev/null
    sayrun shell off
    sayrun setup --yes --dry-run --zshrc "$2" >/dev/null
    sayrun shell status
    sayrun setup --yes --no-shell --zshrc "$2" >/dev/null
    sayrun shell status
    ta setup --yes --zshrc "$2" >/dev/null
    sayrun shell status`, 'test', source, zshrc], { env: { ...process.env, ...s.env, TERMINAL_AGENT_DSH_BIN: new URL('./fixture-dsh.mjs', import.meta.url).pathname }, cwd: s.cwd, encoding: 'utf8' });
  assert.equal(refresh.status, 0, refresh.stderr + refresh.stdout);
  assert.deepEqual([...refresh.stdout.matchAll(/enabled=(\d)/g)].map((match) => match[1]), ['0', '0', '1']);
});

test('native resume rejects old tool request IDs without replaying their side effects', async (t) => {
  const s = await sandbox(t), { store, meta, writer } = await stored(s);
  await writer.append('command.requested', { requestId: 'one', proposedCommand: 'printf original' }); await writer.finish('completed');
  let executions = 0;
  const peer = fixture([{ ...command, cwd: s.cwd }]);
  await assert.rejects(coordinate(s, peer.backend, { store, resumeMeta: meta, resumeRef: 'old-native', execute: async () => { executions++; return success; } }), /重放旧/);
  assert.equal(executions, 0); assert.equal(peer.info.replies[0].code, 'stale_request');
});

test('a dead owner lock is recovered once; concurrent writers cannot steal a live lock', async (t) => {
  const s = await sandbox(t), { store, meta, writer } = await stored(s); await writer.finish('completed');
  await writeFile(join(store.path(meta.sessionId), 'lock'), JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.lock(meta.sessionId)));
  const successful = results.filter((r) => r.status === 'fulfilled'); assert.equal(successful.length, 1);
  await successful[0].value();
});
