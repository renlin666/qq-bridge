import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIntegrations } from '../src/project-integrations.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

test('正式内置记忆插件：真实来源绑定、持久关键词索引、上下文、撤销和重启删除', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-social-memory-'));
  const cfg = { allow: { private: ['789'], groups: ['456'] }, extensions: { 'social-memory': { enabled: true } } };
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
    h.appendSocialV2Message('group:456', 'fixture', '你好', '你好', false, false, 'source-1', [], '123', [], false, '10001');
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
