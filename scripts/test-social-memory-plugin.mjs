import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntegrations } from '../src/project-integrations.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createReactions } from '../extensions/social-memory/reactions.js';

test('临时反应独立于人、机器人和会话，逐渐衰减；重放不续期，重启可恢复', () => {
  let timestamp = 1000000, persisted = {};
  const storage = { get: () => structuredClone(persisted), set: (_key, value) => { persisted = structuredClone(value); } };
  const reactions = createReactions(storage, () => timestamp);
  assert.equal(reactions.record('bot', 'group:456', '123', 'source', 'annoyed').applied, true);
  assert.equal(reactions.get('bot', 'group:456', '123').label, '不耐烦');
  for (const args of [['bot', 'private:123', '123'], ['bot', 'group:456', '789'], ['other-bot', 'group:456', '123']]) {
    assert.equal(reactions.get(...args), null);
  }
  timestamp += 5 * 60000;
  assert.equal(reactions.get('bot', 'group:456', '123').intensity, 0.5);
  assert.equal(reactions.record('bot', 'group:456', '123', 'source', 'annoyed').duplicate, true);
  assert.equal(createReactions(storage, () => timestamp).get('bot', 'group:456', '123').intensity, 0.5);
  timestamp += 5 * 60000;
  assert.equal(reactions.get('bot', 'group:456', '123'), null);
  reactions.record('bot', 'group:456', '123', 'new-source', 'conflict');
  reactions.record('bot', 'group:456', '123', 'apology', 'repair');
  assert.equal(reactions.get('bot', 'group:456', '123').label, '缓和');
});

