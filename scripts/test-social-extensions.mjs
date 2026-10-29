import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocialHub } from '../src/social-hub.js';
import { createQzoneSocial } from '../src/qzone-social.js';
import { createIntegrations, INTEGRATION_PREFIX } from '../src/qq-integrations.js';
import { registerIntegrationTools } from '../src/mcp-qq-integrations.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-social-tests-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'qq-social-tests-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = { ownerQQ: 12345, socialV2: { sharedMemory: { enabled: true, handoffEnabled: true, allowedKeys: ['group:456', 'group:789', 'private:12345'] } },
    integrations: { qzone: { enabled: true, commentsEnabled: true, autoReact: true, allowedKeys: ['group:456'], minIntervalSeconds: 60 } } };
  const conv = new Map([
    ['group:456', { recentMessages: [{ userId: '12345', sender: '小明' }], memberImpressions: {} }],
    ['group:789', { recentMessages: [{ userId: '12345', sender: '另一个群名片' }, { userId: '23456', sender: '小明' }], memberImpressions: {} }],
    ['private:12345', { recentMessages: [] }]
  ]);
  const calls = []; let self = '99999';
  const deps = { stateDir: dir, getConfig: () => cfg, getConversation: key => conv.get(key), getConversations: () => conv,
    getSelfId: () => self, sessionAllowed: key => cfg.socialV2.sharedMemory.allowedKeys.includes(key),
    deliver: async (key, record) => calls.push({ key, record }), fetchImage: async url => { calls.push(url); return { buffer: png }; },
    validateImage: buffer => buffer.equals(png) ? { buffer, mimeType: 'image/png' } : null };
  return { dir, cfg, conv, calls, deps, hub: createSocialHub(deps), setSelf(id) { self = id; } };
}

test('avatar returns actual image blocks; only self/current subjects can be queried', async t => {
  const f = fixture(t);
  const value = await f.hub.handle('avatar', 'group:456', { userId: '12345' });
  assert.equal(value.image.mimeType, 'image/png');
  assert.equal(value.image.data, png.toString('base64'));
  assert.match(f.calls[0], /nk=12345/);
  await assert.rejects(f.hub.handle('avatar', 'group:456', { userId: '88888' }), /只能查看/);
  assert.equal((await f.hub.handle('avatar', 'group:456', {})).userId, '99999');
  const registered = new Map();
  registerIntegrationTools({ tool: (name, description, schema, fn) => registered.set(name, fn) }, async () => ({ ok: true, ...value }), {});
  const result = await registered.get('qq_get_avatar')({ key: 'group:456', token: 'fixture' });
  assert.equal(result.content[1].type, 'image');
  assert.ok(!result.content[0].text.includes(png.toString('base64')));
});

test('shared memory follows QQ identity across names, persists, and respects source revocation/account changes', async t => {
  const f = fixture(t);
  const first = f.hub.remember('group:456', { userId: '12345', content: '喜欢摄影' });
  f.hub.remember('group:456', { content: '今天讨论过相机' });
  assert.equal(f.hub.query('group:789', { userId: '12345' })[0].content, '喜欢摄影');
  assert.equal(f.hub.query('group:789', { userId: '23456' }).length, 0);
  assert.equal(createSocialHub(f.deps).query('private:12345').length, 2);
  assert.throws(() => f.hub.remember('group:456', { userId: '23456', content: '猜测身份' }), /真实消息/);
  await assert.rejects(f.hub.handle('shared-remove', 'group:789', { id: first.id }), /当前会话写入/);
  f.setSelf('88888'); assert.equal(f.hub.query('group:789').length, 0);
  f.setSelf('99999');
  f.cfg.socialV2.sharedMemory.allowedKeys = ['group:789'];
  assert.equal(f.hub.query('group:789').length, 0);
});

test('legacy impressions migrate, edit and delete without merging duplicate names', t => {
  const f = fixture(t);
  const st = f.conv.get('group:456');
  st.memberImpressions = { 小明: { traits: ['喜欢摄影'], lastSeenAt: 100 } };
  f.hub.migrate();
  assert.equal(f.hub.query('private:12345')[0].content, '喜欢摄影');
  st.memberImpressions.小明.traits = ['喜欢音乐']; f.hub.syncImpressions('group:456', st);
  assert.deepEqual(f.hub.query('private:12345').map(x => x.content), ['喜欢音乐']);
  st.memberImpressions = {}; f.hub.syncImpressions('group:456', st);
  assert.equal(f.hub.query('private:12345').length, 0);
  f.conv.get('group:789').recentMessages.push({ userId: '34567', sender: '小明' });
  assert.equal(f.hub.resolvePerson('group:789', '小明'), null);
});

