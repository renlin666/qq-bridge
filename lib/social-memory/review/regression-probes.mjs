// Independent review regressions: failed on the DSH baseline, required to pass
// after hardening. All data is fictional and SQLite is in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, privateContext, groupContext } from '../test/helpers.js';
import { MockIndexAdapter } from '../src/index.js';

test('R1: a negative trust update must survive one millisecond of time', (t) => {
  const { service, clock } = makeHarness();
  t.after(() => service.close());
  const context = privateContext('u-a');
  const changed = service.recordInteraction(context, {
    kind: 'conflict', sourceMessageId: 'review-negative-1', evidence: '虚构冲突事件'
  });
  const lowered = changed.relationship.dimensions.trust;
  assert.ok(lowered < 30);
  clock.advance(1);
  const after = service.getRelationship(context).relationship.dimensions.trust;
  assert.equal(after, lowered, `trust was ${lowered}, but became ${after} without a positive event`);
});

test('R2: private aliases must not be injected into group context', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  service.remember(privateContext('u-a', '仅私聊使用的称呼'), { content: '虚构私聊事实' });
  const pack = service.retrieveContext(groupContext('u-a', '群内名片'), { query: '' });
  assert.doesNotMatch(pack.text, /仅私聊使用的称呼/);
});

test('R3: forget during an in-flight upsert must leave a pending delete', async (t) => {
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  class DelayedAdapter extends MockIndexAdapter {
    async upsert(document) {
      entered();
      await gate;
      return super.upsert(document);
    }
  }
  const adapter = new DelayedAdapter();
  const { service } = makeHarness({ adapter });
  t.after(() => service.close());
  const context = privateContext('u-a');
  const { memory } = service.remember(context, { content: '虚构待删除事实' });
  const syncing = service.syncOutbox({ force: true });
  await started;
  service.forgetMemory(context, memory.memoryId);
  release();
  await syncing;
  const second = await service.syncOutbox({ force: true });
  assert.equal(adapter.get(memory.memoryId), null,
    `stale upsert survived, and the next sync attempted ${second.attempted} operations`);
});

test('R4: replaying the original source after correction and forgetting must stay suppressed', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const context = privateContext('u-a');
  const message = { messageId: 'review-original-source', text: '我喜欢红茶' };
  const original = service.ingestMessage(context, message).memories[0];
  service.confirmMemory(context, original.memoryId);
  service.correctMemory(context, original.memoryId, { content: '我喜欢乌龙茶' });
  service.forgetMemory(context, original.memoryId);
  const replay = service.ingestMessage(context, message).memories[0];
  assert.equal(replay.suppressed, true,
    `the forgotten source produced ${replay.status} under a new memory ID`);
  assert.equal(replay.memoryId, original.memoryId);
});

test('R5: another group participant must not retrieve a revoked person fact', (t) => {
  const { service, policy } = makeHarness();
  t.after(() => service.close());
  const a = groupContext('u-a');
  const b = groupContext('u-b');
  service.getRelationship(b);
  service.remember(a, {
    content: '甲的虚构个人资料是紫色纸飞机', kind: 'fact', subjectUserId: 'u-a'
  });
  policy.revokePerson('bot-a', 'u-a');
  const pack = service.retrieveContext(b, { query: '紫色纸飞机' });
  assert.doesNotMatch(pack.text, /紫色纸飞机/);
});

test('R6: expired source facts must invalidate derived profile facts', (t) => {
  const { service, clock } = makeHarness();
  t.after(() => service.close());
  const context = privateContext('u-a');
  const parent = service.remember(context, {
    content: '本周在摄影社体验', kind: 'fact', validForMs: 1000
  }).memory;
  service.remember(context, {
    content: '因此本周有摄影社活动安排', kind: 'fact', derivedFromMemoryId: parent.memoryId
  });
  clock.advance(1001);
  const profile = service.getProfile(context);
  assert.ok(!profile.facts.some((fact) => fact.content.includes('摄影社活动安排')),
    'derived fact remains active after its only source expires');
});
