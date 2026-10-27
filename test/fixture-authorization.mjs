// Run via node --import tsx in a PTY. No real sudo or model is invoked.
import { runAgent } from '../src/application/run-task.ts';
import { defaults } from '../src/config/defaults.ts';
import { backendEvent } from '../src/backends/protocol.ts';
import { dshCapabilities } from '../src/backends/dsh/backend.ts';
import { writeFile } from 'node:fs/promises';

const config = structuredClone(defaults);
const mode = process.argv[2];
config.approval.mode = mode === 'normal-sudo' ? 'normal' : mode; config.ui.mode = process.argv[3]; config.history.enabled = false;
const python = 'import os,sys,time; fd=os.open("/dev/tty",os.O_RDONLY); assert os.getsid(0)==int(sys.argv[1]); assert os.getpgrp()!=os.tcgetpgrp(fd); assert sys.stdin.read()==""; print("TTY_VERIFIED",flush=True)';
const commands = config.approval.mode === 'full'
  ? [`python3 -c '${python}' ${process.env.AUTH_SESSION}`, `python3 -c 'import os,time; print("SLEEP_READY",flush=True); open("sleeper.pid","w").write(str(os.getpid())); time.sleep(30)'`]
  : [mode === 'normal-sudo' ? 'printf "sudo simulated"' : 'printf AUTO_FIRST', 'printf AUTO_SECOND'];
let auth = 0, closed = 0;
const backend = { id: 'fixture', apiVersion: 1, probe: async () => ({ available: true, capabilities: dshCapabilities, diagnostics: [] }),
  connect: async () => ({ async *run({ runId }) {
    for (const [index, command] of commands.entries()) yield backendEvent(runId, { type: 'command.requested', requestId: String(index), command, description: 'authorization PTY test', targetId: 'local-zsh' });
    yield backendEvent(runId, { type: 'run.ended', reason: 'completed' });
  }, reply: async (reply) => { if (reply.exitCode !== 0 && !reply.cancelled) throw new Error(`command failed: ${reply.output}`); }, close: async () => {} }) };
try {
  await runAgent('authorization test', { config, backend,
    authorizeSudo: async () => {
      if (process.stdin.isRaw) throw new Error('sudo authentication must own a cooked terminal');
      auth++; return { check: async () => {}, close: async () => { closed++; } };
    },
  });
} catch (error) {
  if (error.exitCode !== 130) { console.error(error); process.exitCode = 1; }
  else console.log('CANCELLED_OK');
}
await writeFile('auth.json', JSON.stringify({ auth, closed }));
