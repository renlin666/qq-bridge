import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocialHub } from '../src/social-hub.js';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-history-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { ownerQQ: 12345, socialV2: { sharedMemory: { enabled: true, allowedKeys: ['private:12345', 'group:456'] } } };
  const states = new Map([['private:12345', { recentMessages: [{ messageId: 'request', seq: 1, userId: '12345', plain: '查查其他聊天窗口有没有聊过Meta' }] }],
    ['group:456', { recentMessages: [{ messageId: 'm1', seq: 8, userId: '23456', sender: 'friend', plain: '昨天讨论Meta眼镜', time: 100 }], agentToken: 'must-never-leak' }],
    ['group:999', { recentMessages: [{ messageId: 'private-data', plain: 'Meta secret' }] }]]);
  const hub = createSocialHub({ stateDir: dir, getConfig: () => cfg, getSelfId: () => '99999',
    getConversation: key => states.get(key), getConversations: () => states, sessionAllowed: () => true });
  return { cfg, states, hub };
}
test('administrator searches actual authorized cached messages with coverage, never a target token or global claim', async t => {
  const f = fixture(t), r = await f.hub.handle('conversation-search', 'private:12345', { query: 'Meta', requestMessageId: 'request' });
  assert.equal(r.matches.length, 1); assert.equal(r.matches[0].messageId, 'm1'); assert.equal(r.completeHistory, false);
  assert.equal(r.coverage.length, 1); assert.match(r.matches[0].excerpt, /Meta/);
  assert.doesNotMatch(JSON.stringify(r), /must-never-leak|private-data/);
  const empty = await f.hub.handle('conversation-search', 'private:12345', { query: '不存在', requestMessageId: 'request' });
  assert.equal(empty.matches.length, 0); assert.match(empty.note, /不能断言从未聊过/);
});
test('other senders, invented requests and ungranted windows cannot use administrator history search', async t => {
  const f = fixture(t), args = { query: 'Meta', requestMessageId: 'request' };
  await assert.rejects(f.hub.handle('conversation-search', 'group:456', args), /仅供管理员/);
  await assert.rejects(f.hub.handle('conversation-search', 'private:12345', { ...args, targetKey: 'group:999' }), /未获/);
  await assert.rejects(f.hub.handle('conversation-search', 'private:12345', { ...args, requestMessageId: 'invented' }), /真实/);
  f.states.get('private:12345').recentMessages[0].userId = '23456';
  await assert.rejects(f.hub.handle('conversation-search', 'private:12345', args), /真实/);
});
