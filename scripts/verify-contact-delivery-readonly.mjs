// Live reads only. Never sends, acknowledges, queues, or replays any QQ request.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const cfg = read('config.json');
const before = read('state/contact-delivery-before.json');
const memory = read('state/shared-memory.json');
const old = memory.handoffs.find(h => h.requestId === 'handoff_goblin_20261023_01');
if (!old) throw new Error('Incident handoff not found; verification will not invent a replacement');
const sourceKey = old.key;
const token = read('state/social-v2.json').conversations[sourceKey]?.agentToken;
if (!token) throw new Error('No live source token');
const report = { at: new Date().toISOString(), readOnly: true, checks: {} };
const client = new Client({ name: 'contact-delivery-readonly', version: '1.0.0' });
const parse = result => {
  if (result.isError) throw new Error(result.content.find(c => c.type === 'text')?.text || 'MCP read failed');
  return JSON.parse(result.content.find(c => c.type === 'text').text);
};
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp-snowluma-safe.js')], cwd: root, stderr: 'pipe' }));
  const listed = await client.listTools();
  const required = ['qq_send_to_contact', 'qq_get_contact_send_status', 'qq_get_handoff_status'];
  report.checks.tools = { count: listed.tools.length, addedToolsAvailable: required.every(name => listed.tools.some(t => t.name === name)) };
  const status = parse(await client.callTool({ name: 'qq_get_handoff_status', arguments: { key: sourceKey, token, id: old.id } }));
  report.checks.incident = { sent: status.sent, status: status.status, deliveredToAgent: status.deliveredToAgent };
  const prompt = parse(await client.callTool({ name: 'qq_get_prompt', arguments: { key: sourceKey, token } }));
  report.checks.liveCapabilities = { contactSendTool: prompt.capabilities?.contactSendTool,
    receiptRequired: prompt.capabilities?.routing?.includes('receipts'), searchEnabled: prompt.capabilities?.searchEnabled };
  const invalid = await client.callTool({ name: 'qq_get_contact_send_status', arguments: { key: old.target, token, requestId: old.requestId } });
  report.checks.sourceScopeStillEnforced = invalid.isError === true;
  const sessions = read('state/sessions.json').sessions;
  const originalModels = read('state/routing-models-before.json');
  const rpc = probeRpc(probeCookie({ base: cfg.dsh.baseUrl }), { base: cfg.dsh.baseUrl });
  const nowModels = [];
  for (const row of originalModels) {
    const result = await rpc('session/projections', { request: { sessionId: row.sessionId } });
    if (!result?.ok) throw new Error('Model projection read failed');
    nowModels.push(result.value.values.modelSelection);
  }
  report.checks.preservation = { count: originalModels.length,
    mappingsUnchanged: Object.entries(before.sessions).every(([key, id]) => sessions[key] === id),
    selectionsUnchanged: originalModels.every((row, index) => JSON.stringify(row.selection.next) === JSON.stringify(nowModels[index].next)),
    dshConfigUnchanged: before.dshHash === crypto.createHash('sha256').update(JSON.stringify(cfg.dsh)).digest('hex') };
  const after = read('state/shared-memory.json');
  report.checks.noContactSendExecuted = (after.contactSends?.length || 0) === (memory.contactSends?.length || 0);
  if (!report.checks.tools.addedToolsAvailable || status.sent !== false || !report.checks.sourceScopeStillEnforced
    || !report.checks.liveCapabilities.receiptRequired || !Object.values(report.checks.preservation).every(Boolean)
    || !report.checks.noContactSendExecuted) throw new Error('Live read-only verification failed');
} finally {
  await client.close();
  fs.writeFileSync(path.join(root, 'state/contact-delivery-live-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
