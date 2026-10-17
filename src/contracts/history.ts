import type { Config } from './config.ts';
import type { ExecutionResult } from './execution.ts';
import type { BackendCapabilities } from './backend.ts';

export type RunStatus = 'starting' | 'thinking' | 'awaiting_approval' | 'awaiting_input' | 'executing' | 'stopped' | 'limited' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'imported' | 'ready';
export interface SessionMeta {
  schemaVersion: number; sessionId: string; machineId: string; project: string; cwd: string;
  title: string; backend: string; model?: string; config?: Config; kind: string; status: RunStatus;
  createdAt: string; updatedAt: string; pinned: boolean; archived: boolean; commands: number;
  resume: BackendCapabilities['resume']; readOnly: boolean; parentSessionId?: string; source?: string;
  nativeRef?: string; nativeHome?: string; nativeManaged?: boolean; duplicate?: boolean;
}
// The journal is versioned independently of the backend wire protocol. Older
// records can omit fields, so readers must keep their existing runtime checks.
export interface HistoryEvent extends Partial<ExecutionResult> {
  schemaVersion: number; sessionId: string; runId: string; seq: number; timestamp: string; type: string;
  requestId?: string; executionId?: string; originalRunId?: string; outcome?: string;
  prompt?: string; config?: Config; text?: string; final?: boolean; question?: string;
  commandApproval?: boolean; proposedCommand?: string; executedCommand?: string; cwd?: string;
  targetId?: string; decisionSource?: string; approved?: boolean; source?: string; outputRef?: string;
  status?: RunStatus; message?: string; output?: string; contextOutputTruncated?: boolean;
}
export type EventDetail = Omit<Partial<HistoryEvent>, 'schemaVersion' | 'sessionId' | 'runId' | 'seq' | 'timestamp' | 'type'> & Record<string, unknown>;
export interface SessionData { schemaVersion: number; meta: SessionMeta; events: HistoryEvent[]; outputs: Record<string, string> }
export interface CreateSessionOptions {
  prompt: string; cwd: string; backend: string; model?: string; config?: Config;
  kind?: string; parentSessionId?: string; source?: string; readOnly?: boolean;
}
export interface ListSessionsOptions { cwd?: string; all?: boolean; includeClassifier?: boolean; backend?: string; status?: string; archived?: boolean }

export type SessionImport = Omit<SessionData, 'meta'> & { meta: Pick<SessionMeta, 'sessionId' | 'cwd' | 'title' | 'backend'> & Partial<SessionMeta> };