test('a later namesake cannot inherit an existing impression after message-window eviction', t => {
  const f = fixture(t); const st = f.conv.get('group:456');
  st.memberImpressions = { 小明: { traits: ['喜欢摄影'], lastSeenAt: 100 } };
  f.hub.migrate(); assert.equal(st.memberImpressions.小明.userId, '12345');
  st.recentMessages = [{ userId: '23456', sender: '小明' }];
  f.hub.syncImpressions('group:456', st);
  assert.equal(f.hub.query('group:789', { userId: '23456' }).length, 0);
  assert.equal(f.hub.query('private:12345')[0].content, '喜欢摄影');
});

test('handoffs persist to another window, retries are idempotent and bounce loops are blocked', async t => {
  const f = fixture(t);
  const body = { targetKey: 'group:789', content: '请接着说明摄影构图', requestId: 'handoff_01' };
  assert.equal((await f.hub.handle('handoff', 'group:456', body)).queued, true);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.hub.handle('handoff', 'group:456', body)).duplicate, true);
  assert.equal(f.calls.length, 1);
  assert.equal(createSocialHub(f.deps).inbox('group:789')[0].content, body.content);
  await assert.rejects(f.hub.handle('handoff', 'group:789', { ...body, targetKey: 'group:456', requestId: 'bounce_01' }), /反复唤醒/);
  await assert.rejects(f.hub.handle('handoff', 'group:456', { ...body, targetKey: 'group:999' }), /授权范围/);
  await assert.rejects(f.hub.handle('handoff', 'group:456', { ...body, content: 'changed' }), /其他交接/);
});

test('corrupt shared memory stays untouched', async t => {
  const f = fixture(t); const file = path.join(f.dir, 'shared-memory.json');
  fs.writeFileSync(file, '{broken');
  const hub = createSocialHub(f.deps);
  assert.throws(() => hub.remember('group:456', { content: '测试' }), /暂停写入/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('interrupted handoffs recover once and acknowledgement removes them from future prompts', async t => {
  const f = fixture(t);
  const broken = createSocialHub({ ...f.deps, deliver: async () => { throw new Error('offline'); } });
  await assert.rejects(broken.handle('handoff', 'group:456', { targetKey: 'group:789', content: '协作摘要', requestId: 'recover_01' }), /offline/);
  const restored = createSocialHub(f.deps);
  await restored.replayHandoffs(); await restored.replayHandoffs(); assert.equal(f.calls.length, 1);
  const id = restored.inbox('group:789')[0].id;
  await restored.handle('handoff-ack', 'group:789', { id });
  assert.equal(createSocialHub(f.deps).inbox('group:789').length, 0);
});

function qzoneFixture(t, overrides = {}) {
  const f = fixture(t); const calls = []; const events = [];
  const comments = [{ comment_id: 'c1', uin: 12345, name: '小明', time: 100, content: '已有评论', replies: [] }];
  const deps = { stateDir: f.dir, getConfig: () => f.cfg, sessionAllowed: () => true,
    onebot: async (action, params) => {
      calls.push({ action, params });
      if (action === 'get_login_info') return { user_id: 99999 };
      if (action === 'get_qzone_msg_list') return { msglist: [{ tid: 'own-tid', content: '自己的说说', comment_num: comments.length, images: [] }] };
      if (action === 'get_qzone_msg_detail') return { tid: 'own-tid', content: '自己的说说', comment_num: comments.length, comments };
      if (action === 'get_cookies') return { cookies: 'p_skey=fixture-only' };
      if (action === 'comment_qzone') return { comment_id: 'new-comment' };
      throw new Error('unexpected ' + action);
    }, notify: async (key, event) => events.push({ key, event }), ...overrides };
  return { ...f, calls, events, comments, qdeps: deps, qzone: createQzoneSocial(deps) };
}

test('comment monitor has a silent baseline, skips self, handles nested replies and never replays after restart', async t => {
  const f = qzoneFixture(t);
  await f.qzone.poll(); assert.equal(f.events.length, 0);
  f.comments.push({ comment_id: 'self', uin: 99999, content: '机器人回复', time: 101 });
  f.comments[0].replies.push({ comment_id: 'r2', uin: 12345, content: '新的回复', time: 102 });
  await f.qzone.poll(); assert.equal(f.events.length, 1);
  assert.equal(f.events[0].event.parentId, 'c1');
  await createQzoneSocial(f.qdeps).poll(); assert.equal(f.events.length, 1);
});

test('failed comment delivery is retried from persisted pending inbox', async t => {
  let broken = true;
  const f = qzoneFixture(t, { notify: async () => { if (broken) throw new Error('wake unavailable'); } });
  await f.qzone.poll();
  f.comments.push({ comment_id: 'c2', uin: 12345, content: '新评论', time: 103 });
  await assert.rejects(f.qzone.poll(), /wake unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'qzone-interactions.json'))).posts[0].pending.length, 1);
  broken = false; await createQzoneSocial(f.qdeps).poll();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'qzone-interactions.json'))).posts[0].pending.length, 0);
});

