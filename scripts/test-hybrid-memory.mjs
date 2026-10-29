import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HybridMemoryIndex } from '../extensions/social-memory/hybrid-index.js';
import { makeHarness, privateContext, groupContext } from '../lib/social-memory/test/helpers.js';
import { createPluginHost } from '../src/plugin-host/index.js';
import { fileURLToPath } from 'node:url';

const trusted = { platform: 'qq', botAccountId: '10001', actor: { userId: '12345' }, conversation: { id: 'private:12345' } };
const basis = n => Array.from({ length: 1024 }, (_, i) => i === n ? 1 : 0);
const doc = (id, text, extra = {}) => ({ memoryId: id, text, version: 1, index: { memoryId: id, keywords: [text], ...extra } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-memory-'));
  const file = path.join(dir, 'vectors.db'); let index = new HybridMemoryIndex(file);
  t.after(() => { index.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get index() { return index; }, restart() { index.close(); index = new HybridMemoryIndex(file); } };
}
test('vector recall finds a paraphrase with no keyword hit; vectors survive restart without re-embedding bodies', async t => {
  const f = fixture(t), documents = [doc('exam', '我正在备考'), doc('food', '我爱吃面条')];
  f.index.sync(trusted, documents);
  await f.index.drain(async text => basis(text.includes('面条') ? 1 : 0), async () => true);
  const result = await f.index.query(trusted, '最近要参加笔试', documents, [], async () => basis(0));
  assert.deepEqual(result.indexes.map(x => x.memoryId), ['exam']);
  assert.deepEqual(result.indexes[0].retrievalSources, ['vector']);
  f.restart(); f.index.sync(trusted, documents);
  let bodyCalls = 0; await f.index.drain(async () => { bodyCalls++; return basis(0); }, async () => true);
  assert.equal(bodyCalls, 0);
  assert.equal((await f.index.query(trusted, '换种说法问考试', documents, [], async () => basis(0))).indexes[0].memoryId, 'exam');
});
test('correction invalidates old vectors immediately; deletion and another scope cannot recall cached material', async t => {
  const f = fixture(t), original = [doc('m1', '旧内容')];
  f.index.sync(trusted, original); await f.index.drain(async () => basis(0), async () => true);
  const corrected = [doc('m1', '新内容')];
  assert.equal((await f.index.query(trusted, '旧问题', corrected, [], async () => basis(0))).indexes.length, 0);
  const other = { ...trusted, conversation: { id: 'group:456' } };
  assert.equal((await f.index.query(other, '旧问题', original, [], async () => basis(0))).indexes.length, 0);
  assert.equal((await f.index.query(trusted, '旧问题', [], [], async () => basis(0))).indexes.length, 0);
  assert.equal(f.index.db.prepare('SELECT count(*) AS n FROM embeddings WHERE namespace=?').get(JSON.stringify(['qq','10001','private:12345','12345'])).n, 0);
});
test('provider failure preserves keyword results and pending work; topic filtering does not delete other vectors', async t => {
  const f = fixture(t), documents = [doc('study', '备考'), doc('work', '开发')];
  f.index.sync(trusted, documents); await f.index.drain(async () => basis(0), async () => true);
  const result = await f.index.query(trusted, '故障查询', documents, [documents[1].index], async () => { throw new Error('offline'); });
  assert.equal(result.rankingProvider, 'keyword'); assert.equal(result.semanticUnavailable, true);
  assert.equal(result.indexes[0].memoryId, 'work');
  await f.index.query(trusted, '备考', [documents[0]], [documents[0].index], async () => basis(0), { complete: false });
  assert.equal(f.index.db.prepare('SELECT count(*) AS n FROM embeddings WHERE vector IS NOT NULL').get().n, 2);
});
test('an old in-flight embedding cannot replace corrected content or erase its newer queue item', async t => {
  const f = fixture(t); f.index.sync(trusted, [doc('m1', 'old')]);
  let release; const gate = new Promise(r => { release = r; });
  const work = f.index.drain(async () => { await gate; return basis(0); }, async (_c, _id, digest) => f.index.validHash('old', digest));
  await new Promise(r => setImmediate(r)); f.index.sync(trusted, [doc('m1', 'new')]); release(); await work;
  assert.equal(f.index.pending.size, 1);
  await f.index.drain(async () => basis(1), async () => true);
  assert.equal(f.index.pending.size, 0);
  assert.equal((await f.index.query(trusted, 'new question', [doc('m1', 'new')], [], async () => basis(1))).indexes.length, 1);
});
test('semantic indexing inputs use the same live identity, scope, source expiry and forgetting rules as keyword search', t => {
  const { service, clock } = makeHarness(); t.after(() => service.close()); const a = privateContext('u-a');
  const id = service.remember(a, { content: '我正在备考', subjectUserId: 'u-a', validForMs: 1000 }).memory.memoryId;
  assert.equal(service.queryMemories(a, { query: '参加笔试' }).length, 0);
  assert.ok(service.retrievalDocuments(a).some(d => d.memoryId === id && d.text === '我正在备考'));
  assert.equal(service.retrievalDocuments(privateContext('u-b')).length, 0);
  assert.equal(service.retrievalDocuments(groupContext('u-a')).length, 0);
  clock.advance(1001); assert.equal(service.retrievalDocuments(a).length, 0);
});
test('actual plugin pre-indexes memories and returns semantic-only evidence without leaking after person revocation', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-plugin-')), ticks = [];
  t.mock.method(globalThis, 'setInterval', fn => { ticks.push(fn); return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const cfg = { extensions: Object.fromEntries(['ark','bilibili','qzone','quark','image-search'].map(id => [id, { enabled: false }])) };
  cfg.extensions['social-memory'] = { enabled: true, config: { autoCapture: false } };
  let allowed = true;
  const message = { messageId: 'm1', userId: '12345', botAccountId: '10001', plain: '我正在备考', time: Date.now() };
  const createHost = () => createPluginHost({ root: fileURLToPath(new URL('..', import.meta.url)), stateDir: dir, getConfig: () => cfg,
    services: { readMessage: () => message,
      'memory.policy': () => ({ botAccountId: '10001', people: allowed ? ['12345'] : [], groups: [], enabled: true, embeddingEnabled: true }),
      'memory.legacy': key => key ? [] : { botAccountId: '10001', scopes: [] },
      'ark.embed': async (_key, args) => { if (args.text === '撤权查询') allowed = false; return basis(0); } } });
  let host = createHost();
  try {
    await host.ready; const scope = { key: 'private:12345', assertAuthorized() {} };
    const call = (name, args) => host.callTool(name, { messageId: 'm1', ...args }, scope).then(r => JSON.parse(r.content[0].text));
    const memory = await call('qq_social_memory_remember', { content: '我正在备考', kind: 'experience', confirmed: false });
    await host.close(); host = createHost(); await host.ready;
    // No incoming message after restart: policy must initialize from the actual
    // configured bot before the background sweep can authorize stored rows.
    const cold = await host.invokeAdmin('social-memory', 'hybrid-status', {}, () => {});
    assert.equal(cold.pending, 1);
    for (const tick of ticks) await tick();
    const result = await call('qq_social_memory_query', { query: '参加笔试' });
    assert.equal(result.rankingProvider, 'keyword+qwen3-embedding-0.6b');
    assert.ok(result.indexes.some(r => r.memoryId === memory.memory.memoryId && r.retrievalSources.includes('vector')));
    assert.equal(result.indexes[0].evidenceLevel, 'observation');
    const revoked = await call('qq_social_memory_query', { query: '撤权查询' });
    assert.equal(revoked.indexes.length, 0);
  } finally { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
