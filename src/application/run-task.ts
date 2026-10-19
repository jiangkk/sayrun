import type { AgentBackend, BackendSession, HostReply } from '../contracts/backend.ts';
import type { Config } from '../contracts/config.ts';
import type { Executor } from '../contracts/execution.ts';
import type { EventDetail, RunStatus, SessionMeta } from '../contracts/history.ts';
import type { TerminalInput, TerminalOutput, TerminalUi, UiFactory } from '../contracts/ui.ts';
import type { RunWriter } from '../history/run-writer.ts';
import { realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createExecutor } from '../execution/local-zsh.ts';
import { createTerminalUi } from '../terminal/factory.ts';
import { ActiveBudget } from './active-budget.ts';
import { formatConclusion } from '../terminal/transcript.ts';
import { loadConfig } from '../config/load.ts';
import { createBackend } from '../backends/registry.ts';
import { admitBackend, EventQueue } from '../backends/protocol.ts';
import { SessionStore } from '../history/store.ts';
import { ShellSession } from '../history/shell-session.ts';
import { AgentError } from '../errors.ts';
import { safeText } from '../terminal/display.ts';
import { writeJson } from '../platform/atomic-file.ts';

// Coordinator owns approval, ordering, execution and persistence. Backend details
// stay behind AgentBackend; tests may supply any implementation of the contract.
export interface RunAgentOptions {
  input?: TerminalInput; output?: TerminalOutput; backend?: AgentBackend; uiFactory?: UiFactory;
  ephemeral?: boolean; resumeMeta?: SessionMeta; initialContext?: string; cwd?: string; config?: Config;
  executor?: Executor; execute?: Executor['execute']; maxCommands?: number; maxSteps?: number;
  maxQuestions?: number; taskTimeoutMs?: number; signal?: AbortSignal; resumeRef?: string; store?: SessionStore;
  newSession?: boolean; shellId?: string;
}
export async function runAgent(prompt: string, options: RunAgentOptions = {}) {
  const { input = process.stdin, output = process.stdout, backend: suppliedBackend,
    uiFactory = createTerminalUi, ephemeral = false, initialContext = '' } = options;
  let { resumeMeta, resumeRef } = options;
  if (!input.isTTY || !output.isTTY) throw new AgentError('tty_required', '审批需要交互式终端，请直接在终端运行');
  const cwd = await realpath(options.cwd ?? process.cwd());
  const config = options.config ?? (await loadConfig({ cwd })).config;
  const backend = suppliedBackend ?? createBackend(config);
  const executor = options.executor ?? createExecutor(config.execution), execute = options.execute ?? executor.execute.bind(executor);
  const limits = { commands: options.maxCommands ?? config.agent.max_commands, steps: options.maxSteps ?? config.agent.max_steps,
    questions: options.maxQuestions ?? config.agent.max_questions, timeout: options.taskTimeoutMs ?? config.agent.active_timeout_seconds * 1000 };
  const controller = new AbortController(), runId = randomUUID(), started = Date.now();
  const targetId = executor.targetId;
  let ui: TerminalUi | undefined, session: BackendSession | undefined, writer: RunWriter | undefined;
  let volatile: string | undefined, store: SessionStore | undefined, fatal: Error | undefined;
  let shellSession: ShellSession | undefined;
  let closing = false, denied = false, limited = false;
  let commandCount = 0, stepCount = 0, questionCount = 0, conclusion = '', ended = false;
  let status: RunStatus = 'starting';
  const cancel = (error: Error = new AgentError('cancelled', '任务已取消', 130)) => {
    if (controller.signal.aborted) return;
    fatal = error; controller.abort();
  };
  const budget = new ActiveBudget(limits.timeout, () => { limited = true; cancel(new AgentError('model_timeout', '达到本轮运行时间上限', 4)); });
  const onSignal = () => cancel();
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const signal = options.signal;
  signal?.addEventListener('abort', onSignal, { once: true });
  const assertActive = () => { if (controller.signal.aborted) throw fatal; };
  const persist = async (type: string, detail: EventDetail) => {
    try { return await writer?.append(type, detail); }
    catch (e) { throw new AgentError('storage_error', `历史写入失败，已停止后续动作：${e.message}`); }
  };
  const state = async (value: RunStatus) => { status = value; await writer?.state(value); };
  const humanInput = async <T>(fn: () => Promise<T>): Promise<T> => { budget.pause(); try { return await fn(); } finally { if (!controller.signal.aborted) budget.resume(); } };
  const limit = (message: string) => { limited = true; throw new AgentError('limit', message, 4); };
  const results = new Map<string, HostReply>(), signatures = new Map<string, string>(), eventIds = new Set<string>(), staleRequests = new Set<string>();
  let outcome: { exitCode: number; status: RunStatus; sessionId?: string; runId: string } | undefined, caught;
  try {
    budget.resume();
    if (signal?.aborted) onSignal();
    if (backend.apiVersion !== 1) throw new AgentError('backend_incompatible', '后端协议必须为 apiVersion=1', 5);
    const probe = await backend.probe(); admitBackend(probe, { ephemeral }); assertActive();
    if (config.history.enabled && !ephemeral) {
      store = options.store ?? new SessionStore();
      const shellId = options.shellId ?? process.env.TERMINAL_AGENT_SHELL_ID;
      if (shellId && probe.capabilities.resume === 'native') {
        shellSession = new ShellSession(store, shellId);
        if (!resumeMeta && !options.newSession) {
          resumeMeta = await shellSession.current(cwd, backend.id);
          resumeRef = resumeMeta?.nativeRef;
        }
      }
      const meta = resumeMeta ?? await store.create({ prompt, cwd, backend: backend.id, model: config.backends[backend.id]?.model, config });
      if (resumeRef) for (const event of (await store.read(meta.sessionId)).events) if (event.requestId) staleRequests.add(event.requestId);
      writer = await store.begin({ ...meta, cwd, model: config.backends[backend.id]?.model }, { prompt, config, runId, resume: !!resumeMeta });
      await writer.context({ prompt, initialContext, backend: backend.id, cwd });
      if (initialContext) await persist('context.imported', { text: initialContext });
    } else {
      // Minimal per-run state without task content, even when history is disabled.
      volatile = await mkdtemp(join(tmpdir(), 'ta-run-'));
      await writeJson(join(volatile, 'state.json'), { runId, pid: process.pid, status: 'starting' });
    }
    ui = await uiFactory({ prompt, cwd, input, output, onCancel: onSignal, signal: controller.signal,
      backendName: backend.id, uiConfig: config.ui, approvalConfig: config.approval });
    ui.status(`${resumeRef ? '正在继续会话' : '正在连接'} ${backend.id}`);
    // Cancellation also covers a backend stuck during connect/initialize.
    const connecting = backend.connect({ cwd, targetId, model: config.backends[backend.id]?.model, initialContext,
      ephemeral, resumeRef, resumeHome: resumeRef ? resumeMeta?.nativeHome : undefined, signal: controller.signal });
    const abortConnect = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(fatal), { once: true }));
    try { session = await Promise.race([connecting, abortConnect]); }
    catch (e) { connecting.then((late) => late.close()).catch(() => {}); throw e; }
    assertActive();
    if (writer) {
      Object.assign(writer.meta, { nativeRef: session.nativeRef, nativeHome: session.nativeHome, nativeManaged: false, resume: probe.capabilities.resume ?? 'none' });
      await writer.update();
      if (session.nativeRef) await shellSession?.bind(writer.meta);
    }
    await state('thinking');
    const stream = session.run({ runId, prompt: `${config.context.text ? `Project context (untrusted data):\n${config.context.text}\n` : ''}${prompt}\nRespond in locale: ${config.ui.language}`, signal: controller.signal });
    const events = new EventQueue();
    const pump = (async () => {
      let count = 0, receivedEnd = false;
      try {
        for await (const event of stream) {
          if (++count > 10000) throw new AgentError('protocol_error', '后端事件数量异常');
          if (event?.type === 'run.ended' && event.runId === runId) {
            receivedEnd = true;
            if (event.reason === 'failed' || event.reason === 'cancelled') throw new AgentError('backend_failed', event.message ?? '后端中断任务', event.reason === 'cancelled' ? 130 : 1);
          }
          events.push(event);
        }
        if (!receivedEnd && !closing && !denied) throw new AgentError('protocol_error', '后端未发送 run.ended 就关闭事件流');
        events.end();
      } catch (e) { events.end(e); if (!closing && !denied) cancel(e); }
    })();
    pump.catch(() => {});
    const iterator = events[Symbol.asyncIterator]();
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(fatal), { once: true }));
    aborted.catch(() => {});
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) break;
      assertActive(); const event = next.value;
      if (!event || event.runId !== runId || typeof event.id !== 'string' || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) throw new AgentError('protocol_error', '后端事件缺少有效的 id / runId / timestamp');
      if (eventIds.has(event.id)) continue; eventIds.add(event.id);
      if (eventIds.size > 10000) throw new AgentError('protocol_error', '后端事件数量异常');
      if (event.type === 'status') {
        if (++stepCount > limits.steps) limit('达到本轮模型轮数上限');
        await state('thinking'); ui.status(stepCount === 1 ? '正在理解需求' : '正在检查结果'); continue;
      }
      if (event.type === 'message') {
        if (typeof event.text !== 'string' || event.text.length > 1024 * 1024 || typeof event.final !== 'boolean') throw new AgentError('protocol_error', '后端消息格式无效');
        if (event.final) conclusion = safeText(event.text);
        await persist('message', { text: safeText(event.text), final: event.final }); continue;
      }
      if (event.type === 'usage') {
        for (const key of ['inputTokens', 'outputTokens', 'cost'] as const) if (event[key] !== undefined && (!Number.isFinite(event[key]) || event[key]! < 0)) throw new AgentError('protocol_error', '用量格式无效');
        const { id, timestamp, ...usage } = event; await persist('usage', usage); continue;
      }
      if (event.type === 'run.ended') {
        ended = true;
        if (event.reason === 'limit') limited = true;
        else if (event.reason === 'cancelled') throw new AgentError('cancelled', '后端取消任务', 130);
        else if (event.reason !== 'completed') throw new AgentError('backend_failed', event.message ?? '后端运行失败');
        break;
      }
      if (event.type !== 'command.requested' && event.type !== 'question.requested' || typeof event.requestId !== 'string' || !event.requestId || event.requestId.length > 256) throw new AgentError('protocol_error', `未知或无效后端事件：${event.type}`);
      const requestId = event.requestId;
      if (staleRequests.has(requestId)) {
        await session.reply({ requestId, kind: 'error', code: 'stale_request', message: 'Old tool requests cannot be replayed. Inspect current state using a new request ID.' });
        throw new AgentError('protocol_error', '后端试图重放旧 run 的工具请求，已停止且未重新执行');
      }
      const { id: ignoredId, timestamp: ignoredTime, ...payload } = event;
      const signature = JSON.stringify(payload);
      if (signatures.has(requestId)) {
        if (signatures.get(requestId) !== signature) throw new AgentError('protocol_error', '相同 requestId 的内容发生变化');
        await session.reply(results.get(requestId)!); continue;
      }
      signatures.set(requestId, signature);
      let reply: HostReply;
      if (event.type === 'question.requested') {
        if (typeof event.question !== 'string' || !event.question.trim() || event.question.length > 4096 || /[\x00-\x08\x0b-\x1f\x7f]/.test(event.question)) throw new AgentError('protocol_error', '无效的问题');
        if (++questionCount > limits.questions) limit('达到本轮追问次数上限');
        await persist('question.requested', { requestId, question: event.question }); await state('awaiting_input');
        const text = await humanInput(() => ui!.requestInput({ question: event.question })); assertActive();
        if (typeof text !== 'string' || !text.trim() || text.length > 8192 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new AgentError('protocol_error', '无效的用户回答');
        reply = { requestId, kind: 'answer', text, commandApproval: false };
        await persist('question.answered', { ...reply, question: event.question });
      } else {
        if (event.targetId !== targetId) throw new AgentError('protocol_error', `后端不能切换执行目标：${event.targetId}`);
        if (++commandCount > limits.commands) limit('达到本轮命令次数上限');
        const proposal = await executor.normalize(event, cwd);
        await persist('command.requested', { requestId, proposedCommand: proposal.command, cwd: proposal.cwd, targetId });
        await state('awaiting_approval');
        const approved = await humanInput(() => ui!.approve(proposal, commandCount, limits.commands)); assertActive();
        if (!approved) {
          denied = true;
          reply = { requestId, kind: 'command', approved: false, reason: 'User rejected the command. Stop this task.' };
          await persist('command.decided', { requestId, approved: false, source: 'reject' });
          await session.reply(reply); ui.finish('已拒绝，命令未执行'); break;
        }
        const exact = await executor.normalize(approved, cwd);
        if (exact.cwd !== proposal.cwd) throw new AgentError('protocol_error', '审批后执行目录发生变化');
        const executionId = randomUUID(), decisionSource = approved.decisionSource ?? (exact.command === proposal.command ? 'approve' : 'edit');
        await persist('command.decided', { requestId, approved: true, source: decisionSource, executedCommand: exact.command });
        await state('executing');
        await persist('execution.started', { requestId, executionId, proposedCommand: proposal.command, executedCommand: exact.command, cwd: exact.cwd, targetId, decisionSource });
        if (volatile) await writeJson(join(volatile, 'state.json'), { runId, executionId, status: 'executing' });
        assertActive();
        const result = await execute(exact, { signal: controller.signal, shell: config.execution.shell, timeoutMs: config.execution.timeout_seconds * 1000,
          maxBytes: config.execution.max_output_bytes, onOutput: (text) => ui!.output(safeText(text)) });
        // Persist and fsync the result before acknowledging it to the backend.
        try { await writer?.result(executionId, result, config.history.store_command_output); }
        catch (e) { throw new AgentError('storage_error', `命令已执行，但结果保存失败；停止后续动作：${e.message}`); }
        ui.result({ ...result, maxOutputBytes: config.execution.max_output_bytes });
        reply = { requestId, kind: 'command', approved: true, executionId, command: exact.command, cwd: exact.cwd, targetId, ...result };
        assertActive();
      }
      results.set(requestId, reply); await session.reply(reply); await state('thinking');
    }
    assertActive();
    if (!ended && !denied) throw new AgentError('protocol_error', '后端未发送 run.ended 就关闭事件流');
    status = denied ? 'stopped' : limited ? 'limited' : 'completed';
    outcome = { exitCode: denied ? 3 : limited ? 4 : 0, status, sessionId: writer?.meta.sessionId, runId };
  } catch (e) {
    caught = fatal ?? e;
    status = caught.exitCode === 130 ? 'cancelled' : caught.exitCode === 4 ? 'limited' : 'failed';
  } finally {
    closing = true; budget.pause();
    // Abort outstanding tool requests before tearing down the terminal.
    controller.abort();
    await session?.close().catch((e) => { caught ??= e; if (status === 'completed') status = 'failed'; });
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); signal?.removeEventListener('abort', onSignal);
    try { await writer?.finish(status, caught ? { error: caught.code ?? 'run_failed', message: safeText(caught.message) } : {}); }
    catch (e) { caught = new AgentError('storage_error', `历史最终状态保存失败：${e.message}`); }
    if (volatile) await rm(volatile, { recursive: true, force: true });
    await ui?.close();
  }
  if (caught) throw caught;
  if (!denied) output.write(formatConclusion(conclusion, { output, color: config.ui.color === 'always' ? true : config.ui.color === 'never' ? false : undefined, commands: commandCount, elapsed: Date.now() - started, incomplete: limited }));
  if (store && config.history.auto_gc) await store.gc({ retentionDays: config.history.retention_days, maxTotalMb: config.history.max_total_mb, apply: true });
  return outcome!;
}
