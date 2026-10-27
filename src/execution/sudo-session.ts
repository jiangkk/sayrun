import { spawn } from 'node:child_process';
import { AgentError } from '../errors.ts';

export interface SudoSession { check(): Promise<void>; close(): Promise<void> }
export type SudoRunner = (interactive: boolean, signal: AbortSignal) => Promise<void>;

const runSudo: SudoRunner = (interactive, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new AgentError('cancelled', '任务已取消', 130));
  // The password stays in sudo's inherited terminal; never read or store it.
  const child = spawn('/usr/bin/sudo', interactive ? ['-v'] : ['-n', '-v'], { stdio: interactive ? 'inherit' : 'ignore' });
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill('SIGTERM');
    hardKill ??= setTimeout(() => child.kill('SIGKILL'), 500);
    hardKill.unref();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timeout = interactive ? undefined : setTimeout(abort, 5000);
  const cleanup = () => { signal.removeEventListener('abort', abort); clearTimeout(timeout); clearTimeout(hardKill); };
  child.once('error', (error) => { cleanup(); reject(new AgentError('sudo_failed', `无法启动 sudo：${error.message}`)); });
  child.once('close', (code, exitSignal) => {
    cleanup();
    if (signal.aborted || exitSignal === 'SIGINT') reject(new AgentError('cancelled', 'sudo 验证已取消', 130));
    else if (code !== 0) reject(new AgentError('sudo_failed', 'sudo 验证失败或凭据已失效，已停止任务'));
    else resolve();
  });
});

export async function startSudoSession({ signal, onFailure, run = runSudo, refreshMs = 30000 }: {
  signal: AbortSignal; onFailure: (error: Error) => void; run?: SudoRunner; refreshMs?: number;
}): Promise<SudoSession> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let pending = Promise.resolve();
  try { await run(true, controller.signal); }
  catch (error) { signal.removeEventListener('abort', abort); throw error; }
  const check = () => {
    pending = pending.then(() => run(false, controller.signal));
    return pending;
  };
  const timer = setInterval(() => { check().catch(onFailure); }, refreshMs);
  timer.unref();
  return { check, async close() {
    clearInterval(timer); signal.removeEventListener('abort', abort); controller.abort();
    await pending.catch(() => {});
  } };
}
