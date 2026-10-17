import type { SessionData } from '../contracts/history.ts';

export function visibleContext(data: SessionData, { maxBytes = 32768 } = {}) {
  const relevant = data.events.filter((e) => ['run.started', 'message', 'execution.started', 'execution.result', 'question.answered', 'run.ended', 'context.imported'].includes(e.type));
  const chunks = relevant.map((event) => {
    const { config, outputRef, ...visible } = event;
    if (outputRef && data.outputs[outputRef]) { visible.output = data.outputs[outputRef].slice(-4096); visible.contextOutputTruncated = data.outputs[outputRef].length > 4096; }
    return JSON.stringify(visible);
  });
  const chosen = []; let bytes = 0;
  for (const chunk of chunks.reverse()) { const n = Buffer.byteLength(chunk); if (bytes + n > maxBytes) continue; chosen.unshift(chunk); bytes += n; }
  return { text: chosen.join('\n'), included: chosen.length, total: relevant.length, bytes };
}
