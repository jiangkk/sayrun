#!/usr/bin/env node
// Deterministic SDK peer used only by the PTY regression tests, not by the app.
import { createInterface } from 'node:readline';
import http from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('fixture-dsh 0.2.0-rc.2'); process.exit(0); }
const rl = createInterface({ input: process.stdin });
const send = (value) => console.log(JSON.stringify(value));
const event = (sessionId, type, data) => send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, data } } });
function bridge(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: process.env.TERMINAL_AGENT_SOCKET, path, method: 'POST', headers: { authorization: `Bearer ${process.env.TERMINAL_AGENT_TOKEN}` } }, (res) => {
      let data=''; res.on('data', (s) => {data+=s;}); res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
const execute = (command) => bridge('/execute', { command, description: 'PTY regression command' });
const assistant = (id, text) => event(id, 'assistant/message', { message: { content: [{ type: 'text', text }] } });
const sessions = new Map();
const sessionPath = (id) => join(process.env.DSH_HOME, 'fixture-sessions', `${id}.json`);
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (process.env.TERMINAL_AGENT_FIXTURE_TRACE) appendFileSync(process.env.TERMINAL_AGENT_FIXTURE_TRACE, JSON.stringify({ method: msg.method, params: msg.params }) + '\n');
  if (msg.method === 'initialize') return send({ id: msg.id, result: { serverInfo: { name: 'fixture', version: '1' } } });
  if (msg.method === 'session/resume') {
    try {
      if (process.env.TERMINAL_AGENT_FIXTURE_SCENARIO === 'resume-fails') throw new Error('fixture resume failure');
      sessions.set(msg.params.sessionId, JSON.parse(readFileSync(sessionPath(msg.params.sessionId), 'utf8')));
      return send({ id: msg.id, result: {} });
    } catch (e) { return send({ id: msg.id, error: { code: -32000, message: e.message } }); }
  }
  if (msg.method === 'session/working-directory/set') return send({ id: msg.id, result: { cwd: msg.params.path } });
  if (msg.method === 'shutdown') {
    mkdirSync(join(process.env.DSH_HOME, 'fixture-sessions'), { recursive: true });
    for (const [id, state] of sessions) writeFileSync(sessionPath(id), JSON.stringify(state));
    send({ id: msg.id, result: {} });
    rl.close(); process.stdin.destroy(); return;
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    const state = sessions.get(sessionId) ?? { turns: 0 };
    state.turns++; sessions.set(sessionId, state);
    send({ id: msg.id, result: { messageId: 'fixture' } });
    try {
      event(sessionId, 'step/start', {});
      if (sessionId.startsWith('classify-')) {
        if (process.env.TERMINAL_AGENT_FIXTURE_SCENARIO === 'classifier-tool-attempt') event(sessionId, 'tool/call', {});
        assistant(sessionId, JSON.stringify({ route: msg.params.contentBlocks[0].text.includes('find largest') ? 'agent' : 'shell', confidence: 0.99 }));
        event(sessionId, 'turn/end', { reason: { kind: 'completed' } });
        return;
      }
      if (process.env.TERMINAL_AGENT_FIXTURE_SCENARIO === 'question') {
        const answer = await bridge('/question', { question: 'QUESTION_FIXTURE_SCOPE：请输入范围' });
        if (answer.answer !== 'y' || answer.commandApproval !== false) throw new Error('question answer is not an approval');
      }
      event(sessionId, 'assistant/message', { message: { content: [
        { type: 'text', text: 'INTERNAL_PLAN_SHOULD_NOT_APPEAR' }, { type: 'tool-call' },
      ] } });
      const first = await execute('printf FIRST_STEP; exit 7');
      if (first.exitCode !== 7) throw new Error('fixture expected exit 7');
      event(sessionId, 'step/start', {});
      const second = await execute('printf VERIFIED_RESULT');
      if (second.exitCode !== 0 || second.output !== 'VERIFIED_RESULT') throw new Error('fixture verification failed');
      assistant(sessionId, `**FIXTURE_COMPLETED_WITH_VERIFICATION**\n\n### 验证结果\n- 已收到 \`VERIFIED_RESULT\`。\n- NATIVE_TURN_${state.turns}\n- FINAL_ANSWER_END`);
      event(sessionId, 'turn/end', { reason: { kind: process.env.TERMINAL_AGENT_FIXTURE_SCENARIO === 'max-tokens' ? 'max-tokens' : 'completed' } });
    } catch (e) {
      event(sessionId, 'turn/end', { reason: { kind: 'error', error: { message: e.message } } });
    }
  }
});
