import { createInterface } from 'node:readline/promises';
import { write } from './display.mjs';
import { hostname } from 'node:os';
import { StepTranscript } from './transcript.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './storage.mjs';
import { runEditor } from './setup.mjs';

export async function createTerminalUi(options) {
  if ((options.uiConfig?.mode ?? process.env.TERMINAL_AGENT_UI) === 'plain') return new PlainUi(options);
  const { createOpenTui } = await import(new URL('./ui-opentui.mjs', import.meta.url).href);
  return createOpenTui(options);
}

// Explicit compatibility mode for limited terminals; the default is OpenTUI.
class PlainUi {
  constructor({ input, output, onCancel, signal, uiConfig = {}, approvalConfig = {} }) {
    this.readline = createInterface({ input, output });
    this.readline.on('SIGINT', onCancel);
    this.readline.on('close', () => { if (!this.closed) onCancel(); });
    this.signal = signal; this.approvalConfig = approvalConfig;
    this.host = hostname();
    this.transcript = new StepTranscript(output, { previewLines: uiConfig.output_preview_lines, color: uiConfig.color === 'always' ? true : uiConfig.color === 'never' ? false : undefined });
  }
  status(text) { write(`\n[agent] ${text}\n`); }
  message(text) { write(`\n${text}\n`); }
  async requestInput({ question }) {
    if (question) write(`\n◇ ${question}\n`);
    for (;;) {
      const answer = (await this.readline.question('补充信息：', { signal: this.signal })).trim();
      if (answer && answer.length <= 8192 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(answer)) return answer;
      write('请输入有效内容（最多 8192 字符），或按 Ctrl-C 取消。\n');
    }
  }
  async approve(proposal, count, max) {
    write(`\n[审批 ${count}/${max}] ${proposal.description}\n主机：${this.host ?? '本机'}\n目录：${proposal.cwd}\n命令（${proposal.shell ?? 'zsh'} -f）：\n${proposal.command}\n`);
    let answer = (await this.readline.question('执行？[Y/n/q] （e：用 EDITOR 编辑） ', { signal: this.signal })).trim();
    if (!answer && this.approvalConfig.default_selection === 'edit' && !proposal.decisionSource || answer.toLowerCase() === 'e') {
      const temp = await mkdtemp(join(tmpdir(), 'ta-command-edit-')), file = join(temp, 'command.zsh');
      try {
        await atomicWrite(file, proposal.command); this.readline.pause(); runEditor(file); this.readline.resume();
        const command = await readFile(file, 'utf8');
        if (!command.trim() || command.length > 32768 || /[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error('编辑后的命令无效');
        return this.approve({ ...proposal, command, decisionSource: 'external-editor-approve' }, count, max);
      } finally { this.readline.resume(); await rm(temp, { recursive: true, force: true }); }
    }
    if (!answer && this.approvalConfig.default_selection === 'reject' || !/^(?:y(?:es)?)?$/i.test(answer)) return null;
    this.transcript.start(proposal, count);
    return proposal;
  }
  output(text) { this.transcript.append(text); }
  result(result) { this.transcript.complete(result); }
  finish(text) { write(`\n[agent] ${text}\n`); }
  async close() { this.closed = true; this.readline.close(); }
}
