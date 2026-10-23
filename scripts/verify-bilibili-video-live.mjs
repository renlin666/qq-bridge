// Read-only QQ integration check plus an isolated DSH vision check.
// Never prompts a QQ-mapped agent or sends/publishes messages.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--key') || !process.argv.includes('--message')) throw new Error('Pass --key and --message for an existing received video card');
const key = arg('--key'), messageId = arg('--message');
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const social = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8'));
const token = social.conversations[key]?.agentToken;
if (!token) throw new Error('Conversation token missing');
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp-snowluma-safe.js')], cwd: process.cwd(), stderr: 'pipe' });
const client = new Client({ name: 'bilibili-read-only-verification', version: '1.0' });
let tool;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const descriptor = tools.find(t => t.name === 'qq_read_bilibili');
  if (!descriptor?.inputSchema?.properties?.startSeconds) throw new Error('Old video tool schema');
  tool = await client.callTool({ name: 'qq_read_bilibili', arguments: { key, token, messageId } }, undefined, { timeout: 600000 });
  if (tool.isError) throw new Error(tool.content?.[0]?.text);
} finally { await client.close(); }
const data = JSON.parse(tool.content[0].text);
const images = tool.content.filter(b => b.type === 'image');
const evidence = { video: data.video.bvid, frameCount: images.length, timestamps: data.video.frameTimestamps,
  transcriptStatus: data.video.transcriptStatus, transcriptChars: data.video.transcript?.length };
if (images.length !== 16 || data.video.transcriptStatus !== 'available') throw new Error('Video read incomplete: ' + JSON.stringify(evidence));
console.log(JSON.stringify({ mcp: evidence }));

const api = new NodeApiClient(cfg.dsh.baseUrl, 15000, {});
await api.ensureAuth();
const cwd = path.resolve('state/bilibili-native-vision-probe'); fs.mkdirSync(cwd, { recursive: true });
const { sessionId } = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'create');
unwrap(await api.sessions.selectModel({ sessionId, provider: cfg.dsh.provider, model: cfg.dsh.model }), 'select');
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 120000);
const stream = api.events.mux({}, ctrl.signal), collector = createTurnCollector();
let toolCalls = 0;
const done = (async () => {
  for await (const envelope of stream) {
    const f = envelope.payload;
    if (f.type !== 'session/event' || f.sessionId !== sessionId) continue;
    if (f.event.type === 'tool/call') toolCalls++;
    const ended = collector.push(f.event);
    if (ended) return ended;
  }
  throw new Error('Native vision verification ended without a result');
})();
stream.follow(sessionId);
try {
  const selected = [3, 6, 11, 14];
  const content = [{ type: 'text', text: '本地维护视觉诊断：禁止调用任何工具、发送QQ消息或设置唤醒；仅在本对话回答。以下是同一个真实视频中抽出的四帧，请按时间顺序概述可见人物与场景，并准确读出最后一帧画面底部的文字及角色标签。不要仅根据视频标题回答，也不要声称逐秒看过。' }];
  for (const i of selected) {
    content.push({ type: 'text', text: `时间：${data.video.frameTimestamps[i]} 秒` });
    content.push({ type: 'image', mediaType: images[i].mimeType, data: images[i].data });
  }
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content }), 'prompt');
  const ended = await done;
  Object.assign(evidence, { sessionId, provider: cfg.dsh.provider, model: cfg.dsh.model, toolCalls, reason: ended.reason, answer: ended.text });
  evidence.ok = ended.reason.kind === 'completed' && toolCalls === 0 && /综合来看/.test(ended.text) && /千问/.test(ended.text);
  fs.writeFileSync('state/bilibili-video-pipeline-verification.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  if (!evidence.ok) process.exitCode = 1;
} finally { clearTimeout(timer); ctrl.abort(); await done.catch(() => {}); }
