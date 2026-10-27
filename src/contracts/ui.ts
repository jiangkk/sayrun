import type { Config } from './config.ts';
import type { CommandProposal, ExecutionResult } from './execution.ts';

export type TerminalInput = NodeJS.ReadStream;
export type TerminalOutput = NodeJS.WriteStream;
export interface UiOptions {
  prompt: string; cwd: string; input: TerminalInput; output: TerminalOutput;
  onCancel: () => void; signal?: AbortSignal; animate?: boolean; backendName?: string;
  uiConfig?: Partial<Config['ui']>; approvalConfig?: Partial<Config['approval']>;
}
export type DisplayResult = ExecutionResult & { maxOutputBytes?: number };
export interface TerminalUi {
  status(text: string): void;
  message(text: string): void;
  requestInput(request: { question: string }): Promise<string>;
  approve(proposal: CommandProposal, count: number, max: number): Promise<CommandProposal | null>;
  command(proposal: CommandProposal, count: number, max: number): void;
  external<T>(action: () => Promise<T>): Promise<T>;
  output(text: string): void;
  result(result: DisplayResult): void;
  finish(text: string): void;
  close(): Promise<void>;
}
export type UiFactory = (options: UiOptions) => Promise<TerminalUi>;
export type StyleName = 'accent' | 'muted' | 'text' | 'green' | 'amber' | 'red' | 'bold';
export type TranscriptRows = { text: string; style?: StyleName }[][];