test('高好感允许互损和短暂不悦，临时反应不加减分、不泄露到私聊，证据与撤权有效', async t => {
  const timestamp = Date.now();
  t.mock.method(Date, 'now', () => timestamp);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reactions-'));
  const cfg = { allow: { private: ['789'], groups: ['456'] }, extensions: { 'social-memory': { enabled: true, config: { minimumTiers: { '789': '亲近' } } } } };
  const message = { messageId: 'joke', botAccountId: '10001', userId: '789', sender: 'fixture',
    text: '你这局又开始嘴硬了', plain: '你这局又开始嘴硬了' };
  const state = { recentMessages: [message] };
  const options = { stateDir: dir, getConfig: () => cfg, getConversation: () => state,
    sessionAllowed: () => true, tokenOk: () => true };
  let integration = createIntegrations(options);
  let db;
  t.after(async () => { db?.close(); await integration.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const scope = { key: 'group:456', assertAuthorized() {} };
  await integration.host.dispatchMessage(message, scope);
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(dir, 'extensions/social-memory/memory.db'), { readOnly: true });
  const before = db.prepare('SELECT closeness,familiarity,trust FROM relationships').get();
  const call = args => integration.host.callTool('qq_social_relationship_event', { messageId: message.messageId, ...args }, scope)
    .then(result => JSON.parse(result.content[0].text));
  const result = await call({ kind: 'banter', evidence: '又开始嘴硬' });
  assert.equal(result.transient, true);
  assert.equal(result.reaction.kind, 'banter');
  assert.match(await integration.contextFor(scope.key), /熟人互损|嘴硬/);
  assert.equal((await call({ kind: 'annoyed', evidence: '嘴硬' })).duplicate, true);
  message.messageId = 'irritation'; message.text = message.plain = '这话让人不舒服，别说了';
  await call({ kind: 'annoyed', evidence: '别说了' });
  const group = await integration.contextFor(scope.key);
  assert.match(group, /"reaction":\{"kind":"annoyed"/);
  assert.match(group, /高好感不是讨好/);
  assert.doesNotMatch(await integration.contextFor('private:789'), /"reaction"/);
  assert.deepEqual(db.prepare('SELECT closeness,familiarity,trust FROM relationships').get(), before);
  await assert.rejects(call({ kind: 'annoyed', evidence: '不在原消息里的捏造内容' }), /证据/);
  await integration.close(); integration = createIntegrations(options);
  assert.match(await integration.contextFor(scope.key), /"reaction":\{"kind":"annoyed"/);
  message.messageId = 'repair'; message.text = message.plain = '刚才说重了，对不起';
  await call({ kind: 'repair', evidence: '对不起' });
  assert.match(await integration.contextFor(scope.key), /缓和/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'extensions/social-memory/reactions.json'), 'utf8'), /说重了|对不起|不舒服/);
  cfg.allow.private = [];
  await assert.rejects(call({ kind: 'banter', evidence: '对不起' }), /允许建档/);
});

test('多人同聊分别提供相处方式，主说话人保留关键词；总上下文有界', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-multi-attitude-'));
  const cfg = { allow: { private: ['123', '789'], groups: ['456'] }, extensions: { 'social-memory': { enabled: true,
    config: { minimumTiers: { '789': '亲近' } } } } };
  const messages = ['123', '789'].map((userId, i) => ({ messageId: String(i), botAccountId: '10001', userId,
    sender: 'fixture', text: '继续聊今天的事', plain: '继续聊今天的事' }));
  const integration = createIntegrations({ stateDir: dir, getConfig: () => cfg, getConversation: () => ({ recentMessages: messages }),
    sessionAllowed: () => true, tokenOk: () => true });
  t.after(async () => { await integration.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const scope = { key: 'group:456', assertAuthorized() {} };
  for (const message of messages) await integration.host.dispatchMessage(message, scope);
  const context = await integration.contextFor(scope.key);
  assert.match(context, /"userId":"123"/); assert.match(context, /"userId":"789"/);
  assert.match(context, /公开的梗/); assert.match(context, /熟人互损/);
  assert.ok(context.length <= 1500);
});

test('正式内置记忆插件：真实来源绑定、持久关键词索引、上下文、撤销和重启删除', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-social-memory-'));
  const cfg = { allow: { private: ['789'], groups: ['456'] }, extensions: { 'social-memory': { enabled: true, config: { minimumTiers: { '789': '亲近' } } } } };
  const message = { messageId: 'source-1', botAccountId: '10001', userId: '789', sender: '虚构人物',
    text: '我喜欢乌龙茶', plain: '我喜欢乌龙茶' };
  const options = { stateDir: dir, getConfig: () => cfg, getConversation: () => ({ recentMessages: [message] }),
    sessionAllowed: () => true, tokenOk: () => true };
  let integration = createIntegrations(options);
  t.after(async () => { await integration.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const scope = { key: 'group:456', assertAuthorized() {} };
  const call = async (name, args = {}) => JSON.parse((await integration.host.callTool(name, { messageId: 'source-1', ...args }, scope)).content[0].text);
  await integration.ready;
  await integration.host.dispatchMessage(message, scope);
  const memory = (await call('qq_social_memory_remember', { content: '喜欢乌龙茶', confirmed: true })).memory;
  assert.match(await integration.contextFor('group:456'), /indexes/);
  const injected = await integration.contextFor('group:456');
  assert.ok(!injected.includes('喜欢乌龙茶'), '自动注入不包含记忆正文');
  assert.match(injected, /memoryId/);
  const indexes = (await call('qq_social_memory_query', { query: '乌龙茶' })).indexes;
  assert.equal(indexes.length, 1);
  assert.equal(indexes[0].content, undefined);
  assert.equal((await call('qq_social_memory_read', { memoryId: memory.memoryId })).content, '喜欢乌龙茶');
  const first = await call('qq_social_relationship_event', { kind: 'support', evidence: '喜欢乌龙茶' });
  assert.equal(first.applied, true);
  assert.equal(first.relationship.tier, '亲近');
  const replay = await call('qq_social_relationship_event', { kind: 'positive_chat', evidence: '喜欢乌龙茶' });
  assert.equal(replay.duplicate, true);
  await assert.rejects(call('qq_social_relationship_event', { kind: 'support', evidence: '虚构消息里没有这句话' }), /证据/);
  cfg.allow.private = [];
  await assert.rejects(call('qq_social_memory_read', { memoryId: memory.memoryId }), /允许建档/);
  cfg.allow.private = ['789'];
  await call('qq_social_memory_forget', { memoryId: memory.memoryId });
  await integration.close();
  integration = createIntegrations(options);
  await integration.ready;
  await assert.rejects(call('qq_social_memory_read', { memoryId: memory.memoryId }), /不可读/);
  assert.equal((await call('qq_social_memory_query', { query: '乌龙茶' })).indexes.length, 0);
});

test('真实唤醒链路注入关键词，等待上下文期间不会重复投递', async () => {
  let integration, enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = await bridgeHarness({
    config: { extensions: { 'social-memory': { enabled: true } } },
    globals: { createIntegrations(options) {
      const real = createIntegrations(options);
      integration = real;
      return Object.assign((...args) => real(...args), real, { contextFor: async key => {
        enter(); await gate; return real.contextFor(key);
      } });
    } },
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    h.setMode('reserved2'); h.setSelfIdentity('fixture', '10001');
    h.appendSocialV2Message('group:456', 'fixture', '铁观音是什么茶', '铁观音是什么茶', false, false, 'source-1', [], '123', [], false, '10001');
    await integration.ready;
    await integration.host.callTool('qq_social_memory_remember', { messageId: 'source-1', content: '喜欢铁观音', confirmed: true },
      { key: 'group:456', assertAuthorized() {} });
    assert.match(await integration.contextFor('group:456'), /memoryId/, '唤醒前本地索引必须可用');
    const first = h.sendWakePromptV2('group:456', 'admin');
    await entered;
    await h.sendWakePromptV2('group:456', 'admin');
    release(); await first;
    assert.equal(h.calls.prompts.length, 1);
    const delivered = h.calls.prompts[0].content.map(part => part.text ?? '').join('\n');
    assert.match(delivered, /<memory-data/);
    assert.match(delivered, /memoryId/);
    assert.ok(!delivered.includes('喜欢铁观音'));
  } finally {
    release(); await new Promise(resolve => server.close(resolve)); await h.close();
  }
});

test('旧记忆按会话持久化为关键词索引，正文按需读取；不同群和删除源记录均不可绕过', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-legacy-memory-'));
  const cfg = { allow: { private: ['789'], groups: ['456', '999'] }, extensions: { 'social-memory': { enabled: true } } };
  const message = { messageId: 'source-1', botAccountId: '10001', userId: '789', plain: '桂花乌龙茶' };
  const state = { recentMessages: [message], activeTopics: [{ text: '周末参观机器人展' }],
    memberImpressions: { '可能同名的人': { traits: ['喜欢桂花乌龙茶'] } } };
  const integration = createIntegrations({ stateDir: dir, getConfig: () => cfg,
    getConversation: key => key === 'group:456' ? state : { recentMessages: [message] },
    sessionAllowed: key => cfg.allow.groups.includes(key.slice(6)), tokenOk: () => true });
  t.after(async () => { await integration.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (name, args, key = 'group:456') => JSON.parse((await integration.host.callTool(name,
    { messageId: 'source-1', ...args }, { key, assertAuthorized() { assert.ok(cfg.allow.groups.includes(key.slice(6))); } })).content[0].text);
  const result = await call('qq_social_memory_query', { query: '桂花乌龙茶' });
  assert.equal(result.indexes.length, 1);
  const index = result.indexes[0];
  assert.equal(index.identityBound, false);
  assert.equal(index.content, undefined);
  assert.ok(fs.existsSync(path.join(dir, 'extensions/social-memory/legacy-memory.db')));
  const injected = await integration.contextFor('group:456');
  assert.match(injected, /legacy:/);
  assert.ok(!injected.includes('喜欢桂花乌龙茶'));
  assert.equal((await call('qq_social_memory_read', { memoryId: index.memoryId })).content, '可能同名的人：喜欢桂花乌龙茶');
  assert.equal((await call('qq_social_memory_query', { query: '毫不相关的天气' })).indexes.length, 0);
  await assert.rejects(call('qq_social_memory_read', { memoryId: index.memoryId }, 'group:999'), /不在当前会话/);
  state.memberImpressions = {};
  await assert.rejects(call('qq_social_memory_read', { memoryId: index.memoryId }), /移除/);
});

test('唤醒与get_prompt不再直塞旧摘要，关键词入口可读取旧资料', async () => {
  const h = await bridgeHarness({ config: { extensions: { 'social-memory': { enabled: true } } } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try {
    h.setMode('reserved2'); h.setSelfIdentity('fixture', '10001');
    h.appendSocialV2Message('group:456', 'fixture', '机器人展', '机器人展', false, false, 'legacy-source', [], '123', [], false, '10001');
    h.getSocialV2State('group:456').activeTopics = [{ text: '周末一起参观机器人展并拍照' }];
    assert.ok(!h.buildWakePromptV2('group:456', 'admin').includes('周末一起参观机器人展并拍照'));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/prompt?key=group:456`,
      { headers: { 'x-console-token': 'fixture-console-token' } });
    const prompt = await response.text();
    assert.equal(response.status, 200, prompt);
    assert.ok(!prompt.includes('周末一起参观机器人展并拍照'));
    assert.match(prompt, /legacy:/);
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});
