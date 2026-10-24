import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBingImages, bingImageSearch, createImageSearchStore } from '../src/image-search.js';
import { registerIntegrationTools } from '../src/mcp-qq-integrations.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createQzonePublisher } from '../src/qzone-publisher.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
const source = 'private:12345', target = 'private:23456';
const candidate = { title: '孙笑川 表情包', imageUrl: 'https://images.example/meme.png', thumbnailUrl: 'https://images.example/thumb.png', pageUrl: 'https://example.com/memes' };
const html = item => '<a class="iusc" m="' + JSON.stringify(item).replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></a>';
function fixture(t, extra = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-search-'));
  t.after(() => { assert.ok(path.resolve(stateDir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'qq-image-search-')); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const cfg = { webSearch: { enabled: true }, socialV2: { tools: {} } };
  let self = '99999', clock = 100000;
  const deps = { stateDir, getConfig: () => cfg, getSelfId: () => self, sessionAllowed: () => true,
    validateImage: buffer => buffer.equals(png) ? { buffer, mimeType: 'image/png' } : null,
    fetchImage: async () => ({ buffer: png }), searchImages: async () => ({ provider: 'bing-images', results: [candidate] }),
    now: () => clock, ...extra };
  return { deps, cfg, store: createImageSearchStore(deps), setSelf: id => { self = id; }, advance: ms => { clock += ms; } };
}

test('parses real image metadata, entities and duplicates; rejects non-image URL schemes', () => {
  const row = { murl: candidate.imageUrl + '?a=1&b=2', turl: candidate.thumbnailUrl, purl: candidate.pageUrl, t: candidate.title };
  const result = parseBingImages(html(row) + html(row) + html({ ...row, murl: 'file:///private' })
    + html({ ...row, murl: 'https://user:password@example.com/image' }) + '<a m="{bad}">');
  assert.equal(result.length, 1); assert.equal(result[0].imageUrl, row.murl);
});

test('Bing image search filters observed single-character junk and retries the compact subject', async () => {
  const queries = [];
  const result = await bingImageSearch('孙笑川 表情包', { fetchHtml: async url => {
    const q = new URL(url).searchParams.get('q'); queries.push(q);
    return { statusCode: 200, body: html({ murl: candidate.imageUrl, turl: candidate.thumbnailUrl, purl: candidate.pageUrl,
      t: queries.length === 1 ? '孙的笔顺 汉字词典' : candidate.title }) };
  } });
  assert.equal(result.results.length, 1); assert.equal(queries.length, 2);
  assert.equal(queries[1], '孙笑川表情包');
});

test('generic meme/image words cannot make another subject count as relevant', async () => {
  const result = await bingImageSearch('孙笑川 表情包', { fetchHtml: async () => ({ statusCode: 200,
    body: html({ murl: candidate.imageUrl, turl: candidate.thumbnailUrl, t: '猫猫表情包' }) }) });
  assert.equal(result.results.length, 0);
});

test('search previews and persisted send image use exactly the same validated bytes', async t => {
  const f = fixture(t);
  const result = await f.store.search(source, { query: '孙笑川 表情包' });
  assert.equal(result.previews[0].data, png.toString('base64'));
  const id = result.images[0].imageId;
  assert.ok(createImageSearchStore(f.deps).resolve(source, id).buffer.equals(png));
  assert.throws(() => f.store.resolve(target, id), /不属于/);
  f.setSelf('88888'); assert.throws(() => f.store.resolve(source, id), /不属于/);
  f.setSelf('99999'); f.advance(3600001); assert.throws(() => f.store.resolve(source, id), /过期/);
});

test('blocked original can use the actual indexed thumbnail without inventing image content', async t => {
  const fetched = [];
  const f = fixture(t, { fetchImage: async url => { fetched.push(url); if (url === candidate.imageUrl) throw new Error('HTTP 403'); return { buffer: png }; } });
  const result = await f.store.search(source, { query: '孙笑川' });
  assert.equal(result.images[0].variant, 'thumbnail'); assert.equal(fetched.length, 2);
});

test('HTML/non-image bytes and empty search results never become sendable image IDs', async t => {
  const f = fixture(t, { fetchImage: async () => ({ buffer: Buffer.from('<html>blocked</html>') }) });
  const result = await f.store.search(source, { query: '孙笑川' });
  assert.equal(result.images.length, 0); assert.equal(result.previews.length, 0);
  assert.throws(() => f.store.resolve(source, '../config.json'), /真实 imageId/);
});

test('search respects off switches and rejects known tokens before any external lookup', async t => {
  let lookups = 0;
  const f = fixture(t, { sanitizeText: s => s.replaceAll('fixture-secret', '[redacted]'),
    searchImages: async () => { lookups++; return { results: [] }; } });
  await assert.rejects(f.store.search(source, { query: 'fixture-secret' }), /敏感/);
  f.cfg.webSearch.enabled = false; await assert.rejects(f.store.search(source, { query: '孙笑川' }), /关闭/);
  f.cfg.webSearch.enabled = true; f.cfg.socialV2.tools.getImages = false;
  await assert.rejects(f.store.search(source, { query: '孙笑川' }), /未启用/);
  assert.equal(lookups, 0);
});

test('permission or source-token revocation during preview download prevents issuing an image ID', async t => {
  let revoked = false;
  const f = fixture(t, { fetchImage: async () => { revoked = true; return { buffer: png }; } });
  await assert.rejects(f.store.search(source, { query: '孙笑川' }, () => { if (revoked) throw new Error('agent token 无效'); }), /token/);
  assert.equal(fs.existsSync(path.join(f.deps.stateDir, 'image-search/index.json')), false);
});

test('corrupt cache and changed file bytes fail closed', async t => {
  const f = fixture(t);
  const result = await f.store.search(source, { query: '孙笑川' });
  const id = result.images[0].imageId;
  fs.writeFileSync(path.join(f.deps.stateDir, 'image-search', id + '.bin'), Buffer.from('changed'));
  assert.throws(() => f.store.resolve(source, id), /校验失败/);
  fs.writeFileSync(path.join(f.deps.stateDir, 'image-search/index.json'), '{bad');
  await assert.rejects(createImageSearchStore(f.deps).search(source, { query: '孙笑川' }), /损坏/);
});

test('MCP returns image content blocks in the same order as candidate IDs', async () => {
  const registered = new Map();
  registerIntegrationTools({ tool: (name, description, schema, fn) => registered.set(name, fn) }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ images: [{ imageId: 'test' }] }) }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }), {});
  const result = await registered.get('qq_search_images')({ key: source, token: 'fixture', query: '孙笑川' });
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].data, png.toString('base64')); assert.ok(!result.content[0].text.includes('previews'));
});

