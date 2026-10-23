import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocialHub } from '../src/social-hub.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const source = 'private:12345', target = 'private:23456';
const body = { targetKey: target, messages: ['测试文本'], stickerIds: ['picture'], requestId: 'delivery_test_01' };
function fixture(t, send) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-'));
  t.after(() => { assert.ok(path.resolve(stateDir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'qq-delivery-')); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const cfg = { socialV2: { sharedMemory: { enabled: true, handoffEnabled: true, allowedKeys: [source, target] } } };
  const calls = [];
  const deps = { stateDir, getConfig: () => cfg, getSelfId: () => '99999', getConversation: () => null,
    getConversations: () => new Map(), sessionAllowed: () => true, getSticker: id => id === 'picture' ? { id } : null,
    deliver: async () => {}, sendContactPart: async (...args) => { calls.push(args); return send ? send(...args) : { messageId: -100 - calls.length }; } };
  return { cfg, deps, calls, hub: createSocialHub(deps) };
}

test('handoff acknowledgement has no send receipt and can never report sent', async t => {
  const f = fixture(t);
  const queued = await f.hub.handle('handoff', source, { targetKey: target, content: '协作', requestId: 'handoff_test_01' });
  assert.equal(queued.sent, false);
  const ack = await f.hub.handle('handoff-ack', target, { id: queued.id });
  assert.equal(ack.sent, false);
  const status = await f.hub.handle('handoff-status', source, { id: queued.id });
  assert.equal(status.status, 'acknowledged_without_send_receipt');
  assert.equal(status.sent, false); assert.equal(f.calls.length, 0);
});

test('direct delivery persists real text/image receipts; retry and process restart cannot duplicate', async t => {
  const f = fixture(t);
  const result = await f.hub.handle('contact-send', source, body);
  assert.equal(result.sent, true); assert.equal(result.receipts.length, 2);
  assert.deepEqual(f.calls.map(c => c[1].type), ['text', 'sticker']);
  const restarted = createSocialHub(f.deps);
  assert.equal((await restarted.handle('contact-send', source, body)).duplicate, true);
  assert.equal(f.calls.length, 2);
  await assert.rejects(restarted.handle('contact-send', source, { ...body, messages: ['不同内容'] }), /requestId/);
  await assert.rejects(restarted.handle('contact-send-status', target, { requestId: body.requestId }), /当前会话/);
});

test('missing receipt or a timeout stays uncertain and does not automatically retry', async t => {
  for (const send of [async () => ({}), async () => { throw new Error('timeout'); }]) {
    const f = fixture(t, send);
    const result = await f.hub.handle('contact-send', source, body);
    assert.equal(result.sent, false); assert.equal(result.status, 'uncertain');
    await createSocialHub(f.deps).handle('contact-send', source, body);
    assert.equal(f.calls.length, 1);
  }
});

test('partial success preserves receipts and never resends the successful text', async t => {
  const f = fixture(t, async (_, part) => {
    if (part.type === 'sticker') throw Object.assign(new Error('图片下载失败'), { notSent: true });
    return { messageId: 123456 };
  });
  const result = await f.hub.handle('contact-send', source, body);
  assert.equal(result.sent, false); assert.equal(result.status, 'partial');
  assert.deepEqual(result.receipts, [{ type: 'text', messageId: '123456' }]);
  await f.hub.handle('contact-send', source, body); assert.equal(f.calls.length, 2);
});

test('revoked source token/target scope cancels before network write and does not claim delivery', async t => {
  const f = fixture(t, async (_, part, check) => {
    f.cfg.socialV2.sharedMemory.allowedKeys = [source];
    try { check(); } catch (e) { e.notSent = true; throw e; }
    assert.fail('revoked request reached write');
  });
  const result = await f.hub.handle('contact-send', source, body);
  assert.equal(result.sent, false); assert.equal(result.status, 'not_sent');
  const g = fixture(t);
  let checks = 0;
  await assert.rejects(g.hub.handle('contact-send', source, body, () => { checks++; throw new Error('agent token 无效'); }), /token/);
  assert.equal(checks, 1); assert.equal(g.calls.length, 0);
});

test('known tokens, unknown stickers, disabled send tools and ungranted destinations are blocked', async t => {
  const f = fixture(t);
  const hub = createSocialHub({ ...f.deps, sanitizeText: s => s.replaceAll('known-secret', '[redacted]') });
  await assert.rejects(hub.handle('contact-send', source, { ...body, messages: ['known-secret'] }), /敏感/);
  await assert.rejects(hub.handle('contact-send', source, { ...body, targetKey: 'private:88888' }), /授权/);
  await assert.rejects(hub.handle('contact-send', source, { ...body, stickerIds: ['invented'] }), /真实图片/);
  f.cfg.socialV2.tools = { sendMessage: false };
  await assert.rejects(hub.handle('contact-send', source, body), /未启用/);
  assert.equal(f.calls.length, 0);
});

test('concurrent identical calls reserve the request before sending', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async () => { await pending; return { messageId: 123 }; });
  const first = f.hub.handle('contact-send', source, { ...body, stickerIds: [] });
  const second = await f.hub.handle('contact-send', source, { ...body, stickerIds: [] });
  assert.equal(second.sent, false); assert.equal(second.duplicate, true);
  release(); assert.equal((await first).sent, true); assert.equal(f.calls.length, 1);
});

