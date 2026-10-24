import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { directlyMentionsBot, videoPolicy } from '../src/video-watch-policy.js';
import { readBilibiliMedia } from '../src/bilibili-media.js';
import { readBilibili } from '../src/bilibili.js';
import { createIntegrations } from '../src/project-integrations.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { compactModelMessage, compactModelData, videoMessageView, blockedVideoOnly } from '../src/qq-model-view.js';
const bv = 'BV1xx411c7mD';

test('未@视频卡片的标题和链接不进入模型；保留原始存储及独立文字', () => {
  const card = `[B站视频卡片（分享者提供的信息）] 不应曝光的标题\nhttps://www.bilibili.com/video/${bv}`;
  const message = { seq: 1, text: card, plain: card, tail: `曝光的标题\nhttps://b23.tv/fixture`,
    sharedLinks: [`https://www.bilibili.com/video/${bv}`, 'magnet:?xt=urn:btih:fixture'], directAtSelf: false };
  const view = compactModelMessage(message);
  assert.equal(view.directAtSelf, false);
  assert.equal(view.videoWatch.reason, 'mention_required');
  assert.doesNotMatch(JSON.stringify(view), /不应曝光|曝光的标题|bilibili|b23|BV1/);
  assert.equal(view.sharedLinks[0], 'magnet:?xt=urn:btih:fixture');
  assert.equal(message.text, card, '本地原记录不变');
  assert.doesNotMatch(JSON.stringify(compactModelData({ info: message, recentMessages: [message] })), /不应曝光|曝光的标题|bilibili|b23|BV1/);
  assert.equal(blockedVideoOnly(videoMessageView(message)), true);
  const mixed = videoMessageView({ ...message, plain: `明天几点见面？\n${card}` });
  assert.match(mixed.plain, /明天几点见面/);
  assert.equal(blockedVideoOnly(mixed), false);
  assert.match(compactModelMessage({ ...message, directAtSelf: true }).text, /不应曝光的标题/);
});

test('未@视频不会从bootstrap/任意消息触发；后续唤醒和等待上下文也屏蔽卡片', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2'); h.setSelfIdentity('fixture', '10001'); h.setReady(true);
    const card = JSON.stringify({ meta: { detail_1: { title: '禁止借标题接话', qqdocurl: `https://www.bilibili.com/video/${bv}` } } });
    await h.handleIncoming('group', 456, { self_id: 10001, user_id: 123, group_id: 456, message_id: 'share',
      sender: { nickname: 'fixture' }, message: [{ type: 'json', data: { data: card } }] }, h.cfg);
    const st = h.getSocialV2State('group:456');
    assert.equal(st.bootstrapSent, false);
    assert.equal(st.pendingWakeTimer, null);
    assert.equal(h.calls.prompts.length, 0);
    assert.match(st.recentMessages.at(-1).text, /禁止借标题接话/);
    const snapshot = h.buildWakeSnapshotV2('group:456');
    assert.doesNotMatch(JSON.stringify(snapshot), /禁止借标题接话|bilibili|BV1/);
    assert.equal(snapshot.messages[0].videoWatch.reason, 'mention_required');
    assert.doesNotMatch(h.buildWakePromptV2('group:456', 'timeout'), /禁止借标题接话/);
    st.bootstrapSent = true; st.wakeConfig = { mode: 'active', triggers: { anyMessage: true } };
    await h.handleIncoming('group', 456, { self_id: 10001, user_id: 123, group_id: 456, message_id: 'native',
      sender: { nickname: 'fixture' }, message: [{ type: 'video', data: { file: 'fixture.mp4' } }] }, h.cfg);
    assert.equal(st.pendingWakeTimer, null);
    assert.equal(h.calls.prompts.length, 0);
    // Independently typed questions still enter the normal wake path.
    await h.handleIncoming('group', 456, { self_id: 10001, user_id: 123, group_id: 456, message_id: 'mixed',
      sender: { nickname: 'fixture' }, message: [{ type: 'json', data: { data: card } }, { type: 'text', data: { text: '明天几点见面？' } }] }, h.cfg);
    assert.ok(st.pendingWakeTimer);
    assert.match(JSON.stringify(h.buildWakeSnapshotV2('group:456')), /明天几点见面/);
  } finally { await h.close(); }
});

test('真实@与引用、昵称、@全体分开；门槛默认300秒8帧', () => {
  assert.deepEqual(videoPolicy(), { maxVideoSeconds: 300, defaultFrameCount: 8, maxTextChars: 6000 });
  for (const message of [[{ type: 'text', data: { text: '@10001' } }], [{ type: 'reply', data: { id: '1' } }], [{ type: 'at', data: { qq: 'all' } }], [{ type: 'at', data: { qq: '10002' } }]]) {
    assert.equal(directlyMentionsBot({ self_id: 10001, message }), false);
  }
  assert.equal(directlyMentionsBot({ self_id: 10001, message: [{ type: 'at', data: { qq: '10001' } }] }), true);
});

test('超长/未知时长/多P总时长超限在字幕和媒体请求前停止，片段参数不能绕过', async () => {
  for (const [duration, total] of [[301, 301], [undefined, undefined], [null, null], [10, 600]]) {
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
    assert.equal(result.description, undefined);
  }
  let calls = 0;
  const result = await readBilibili(bv, { maxVideoSeconds: 300, fetcher: async url => {
    calls++;
    return { statusCode: 200, url, body: JSON.stringify(url.includes('/view?') ? { code: 0, data: { bvid: bv, duration: 300, pages: [{ cid: 1, duration: 300 }] } } : { data: {} }) };
  } });
  assert.equal(result.watchBlockReason, undefined);
  assert.equal(calls, 2, '恰好300秒允许继续检查字幕');
});

test('缓存、作用域和热修改时长上限均不能绕过观看门槛', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-video-policy-'));
  const cfg = { integrations: { bilibili: {} } };
  const message = { messageId: '1', directAtSelf: false, sharedLinks: [`https://www.bilibili.com/video/${bv}`] };
  let reads = 0;
  const integration = createIntegrations({ stateDir: dir, getConfig: () => cfg,
    getConversation: () => ({ recentMessages: [message] }), sessionAllowed: () => true, tokenOk: () => true,
    readVideo: async () => { reads++; return { duration: 30, frames: [] }; } });
  t.after(async () => { await integration.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const scope = { key: 'group:456', assertAuthorized() {} };
  const read = async () => JSON.parse((await integration.host.callTool('qq_read_bilibili', { messageId: '1' }, scope)).content[0].text).video;
  assert.equal((await read()).reason, 'mention_required');
  assert.equal(reads, 0);
  message.directAtSelf = true;
  assert.equal((await read()).duration, 30);
  assert.equal(reads, 1);
  message.directAtSelf = false;
  assert.equal((await read()).reason, 'mention_required');
  assert.equal(reads, 1);
  message.directAtSelf = true;
  cfg.integrations.bilibili.maxVideoSeconds = 10;
  assert.equal((await read()).watchStatus, 'skipped');
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
