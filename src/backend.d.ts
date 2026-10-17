/** Version 1 host-tools contract. Implementations must never read the host TTY. */
export type BackendCapabilities = {
  hostTools: boolean; commandEditing: boolean; userQuestions: boolean;
  cancellation: 'native' | 'process'; resume: 'native' | 'context-only' | 'none';
  ephemeral: boolean; classify: boolean; modelDiscovery: boolean; usage: boolean;
};
export type BackendEvent = { id: string; runId: string; timestamp: string } & (
  | { type: 'status'; phase: 'thinking' | 'checking'; message?: string }
  | { type: 'message'; text: string; final: boolean }
  | { type: 'command.requested'; requestId: string; command: string; description: string; cwd: string; targetId: string }
  | { type: 'question.requested'; requestId: string; question: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cost?: number }
  | { type: 'run.ended'; reason: 'completed' | 'cancelled' | 'limit' | 'failed'; message?: string }
);
export type HostReply =
  | { requestId: string; kind: 'command'; approved: false; reason: string }
  | { requestId: string; kind: 'command'; approved: true; executionId: string; command: string; cwd: string; targetId: string;
      output: string; exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean; truncated: boolean }
  | { requestId: string; kind: 'answer'; text: string; commandApproval: false }
  | { requestId: string; kind: 'error'; code: string; message: string };
export type ConnectOptions = { cwd: string; targetId: string; model?: string; resumeRef?: string; initialContext?: string; ephemeral: boolean; signal?: AbortSignal };
export interface BackendSession {
  nativeRef?: string;
  run(input: { runId: string; prompt: string; signal: AbortSignal }): AsyncIterable<BackendEvent>;
  reply(result: HostReply): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
export interface AgentBackend {
  id: string; apiVersion: 1;
  probe(): Promise<{ available: boolean; version?: string; capabilities: BackendCapabilities; diagnostics: string[] }>;
  connect(options: ConnectOptions): Promise<BackendSession>;
  classify?(input: string, options: { cwd: string; timeoutMs: number; threshold: number; signal?: AbortSignal }): Promise<'shell' | 'agent' | 'ask'>;
}