test('corrupt delivery ledger fails closed without a network write', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.deps.stateDir, 'shared-memory.json'), '{bad');
  await assert.rejects(createSocialHub(f.deps).handle('contact-send', source, body), /发送记录/);
  assert.equal(f.calls.length, 0);
});

async function realBridge(t, globals = {}, extra = {}) {
  const h = await bridgeHarness({ config: { ownerQQ: 12345, allow: { private: ['12345', '23456'], groups: [] },
    socialV2: { sharedMemory: { enabled: true, handoffEnabled: true, allowedKeys: [source, target] }, ...extra } }, globals,
    files: { 'state/stickers.json': [{ id: 'fixture-sticker', url: 'https://public.invalid/sticker', desc: '模拟图片' }] } });
  h.setMode('reserved2'); h.setSelfIdentity('测试机器人', '99999');
  const token = h.getSocialV2State(source).agentToken;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });
  const post = async (data, actualToken = token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/integrations/contact-send`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': actualToken },
      body: JSON.stringify({ key: source, ...data }) });
    return { status: res.status, data: await res.json() };
  };
  return { h, post };
}

test('real bridge source-token route sends to correct target without a target agent turn', async t => {
  const { h, post } = await realBridge(t);
  const payload = { ...body, stickerIds: [] };
  const result = await post(payload);
  assert.equal(result.status, 200); assert.equal(result.data.sent, true);
  assert.equal(result.data.receipts[0].messageId, '9001');
  assert.equal(h.calls.http.length, 1); assert.equal(h.calls.http[0].body.user_id, 23456);
  assert.equal(h.calls.http[0].body.message[0].data.text, '测试文本');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.getSocialV2State(target).recentMessages.at(-1).messageId, '9001');
  await post(payload); assert.equal(h.calls.http.length, 1);
  assert.equal((await post({ ...payload, requestId: 'new_req_01' }, 'wrong-token')).status, 403);
});

test('real bridge missing message ID cannot produce successful delivery', async t => {
  let writes = 0;
  const { post } = await realBridge(t, { fetch: async () => { writes++; return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: {} }) }; } });
  const result = await post({ ...body, stickerIds: [] });
  assert.equal(result.data.sent, false); assert.equal(result.data.status, 'uncertain');
  await post({ ...body, stickerIds: [] }); assert.equal(writes, 1);
});

test('real bridge text quota is shared with normal sends', async t => {
  const { h, post } = await realBridge(t, {}, { send: { maxSendPerMinute: 1 } });
  h.getSocialV2State(target).sendTimes.push(Date.now());
  const result = await post({ ...body, stickerIds: [] });
  assert.equal(result.data.sent, false); assert.equal(result.data.status, 'not_sent');
  assert.match(result.data.error, /频率/); assert.equal(h.calls.http.length, 0);
});

test('real bridge directly sends collected image bytes and records its receipt', async t => {
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const { h, post } = await realBridge(t, { safeFetchBuffer: async () => ({ buffer: image }) });
  const result = await post({ ...body, messages: [], stickerIds: ['fixture-sticker'] });
  assert.equal(result.data.sent, true); assert.equal(result.data.receipts[0].type, 'sticker');
  assert.equal(h.calls.http[0].body.user_id, 23456);
  assert.equal(h.calls.http[0].body.message[0].data.file, 'base64://' + image.toString('base64'));
});

test('source token rotation while preparing an image cancels its queued write', async t => {
  let bridge;
  const { h, post } = await realBridge(t, { safeFetchBuffer: async () => {
    bridge.getSocialV2State(source).agentToken = 'rotated-fixture-token';
    return { buffer: Buffer.from('image') };
  } });
  bridge = h;
  const result = await post({ ...body, messages: [], stickerIds: ['fixture-sticker'] });
  assert.equal(result.status, 403); // The HTTP result is also hidden from the revoked source.
  assert.equal(h.calls.http.length, 0);
  const ledger = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/shared-memory.json')));
  assert.equal(ledger.contactSends[0].parts[0].status, 'failed');
});
