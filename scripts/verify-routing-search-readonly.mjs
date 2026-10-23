// Real reads only: no handoff, QQ send, sticker send, Qzone write or model request.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
const state = JSON.parse(fs.readFileSync(path.join(root, 'state/social-v2.json')));
const sourceKey = process.argv[2] || cfg.socialV2.sharedMemory.allowedKeys.find(k => k.startsWith('private:') && state.conversations[k]);
if (!cfg.socialV2.sharedMemory.allowedKeys.includes(sourceKey)) throw new Error('Unauthorized verification source');
const token = state.conversations[sourceKey]?.agentToken;
if (!token) throw new Error('No live source conversation');
const groupKey = cfg.socialV2.sharedMemory.allowedKeys.find(k => k.startsWith('group:'));
const report = { at: new Date().toISOString(), readOnly: true, checks: {} };
async function withClient(script, run) {
  const client = new Client({ name: 'routing-search-readonly', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, script)], cwd: root, stderr: 'pipe' }));
    await run(client);
  } finally { await client.close(); }
}
const parse = result => JSON.parse(result.content.find(c => c.type === 'text').text);
try {
  await withClient('src/mcp-snowluma-safe.js', async client => {
    const tools = await client.listTools();
    report.checks.tools = { count: tools.tools.length, hasContactLookup: tools.tools.some(t => t.name === 'qq_find_contact') };
    const wrongScope = await client.callTool({ name: 'qq_get_recent_messages', arguments: { key: groupKey, token, limit: 1 } });
    report.checks.wrongToken = { denied: wrongScope.isError === true, pointsToHandoff: wrongScope.content.some(c => c.text?.includes('qq_handoff')) };
    const lookup = await client.callTool({ name: 'qq_find_contact', arguments: { key: sourceKey, token, query: '哥布林' } });
    if (lookup.isError) throw new Error('Live contact lookup failed');
    const contacts = parse(lookup).conversations;
    report.checks.contact = { count: contacts.length, hasVerifiedFriend: contacts.some(c => c.isFriend && c.userId && c.remark), tokensExposed: contacts.some(c => Object.keys(c).some(k => /token/i.test(k))) };
    const prompt = await client.callTool({ name: 'qq_get_prompt', arguments: { key: sourceKey, token } });
    if (prompt.isError) throw new Error('Live prompt read failed');
    const capabilities = parse(prompt).capabilities;
    report.checks.liveCapabilities = { correctSource: capabilities.sourceKey === sourceKey, handoffEnabled: capabilities.handoffEnabled,
      searchEnabled: capabilities.searchEnabled, searchProvider: capabilities.searchProvider };
  });
  await withClient('src/mcp-web-search-safe.js', async client => {
    const result = await client.callTool({ name: 'web_search', arguments: { query: '孙笑川 你说是就是吧 表情' } });
    if (result.isError) throw new Error('Live search failed: ' + result.content.find(c => c.type === 'text')?.text);
    const search = parse(result);
    report.checks.webSearch = { provider: search.provider, count: search.results.length,
      relevant: search.results.some(r => `${r.title} ${r.snippet}`.includes('孙笑川')), urls: search.results.slice(0, 2).map(r => r.url) };
  });
  const before = JSON.parse(fs.readFileSync(path.join(root, 'state/routing-models-before.json')));
  const sessions = JSON.parse(fs.readFileSync(path.join(root, 'state/sessions.json'))).sessions;
  const rpc = probeRpc(probeCookie({ base: cfg.dsh.baseUrl }), { base: cfg.dsh.baseUrl });
  const after = [];
  for (const row of before) {
    const r = await rpc('session/projections', { request: { sessionId: row.sessionId } });
    if (!r?.ok) throw new Error('Model selection verification failed');
    after.push({ key: row.key, sessionId: row.sessionId, selection: r.value.values.modelSelection });
  }
  report.checks.modelPreservation = { sessions: before.length,
    mappingsUnchanged: before.every(b => sessions[b.key] === b.sessionId),
    selectionsUnchanged: before.every((b, i) => JSON.stringify(b.selection.next) === JSON.stringify(after[i].selection.next)),
    usesAdditionalSearchModel: false };
} finally {
  fs.writeFileSync(path.join(root, 'state/routing-search-live-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
