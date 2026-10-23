import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocialHub } from '../src/social-hub.js';
import { searchResultMatches } from '../src/web-search.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function hubFixture(t, override = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-routing-'));
  t.after(() => {
    assert.ok(path.resolve(stateDir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'qq-routing-'));
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const cfg = { socialV2: { sharedMemory: { enabled: true, handoffEnabled: true, allowedKeys: ['private:12345', 'private:23456', 'group:456'] } } };
  const delivered = [];
  const deps = { stateDir, getConfig: () => cfg, getSelfId: () => '99999', getConversation: () => null,
    getConversations: () => new Map(), sessionAllowed: () => true,
    onebot: async action => action === 'get_friend_list' ? [
      { user_id: 23456, nickname: 'YOU', remark: '哥布林檎（测试）', token: 'must-not-leak' },
      { user_id: 88888, nickname: '未经授权的好友' }
    ] : [{ group_id: 456, group_name: '摄影群' }, { group_id: 999, group_name: '未经授权的群' }],
    getSticker: id => id === 'received-picture' ? { id } : null,
    deliver: async (key, handoff) => delivered.push({ key, handoff }), ...override };
  return { cfg, deps, delivered, hub: createSocialHub(deps) };
}

test('authorized contact lookup resolves remarks and never exposes ungranted friends or tokens', async t => {
  const f = hubFixture(t);
  const result = await f.hub.handle('contact-lookup', 'private:12345', { query: '哥布林檎' });
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].key, 'private:23456');
  assert.equal(result.conversations[0].isFriend, true);
  const all = await f.hub.handle('handoff-list', 'private:12345', {});
  assert.equal(all.conversations.length, 2);
  assert.ok(!JSON.stringify(all).includes('must-not-leak'));
  assert.ok(!JSON.stringify(all).includes('88888'));
  const typo = await f.hub.handle('contact-lookup', 'private:12345', { query: '哥布林擒' });
  assert.equal(typo.conversations[0].approximate, true);
  assert.equal(f.delivered.length, 0);
});

test('handoff carries selected real sticker IDs into target inbox with no external send', async t => {
  const f = hubFixture(t);
  const body = { targetKey: 'group:456', content: '请在本群分享这张图', stickerIds: ['received-picture'], requestId: 'image_handoff_01' };
  const result = await f.hub.handle('handoff', 'private:12345', body);
  assert.equal(result.queued, true);
  assert.deepEqual(f.hub.inbox('group:456')[0].stickerIds, ['received-picture']);
  assert.equal(f.delivered[0].key, 'group:456');
  assert.equal((await f.hub.handle('handoff', 'private:12345', body)).duplicate, true);
  assert.equal(f.delivered.length, 1);
  await assert.rejects(f.hub.handle('handoff', 'private:12345', { ...body, stickerIds: [] }), /其他交接/);
  await assert.rejects(f.hub.handle('handoff', 'private:12345', { ...body, stickerIds: ['file:///private'] }), /真实表情图片/);
});

test('revoking source authorization while directory API is pending denies its result', async t => {
  const f = hubFixture(t);
  const hub = createSocialHub({ ...f.deps, onebot: async () => { f.cfg.socialV2.sharedMemory.allowedKeys = ['group:456']; return []; } });
  await assert.rejects(hub.handle('contact-lookup', 'private:12345', { query: '摄影' }), /撤销/);
});

test('Chinese relevance filter rejects the observed single-character fallback but accepts real subject matches', () => {
  assert.equal(searchResultMatches('孙笑川 你说是就是吧 表情', { title: '孙（汉语汉字）', snippet: '孙姓' }), false);
  assert.equal(searchResultMatches('孙笑川 你说是就是吧 表情', { title: '孙笑川_百科' }), true);
  assert.equal(searchResultMatches('孙笑川你说是就是吧', { title: '孙笑川_百科' }), true);
  assert.equal(searchResultMatches('Node.js fs readFile', { title: 'Node.js documentation' }), true);
});

test('source token cannot read target messages, but can hand off; existing turns receive live routing/search hints', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: 12345, allow: { groups: ['456'], private: ['12345', '23456'] },
    webSearch: { enabled: true, provider: 'bing' },
    socialV2: { sharedMemory: { enabled: true, handoffEnabled: true, allowedKeys: ['private:12345', 'private:23456', 'group:456'] } } } });
  let server;
  try {
    h.setMode('reserved2'); h.setSelfIdentity('测试机器人', '99999');
    const token = h.getSocialV2State('private:12345').agentToken;
    h.bot.raw = async action => action === 'get_friend_list' ? [{ user_id: 23456, nickname: 'YOU', remark: '哥布林檎' }] : [{ group_id: 456, group_name: '测试群' }];
    server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': token };
    const url = `http://127.0.0.1:${server.address().port}`;
    const denied = await fetch(url + '/api/socialV2/recent?key=group:456', { headers });
    assert.equal(denied.status, 403);
    const current = await (await fetch(url + '/api/socialV2/unread?key=private:12345', { headers })).json();
    assert.equal(current.capabilities.sourceKey, 'private:12345');
    assert.equal(current.capabilities.handoffEnabled, true);
    assert.equal(current.capabilities.searchEnabled, true);
    assert.equal(current.capabilities.searchProvider, 'bing');
    assert.match(current.capabilities.routing, /无需对方先@/);
    const lookup = await (await fetch(url + '/api/socialV2/integrations/contact-lookup', { method: 'POST', headers,
      body: JSON.stringify({ key: 'private:12345', query: '哥布林檎' }) })).json();
    assert.equal(lookup.conversations[0].key, 'private:23456');
    const response = await fetch(url + '/api/socialV2/integrations/handoff', { method: 'POST', headers,
      body: JSON.stringify({ key: 'private:12345', targetKey: 'group:456', content: '协作测试', requestId: 'routing_bridge_01' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).queued, true);
    assert.equal(h.calls.sent.length, 0);
    assert.match(h.buildWakePromptV2('private:12345', 'test'), /当前已启用/);
    assert.match(h.buildWakePromptV2('private:12345', 'test'), /qq_find_contact/);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await h.close(); }
});
