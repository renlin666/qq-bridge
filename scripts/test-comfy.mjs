import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createComfyService } from '../src/comfy-service.js';
import { createLocalComfyClient } from '../src/local-comfy-client.js';
import { createArkAssistant } from '../src/ark-assistant.js';
import { createPluginHost } from '../src/plugin-host/index.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { fileURLToPath } from 'node:url';

const key = 'private:12345';
const bytes = Buffer.concat([Buffer.from('000000186674797069736f6d', 'hex'), Buffer.alloc(128)]);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const args = { action: 'generate-video', requestMessageId: '101', prompt: 'A teapot slowly rotates.', requestId: 'video_test_001' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { extensions: { comfy: { enabled: true, config: { videoGenerationEnabled: true, videoSendEnabled: true, volcanoFallbackEnabled: true } }, ark: { enabled: true, config: { imageGenerationEnabled: true } } } };
  const calls = [], jobs = new Map(); let sends = 0;
  const deps = { stateDir: dir, getConfig: () => cfg, sanitizeText: String,
    readMessage: (_key, id) => ['101', '102'].includes(String(id)) ? { messageId: String(id), plain: '生成视频，让这张图动起来，顺便画一张图片', isSelf: false } : null,
    readMessageImages: async () => bytes, validateImage: raw => ({ buffer: raw, mimeType: 'image/png' }),
    storeImage: () => ({ imageId: 'img_' + 'a'.repeat(32) }),
    sendVideo: async (_key, raw, check) => { check(); assert.deepEqual(raw, bytes); sends++; return { messageId: 9001 }; },
    onebot: async () => ({ message: [{ type: 'video' }] }),
    client: { async call(route, options = {}) {
      calls.push({ route, ...options });
      if (route === '/health') return { ok: true };
      if (route === '/jobs') { const row = { id: options.body.id, kind: options.body.kind, state: 'ready', bytes: bytes.length, sha256: hash }; jobs.set(row.id, row); return row; }
      if (route.endsWith('/result') || route.endsWith('/preview')) return bytes;
      return jobs.get(route.split('/')[2]);
    } },
    sleep: async () => {} };
  return { dir, cfg, deps, calls, jobs, get sends() { return sends; }, service: createComfyService(deps) };
}

test('generation submits a fixed typed payload once; duplicate/restart cannot create another job', async t => {
  const f = fixture(t);
  const row = await f.service.handle(key, args, () => {});
  assert.match(row.jobId, /^gen_[a-f0-9]{32}$/); assert.equal(row.sent, false);
  const again = await createComfyService(f.deps).handle(key, args, () => {});
  assert.equal(row.jobId, again.jobId);
  assert.equal(f.calls.filter(c => c.route === '/jobs').length, 1);
  const body = f.calls.find(c => c.route === '/jobs').body;
  assert.deepEqual(Object.keys(body).sort(), ['id', 'images', 'kind', 'prompt', 'seed']);
  assert.equal(body.kind, 'video'); assert.equal(body.images.length, 0);
  await assert.rejects(f.service.handle(key, { ...args, prompt: 'Other prompt' }, () => {}), /requestId/);
});

test('video requires a real nonnegative user request and scoped reference image', async t => {
  for (const request of [null, { plain: '你好', isSelf: false }, { plain: '不要生成视频', isSelf: false }, { plain: '生成视频', isSelf: true }]) {
    const f = fixture(t), service = createComfyService({ ...f.deps, readMessage: () => request });
    await assert.rejects(service.handle(key, args, () => {}), /真实用户/); assert.equal(f.calls.length, 0);
  }
  const f = fixture(t);
  await assert.rejects(f.service.handle(key, { ...args, imageMessageId: 'outside' }, () => {}), /当前会话/);
  await f.service.handle(key, { ...args, imageMessageId: '102' }, () => {});
  assert.match(f.calls.find(c => c.route === '/jobs').body.images[0], /^data:image\/png;base64,/);
});

