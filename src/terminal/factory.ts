import type { TerminalUi, UiOptions } from '../contracts/ui.ts';
import { PlainUi } from './plain.ts';

export async function createTerminalUi(options: UiOptions): Promise<TerminalUi> {
  if ((options.uiConfig?.mode ?? process.env.TERMINAL_AGENT_UI) === 'plain') return new PlainUi(options);
  const { createOpenTui } = await import(new URL(typeof __TERMINAL_AGENT_BUILD__ !== 'undefined' ? './ui-opentui.js' : './ui-opentui.ts', import.meta.url).href);
  return createOpenTui(options);
}