test('nested reply uses observed comment identity; duplicate requests never issue a second write', async t => {
  const writes = [];
  const f = qzoneFixture(t, { fetcher: async (url, init) => { writes.push({ url, init }); return { ok: true, text: async () => '{"code":0,"commentid":"r-new"}' }; } });
  const body = { tid: 'own-tid', commentId: 'c1', commentUserId: '12345', content: '谢谢你的评论', requestId: 'reply_001' };
  assert.equal((await f.qzone.handle('qzone-react', 'group:456', body)).confirmed, true);
  assert.equal((await f.qzone.handle('qzone-react', 'group:456', body)).duplicate, true);
  assert.equal(writes.length, 1);
  const params = new URLSearchParams(writes[0].init.body);
  assert.equal(params.get('commentId'), 'c1'); assert.equal(params.get('commentUin'), '12345');
  assert.equal(params.get('hostUin'), '99999'); assert.equal(params.get('paramstr'), '2');
  assert.equal(writes[0].init.redirect, 'error');
  await assert.rejects(f.qzone.handle('qzone-react', 'group:456', { ...body, tid: 'foreign' }), /自己空间/);
});

test('replying to a nested foreign author anchors to the root author, mentioning the actual target', async t => {
  let params;
  const f = qzoneFixture(t, { fetcher: async (_url, init) => {
    params = new URLSearchParams(init.body);
    return { ok: true, text: async () => '{"code":0,"commentid":"new"}' };
  } });
  f.comments[0].replies.push({ comment_id: 'r2', uin: 23456, content: 'nested', time: 103 });
  await f.qzone.handle('qzone-react', 'group:456', { tid: 'own-tid', commentId: 'r2',
    commentUserId: '23456', parentCommentId: 'c1', content: '回复楼中楼', requestId: 'nested_001' });
  assert.equal(params.get('commentId'), 'c1');
  assert.equal(params.get('commentUin'), '12345');
  assert.equal(params.get('replyUin'), '23456');
  assert.match(params.get('content'), /uin:23456/);
});

test('explicit server rejection may retry the same request; malformed/unknown results remain reserved', async t => {
  let reject = true, writes = 0;
  const f = qzoneFixture(t, { fetcher: async () => {
    writes++;
    return { ok: true, text: async () => reject ? '{"code":-10005}' : '{"code":0,"commentid":"new"}' };
  } });
  const body = { tid: 'own-tid', commentId: 'c1', content: '回复', requestId: 'rejected_01' };
  await assert.rejects(f.qzone.handle('qzone-react', 'group:456', body), /code=-10005/);
  reject = false;
  assert.equal((await f.qzone.handle('qzone-react', 'group:456', body)).confirmed, true);
  assert.equal(writes, 2);
});

test('uncertain comments reserve request IDs across restarts', async t => {
  const f = qzoneFixture(t, { fetcher: async () => { throw new Error('timeout'); } });
  const body = { tid: 'own-tid', commentId: 'c1', content: '回复', requestId: 'reply_002' };
  await assert.rejects(f.qzone.handle('qzone-react', 'group:456', body), /timeout/);
  await assert.rejects(createQzoneSocial(f.qdeps).handle('qzone-react', 'group:456', body), /上次评论结果未确认/);
});

