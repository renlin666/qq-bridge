// Uses the live MCP/bridge to search and preview public pictures; NEVER sends QQ.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { looksLikeImageBuffer } from '../src/safe-fetch.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const cfg = read('config.json'), before = read('state/image-search-before.json');
const conversations = read('state/social-v2.json').conversations;
const memory = read('state/shared-memory.json');
const sourceKey = memory.handoffs.find(h => h.requestId === 'handoff_goblin_20261023_01')?.key;
const token = conversations[sourceKey]?.agentToken;
if (!sourceKey || !token || !cfg.socialV2.sharedMemory.allowedKeys.includes(sourceKey)) throw new Error('No authorized verification source');
const client = new Client({ name: 'image-search-readonly', version: '1.0.0' });
const report = { at: new Date().toISOString(), readOnly: true, checks: {} };
const parse = result => {
  if (result.isError) throw new Error(result.content.find(c => c.type === 'text')?.text || 'MCP read failed');
  return JSON.parse(result.content.find(c => c.type === 'text').text);
};
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp-snowluma-safe.js')], cwd: root, stderr: 'pipe' }));
  const { tools } = await client.listTools();
  report.checks.tools = { count: tools.length, search: tools.some(t => t.name === 'qq_search_images'), send: tools.some(t => t.name === 'qq_send_image'),
    contactAcceptsImageIds: !!tools.find(t => t.name === 'qq_send_to_contact')?.inputSchema.properties?.imageIds };
  const result = await client.callTool({ name: 'qq_search_images', arguments: { key: sourceKey, token, query: '孙笑川 你说是就是吧 表情包', count: 3 } });
  const meta = parse(result);
  const blocks = result.content.filter(c => c.type === 'image');
  report.checks.search = { provider: meta.provider, searchTerm: meta.searchTerm, count: meta.images.length, imageBlocks: blocks.length,
    realImageBytes: blocks.every(b => looksLikeImageBuffer(Buffer.from(b.data, 'base64'))),
    cacheMatchesPreviews: meta.images.every((row, i) => fs.readFileSync(path.join(root, 'state/image-search', row.imageId + '.bin')).equals(Buffer.from(blocks[i]?.data || '', 'base64'))),
    candidates: meta.images.map((row, i) => ({ imageId: row.imageId, title: row.title, pageUrl: row.pageUrl, variant: row.variant, mimeType: blocks[i]?.mimeType,
      previewPath: path.join(root, 'state/image-search', row.imageId + '.bin') })) };
  const prompt = parse(await client.callTool({ name: 'qq_get_prompt', arguments: { key: sourceKey, token } }));
  report.checks.capabilities = { enabled: prompt.capabilities?.imageSearchEnabled, searchTool: prompt.capabilities?.imageSearchTool,
    sendTool: prompt.capabilities?.imageSendTool, directsToImages: prompt.capabilities?.imageRouting?.includes('无需收藏') };
  const otherKey = cfg.socialV2.sharedMemory.allowedKeys.find(key => key !== sourceKey);
  const denied = await client.callTool({ name: 'qq_search_images', arguments: { key: otherKey, token, query: '猫 表情包', count: 1 } });
  report.checks.wrongSourceDenied = denied.isError === true;
  const sessions = read('state/sessions.json').sessions;
  const originalModels = read('state/routing-models-before.json');
  const rpc = probeRpc(probeCookie({ base: cfg.dsh.baseUrl }), { base: cfg.dsh.baseUrl });
  const afterModels = [];
  for (const row of originalModels) {
    const projection = await rpc('session/projections', { request: { sessionId: row.sessionId } });
    if (!projection?.ok) throw new Error('Cannot read model selection');
    afterModels.push(projection.value.values.modelSelection);
  }
  report.checks.preservation = { mappingsUnchanged: Object.entries(before.sessions).every(([key, id]) => sessions[key] === id),
    modelSelectionsUnchanged: originalModels.every((row, i) => JSON.stringify(row.selection.next) === JSON.stringify(afterModels[i].next)),
    dshConfigUnchanged: before.dshHash === crypto.createHash('sha256').update(JSON.stringify(cfg.dsh)).digest('hex'),
    noContactSendExecuted: (read('state/shared-memory.json').contactSends?.length || 0) === (memory.contactSends?.length || 0) };
  if (!report.checks.tools.search || !report.checks.tools.send || !meta.images.length || blocks.length !== meta.images.length
    || !report.checks.search.realImageBytes || !report.checks.search.cacheMatchesPreviews || !report.checks.capabilities.enabled
    || !report.checks.wrongSourceDenied || !Object.values(report.checks.preservation).every(Boolean)) throw new Error('Live image search verification failed');
} finally {
  await client.close();
  fs.writeFileSync(path.join(root, 'state/image-search-live-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
