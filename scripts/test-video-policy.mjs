import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { directlyMentionsBot, videoPolicy, videoApproval } from '../src/video-watch-policy.js';
import { readBilibiliMedia } from '../src/bilibili-media.js';
import { readBilibili } from '../src/bilibili.js';
import { createIntegrations } from '../src/project-integrations.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { compactModelMessage, compactModelData, videoMessageView } from '../src/qq-model-view.js';
const bv = 'BV1xx411c7mD';

test('未@仍显示视频标题链接，但只标为分享元数据，不能当作观看证据', () => {
  const card = '[B站视频卡片（分享者提供的信息）] 分享标题\nhttps://www.bilibili.com/video/' + bv;
  const message = { seq: 1, text: card, plain: card, tail: card, sharedLinks: ['https://www.bilibili.com/video/' + bv], directAtSelf: false };
  const view = compactModelMessage(message);
  assert.equal(view.directAtSelf, false);
  assert.equal(view.text, card);
  assert.deepEqual(view.videoWatch, { status: 'not-read', evidence: 'share-metadata-only' });
  assert.match(JSON.stringify(compactModelData({ info: message, recentMessages: [message] })), /分享标题/);
  assert.equal(message.videoWatch, undefined, '不篡改原消息');
  assert.equal(videoMessageView({ ...message, directAtSelf: true }).text, card);
});

test('未@视频恢复普通唤醒，旧消息快照显示标题；许可回复保留真实引用编号', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2'); h.setSelfIdentity('fixture', '10001'); h.setReady(true);
    const card = JSON.stringify({ meta: { detail_1: { title: '可按标题接话', qqdocurl: 'https://www.bilibili.com/video/' + bv } } });
    await h.handleIncoming('group', 456, { self_id: 10001, user_id: 123, group_id: 456, message_id: 'share',
      sender: { nickname: 'fixture' }, message: [{ type: 'json', data: { data: card } }] }, h.cfg);
    const st = h.getSocialV2State('group:456');
    assert.equal(st.bootstrapSent, true);
    assert.ok(st.pendingWakeTimer);
    const snapshot = h.buildWakeSnapshotV2('group:456');
    assert.match(JSON.stringify(snapshot), /可按标题接话/);
    assert.equal(snapshot.messages[0].videoWatch.status, 'not-read');
    assert.match(h.buildWakePromptV2('group:456', 'timeout'), /标题不是观看证据/);
    await h.handleIncoming('group', 456, { self_id: 10001, user_id: 123, group_id: 456, message_id: 'approval',
      sender: { nickname: 'fixture' }, message: [{ type: 'reply', data: { id: 'share' } }, { type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: '允许观看视频' } }] }, h.cfg);
    assert.equal(st.recentMessages.at(-1).replyToMessageId, 'share');
    assert.match(st.recentMessages.at(-1).plain, /@/);
    assert.equal(st.recentMessages.at(-1).approvalText, '允许观看视频');
    assert.ok(videoApproval(st.recentMessages[0], [st.recentMessages.at(-1)], { approvalUserId: '123' }));
  } finally { await h.close(); }
});

test('许可绑定真实发信人、原视频与当前会话消息，引用他人许可/模型布尔值不能授权', () => {
  const message = { seq: 42, messageId: '-123' }, cfg = { approvalUserId: '10009' };
  const grant = { seq: 43, messageId: '-124', userId: '10009', plain: '允许观看视频 42' };
  assert.equal(videoApproval(message, [grant], cfg), grant);
  assert.equal(videoApproval(message, [{ ...grant, plain: '允许观看视频', replyToMessageId: '-123' }], cfg)?.seq, 43);
  for (const candidate of [{ ...grant, userId: '10008' }, { ...grant, isSelf: true },
    { ...grant, plain: '他说允许观看视频 42' }, { ...grant, plain: '允许观看视频 99' },
    { ...grant, plain: '允许观看视频' }, { ...grant, plain: '允许观看视频', replyToMessageId: '-999' }]) {
    assert.equal(videoApproval(message, [candidate], cfg), null);
  }
  assert.equal(videoApproval(message, [], cfg), null);
  assert.equal(videoApproval(message, [grant], {}, '43'), null);
  assert.equal(videoApproval(message, [grant], cfg, '99'), null);
});

