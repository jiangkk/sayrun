import type { SessionMeta } from '../contracts/history.ts';
import type { SessionStore } from './store.ts';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { projectRoot } from '../platform/project-root.ts';
import { readJson, writeJson } from '../platform/atomic-file.ts';

// Shell identity comes from the integration, never from a terminal device name:
// nested interactive shells may share a TTY but must have independent sessions.
export class ShellSession {
  constructor(private store: SessionStore, private shellId: string) {}
  private path(project: string, backend: string) {
    const key = createHash('sha256').update(JSON.stringify([this.shellId, project, backend])).digest('hex');
    return join(this.store.paths.state, 'shell-sessions', `${key}.json`);
  }
  async current(cwd: string, backend: string) {
    const project = await projectRoot(cwd);
    const binding = await readJson<{ sessionId: string } | null>(this.path(project, backend), null);
    if (!binding) return undefined;
    // Deleted, archived and imported history must never become an active task.
    return (await this.store.list({ cwd, backend })).find((m) => m.sessionId === binding.sessionId
      && !m.readOnly && m.resume === 'native' && m.nativeRef);
  }
  async bind(meta: SessionMeta) {
    await writeJson(this.path(meta.project, meta.backend), { sessionId: meta.sessionId });
  }
}