async function bridge(t, extraGlobals = {}, extraConfig = {}) {
  const h = await bridgeHarness({ config: { ownerQQ: 12345, allow: { private: ['12345', '23456'], groups: ['456'] }, webSearch: { enabled: true },
    socialV2: { sharedMemory: { enabled: true, handoffEnabled: true, allowedKeys: [source, target, 'group:456'] } }, ...extraConfig }, globals: {
    bingImageSearch: async () => ({ provider: 'bing-images', results: [candidate] }), safeFetchBuffer: async () => ({ buffer: png }), ...extraGlobals } });
  h.setMode('reserved2'); h.setSelfIdentity('测试机器人', '99999');
  const token = h.getSocialV2State(source).agentToken;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });
  const post = async (action, payload, auth = token) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/integrations/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': auth },
      body: JSON.stringify({ key: source, ...payload }) });
    return { status: r.status, data: await r.json() };
  };
  return { h, post };
}

test('real bridge searches/previews and sends to a friend/group/current chat with actual receipts, without collecting', async t => {
  const { h, post } = await bridge(t);
  const search = await post('image-search', { query: '孙笑川 表情包', count: 1 });
  assert.equal(search.status, 200); assert.equal(search.data.previews[0].data, png.toString('base64'));
  const imageId = search.data.images[0].imageId;
  const payload = { targetKey: target, imageIds: [imageId], requestId: 'web_image_friend_01' };
  const friend = await post('contact-send', payload);
  assert.equal(friend.data.sent, true); assert.equal(friend.data.receipts[0].messageId, '9001');
  assert.equal(h.calls.http[0].body.user_id, 23456);
  assert.equal(h.calls.http[0].body.message[0].data.file, 'base64://' + png.toString('base64'));
  await post('contact-send', payload); assert.equal(h.calls.http.length, 1);
  const group = await post('image-send', { targetKey: 'group:456', imageId, requestId: 'web_image_group_01' });
  assert.equal(group.data.sent, true); assert.equal(h.calls.http[1].body.group_id, 456);
  const current = await post('image-send', { imageId, requestId: 'web_image_current_01' });
  assert.equal(current.data.sent, true); assert.equal(h.calls.http[2].body.user_id, 12345);
  assert.equal(h.calls.faces.length, 0);
  assert.equal((await post('image-send', { imageId, requestId: 'image_wrong_token' }, 'wrong-token')).status, 403);
});

test('real bridge rejects unissued IDs before QQ transport, and a missing receipt is uncertain', async t => {
  let writes = 0;
  const { post } = await bridge(t, { fetch: async () => { writes++; return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: {} }) }; } });
  assert.equal((await post('image-send', { imageId: 'https://example.com/image.png', requestId: 'invented_image_01' })).status, 400);
  assert.equal(writes, 0);
  const search = await post('image-search', { query: '孙笑川' });
  const payload = { imageId: search.data.images[0].imageId, requestId: 'missing_receipt_01' };
  const sent = await post('image-send', payload);
  assert.equal(sent.data.sent, false); assert.equal(sent.data.status, 'uncertain');
  await post('image-send', payload); assert.equal(writes, 1);
});

