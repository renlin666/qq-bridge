// Real DSH attachment -> pi-ai -> selected platform vision check, isolated
// from QQ session mappings. Does not send messages to QQ or publish anything.
import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const api = new NodeApiClient(cfg.dsh.baseUrl, 15000, {});
await api.ensureAuth();
const cwd = path.resolve('state/model-repair-vision-check');
fs.mkdirSync(cwd, { recursive: true });
// An existing session may be checked explicitly while the bridge is stopped.
const sessionArg = process.argv.indexOf('--session');
const { sessionId } = sessionArg >= 0
  ? { sessionId: process.argv[sessionArg + 1] }
  : unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'create');
unwrap(await api.sessions.selectModel({ sessionId, provider: cfg.dsh.provider, model: cfg.dsh.model }), 'select');
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(new Error('Vision check timed out')), 90000);
const stream = api.events.mux({}, abort.signal);
const collector = createTurnCollector();
const evidence = { sessionId, provider: cfg.dsh.provider, model: cfg.dsh.model, toolCalls: 0 };
const endedPromise = (async () => {
  for await (const envelope of stream) {
    const f = envelope.payload;
    if (f.type !== 'session/event' || f.sessionId !== sessionId) continue;
    if (f.event.type === 'request/context') evidence.context = f.event.data;
    if (f.event.type === 'assistant/message') evidence.usage = f.event.data.usage;
    if (f.event.type === 'tool/call') evidence.toolCalls++;
    const ended = collector.push(f.event);
    if (ended) return ended;
  }
  throw new Error('Event stream ended without a turn result');
})();
stream.follow(sessionId);
try {
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [
    { type: 'text', text: '这是隔离的本地视觉维护诊断，不是 QQ 聊天。禁止调用任何工具、发送消息或设置唤醒。请仅在本对话用纯文本读出图片中的字符，并写出两种彩色形状及其颜色。' },
    { type: 'image', mediaType: 'image/png', data: fs.readFileSync(path.resolve('state/vision-diagnostic.png')).toString('base64') }
  ] }), 'prompt');
  const ended = await endedPromise;
  evidence.reason = ended.reason;
  evidence.text = ended.text;
  evidence.ok = ended.reason.kind === 'completed' && /M7K29/.test(ended.text) && /红/.test(ended.text) && /蓝/.test(ended.text) && evidence.toolCalls === 0;
  fs.writeFileSync('state/model-repair-vision-result.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  if (!evidence.ok) process.exitCode = 1;
} finally {
  clearTimeout(timer);
  abort.abort();
  await endedPromise.catch(() => {});
}
