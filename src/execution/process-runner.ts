import type { CommandInput, CommandProposal, ExecutionOptions, ExecutionResult } from '../contracts/execution.ts';
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function normalizeCommand(args: CommandInput, defaultCwd: string): Promise<Readonly<CommandProposal>> {
  if (!args || typeof args.command !== 'string' || !args.command.trim() || args.command.length > 32768) {
    throw new Error('命令为空或过长');
  }
  if (typeof args.description !== 'string' || !args.description.trim()) throw new Error('缺少命令说明');
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(args.command)) throw new Error('命令包含不可显示的控制字符');
  if (args.cwd !== undefined && (typeof args.cwd !== 'string' || !isAbsolute(args.cwd))) {
    throw new Error('执行目录必须是绝对路径');
  }
  const cwd = await realpath(args.cwd ?? defaultCwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('执行目录不存在');
  // Freeze the exact proposal before presenting it for approval.
  return Object.freeze({ command: args.command, description: args.description, cwd });
}

export function runCommand(proposal: CommandProposal, { signal, onOutput = () => {}, timeoutMs = 30000, maxBytes = 65536, shell = '/bin/zsh', env = process.env, preserveTerminal = false }: ExecutionOptions = {}): Promise<ExecutionResult> {
  return new Promise<ExecutionResult>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('任务已取消'));
    // Do not hand model credentials or bridge authorization to generated commands.
    const commandEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key) &&
      !key.startsWith('TERMINAL_AGENT_') && !key.startsWith('DSH_')));
    // sudo's default credentials are scoped to the controlling terminal. zsh's
    // noninteractive job-control bootstrap creates a separate process group
    // without setsid(), then closes stdin before running the exact command.
    // Keep the bootstrap alive so zsh cannot restore its old group via exec.
    const args = preserveTerminal ? ['-m', '-f', '-c', 'exec </dev/null; unsetopt monitor; "$@"; result=$?; exit $result', 'sayrun', shell, '-f', '-c', proposal.command] : ['-f', '-c', proposal.command];
    const child = spawn(shell, args, {
      cwd: proposal.cwd, env: commandEnv, stdio: [preserveTerminal ? 'inherit' : 'ignore', 'pipe', 'pipe'], detached: !preserveTerminal,
    });
    let output = '', bytes = 0, truncated = false, timedOut = false, settled = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      hardKill ??= setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 500);
      hardKill.unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const collect = (chunk: string) => {
      const available = Math.max(0, maxBytes - bytes);
      const bounded = Buffer.from(chunk).subarray(0, available);
      let accepted = '';
      for (let end = bounded.length; end >= Math.max(0, bounded.length - 3); end--) {
        try { accepted = new TextDecoder('utf-8', { fatal: true }).decode(bounded.subarray(0, end)); break; } catch {}
      }
      bytes += Buffer.byteLength(chunk);
      if (accepted) { output += accepted; onOutput(accepted); }
      if (bytes > maxBytes) truncated = true;
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    child.once('error', (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.once('close', (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Terminate any ordinary descendants left by the command as well.
      kill();
      resolve({ exitCode, signal: exitSignal, timedOut, cancelled: signal?.aborted ?? false, truncated, output });
    });
  });
}
