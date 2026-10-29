import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createSingingService } from '../src/singing-service.js';
import { createPluginHost } from '../src/plugin-host/index.js';
import { toolCategory } from '../plugins/qq-agent-presets/qq-tool-discovery.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const input = { action: 'generate', requestMessageId: '123', bvid: 'BV1xx411c7mD', startSeconds: 20, durationSeconds: 30, language: 'Auto', requestId: 'singing_test_001' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'singing-test-'));
  t.after(() => { assert.ok(dir.startsWith(path.join(os.tmpdir(), 'singing-test-'))); fs.rmSync(dir, { recursive: true, force: true }); });
  const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, 'a'.repeat(64));
  const cfg = { extensions: { singing: { enabled: true, config: { language: 'Japanese', tokenFile } } }, socialV2: { voice: { enabled: true } } };
  let calls = 0, id, audio = Buffer.from('ID3' + 'x'.repeat(300));
  const fetcher = async (url, options) => {
    calls++; assert.ok(url.startsWith('http://127.0.0.1:23916/sing/jobs'));
    assert.equal(options.headers.Authorization, 'Bearer ' + 'a'.repeat(64)); assert.equal(options.redirect, 'error');
    if (options.method === 'POST') { const body = JSON.parse(options.body); id = body.id; assert.equal(body.language, 'Auto'); return Response.json({ id, state: 'queued' }); }
    if (url.endsWith('/audio')) return new Response(audio);
    return Response.json({ id, state: 'ready', language: 'Auto', modelSha256: 'ad0f36aba2a369cf80d1894c5c6fd0684a7c8a6f45dc61ef2bd87f6c0cc84b78', speakerId: 0, sha256: crypto.createHash('sha256').update(audio).digest('hex') });
  };
  const options = { stateDir: dir, projectRoot: dir, getConfig: () => cfg, readMessage: (key, mid) => key === 'group:456' && mid === '123' ? { plain: '唱一段日语歌', isSelf: false } : null, fetcher };
  return { dir, cfg, options, service: createSingingService(options), count: () => calls };
}
const authorize = () => {};
test('async Japanese cover generates a scoped library artifact; no implicit sending; idempotent across restart', async t => {
  const f = fixture(t);
  const first = await f.service.handle('group:456', input, authorize);
  assert.equal(first.state, 'queued'); assert.equal(first.sent, false); assert.equal(f.count(), 1);
  const restart = createSingingService(f.options);
  assert.equal((await restart.handle('group:456', input, authorize)).jobId, first.jobId); assert.equal(f.count(), 1);
  await assert.rejects(restart.handle('group:456', { ...input, startSeconds: 21 }, authorize), /requestId/);
  await assert.rejects(restart.handle('private:999', { action: 'status', jobId: first.jobId }, authorize), /当前会话/);
  const result = await restart.handle('group:456', { action: 'status', jobId: first.jobId }, authorize);
  assert.equal(result.state, 'ready'); assert.match(result.voice, /^ark-sing-[a-f0-9]{32}\.mp3$/);
  assert.equal(result.speaker, 'manbo-zh-rvc-slot-0');
  assert.ok(fs.existsSync(path.join(f.dir, 'audio', result.voice))); assert.equal(result.language, 'Auto');
});
test('language, source, duration, authentic requests and revoked permissions fail before network', async t => {
  const f = fixture(t);
  for (const patch of [{ language: '' }, { bvid: 'file:///secret' }, { durationSeconds: 60 }, { startSeconds: NaN }, { requestMessageId: 'unseen' }]) {
    await assert.rejects(f.service.handle('group:456', { ...input, ...patch }, authorize));
  }
  await assert.rejects(f.service.handle('group:456', input, () => { throw Error('revoked'); }), /revoked/);
  f.cfg.extensions.singing.enabled = false;
  await assert.rejects(f.service.handle('group:456', input, authorize), /未启用/); assert.equal(f.count(), 0);
});
test('language labels and omitted language all reach the worker as Auto', async t => {
  for (const language of ['Chinese', '中文', 'English', 'Japanese', undefined]) {
    const f = fixture(t);
    const result = await f.service.handle('group:456', { ...input, language }, authorize);
    assert.equal(result.state, 'queued');
  }
});
test('rejects an unexpected model or speaker slot before importing audio', async t => {
  for (const patch of [{ speakerId: 108 }, { modelSha256: '0'.repeat(64) }]) {
    const f = fixture(t);
    let id;
    const service = createSingingService({ ...f.options, fetcher: async (_url, options) => {
      if (options.method === 'POST') { id = JSON.parse(options.body).id; return Response.json({ id, state: 'queued' }); }
      return Response.json({ id, state: 'ready', language: 'Auto', speakerId: 0,
        modelSha256: 'ad0f36aba2a369cf80d1894c5c6fd0684a7c8a6f45dc61ef2bd87f6c0cc84b78', ...patch });
    } });
    const queued = await service.handle('group:456', input, authorize);
    await assert.rejects(service.handle('group:456', { action: 'status', jobId: queued.jobId }, authorize), /音色校验失败/);
    assert.equal(fs.existsSync(path.join(f.dir, 'audio')), false);
  }
});
test('offline submit retains a queryable uncertain job and never resubmits or falls back', async t => {
  const f = fixture(t); let attempts = 0;
  const service = createSingingService({ ...f.options, fetcher: async () => { attempts++; throw Error('offline'); } });
  const result = await service.handle('group:456', input, authorize);
  assert.equal(result.state, 'uncertain'); assert.match(result.error, /不会调用付费/);
  assert.equal((await service.handle('group:456', input, authorize)).jobId, result.jobId); assert.equal(attempts, 1);
});
test('connection refusal and busy response consume no quota and allow the same request to retry', async t => {
  const f = fixture(t); let attempts = 0;
  const service = createSingingService({ ...f.options, fetcher: async (url, options) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('connect failed'), { cause: { code: 'ECONNREFUSED' } });
    if (attempts === 2) return new Response('', { status: 429 });
    return Response.json({ id: JSON.parse(options.body).id, state: 'queued' });
  } });
  await assert.rejects(service.handle('group:456', input, authorize), /本地电脑离线/);
  await assert.rejects(service.handle('group:456', input, authorize), /本地正在生成/);
  assert.equal((await service.handle('group:456', input, authorize)).state, 'queued');
  assert.equal(attempts, 3);
});
test('local daily limit is distinguished from a busy worker', async t => {
  const f = fixture(t);
  const service = createSingingService({ ...f.options, fetcher: async () => Response.json({error: 'daily_limit'}, {status: 429}) });
  await assert.rejects(service.handle('group:456', input, authorize), /滚动24小时最多处理20个/);
});
test('confirmed generation failures do not exhaust the rolling session quota', async t => {
  const f = fixture(t);
  const service = createSingingService({ ...f.options, fetcher: async (_url, options) => {
    if (options.method === 'POST') return Response.json({ id: JSON.parse(options.body).id, state: 'queued' });
    return Response.json({ id: _url.split('/').at(-1), state: 'failed', error: '处理超时' });
  } });
  for (let i = 0; i < 4; i++) {
    const queued = await service.handle('group:456', { ...input, requestId: `failed_test_${i}` }, authorize);
    assert.equal((await service.handle('group:456', { action: 'status', jobId: queued.jobId }, authorize)).state, 'failed');
  }
});
test('administrator-designated verification jobs do not consume a session quota', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'singing-jobs.json'), JSON.stringify(Array.from({length: 3}, (_, i) => ({
    id: 'sing_' + String(i).padStart(32, '0'), key: 'group:456', requestId: `verify_${i}`, at: Date.now(), state: 'ready', quotaExempt: true
  }))));
  const service = createSingingService(f.options);
  assert.equal((await service.handle('group:456', input, authorize)).state, 'queued');
});
test('revocation during generation prevents importing audio', async t => {
  const f = fixture(t); let allowed = true;
  const service = createSingingService({ ...f.options, fetcher: async () => { allowed = false; return Response.json({}); } });
  const result = await service.handle('group:456', input, () => { if (!allowed) throw Error('revoked'); });
  assert.equal(result.state, 'uncertain'); assert.ok(!fs.existsSync(path.join(f.dir, 'audio')));
});
test('song search normalizes the query, drops non-BV rows and rejects empty input', async t => {
  const f = fixture(t);
  const service = createSingingService({ ...f.options, fetcher: async (url, options) => {
    assert.ok(url.startsWith('http://127.0.0.1:23916/sing/search?q=')); assert.equal(options.method, 'GET');
    return Response.json({ candidates: [{ bvid: 'BV1xx411c7mD', title: 'hitomi - LOVE 2000', author: 'x', durationSeconds: 240, suggestedStartSeconds: 60 },
      { bvid: 'file:///secret', title: 'bad' }] });
  } });
  const result = await service.handle('group:456', { action: 'search', query: '  LOVE  2000 ' }, authorize);
  assert.equal(result.query, 'LOVE 2000'); assert.deepEqual(result.candidates.map(r => r.bvid), ['BV1xx411c7mD']);
  await assert.rejects(service.handle('group:456', { action: 'search', query: '   ' }, authorize), /歌名/);
});
test('manifest exposes multilingual tools with plugin scope and media discovery', async t => {
  const f = fixture(t);
  const host = createPluginHost({ root: ROOT, stateDir: f.dir, getConfig: () => ({ ...f.cfg, extensions: { bilibili: { enabled: false }, 'image-search': { enabled: false }, esports: { enabled: false }, ...f.cfg.extensions } }), services: { 'singing.generate': (_key, args) => args } });
  t.after(() => host.close());
  const catalog = await host.catalog(); assert.deepEqual(catalog.map(r => r.name).sort(), ['qq_generate_singing', 'qq_get_singing', 'qq_search_song']);
  const { action: _action, ...toolInput } = input;
  for (const language of ['Chinese', '中文', 'English', 'Japanese', 'Auto']) {
    const result = await host.callTool('qq_generate_singing', { ...toolInput, language }, { key: 'group:456', assertAuthorized: authorize });
    assert.equal(JSON.parse(result.content[0].text).language, language);
  }
  assert.equal(toolCategory('mcp__snowluma__qq_generate_singing'), 'media');
});
