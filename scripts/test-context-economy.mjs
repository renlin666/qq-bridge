import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { selectPromptTopics } from '../src/prompt-context.js';
import { installToolDiscovery } from '../plugins/qq-agent-presets/qq-tool-discovery.mjs';
import { apply as installCompression, eligibleNodes } from '../plugins/qq-agent-presets/qq-context-compression.mjs';

test('ordinary wakes omit unrelated manuals while retaining protocol, token and message watermarks', async () => {
  const h = await bridgeHarness();
  try {
    h.appendSocialV2Message('group:456', 'fixture', '你好', '你好', false, false, 'm1', [], '789', []);
    const lean = h.buildWakePromptV2('group:456', 'message');
    h.cfg.socialV2.context = { enabled: false };
    const legacy = h.buildWakePromptV2('group:456', 'message');
    assert.ok(lean.length < legacy.length * 0.6, `${lean.length}/${legacy.length} characters`);
    assert.doesNotMatch(lean, /QZONE_NOT_FRIEND|当前整段时长门槛|【工具约束】/);
    for (const rule of ['不会自动发送', 'socialEvents', '原requestId', '【会话令牌】', '沉睡前强制等待', 'qq_get_prompt(topic=']) assert.ok(lean.includes(rule));
    assert.match(legacy, /当前整段时长门槛/);
  } finally { await h.close(); }
});

test('current-message routing is repeatable after reset/compaction and covers every unread video', () => {
  const messages = [{ plain: '你好', isSelf: true }, { plain: '看看这个', media: [{ type: 'video' }] },
    { plain: '帮我画张图片，加我好友看说说，查其他窗口聊过什么，搜一下新闻' }];
  const wanted = ['video', 'delivery', 'images', 'history', 'friends', 'web'];
  assert.deepEqual(selectPromptTopics(messages).sort(), wanted.sort());
  assert.deepEqual(selectPromptTopics(messages), selectPromptTopics(JSON.parse(JSON.stringify(messages))));
  assert.deepEqual(selectPromptTopics([{ plain: '你好' }]), []);
});

