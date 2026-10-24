import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createQzoneSocial } from '../src/qzone-social.js';
import { catalogFromDisk } from '../src/plugin-host/catalog.js';

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-qzone-friends-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { ownerQQ: 12345, integrations: { qzone: { enabled: true, commentsEnabled: true, friendsEnabled: true,
    likesEnabled: true, autoReact: true, autoBrowseFriends: true, likeIntervalSeconds: 0, maxCommentLikesPerPost: 2,
    commentKey: 'private:12345', allowedKeys: ['private:12345', 'group:456'] } } };
  const calls = []; const writes = []; const events = []; const tids = ['same-tid'];
  const comments = [{ comment_id: '1', uin: 54321, name: '朋友', time: 100, content: '给出了有用的具体建议',
    replies: [{ comment_id: '1', uin: 54321, name: '朋友', time: 101, content: '二级回复' }] },
    { comment_id: '2', uin: 65432, time: 102, content: '补充了另一个细节', replies: [] },
    { comment_id: '3', uin: 76543, time: 103, content: '第三条', replies: [] },
    { comment_id: '4', uin: 99999, time: 104, content: '自己', replies: [] }];
  const deps = { stateDir: dir, getConfig: () => cfg, sessionAllowed: () => true,
    onebot: async (action, params) => {
      calls.push({ action, params });
      if (action === 'get_login_info') return { user_id: 99999 };
      if (action === 'get_friend_list') return [{ user_id: 12345 }];
      if (action === 'get_qzone_feeds') return { feeds: [{ uin: 12345, appid: 311, key: 'not-a-real-tid', html: 'untrusted' }], has_more: true };
      if (action === 'get_qzone_msg_list') return { msglist: tids.map(tid => ({ tid, content: '真实说说', time: 77, images: [], comment_num: comments.length })) };
      if (action === 'get_qzone_msg_detail') return { tid: params.tid, content: '正文', comment_num: comments.length, comments };
      if (action === 'get_cookies') return { cookies: 'p_skey=fixture-only' };
      if (action === 'like_qzone') { writes.push({ action, params }); return null; }
      if (action === 'comment_qzone') { writes.push({ action, params }); return { comment_id: '5' }; }
      throw new Error('unexpected ' + action);
    }, fetcher: async (url, init) => { writes.push({ url, init }); return { ok: true, text: async () => '{"code":0,"commentid":"5"}' }; },
    notify: async (key, event) => events.push({ key, event }), ...overrides };
  const qzone = createQzoneSocial(deps);
  return { dir, cfg, calls, writes, events, tids, comments, deps, qzone };
}
const key = 'private:12345';
const like = (extra = {}) => ({ targetUserId: '12345', tid: 'same-tid', reason: '这条建议有具体细节，对当前问题有帮助', requestId: 'like_001', ...extra });

test('friend feed resolves real post IDs; author and session remain bound', async t => {
  const f = fixture(t);
  const feed = await f.qzone.handle('qzone-feed', key, {});
  assert.equal(feed.posts[0].tid, 'same-tid'); assert.equal(feed.posts[0].targetUserId, '12345');
  assert.ok(f.calls.some(c => c.action === 'get_qzone_msg_list' && c.params.target_uin === 12345));
  await assert.rejects(f.qzone.handle('qzone-like', 'group:456', like()), /本会话已读取/);
  await assert.rejects(f.qzone.handle('qzone-like', key, like({ targetUserId: '77777' })), /已读取/);
  await assert.rejects(f.qzone.handle('qzone-list', key, { targetUserId: '77777' }), /真实 QQ 好友/);
  assert.equal(f.writes.length, 0);
});

test('post like carries friend owner and observed timestamp; restart and new request IDs cannot double-like', async t => {
  const f = fixture(t); await f.qzone.handle('qzone-list', key, { targetUserId: '12345' });
  assert.equal((await f.qzone.handle('qzone-like', key, like())).liked, true);
  assert.deepEqual(f.writes[0], { action: 'like_qzone', params: { tid: 'same-tid', target_uin: 12345, abstime: 77 } });
  assert.equal((await createQzoneSocial(f.deps).handle('qzone-like', key, like({ requestId: 'like_002' }))).duplicate, true);
  assert.equal(f.writes.length, 1);
});

test('friend comments and nested replies keep host distinct from logged-in author', async t => {
  const f = fixture(t); await f.qzone.handle('qzone-list', key, { targetUserId: '12345' });
  await f.qzone.handle('qzone-react', key, { targetUserId: '12345', tid: 'same-tid', content: '谢谢这个具体建议', requestId: 'comment_01' });
  assert.equal(f.writes[0].params.target_uin, 12345);
  const g = fixture(t); await g.qzone.handle('qzone-list', key, { targetUserId: '12345' });
  await g.qzone.handle('qzone-react', key, { targetUserId: '12345', tid: 'same-tid', commentId: '1', commentUserId: '54321', parentCommentId: '1', content: '这个补充很有用', requestId: 'reply_01' });
  const body = new URLSearchParams(g.writes[0].init.body);
  assert.equal(body.get('hostUin'), '12345'); assert.equal(body.get('uin'), '99999');
  assert.equal(body.get('t1_uin'), '12345'); assert.equal(body.get('commentUin'), '54321');
});

