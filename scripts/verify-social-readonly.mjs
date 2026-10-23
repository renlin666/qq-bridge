// Real MCP -> bridge -> QQ reads only. Never publishes, replies, or wakes agents.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const state = JSON.parse(fs.readFileSync(path.join(root, 'state/social-v2.json'), 'utf8'));
const key = config.integrations.qzone.allowedKeys.find(k => state.conversations[k]?.agentToken);
if (!key) throw new Error('No existing authorized QQ conversation for read-only verification');
const common = { key, token: state.conversations[key].agentToken };
const client = new Client({ name: 'social-readonly-verification', version: '1.0.0' });
const report = { at: new Date().toISOString(), readOnly: true, checks: {} };
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp-snowluma-safe.js')], cwd: root, stderr: 'pipe' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: { ...common, ...args } });
  if (result.isError) throw new Error(result.content.find(c => c.type === 'text')?.text || name + ' failed');
  return result;
}
function json(result) { return JSON.parse(result.content.find(c => c.type === 'text').text); }
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map(t => t.name);
  const required = ['qq_get_avatar', 'qq_shared_memory_query', 'qq_shared_memory_remember', 'qq_handoff', 'qq_ack_handoff',
    'qq_list_qzone', 'qq_get_qzone_comments', 'qq_react_qzone', 'qq_publish_qzone'];
  report.checks.tools = { count: names.length, requiredAvailable: required.every(n => names.includes(n)) };
  const avatar = await call('qq_get_avatar');
  const image = avatar.content.find(c => c.type === 'image');
  report.checks.avatar = { ok: !!image?.data, mimeType: image?.mimeType, bytes: image ? Buffer.from(image.data, 'base64').length : 0 };
  const memory = json(await call('qq_shared_memory_query'));
  report.checks.sharedMemory = { ok: Array.isArray(memory.memories), visibleCount: memory.memories?.length };
  const linked = json(await call('qq_list_linked_conversations'));
  report.checks.linkedWindows = { ok: Array.isArray(linked.conversations), count: linked.conversations?.length };
  const posts = json(await call('qq_list_qzone'));
  report.checks.qzoneList = { ok: Array.isArray(posts.posts), count: posts.posts?.length };
  if (posts.posts?.length) {
    const comments = json(await call('qq_get_qzone_comments', { tid: posts.posts[0].tid }));
    report.checks.qzoneComments = { ok: Array.isArray(comments.comments), count: comments.comments?.length, reportedTotal: comments.commentCount };
  }
  const before = JSON.parse(fs.readFileSync(path.join(root, 'state/feature-sessions-before-restart.json')));
  const after = JSON.parse(fs.readFileSync(path.join(root, 'state/sessions.json')));
  report.checks.sessionPreservation = { ok: JSON.stringify(before.sessions) === JSON.stringify(after.sessions), count: Object.keys(after.sessions).length };
  const poller = JSON.parse(fs.readFileSync(path.join(root, 'state/qzone-interactions.json')));
  report.checks.commentMonitor = { initializedPosts: poller.posts.filter(p => p.initialized).length,
    pendingEvents: poller.posts.reduce((n, p) => n + p.pending.length, 0) };
  report.notTested = ['Real image publication', 'Real comment/reply submission'];
} finally {
  await client.close();
  fs.writeFileSync(path.join(root, 'state/feature-live-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
