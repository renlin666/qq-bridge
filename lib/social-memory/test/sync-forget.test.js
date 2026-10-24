import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, privateContext } from './helpers.js';

test('上游断线不阻塞本地，恢复后幂等重试且索引不含正文', async (t) => {
  const { service, adapter } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  adapter.setOnline(false);
  const created = service.remember(a, {
    content: '断网期间记住：周末去看展',
    kind: 'experience',
    sourceMessageId: 'sync-m-1'
  });
  const memoryId = created.memory.memoryId;
  assert.equal(service.getMemory(a, memoryId).content, '断网期间记住：周末去看展');

  const failed = await service.syncOutbox();
  assert.equal(failed.failed, 1);
  assert.equal(failed.pending, 1);
  assert.equal(adapter.get(memoryId), null);
  const pending = service.outboxState().find((item) => item.memoryId === memoryId);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.attempts, 1);
  assert.ok(pending.nextAttemptAt > 0);

  adapter.setOnline(true);
  const recovered = await service.syncOutbox({ force: true });
  assert.equal(recovered.succeeded, 1);
  assert.equal(recovered.pending, 0);
  const document = adapter.get(memoryId);
  assert.ok(document);
  assert.equal(document.memoryId, memoryId);
  assert.equal(document.deleted, false);
  assert.equal(document.version, 1);
  assert.equal(document.identity.botAccountId, 'bot-a');
  assert.ok(!Object.hasOwn(document, 'content'));
  assert.ok(!Object.hasOwn(document, 'quote'));
  assert.equal(adapter.inspectBodies().containsBody, false);
});

test('事实更正增加版本并同步新关键词，遗忘后删除且不会被旧重试复活', async (t) => {
  const { service, adapter } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const created = service.remember(a, {
    content: '我喜欢喝红茶',
    kind: 'preference',
    sourceMessageId: 'sync-m-2'
  });
  const memoryId = created.memory.memoryId;
  await service.syncOutbox({ force: true });
  const v1 = adapter.get(memoryId);
  assert.equal(v1.version, 1);

  const corrected = service.correctMemory(a, memoryId, {
    content: '我喜欢喝乌龙茶',
    reason: '本人更正'
  });
  assert.equal(corrected.memory.version, 2);
  await service.syncOutbox({ force: true });
  const v2 = adapter.get(memoryId);
  assert.equal(v2.version, 2);
  assert.ok(!Object.hasOwn(v2, 'content'));
  assert.ok(v2.keywords.some((keyword) => keyword.includes('乌龙')));
  assert.ok(!v2.keywords.some((keyword) => keyword.includes('红茶')));
  assert.equal(service.getProfile(a).facts[0].content, '我喜欢喝乌龙茶');
  assert.doesNotMatch(service.retrieveContext(a, { query: '红茶' }).text, /红茶/);

  service.forgetMemory(a, memoryId, { reason: '用户要求删除' });
  await service.syncOutbox({ force: true });
  assert.equal(adapter.get(memoryId), null);
  const tombstone = adapter.deletedList().find((item) => item.memoryId === memoryId);
  assert.ok(tombstone);
  assert.equal(tombstone.deleted, true);
  assert.ok(!Object.hasOwn(tombstone, 'content'));

  const retry = await service.syncOutbox({ force: true });
  assert.equal(retry.attempted, 0);
  assert.equal(adapter.get(memoryId), null);

  const replay = service.remember(a, {
    content: '我喜欢喝乌龙茶',
    kind: 'preference',
    sourceMessageId: 'sync-m-2'
  });
  assert.equal(replay.suppressed, true);
  assert.throws(() => service.getMemory(a, memoryId), { code: 'NOT_FOUND' });
  assert.equal(service.inspectMemory({ ...a, permissions: ['memory.audit'] }, memoryId).status, 'forgotten');
  assert.equal(service.outboxState().filter((item) => item.status === 'pending').length, 0);

  await assert.rejects(
    () => adapter.upsert(v1),
    (error) => error.code === 'INDEX_REJECTED' || /复活/.test(error.message)
  );
});

test('失去来源的派生记忆同步失效，不留下旧画像', async (t) => {
  const { service, adapter } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const parent = service.remember(a, {
    content: '来源事实：小白在学摄影',
    kind: 'fact',
    sourceMessageId: 'derive-m-1'
  });
  const child = service.remember(a, {
    content: '派生结论：小白可能喜欢拍照',
    kind: 'fact',
    sourceMessageId: 'derive-m-2',
    derivedFromMemoryId: parent.memory.memoryId
  });
  await service.syncOutbox({ force: true });
  assert.ok(adapter.get(child.memory.memoryId));
  service.forgetMemory(a, parent.memory.memoryId, { reason: '来源撤回' });
  assert.throws(() => service.getMemory(a, child.memory.memoryId), { code: 'NOT_FOUND' });
  assert.equal(service.inspectMemory({ ...a, permissions: ['memory.audit'] }, child.memory.memoryId).status, 'forgotten');
  await service.syncOutbox({ force: true });
  assert.equal(adapter.get(child.memory.memoryId), null);
  assert.doesNotMatch(service.retrieveContext(a, { query: '拍照' }).text, /拍照/);
});

test('删除标记本身可理解为 outbox 中的 tombstone，同步失败也不改本地遗忘状态', async (t) => {
  const { service, adapter } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const created = service.remember(a, { content: '稍后要忘记的临时记录' });
  await service.syncOutbox({ force: true });
  adapter.setOnline(false);
  service.forgetMemory(a, created.memory.memoryId);
  const result = await service.syncOutbox({ force: true });
  assert.equal(result.failed, 1);
  assert.throws(() => service.getMemory(a, created.memory.memoryId), { code: 'NOT_FOUND' });
  assert.equal(service.inspectMemory({ ...a, permissions: ['memory.audit'] }, created.memory.memoryId).status, 'forgotten');
  assert.ok(service.outboxState().some((item) => item.op === 'delete' && item.status === 'pending'));
  adapter.setOnline(true);
  await service.syncOutbox({ force: true });
  assert.equal(adapter.get(created.memory.memoryId), null);
});
