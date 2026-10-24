import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cardToText, expandCqCards, extractSharedLinks, readBilibili } from '../src/bilibili.js';
import { normalizeMagnet, formatQuarkResult } from '../src/quark-drive.js';
import { createIntegrations, INTEGRATION_PREFIX } from '../src/qq-integrations.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const bv = 'BV1xx411c7mD';
const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;
const card = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '测试视频', qqdocurl: `https://www.bilibili.com/video/${bv}`, desc: '哔哩哔哩' } } };

test('JSON / XML / escaped CQ cards preserve B站 links; malformed cards stay opaque', async () => {
  assert.match(cardToText(JSON.stringify(card)), new RegExp(bv));
  assert.match(cardToText(`<msg url="https://www.bilibili.com/video/${bv}"><title>视频</title></msg>`), new RegExp(bv));
  const encoded = JSON.stringify(card).replace(/,/g, '&#44;');
  assert.match(expandCqCards(`[CQ:json,data=${encoded}]`), new RegExp(bv));
  assert.equal(cardToText('{broken'), '[卡片消息]');
  assert.equal(cardToText({ app: 'other', meta: { url: 'http://localhost/secret' } }), '[卡片消息]');
  const h = await bridgeHarness();
  try {
    const text = await h.segmentsToText([{ type: 'json', data: { data: JSON.stringify(card) } }]);
    assert.match(text, new RegExp(bv));
    h.appendSocialV2Message('group:456', 'sender', 'x'.repeat(300) + text, 'x'.repeat(300) + text, false, false, '123');
    assert.ok(h.getSocialV2State('group:456').recentMessages[0].sharedLinks.some(s => s.includes(bv)));
  } finally { await h.close(); }
});