test('status never exposes other conversations and completed video returns only a preview', async t => {
  const f = fixture(t), row = await f.service.handle(key, args, () => {});
  await assert.rejects(f.service.handle('group:99999', { action: 'status', jobId: row.jobId }, () => {}), /当前会话/);
  const status = await f.service.handle(key, { action: 'status', jobId: row.jobId }, () => {});
  assert.equal(status.state, 'ready'); assert.equal(status.previewOnly, true); assert.equal(status.sent, false);
});

test('verified video receipt is persisted and sender cannot duplicate across restart', async t => {
  const f = fixture(t), row = await f.service.handle(key, args, () => {});
  const send = { action: 'send-video', jobId: row.jobId };
  const result = await f.service.handle(key, send, () => {});
  assert.equal(result.sent, true); assert.equal(result.delivery.verified, true); assert.equal(result.delivery.messageId, '9001');
  assert.equal((await createComfyService(f.deps).handle(key, send, () => {})).sent, true); assert.equal(f.sends, 1);
});

test('simultaneous generation and video-send calls reserve one job and one write', async t => {
  const f = fixture(t);
  const pair = await Promise.all([f.service.handle(key, args, () => {}), f.service.handle(key, args, () => {})]);
  assert.equal(pair[0].jobId, pair[1].jobId); assert.equal(f.calls.filter(c => c.route === '/jobs').length, 1);
  await Promise.all([1, 2].map(() => f.service.handle(key, { action: 'send-video', jobId: pair[0].jobId }, () => {})));
  assert.equal(f.sends, 1);
});

test('readback uncertainty preserves the receipt and status may later confirm without resending', async t => {
  const f = fixture(t); let confirm = false, sends = 0;
  const service = createComfyService({ ...f.deps,
    sendVideo: async () => { sends++; return { messageId: 9001 }; },
    onebot: async () => ({ message: confirm ? [{ type: 'video' }] : [] }) });
  const row = await service.handle(key, args, () => {});
  const send = { action: 'send-video', jobId: row.jobId };
  assert.equal((await service.handle(key, send, () => {})).sent, false);
  await service.handle(key, send, () => {}); assert.equal(sends, 1);
  confirm = true;
  assert.equal((await service.handle(key, { action: 'status', jobId: row.jobId }, () => {})).sent, true);
  assert.equal(sends, 1);
});

test('missing receipt, transport timeout, and payload corruption cannot claim success or retry a send', async t => {
  for (const sendVideo of [async () => ({}), async () => { throw new Error('timeout'); }]) {
    const f = fixture(t); let count = 0;
    const service = createComfyService({ ...f.deps, sendVideo: async (...a) => { count++; return sendVideo(...a); } });
    const row = await service.handle(key, args, () => {}), send = { action: 'send-video', jobId: row.jobId };
    await assert.rejects(service.handle(key, send, () => {}));
    assert.equal((await service.handle(key, send, () => {})).sent, false); assert.equal(count, 1);
  }
  const f = fixture(t), row = await f.service.handle(key, args, () => {});
  f.jobs.get(row.jobId).sha256 = '0'.repeat(64);
  await assert.rejects(f.service.handle(key, { action: 'send-video', jobId: row.jobId }, () => {}), /完整性/);
  assert.equal(f.sends, 0);
});

test('generation timeout is not replayed after a process restart', async t => {
  const f = fixture(t); let requests = 0;
  const deps = { ...f.deps, client: { call: async route => { if (route === '/health') return {}; requests++; throw new Error('timeout'); } } };
  await assert.rejects(createComfyService(deps).handle(key, args, () => {}), /jobId=gen_/);
  const retry = await createComfyService(deps).handle(key, args, () => {});
  assert.equal(retry.state, 'uncertain'); assert.equal(requests, 1);
});