test('real bridge publishes searched preview bytes directly to Qzone, with readback and idempotent retry', async t => {
  const { h, post } = await bridge(t, {}, { integrations: { qzone: { enabled: true, allowedKeys: [source, target] } } });
  const writes = [];
  h.bot.raw = async (action, params) => {
    writes.push({ action, params });
    return action === 'send_qzone_msg' ? { tid: 'searched-picture-post' }
      : { msglist: [{ tid: 'searched-picture-post', images: ['observed-image'] }] };
  };
  const search = await post('image-search', { query: '孙笑川 表情包', count: 1 });
  assert.equal(search.status, 200);
  const imageId = search.data.images[0].imageId;
  const payload = { content: '分享一张刚找到的图', imageIds: [imageId], requestId: 'qzone_search_001' };
  const result = await post('qzone-publish', payload);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.published, true); assert.equal(result.data.imagesVerified, true);
  assert.equal(result.data.imageCount, 1);
  assert.deepEqual(writes[0].params.images, ['base64://' + search.data.previews[0].data]);
  assert.equal((await post('qzone-publish', payload)).data.duplicate, true);
  assert.equal(writes.filter(w => w.action === 'send_qzone_msg').length, 1);
  assert.equal(h.calls.sent.length, 0); assert.equal(h.calls.http.length, 0);
  assert.equal((await post('qzone-publish', { ...payload, imageIds: ['img_' + 'a'.repeat(32)] })).status, 409);
});

test('Qzone cached images reject wrong source, revoked tools, invalid IDs and mixed image overflow before transport', async t => {
  const { h, post } = await bridge(t, {}, { integrations: { qzone: { enabled: true, allowedKeys: [source, target] } } });
  let writes = 0; h.bot.raw = async () => { writes++; return { tid: 'must-not-publish' }; };
  const search = await post('image-search', { query: '孙笑川' });
  const imageId = search.data.images[0].imageId;
  const payload = { content: '配图校验', imageIds: [imageId], requestId: 'qzone_checks_001' };
  const foreign = await post('qzone-publish', { ...payload, key: target }, h.getSocialV2State(target).agentToken);
  assert.equal(foreign.status, 404); assert.match(foreign.data.error, /不属于/);
  h.cfg.socialV2.tools.getImages = false;
  assert.equal((await post('qzone-publish', payload)).status, 403);
  h.cfg.socialV2.tools.getImages = true;
  h.cfg.extensions = { 'image-search': { enabled: false } };
  assert.equal((await post('qzone-publish', payload)).status, 403);
  h.cfg.extensions['image-search'].enabled = true;
  assert.equal((await post('qzone-publish', { ...payload, imageIds: ['https://example.com/a.png'] })).status, 400);
  const overflow = await post('qzone-publish', { ...payload, imageIds: Array(9).fill(imageId), includeSelfImage: true });
  assert.equal(overflow.status, 400); assert.match(overflow.data.error, /最多 9/);
  assert.equal((await post('qzone-publish', payload, 'invalid-token')).status, 403);
  assert.equal(writes, 0);
});

test('expired/tampered search images fail before publication; confirmed retries survive expired cache', async t => {
  const f = fixture(t); f.cfg.integrations = { qzone: { enabled: true, allowedKeys: [source] } };
  const result = await f.store.search(source, { query: '孙笑川' });
  const imageId = result.images[0].imageId;
  let writes = 0;
  const publish = createQzonePublisher({ ...f.deps, readSearchImage: (key, id) => f.store.resolve(key, id).buffer,
    onebot: async action => action === 'send_qzone_msg' ? (writes++, { tid: 'cache-post' })
      : { msglist: [{ tid: 'cache-post', images: ['observed'] }] } });
  const payload = { content: '图片缓存发布测试', imageIds: [imageId], requestId: 'qzone_cache_001' };
  const file = path.join(f.deps.stateDir, 'image-search', imageId + '.bin');
  fs.writeFileSync(file, Buffer.from('tampered'));
  await assert.rejects(publish(source, payload, () => {}), /校验失败/);
  fs.writeFileSync(file, png); f.advance(3600001);
  await assert.rejects(publish(source, payload, () => {}), /过期/); assert.equal(writes, 0);
  f.advance(-3600001);
  assert.equal((await publish(source, payload, () => {})).imagesVerified, true);
  f.advance(3600001); fs.rmSync(file);
  assert.equal((await publish(source, payload, () => {})).duplicate, true); assert.equal(writes, 1);
});