test('真实@与引用、昵称、@全体分开；门槛默认180秒8帧', () => {
  assert.deepEqual(videoPolicy(), { maxVideoSeconds: 180, defaultFrameCount: 8, maxTextChars: 6000 });
  for (const message of [[{ type: 'text', data: { text: '@10001' } }], [{ type: 'reply', data: { id: '1' } }], [{ type: 'at', data: { qq: 'all' } }], [{ type: 'at', data: { qq: '10002' } }]]) {
    assert.equal(directlyMentionsBot({ self_id: 10001, message }), false);
  }
  assert.equal(directlyMentionsBot({ self_id: 10001, message: [{ type: 'at', data: { qq: '10001' } }] }), true);
});

test('超长/未知时长/多P总时长超限在字幕和媒体请求前停止，片段参数不能绕过', async () => {
  for (const [duration, total] of [[181, 181], [undefined, undefined], [null, null], [10, 600]]) {
    let requests = 0;
    const fetcher = async url => {
      requests++;
      assert.match(url, /\/view\?/);
      return { statusCode: 200, url, body: JSON.stringify({ code: 0, data: { bvid: bv, duration: total,
        pages: [{ cid: 1, duration }], desc: '不可作为观看内容' } }) };
    };
    const result = await readBilibiliMedia(bv, { fetcher, startSeconds: 0, endSeconds: 5, media: {} });
    assert.equal(requests, 1);
    assert.equal(result.watchStatus, 'skipped');
    assert.equal(result.frames.length, 0);
    assert.equal(result.transcript, undefined);
    assert.equal(result.description, '不可作为观看内容');
    assert.equal(result.requiresUnwatchedDisclosure,true);
    assert.equal(result.responseMode,'metadata-comment-only');
  }
  let calls = 0;
  const result = await readBilibili(bv, { maxVideoSeconds: 180, fetcher: async url => {
    calls++;
    return { statusCode: 200, url, body: JSON.stringify(url.includes('/view?') ? { code: 0, data: { bvid: bv, duration: 180, pages: [{ cid: 1, duration: 180 }] } } : { data: {} }) };
  } });
  assert.equal(result.watchBlockReason, undefined);
  assert.equal(calls, 2, '恰好180秒允许继续检查字幕');
});

test('≤180秒无需@；超长需真实许可；撤销账号后不能借缓存或参数绕过', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-policy-'));
  const cfg = { integrations: { bilibili: { approvalUserId: '10009' } } };
  const message = { messageId: '1', seq: 42, directAtSelf: false, sharedLinks: ['https://www.bilibili.com/video/' + bv] };
  const messages = [message]; let reads = 0, duration = 180, approvedOptions;
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const integration = createIntegrations({ stateDir: dir, getConfig: () => cfg,
    getConversation: () => ({ recentMessages: messages }), sessionAllowed: () => true, tokenOk: () => true,
    readVideo: async (_ref, options) => { reads++; approvedOptions = options.watchApproved; return { duration, frames: [] }; } });
  t.after(async () => { await integration.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const scope = { key: 'group:456', assertAuthorized() {} };
  const read = async (extra = {}) => { clock += 6000; return JSON.parse((await integration.host.callTool('qq_read_bilibili', { messageId: '1', ...extra }, scope)).content[0].text).video; };
  assert.equal((await read()).duration, 180);
  assert.equal(approvedOptions, false);
  duration = 181;
  assert.equal((await read()).reason, 'duration_exceeded');
  messages.push({ seq: 43, userId: '10008', plain: '允许观看视频 42' });
  assert.equal((await read()).reason, 'duration_exceeded');
  messages.push({ seq: 44, userId: '10009', plain: '允许观看视频 42' });
  assert.equal((await read()).watchAuthorization, 'explicit-approval');
  assert.equal(approvedOptions, true);
  cfg.integrations.bilibili.approvalUserId = '10007';
  assert.equal((await read()).reason, 'duration_exceeded');
  assert.equal(approvedOptions, false);
  const forged = await integration.host.callTool('qq_read_bilibili', { messageId: '1', watchApproved: true }, scope).catch(error => error);
  assert.ok(forged.isError || forged instanceof Error, '模型不能传内部批准标志');
  assert.equal(reads, 5);
});

test('真实进线保存独立的直接@证据，普通分享不被标成已@', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2'); h.setSelfIdentity('fixture', '10001');
    for (const [id, segments, expected] of [['no-at', [], false], ['with-at', [{ type: 'at', data: { qq: '10001' } }], true]]) {
      await h.handleIncoming('group', 456, { self_id: 10001, user_id: 123, group_id: 456, message_id: id,
        sender: { nickname: 'fixture' }, message: [...segments, { type: 'text', data: { text: bv } }] }, h.cfg);
      assert.equal(h.getSocialV2State('group:456').recentMessages.at(-1).directAtSelf, expected);
    }
  } finally { await h.close(); }
});