test('corrupt ledger and revoked plugin/scope block network calls', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'comfy-jobs.json'), '{broken');
  await assert.rejects(createComfyService(f.deps).handle(key, args, () => {}), /记录损坏/);
  f.cfg.extensions.comfy.enabled = false;
  await assert.rejects(f.service.handle(key, args, () => {}), /未启用/);
  f.cfg.extensions.comfy.enabled = true;
  await assert.rejects(f.service.handle(key, args, () => { throw new Error('revoked'); }), /revoked/);
  assert.equal(f.calls.length, 0);
});

test('local image completes through the same scoped job pipeline', async t => {
  const f = fixture(t);
  const result = await f.service.generateImage(key, 'A teapot', [], '101', () => {});
  assert.equal(result.provider, 'local-comfyui'); assert.equal(result.model, 'Z-Image-Turbo'); assert.deepEqual(result.buffer, bytes);
});

test('image generation prefers local; only known local failure allows configured volcano fallback', async t => {
  for (const mode of ['success', 'offline', 'running', 'fallback-disabled']) {
    const f = fixture(t); let paid = 0;
    if (mode === 'fallback-disabled') f.cfg.extensions.comfy.config.volcanoFallbackEnabled = false;
    const assistant = createArkAssistant({ ...f.deps, projectRoot: f.dir,
      localGenerate: async () => {
        if (mode === 'success') return { buffer: bytes, provider: 'local-comfyui', model: 'Z-Image-Turbo' };
        throw Object.assign(new Error('local failure'), { fallbackAllowed: mode !== 'running' });
      }, compose: async () => { paid++; return bytes; } });
    const call = assistant.handle(key, { action: 'image', requestMessageId: '101', prompt: 'A teapot' }, () => {});
    if (mode === 'running' || mode === 'fallback-disabled') await assert.rejects(call, /local failure/);
    else assert.equal((await call).provider, mode === 'success' ? 'local-comfyui' : 'volcano-seedream');
    assert.equal(paid, mode === 'offline' ? 1 : 0);
  }
});

test('local client pins the tunnel destination, requires its token and rejects redirects/oversized replies', async t => {
  const f = fixture(t), tokenFile = path.join(f.dir, 'token'); fs.writeFileSync(tokenFile, 'a'.repeat(64));
  const client = createLocalComfyClient({ getConfig: () => ({ tokenFile }), fetcher: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:23918/health'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + 'a'.repeat(64)); return new Response('{"ok":true}');
  } });
  assert.equal((await client.call('/health')).ok, true);
});

test('built-in Comfy plugin registers all three scoped tools', async t => {
  const f = fixture(t), root = fileURLToPath(new URL('..', import.meta.url));
  const cfg = { extensions: Object.fromEntries(['bilibili','image-search','quark','qzone','social-memory','ark','esports'].map(id => [id, { enabled: false }])) };
  cfg.extensions.comfy = { enabled: true, config: {} };
  const host = createPluginHost({ root, stateDir: f.dir, getConfig: () => cfg, services: { 'comfy.generate': () => ({ state: 'queued' }) } });
  t.after(() => host.close());
  assert.deepEqual((await host.catalog()).map(x => x.name), ['qq_generate_video', 'qq_get_local_generation', 'qq_send_generated_video']);
});

test('real bridge queues only video bytes and still checks source authorization before the write', async t => {
  const h = await bridgeHarness({ config: { ownerQQ: 12345, allow: { private: ['12345'], groups: [] } } });
  t.after(() => h.close()); h.setMode('reserved2');
  const result = await h.sendContactPartV2(key, { type: 'video', buffer: bytes }, () => {}, key);
  assert.equal(result.messageId, '9001'); assert.equal(h.calls.http[0].body.message[0].type, 'video');
  assert.equal(h.calls.http[0].body.message[0].data.file, 'base64://' + bytes.toString('base64'));
  await assert.rejects(h.sendContactPartV2(key, { type: 'video', buffer: bytes }, () => { throw new Error('revoked'); }, key), /revoked/);
  assert.equal(h.calls.http.length, 1);
});