test('specialist HTTP reads preserve token, allowlist and tool-switch guards and omit unrelated data', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const token = h.getSocialV2State('group:456').agentToken;
  const request = (topic, selectedToken = token, key = 'group:456') => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/prompt?key=${encodeURIComponent(key)}&topic=${encodeURIComponent(topic)}`,
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': selectedToken } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    }).on('error', reject);
  });
  try {
    const video = await request('video');
    assert.equal(video.status, 200); assert.match(video.data.instructions, /标题不是观看证据/);
    assert.equal(Object.hasOwn(video.data, 'memory'), false); assert.equal(Object.hasOwn(video.data, 'role'), false);
    assert.ok(!JSON.stringify(video.data).includes(token));
    assert.equal((await request('wrong')).status, 400);
    assert.equal((await request('video', 'wrong')).status, 403);
    assert.equal((await request('video', token, 'group:999')).status, 403);
    h.cfg.socialV2.tools.getPrompt = false;
    assert.equal((await request('video')).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('message reads and waits return live capability flags without repeating unrelated manuals', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const key = 'group:456', st = h.getSocialV2State(key);
  h.cfg.webSearch = { enabled: true, provider: 'bing', images: { enabled: true } };
  h.cfg.extensions ||= {};
  h.cfg.extensions.comfy = { enabled: true };
  h.cfg.socialV2.wait = { minMs: 1, maxMs: 600000, minQuietAfterNewMs: 0 };
  h.appendSocialV2Message(key, 'fixture', '你好', '你好', false, false, 'economy-message', [], '789', []);
  st.lastIncomingAt = Date.now() - 10000;
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken };
  const request = async (endpoint, body, overrides = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/${endpoint}${body ? '' : `?key=${key}`}`, {
      headers: { ...headers, ...overrides }, ...(body ? { method: 'POST', body: JSON.stringify({ key, ...body }) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const full = await request('prompt');
    assert.equal(full.status, 200);
    for (const name of ['routing', 'generationRouting', 'contactVoiceRouting', 'imageRouting']) assert.equal(typeof full.data.capabilities[name], 'string');
    for (const endpoint of ['unread', 'recent', 'wait']) {
      if (endpoint === 'wait') {
        h.appendSocialV2Message(key, 'fixture', '补充', '补充', false, false, 'economy-wait', [], '789', []);
        st.lastIncomingAt = Date.now() - 10000;
      }
      const result = await request(endpoint, endpoint === 'wait' ? { purpose: 'reply', timeoutMs: 100, quietMs: 1 } : null);
      assert.equal(result.status, 200, endpoint);
      const capabilities = result.data.capabilities;
      assert.equal(capabilities.sourceKey, key);
      assert.equal(capabilities.localGenerationEnabled, true);
      assert.equal(capabilities.searchProvider, 'bing');
      assert.equal(capabilities.detailsTool, 'qq_get_prompt');
      for (const [name, value] of Object.entries(full.data.capabilities)) {
        if (['routing', 'generationRouting', 'contactVoiceRouting', 'imageRouting'].includes(name)) {
          assert.equal(Object.hasOwn(capabilities, name), false, name);
        } else assert.deepEqual(capabilities[name], value, name);
      }
      assert.ok(JSON.stringify(capabilities).length < JSON.stringify(full.data.capabilities).length * 0.4);
      assert.equal(result.data.readThroughSeq, st.lastUnreadSeq);
      const messages = result.data.messages ?? result.data.newMessages;
      assert.ok(messages.some(message => message.messageId === (endpoint === 'wait' ? 'economy-wait' : 'economy-message')), endpoint);
      if (endpoint === 'wait') {
        assert.equal(result.data.quiet, true);
        assert.equal(typeof result.data.preSleepWaitSatisfied, 'boolean');
      }
    }
    h.cfg.webSearch.enabled = false; h.cfg.extensions.comfy.enabled = false;
    const changed = await request('unread');
    assert.equal(changed.data.capabilities.searchEnabled, false);
    assert.equal(changed.data.capabilities.localGenerationEnabled, false);
    const denied = await request('unread', null, { 'x-agent-token': 'invalid' });
    assert.equal(denied.status, 403);
    assert.equal(Object.hasOwn(denied.data, 'capabilities'), false);
    h.cfg.socialV2.tools ||= {}; h.cfg.socialV2.tools.getUnread = false;
    assert.equal((await request('unread')).status, 403);
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

test('specialist prompt reads stay lean and full manuals remain available on every explicit full prompt read', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const key = 'group:456', token = h.getSocialV2State(key).agentToken;
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = async topic => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/prompt?key=${key}${topic ? `&topic=${topic}` : ''}`, {
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': token } });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const video = await request('video');
    assert.match(video.instructions, /标题不是观看证据/);
    assert.equal(video.capabilities.detailsTool, 'qq_get_prompt');
    assert.equal(Object.hasOwn(video.capabilities, 'routing'), false);
    for (let i = 0; i < 2; i++) {
      const full = await request();
      assert.match(full.capabilities.routing, /receipts/);
      assert.match(full.capabilities.contactVoiceRouting, /verified=true/);
      assert.match(full.capabilities.imageRouting, /无需收藏/);
    }
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});

function toolFixture() {
  const global = [
    'mcp__snowluma__qq_get_prompt', 'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_read_bilibili',
    'mcp__snowluma__qq_social_memory_query', 'mcp__snowluma__qq_generate_image', 'mcp__web-search-safe__web_search', 'pwsh',
  ].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
  const denied = new Set(), definitions = new Map(), handlers = new Map();
  const ctx = { tools: { schemas: () => [...global.filter(tool => !denied.has(tool.name)), ...definitions.values()],
    restrict: ({ deny }) => { for (const name of deny) denied.add(name); return () => { for (const name of deny) denied.delete(name); }; },
    register: tool => definitions.set(tool.name, tool) }, systemPrompt: { section() {} }, on: (event, callback) => handlers.set(event, callback) };
  return { ctx, definitions, denied, handlers, global };
}

test('tool groups are isolated per agent, idempotent and include late registrations without dropping middleware', () => {
  const a = toolFixture(), b = toolFixture(); installToolDiscovery(a.ctx); installToolDiscovery(b.ctx);
  assert.ok(a.denied.has('mcp__snowluma__qq_read_bilibili'));
  assert.ok(!a.denied.has('mcp__snowluma__qq_send_message'));
  // Dangerous tools remain governed by the separate permanent security mask.
  assert.ok(!a.denied.has('pwsh'));
  const load = a.definitions.get('qq_load_tools');
  assert.equal(load.execute({ category: 'video' }).newlyLoaded, 1);
  assert.equal(load.execute({ category: 'video' }).newlyLoaded, 0);
  assert.ok(b.denied.has('mcp__snowluma__qq_read_bilibili'));
  a.global.push({ name: 'mcp__snowluma__qq_get_avatar' });
  let forwarded = false;
  a.handlers.get('agent/pre-step')({}, () => { forwarded = true; });
  assert.ok(forwarded); assert.ok(a.denied.has('mcp__snowluma__qq_get_avatar'));
  assert.throws(() => load.execute({ category: 'pwsh' }), /未知/);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostModules = process.env.DSH_INSTALL_MODULES || path.resolve(root, '../dsh-asar/dsh/node_modules');
const hostAvailable = fs.existsSync(path.join(hostModules, '@deepseek-ai/dsh-session/lib/index.js'));

test('real DSH registry masks optional schemas per scope and keeps permanent safety masks', { skip: !hostAvailable }, async () => {
  const hostImport = name => import(pathToFileURL(path.join(hostModules, `@deepseek-ai/${name}/lib/index.js`)).href);
  const [{ Context }, { default: SystemPrompt }, { default: Tools }, { createScope }] = await Promise.all([
    hostImport('cordis'), hostImport('dsh-system-prompt'), hostImport('dsh-tools'), hostImport('dsh-scope'),
  ]);
  const ctx = new Context(); ctx.plugin(SystemPrompt, {}); ctx.plugin(Tools, {});
  await new Promise(resolve => setImmediate(resolve));
  const output = { schema: { type: 'object', additionalProperties: true }, render: () => [] };
  for (const name of ['mcp__snowluma__qq_read_bilibili', 'mcp__snowluma__qq_send_message', 'pwsh']) {
    ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, output, execute: () => ({}) });
  }
  const a = {}, b = {}, scopes = [createScope(ctx, a), createScope(ctx, b)];
  for (const scope of scopes) scope.ctx.plugin({ name: 'fixture-discovery', inject: ['tools', 'systemPrompt'],
    apply(scoped) {
      scoped.tools.register({ name: 'mcp__snowluma__qq_get_avatar', description: 'own-layer MCP fixture',
        parameters: { type: 'object', properties: {} }, output, execute: () => ({}) });
      scoped.tools.restrict({ deny: ['pwsh'] }); installToolDiscovery(scoped);
    } });
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.ok(!ctx.tools.schemas(a).some(tool => tool.name.includes('bilibili')));
    assert.ok(ctx.tools.schemas().some(tool => tool.name.includes('bilibili')));
    assert.ok(ctx.tools.schemas(a).some(tool => tool.name.includes('avatar'))); // Own tools cannot be restricted.
    const initialAssembly = await ctx.systemPrompt.assemble({ scope: a });
    assert.ok(!initialAssembly.tools.some(tool => tool.name.includes('avatar')));
    assert.match(ctx.tools.guardReason({ name: 'mcp__snowluma__qq_get_avatar', agent: a }), /先用qq_load_tools/);
    ctx.tools.get('qq_load_tools', a).execute({ category: 'video' }, { agent: a });
    assert.ok(ctx.tools.schemas(a).some(tool => tool.name.includes('bilibili')));
    assert.ok(!ctx.tools.schemas(b).some(tool => tool.name.includes('bilibili')));
    assert.ok(!ctx.tools.schemas(a).some(tool => tool.name === 'pwsh'));
    ctx.tools.get('qq_load_tools', a).execute({ category: 'media' }, { agent: a });
    assert.ok((await ctx.systemPrompt.assemble({ scope: a })).tools.some(tool => tool.name.includes('avatar')));
    assert.ok(!(await ctx.systemPrompt.assemble({ scope: b })).tools.some(tool => tool.name.includes('avatar')));
  } finally { for (const scope of scopes) await scope.dispose(); }
});

test('real DSH compaction commits a reversible checkpoint without any auxiliary LLM request', { skip: !hostAvailable }, async () => {
  const hostImport = name => import(pathToFileURL(path.join(hostModules, `@deepseek-ai/${name}/lib/index.js`)).href);
  const [{ Session }, { BasicCompactionEngine }, schemas] = await Promise.all([hostImport('dsh-session'), hostImport('dsh-compaction-basic'), hostImport('dsh-tools')]);
  const session = Session.create('fixture-one');
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'deepseek-flash' } } });
  session.append('system/message', { message: { id: 'system-fixture', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'protected core' }] } }, { surfaceOp: 'append' });
  for (let i = 0; i < 20; i++) session.append('user/message', { id: `user-${i}`, role: 'user', content: [{ type: 'text', text: `old-${i}:` + '历史事实与来源。'.repeat(900) }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('turn/start', { turn: 0 });
  for (let step = 0; step < 3; step++) session.append('assistant/message', { turn: 0, step, stream: [],
    message: { id: `sample-${step}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'deepseek-flash' }, content: [{ type: 'text', text: 'done' }] },
    usage: { inputTokens: 10000, cacheReadTokens: 0, outputTokens: 5 } }, { surfaceOp: 'append' });
  const meter = { measure: s => {
    const nodes = [...s.surface.nodes].map(seq => ({ seq, tokens: JSON.stringify(s.deriveEventMessage(s.eventAt(seq))).length, heuristicTokens: JSON.stringify(s.deriveEventMessage(s.eventAt(seq))).length }));
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
  }, estimateMessage: message => JSON.stringify(message).length };
  let llmCalls = 0;
  const backend = Object.create(BasicCompactionEngine.prototype);
  backend.ctx = { tokenMeter: meter, waterfall: () => false, llm: { stream() { llmCalls++; throw new Error('must not call LLM'); } } };
  const definitions = new Map();
  installCompression({ compaction: backend, tokenMeter: meter, tools: { register: tool => definitions.set(tool.name, tool) }, systemPrompt: { section() {} } });
  for (const tool of definitions.values()) { schemas.assertObjectJsonSchema(tool.parameters); schemas.assertSupportedJsonSchema(tool.output.schema); }
  const exec = { agent: { session, options: { provider: 'fixture', model: 'deepseek-flash' } }, signal: new AbortController().signal };
  const status = definitions.get('qq_context_status').execute({}, exec);
  assert.equal(status.worthwhile, true);
  const originalSeq = status.range.startSeq, original = session.eventAt(originalSeq);
  const result = await definitions.get('qq_compress_context').execute({ ...status.range,
    summary: '已完成的旧任务摘要：明确记录事实与来源；没有未完成的请求，不新增关系、发送授权或承诺。原文保留用于核对，近期消息继续逐条处理。'.repeat(2) }, exec);
  assert.equal(result.compressed, true); assert.equal(llmCalls, 0); assert.equal(backend.summarize, BasicCompactionEngine.prototype.summarize);
  assert.equal(session.eventAt(session.surface.nodes[0]).type, 'system/message'); assert.equal(session.eventAt(originalSeq), original);
  const read = definitions.get('qq_read_context').execute({ seq: originalSeq }, exec);
  assert.match(read.excerpt, /old-0/); assert.ok(read.nextOffset > 0);
  assert.throws(() => definitions.get('qq_read_context').execute({ seq: 0 }, exec), /不是当前会话/);
  assert.throws(() => definitions.get('qq_read_context').execute({ seq: originalSeq }, { agent: { session: Session.create('fixture-other') } }), /不是当前会话/);
  assert.throws(() => definitions.get('qq_context_status').execute({}, {}), /缺少当前会话/);
  await assert.rejects(definitions.get('qq_compress_context').execute({ startSeq: session.surface.nodes.at(-1), endSeq: session.surface.nodes.at(-1), summary: 'x'.repeat(100) }, exec), /受保护/);
  const seed = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq));
  const replay = Session.create('fixture-replay', seed);
  assert.deepEqual(replay.surface.nodes, session.surface.nodes);
  assert.match(definitions.get('qq_read_context').execute({ seq: originalSeq }, { ...exec, agent: { ...exec.agent, session: replay } }).excerpt, /old-0/);
  assert.equal(definitions.get('qq_context_status').execute({}, { ...exec, agent: { ...exec.agent, session: replay } }).worthwhile, false);
});