test('only unambiguous read root comments can be liked; actual comment key differs from mood URL', async t => {
  const f = fixture(t); await f.qzone.handle('qzone-list', key, {});
  const read = await f.qzone.handle('qzone-comments', key, { tid: 'same-tid' });
  assert.equal(read.comments[0].canLike, true); assert.equal(read.comments[1].canLike, false);
  const body = like({ targetUserId: '99999', commentId: '1', commentUserId: '54321' });
  await assert.rejects(f.qzone.handle('qzone-like-comment', key, { ...body, commentUserId: '88888' }), /评论不存在/);
  await assert.rejects(f.qzone.handle('qzone-like-comment', key, { ...body, parentCommentId: '1' }), /独立评论点赞编号/);
  const second = { ...body, requestId: 'like_valid' };
  assert.equal((await f.qzone.handle('qzone-like-comment', key, second)).liked, true);
  const params = new URLSearchParams(f.writes[0].init.body);
  assert.equal(params.get('unikey'), '99999_same-tid_1'); assert.equal(params.get('from'), '-100');
  assert.equal(params.get('opuin'), '99999'); assert.equal(f.writes[0].init.redirect, 'error');
  await assert.rejects(f.qzone.handle('qzone-like-comment', key, like({ targetUserId: '99999', commentId: '4', commentUserId: '99999', requestId: 'self_001' })), /机器人自己/);
});

test('likes require meaningful reason; per-post quota and cooldown enforce selective interaction', async t => {
  const f = fixture(t); f.comments[0].replies = []; await f.qzone.handle('qzone-list', key, {});
  const body = like({ targetUserId: '99999', commentId: '1', commentUserId: '54321' });
  await assert.rejects(f.qzone.handle('qzone-like-comment', key, { ...body, reason: '好' }), /具体点赞理由/);
  await f.qzone.handle('qzone-like-comment', key, body);
  await f.qzone.handle('qzone-like-comment', key, { ...body, commentId: '2', commentUserId: '65432', requestId: 'like_002' });
  await assert.rejects(f.qzone.handle('qzone-like-comment', key, { ...body, commentId: '3', commentUserId: '76543', requestId: 'like_003' }), /不要每条都点/);
  assert.equal(f.writes.length, 2);
  const g = fixture(t); await g.qzone.handle('qzone-list', key, { targetUserId: '12345' });
  await g.qzone.handle('qzone-like', key, like()); g.cfg.integrations.qzone.likeIntervalSeconds = 60;
  await assert.rejects(g.qzone.handle('qzone-like-comment', key, like({ commentId: '2', commentUserId: '65432', requestId: 'like_002' })), /冷却/);
});

test('ambiguous write is reserved across restarts and new IDs; disabling before cookie return prevents writes', async t => {
  const f = fixture(t, { fetcher: async () => { throw new Error('timeout'); } });
  f.comments[0].replies = []; await f.qzone.handle('qzone-list', key, {});
  const body = like({ targetUserId: '99999', commentId: '1', commentUserId: '54321' });
  await assert.rejects(f.qzone.handle('qzone-like-comment', key, body), /timeout/);
  await assert.rejects(createQzoneSocial(f.deps).handle('qzone-like-comment', key, { ...body, requestId: 'like_002' }), /未确认/);
  const g = fixture(t); g.comments[0].replies = []; await g.qzone.handle('qzone-list', key, {});
  const original = g.deps.onebot;
  g.deps.onebot = async (action, params) => { const result = await original(action, params); if (action === 'get_cookies') g.cfg.integrations.qzone.likesEnabled = false; return result; };
  await assert.rejects(createQzoneSocial(g.deps).handle('qzone-like-comment', key, body), /撤销/);
  assert.equal(g.writes.length, 0);
});

test('friend browsing starts silently, emits new posts once and persists pending deliveries', async t => {
  const f = fixture(t); await f.qzone.poll(); assert.equal(f.events.length, 0);
  f.tids.push('new-post'); await createQzoneSocial(f.deps).poll();
  assert.equal(f.events.length, 1); assert.equal(f.events[0].event.kind, 'friend-post');
  assert.equal(f.events[0].event.targetUserId, '12345'); assert.equal(f.events[0].event.tid, 'new-post');
  await createQzoneSocial(f.deps).poll(); assert.equal(f.events.length, 1);
  assert.equal(f.writes.length, 0, 'poller never automatically likes every post');
});

test('feeds3 containing only self falls back to actual friends and reports its source', async t => {
  const f = fixture(t); const original = f.deps.onebot;
  f.deps.onebot = (action, args) => action === 'get_qzone_feeds'
    ? { feeds: [{ uin: 99999, appid: 311 }], has_more: false } : original(action, args);
  const result = await createQzoneSocial(f.deps).handle('qzone-feed', key, {});
  assert.equal(result.source, 'friend-list-fallback'); assert.equal(result.posts[0].targetUserId, '12345');
  assert.ok(f.calls.some(c => c.action === 'get_friend_list'));
});

test('failed friend-post notification remains pending and is delivered once after restart', async t => {
  let broken = true;
  const f = fixture(t, { notify: async (key, event) => { if (broken) throw new Error('wake unavailable'); f.events.push({ key, event }); } });
  await f.qzone.poll(); f.tids.push('fresh-post');
  await assert.rejects(createQzoneSocial(f.deps).poll(), /wake unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'qzone-interactions.json'))).friendFeeds['99999'].pending.length, 1);
  broken = false; await createQzoneSocial(f.deps).poll(); await createQzoneSocial(f.deps).poll();
  assert.equal(f.events.length, 1);
});

test('built-in manifests expose scoped new tools with strict schemas', () => {
  const rows = catalogFromDisk(process.cwd(), { integrations: { qzone: { enabled: true } } });
  for (const name of ['qq_get_qzone_feed', 'qq_like_qzone', 'qq_like_qzone_comment']) {
    assert.ok(rows.some(row => row.name === name));
    assert.equal(rows.find(row => row.name === name).inputSchema.additionalProperties, false);
  }
});