test('B站 reads real metadata and subtitles; missing subtitles are explicit', async () => {
  const requests = [];
  const fake = async url => {
    requests.push(url);
    let data;
    if (url.includes('/view?')) data = { code: 0, data: { bvid: bv, title: '视频', owner: { name: 'UP' }, desc: '简介', pages: [{ cid: 1, duration: 20, part: 'P1' }] } };
    else if (url.includes('/player/')) data = { code: 0, data: { subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://aisubtitle.hdslb.com/example.json' }] } } };
    else data = { body: [{ from: 0, content: '第一句字幕' }] };
    return { statusCode: 200, body: JSON.stringify(data), url, truncated: false };
  };
  const result = await readBilibili(bv, { fetcher: fake });
  assert.equal(result.subtitleStatus, 'available');
  assert.match(result.subtitle, /第一句字幕/);
  assert.equal(requests.length, 3);
  const noSub = await readBilibili(bv, { fetcher: async url => url.includes('/player/') ? { statusCode: 403 } : fake(url) });
  assert.equal(noSub.subtitleStatus, 'unavailable');
  assert.match(noSub.limit, /不能声称/);
  await assert.rejects(readBilibili('https://b23.tv/test', { fetcher: async () => ({ url: 'http://127.0.0.1/private' }) }), /未指向视频/);
});

test('magnet validation and Quark parse-only responses exclude credentials and reject unknown results', () => {
  assert.match(normalizeMagnet(magnet), /^magnet:/);
  assert.throws(() => normalizeMagnet('file:///C:/secret'), /BTIH/);
  assert.throws(() => normalizeMagnet('magnet:?xt=urn:btih:not-valid'), /BTIH/);
  assert.throws(() => formatQuarkResult({ supported: false, files: ['my-secret-file.pdf'] }), /没有可用/);
  assert.equal(formatQuarkResult({ supported: true, finished: false }), null);
  assert.throws(() => formatQuarkResult({ supported: true, errorCode: '401' }), /解析失败/);
  const preview = formatQuarkResult({ supported: true, finished: true, token: 'private-task-token', files: [{ name: 'movie.mkv', size: 100 }, { name: '说明.txt', size: 10 }], fileCount: 2 });
  assert.equal(preview.files.length, 2);
  assert.equal(preview.saved, false);
  assert.equal(preview.contentLevel, 'file-list');
  assert.equal('token' in preview, false);
  assert.ok(extractSharedLinks('x'.repeat(400) + magnet).some(s => s.includes('magnet:')));
});

function fixture(t, override = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-integrations-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'qq-integrations-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  const cfg = { integrations: { bilibili: { enabled: true }, quark: { enabled: true }, qzone: { enabled: true, allowedKeys: ['group:456'], visibility: 4, maxPerDay: 3, minIntervalSeconds: 60 } } };
  const handler = createIntegrations({
    stateDir: dir, getConfig: () => cfg, sessionAllowed: key => key === 'group:456', tokenOk: (key, token) => key === 'group:456' && token === 'valid',
    getConversation: () => ({ recentMessages: [{ seq: 1, messageId: '99', directAtSelf: true, sharedLinks: [magnet, `https://www.bilibili.com/video/${bv}`] }] }),
    onebot: async (action, params) => { calls.push({ action, params }); return { tid: 'fixture-tid' }; },
    readVideo: async reference => { calls.push({ reference }); return { title: 'fixture', duration: 20 }; },
    readMagnet: async value => { calls.push({ magnet: value }); return { files: ['fixture.txt'] }; },
    ...override
  });
  async function request(action, body = {}, token = 'valid') {
    let output;
    await handler({ req: { method: 'POST', headers: { 'x-agent-call': '1', 'x-agent-token': token } },
      url: new URL(`${INTEGRATION_PREFIX}${action}`, 'http://localhost'), readBody: async () => ({ key: 'group:456', ...body }),
      sendJson: (value, status = 200) => { output = { status, value }; } });
    return output;
  }
  return { dir, cfg, calls, request };
}

test('integration routes reject missing tokens, cross-session requests, unseen messages and disabled features', async t => {
  const f = fixture(t);
  await assert.rejects(f.request('bilibili', { messageId: '99' }, ''), /token/);
  await assert.rejects(f.request('bilibili', { key: 'group:999', messageId: '99' }), /token/);
  await assert.rejects(f.request('bilibili', { messageId: '999' }), /已收到/);
  f.cfg.integrations.quark.enabled = false;
  await assert.rejects(f.request('magnet', { messageId: '99' }), /未启用/);
  f.cfg.integrations.qzone.allowedKeys = [];
  await assert.rejects(f.request('qzone-publish', { content: '今天天气不错', requestId: 'fixture_01' }), /未获得/);
  assert.equal(f.calls.length, 0);
});

test('space publication checks visibility, returns only confirmed tid, and retries do not post twice', async t => {
  const f = fixture(t);
  const body = { content: '今天想分享一个小发现。', requestId: 'fixture_01' };
  const first = await f.request('qzone-publish', body);
  assert.equal(first.value.published, true);
  assert.equal(first.value.tid, 'fixture-tid');
  assert.equal(f.calls[0].params.ugc_right, 4);
  const duplicate = await f.request('qzone-publish', body);
  assert.equal(duplicate.value.duplicate, true);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.request('qzone-publish', { ...body, content: '改过的内容' }), /已被其他/);
  await assert.rejects(f.request('qzone-publish', { ...body, requestId: 'fixture_02' }), /相同发布/);
  await assert.rejects(f.request('qzone-publish', { content: '另一条', requestId: 'fixture_03' }), /冷却/);
});

test('ambiguous space response reserves persisted idempotency', async t => {
  const f = fixture(t, { onebot: async () => ({}) });
  const body = { content: '测试内容', requestId: 'uncertain_01' };
  await assert.rejects(f.request('qzone-publish', body), /未确认/);
  await assert.rejects(f.request('qzone-publish', body), /上次发布结果/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'qzone-posts.json'), 'utf8'))[0].status, 'pending');
});

test('B站 and magnet tools only receive links from the bound message', async t => {
  const f = fixture(t);
  assert.equal((await f.request('bilibili', { messageId: 1 })).value.video.title, 'fixture');
  assert.deepEqual((await f.request('magnet', { messageId: '99' })).value.result.files, ['fixture.txt']);
  assert.ok(f.calls[0].reference.includes(bv));
  assert.match(f.calls[1].magnet, /^magnet:/);
});
