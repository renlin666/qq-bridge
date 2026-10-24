// Inspect real tools and Qzone reads without submitting a like/comment or prompting an agent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const saved = JSON.parse(fs.readFileSync(path.join(root, 'state/social-v2.json'), 'utf8'));
const key = config.integrations.qzone.allowedKeys.find(k => saved.conversations[k]?.agentToken);
if (!key) throw new Error('No authorized persisted QQ conversation');
const scope = { key, token: saved.conversations[key].agentToken };
const report = { at: new Date().toISOString(), readOnly: true, checks: {} };
const client = new Client({ name: 'qzone-friends-readonly', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp-snowluma-safe.js')], cwd: root, stderr: 'pipe' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: { ...scope, ...args } });
  if (result.isError) throw new Error(result.content.find(c => c.type === 'text')?.text || name + ' failed');
  return JSON.parse(result.content.find(c => c.type === 'text').text);
}
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const required = ['qq_get_qzone_feed', 'qq_like_qzone', 'qq_like_qzone_comment', 'qq_list_qzone', 'qq_get_qzone_comments', 'qq_react_qzone'];
  report.checks.tools = { available: required.every(n => tools.some(t => t.name === n)), total: tools.length };
  const own = await call('qq_list_qzone');
  report.checks.ownPosts = { count: own.posts.length };
  if (own.posts.length) {
    const detail = await call('qq_get_qzone_comments', { tid: own.posts[0].tid });
    report.checks.ownComments = { count: detail.comments.length, likeableRoots: detail.comments.filter(c => c.canLike).length };
  }
  const feed = await call('qq_get_qzone_feed');
  report.checks.friendFeed = { count: feed.posts.length, unavailableAuthors: feed.unavailable.length, source: feed.source, hasMore: feed.hasMore };
  if (feed.posts.length) {
    const { tid, targetUserId } = feed.posts[0];
    const detail = await call('qq_get_qzone_comments', { tid, targetUserId });
    report.checks.friendComments = { ownerMatches: detail.targetUserId === targetUserId, count: detail.comments.length };
  }
  const rejected = await client.callTool({ name: 'qq_get_qzone_feed', arguments: { key, token: 'invalid-test-token' } });
  report.checks.tokenBoundary = { rejected: rejected.isError === true };
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await client.close();
  report.notTested = ['Real like submission/UI readback', 'Real comment/reply submission'];
  fs.writeFileSync(path.join(root, 'state/qzone-friends-live-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