test('revoked reply permission after cookie retrieval prevents the external write', async t => {
  let writes = 0;
  const f = qzoneFixture(t, { fetcher: async () => { writes++; throw new Error('must not write'); } });
  const original = f.qdeps.onebot;
  f.qdeps.onebot = async (action, params) => {
    const result = await original(action, params);
    if (action === 'get_cookies') f.cfg.integrations.qzone.allowedKeys = [];
    return result;
  };
  const qzone = createQzoneSocial(f.qdeps);
  await assert.rejects(qzone.handle('qzone-react', 'group:456', { tid: 'own-tid', commentId: 'c1', content: '回复', requestId: 'revoke_01' }), /撤销/);
  assert.equal(writes, 0);
});

test('malformed comment reads never establish an empty baseline', async t => {
  const f = qzoneFixture(t); const original = f.qdeps.onebot;
  const broken = createQzoneSocial({ ...f.qdeps, onebot: async (action, params) => action === 'get_qzone_msg_detail'
    ? { tid: 'own-tid', comments: null } : original(action, params) });
  await assert.rejects(broken.poll(), /评论响应无效/);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir, 'qzone-interactions.json')));
  assert.equal(saved.posts[0].initialized, false);
});

test('message pictures and self portrait are validated before publishing, then read back', async t => {
  const f = fixture(t); const writes = [];
  const handler = createIntegrations({ ...f.deps, tokenOk: (_key, token) => token === 'valid',
    validateImage: f.deps.validateImage, readSelfImage: async () => png,
    readMessageImages: async (key, id, index) => { assert.equal(key, 'group:456'); assert.equal(id, '123'); assert.equal(index, 1); return png; },
    onebot: async (action, params) => {
      writes.push({ action, params });
      return action === 'send_qzone_msg' ? { tid: 'picture-post' } : { msglist: [{ tid: 'picture-post', images: ['one', 'two'] }] };
    } });
  const request = async body => {
    let result;
    await handler({ req: { method: 'POST', headers: { 'x-agent-call': '1', 'x-agent-token': 'valid' } },
      url: new URL(INTEGRATION_PREFIX + 'qzone-publish', 'http://localhost'), readBody: async () => ({ key: 'group:456', ...body }), sendJson: value => { result = value; } });
    return result;
  };
  const result = await request({ content: '配图测试', requestId: 'images_001', imageMessages: [{ messageId: 123 }], includeSelfImage: true });
  assert.equal(writes[0].params.images.length, 2); assert.ok(writes[0].params.images.every(s => s.startsWith('base64://')));
  assert.equal(result.imagesVerified, true);
  assert.equal((await request({ content: '配图测试', requestId: 'images_001', imageMessages: [{ messageId: 123 }], includeSelfImage: true })).duplicate, true);
  assert.equal(writes.length, 2);
});

test('real bridge exposes shared memory across two authorized conversation windows', async () => {
  const h = await bridgeHarness({ config: { allow: { groups: ['456', '789'], private: ['12345'] },
    socialV2: { sharedMemory: { enabled: true, allowedKeys: ['group:456', 'group:789', 'private:12345'], handoffEnabled: true } } } });
  let server;
  try {
    h.setMode('reserved2'); h.setSelfIdentity('机器人', '99999');
    h.appendSocialV2Message('group:456', '小明', '你好', '你好', false, false, 'm1', [], '12345');
    h.appendSocialV2Message('group:789', '其他名片', '又见面', '又见面', false, false, 'm2', [], '12345');
    server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    const call = async (action, key, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${INTEGRATION_PREFIX}${action}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': h.getSocialV2State(key).agentToken },
        body: JSON.stringify({ key, ...body }) });
      return { status: r.status, data: await r.json() };
    };
    assert.equal((await call('shared-remember', 'group:456', { userId: '12345', content: '喜欢摄影' })).status, 200);
    assert.equal((await call('shared-query', 'group:789', {})).data.memories[0].content, '喜欢摄影');
    assert.match(h.buildWakePromptV2('group:789', 'test'), /喜欢摄影/);
    const handoff = await call('handoff', 'group:456', { targetKey: 'group:789', content: '协作测试摘要', requestId: 'bridge_handoff_01' });
    assert.equal(handoff.status, 200);
    assert.equal(handoff.data.queued, true);
    assert.ok(h.getSocialV2State('group:789').recentMessages.some(m => m.messageId === `handoff:${handoff.data.id}`));
    assert.ok(h.calls.prompts.some(p => p.sessionId));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
});
