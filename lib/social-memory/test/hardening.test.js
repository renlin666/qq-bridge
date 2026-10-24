import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSocialMemory, MockIndexAdapter } from '../src/index.js';
import { makeHarness, privateContext, groupContext } from './helpers.js';

function delayedAdapter({ fail = false } = {}) {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  class Adapter extends MockIndexAdapter {
    async upsert(document) {
      enter();
      await gate;
      if (fail) throw new Error('delayed failure');
      return super.upsert(document);
    }
  }
  return { adapter: new Adapter(), entered, release };
}

test('在途更正保持新任务 pending；同实例重复同步合并', async (t) => {
  const delayed = delayedAdapter();
  const { service } = makeHarness({ adapter: delayed.adapter });
  t.after(() => service.close());
  const ctx = privateContext('u-a');
  const memory = service.remember(ctx, { content: '我喜欢红茶' }).memory;
  const first = service.syncOutbox({ force: true });
  await delayed.entered;
  assert.equal(service.syncOutbox({ force: true }), first);
  service.correctMemory(ctx, memory.memoryId, { content: '我喜欢乌龙茶' });
  delayed.release();
  await first;
  const pending = service.outboxState()[0];
  assert.equal(pending.version, 2);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.attempts, 0);
  await service.syncOutbox({ force: true });
  assert.equal(delayed.adapter.get(memory.memoryId).version, 2);
});

test('旧同步失败不覆盖较新删除任务的退避与版本', async (t) => {
  const delayed = delayedAdapter({ fail: true });
  const { service } = makeHarness({ adapter: delayed.adapter });
  t.after(() => service.close());
  const ctx = privateContext('u-a');
  const memory = service.remember(ctx, { content: '待遗忘的虚构记录' }).memory;
  const first = service.syncOutbox({ force: true });
  await delayed.entered;
  service.forgetMemory(ctx, memory.memoryId);
  delayed.release();
  await first;
  const pending = service.outboxState()[0];
  assert.equal(pending.op, 'delete');
  assert.equal(pending.version, 2);
  assert.equal(pending.attempts, 0);
  assert.equal(pending.nextAttemptAt, 0);
  await service.syncOutbox();
  assert.equal(delayed.adapter.deletedList().length, 1);
});

test('停用人物同时拦截群内详情、提案和新索引同步，恢复授权可恢复读取', async (t) => {
  const { service, policy, adapter } = makeHarness();
  t.after(() => service.close());
  const a = groupContext('u-a');
  const b = groupContext('u-b');
  service.getRelationship(b);
  const memory = service.remember(a, { content: '甲的虚构个人资料', subjectUserId: 'u-a' }).memory;
  service.ingestMessage(a, { messageId: 'pending-a', text: '我喜欢柠檬茶' });
  service.setPersonStatus('bot-a', 'u-a', 'disabled');
  assert.throws(() => service.getMemory(b, memory.memoryId), { code: 'NOT_FOUND' });
  assert.equal(service.listProposals(b).length, 0);
  assert.equal((await service.syncOutbox({ force: true })).skipped, 1);
  assert.equal(adapter.get(memory.memoryId), null);
  service.setPersonStatus('bot-a', 'u-a', 'active');
  policy.revokePerson('bot-a', 'u-a');
  assert.throws(() => service.getMemory(b, memory.memoryId), { code: 'NOT_FOUND' });
  policy.grantPerson('bot-a', 'u-a');
  assert.equal(service.getMemory(b, memory.memoryId).content, '甲的虚构个人资料');
});

test('到期派生链不能读取、确认或继续派生，过期索引会被清理', async (t) => {
  const { service, clock, adapter } = makeHarness();
  t.after(() => service.close());
  const ctx = privateContext('u-a');
  const parent = service.remember(ctx, { content: '限时事实', validForMs: 1000 }).memory;
  const child = service.remember(ctx, { content: '派生资料', derivedFromMemoryId: parent.memoryId, validForMs: 9000 }).memory;
  const grandchild = service.remember(ctx, { content: '再次派生', derivedFromMemoryId: child.memoryId, confirmed: false }).memory;
  assert.equal(child.validTo, parent.validTo);
  assert.equal(grandchild.validTo, parent.validTo);
  await service.syncOutbox({ force: true });
  clock.advance(1001);
  assert.throws(() => service.getMemory(ctx, child.memoryId), { code: 'NOT_FOUND' });
  assert.throws(() => service.confirmMemory(ctx, grandchild.memoryId), { code: 'CONFLICT' });
  assert.throws(() => service.remember(ctx, { content: '过期后不应派生', derivedFromMemoryId: parent.memoryId }), { code: 'CONFLICT' });
  await service.syncOutbox({ force: true });
  assert.equal(adapter.list().length, 0);
});

test('资料涉及被撤销人物时仍允许同会话清理，删除响应不泄露正文', async (t) => {
  const { service, policy, adapter } = makeHarness();
  t.after(() => service.close());
  const a = groupContext('u-a');
  const b = groupContext('u-b');
  const memory = service.remember(a, { content: '应可清理的虚构资料', subjectUserId: 'u-a' }).memory;
  service.getRelationship(b);
  await service.syncOutbox({ force: true });
  policy.revokePerson('bot-a', 'u-a');
  assert.throws(() => service.getMemory(b, memory.memoryId), { code: 'NOT_FOUND' });
  const deleted = service.forgetMemory(b, memory.memoryId);
  assert.equal(deleted.memory.status, 'forgotten');
  assert.equal(deleted.memory.content, undefined);
  await service.syncOutbox({ force: true });
  assert.equal(adapter.get(memory.memoryId), null);
  assert.throws(() => service.forgetMemory(privateContext('u-b'), memory.memoryId), { code: 'NOT_FOUND' });
});

test('群聊态度因人而异，但不输出私聊资料、情绪、数值或旧称呼', (t) => {
  const { service } = makeHarness({ config: { relationship: {
    repetitionFactor: 1, dailyPositiveCapPerDimension: 100,
    eventRules: { support: { cooldownMs: 0 } }
  } } });
  t.after(() => service.close());
  const a = privateContext('u-a', '私聊限定称呼');
  service.remember(a, { content: '私聊秘密资料' });
  for (let i = 0; i < 25; i += 1) service.recordInteraction(a, {
    kind: 'support', sourceMessageId: `familiar-${i}`, evidence: '虚构长期支持'
  });
  const aPack = service.retrieveContext(groupContext('u-a', '甲群卡'));
  service.getRelationship(groupContext('u-b', '乙群卡'));
  const bPack = service.retrieveContext(groupContext('u-b', '乙群卡'));
  assert.equal(aPack.attitude.style, '自然');
  assert.equal(bPack.attitude.style, '礼貌');
  assert.notEqual(aPack.attitude.guidance, bPack.attitude.guidance);
  assert.match(aPack.text, /相处方式：自然/);
  assert.equal(aPack.relationship, null);
  assert.doesNotMatch(aPack.text, /私聊限定称呼|私聊秘密资料|信任 \d|亲近 \d|临时情绪/);
  const other = groupContext('u-a', '另一个群称呼', { groupId: 'group-2' });
  assert.doesNotMatch(service.retrieveContext(other).text, /甲群卡|私聊限定称呼/);
  service.remember(groupContext('u-a', '甲群卡'), { content: '只在本群有效的明确事实', subjectUserId: 'u-a' });
  assert.equal(service.getProfile(groupContext('u-a', '甲群卡')).facts[0].content, '只在本群有效的明确事实');
});

test('普通读取和遗忘响应不回传已删除内容；审计需要独立宿主权限', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const ctx = privateContext('u-a');
  const memory = service.remember(ctx, { content: '原始保密正文', sourceMessageId: 'source-a' }).memory;
  service.correctMemory(ctx, memory.memoryId, { content: '修改后的正文' });
  assert.equal(service.getMemory(ctx, memory.memoryId).revisions, undefined);
  assert.throws(() => service.inspectMemory(ctx, memory.memoryId), { code: 'FORBIDDEN' });
  assert.doesNotMatch(JSON.stringify(service.forgetMemory(ctx, memory.memoryId)), /正文/);
  const replay = service.remember(ctx, { content: '重新抽取的不同表述', sourceMessageId: 'source-a' });
  assert.equal(replay.suppressed, true);
  assert.equal(replay.memory.content, undefined);
  assert.throws(() => service.getMemory(ctx, memory.memoryId), { code: 'NOT_FOUND' });
  const audit = service.inspectMemory({ ...ctx, permissions: ['memory.audit'] }, memory.memoryId);
  assert.equal(audit.status, 'forgotten');
  assert.ok(audit.revisions.some((revision) => revision.content === '原始保密正文'));
});

test('统一默认配置不共用可变对象，不同人物和服务的状态独立', (t) => {
  const one = makeHarness();
  const two = makeHarness();
  t.after(() => { one.service.close(); two.service.close(); });
  one.service.config.relationship.initial.trust = 60;
  assert.equal(two.service.getRelationship(privateContext('u-a')).relationship.dimensions.trust, 30);
  const a = one.service.getRelationship(privateContext('u-a')).relationship;
  one.service.recordInteraction(privateContext('u-a'), { kind: 'conflict', sourceMessageId: 'one-conflict', evidence: '虚构冲突' });
  assert.equal(one.service.getRelationship(privateContext('u-b')).relationship.dimensions.trust, a.dimensions.trust);
});

test('极小预算仍返回完整资料边界，预算不足时返回空文本', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const ctx = privateContext('u-a');
  service.remember(ctx, { content: '虚构资料' });
  for (const budget of [32, 40, 45, 80, 99]) {
    const pack = service.retrieveContext(ctx, { budget });
    assert.ok(pack.used <= budget);
    if (pack.text) assert.match(pack.text, /^<memory-data[^>]*>.*<\/memory-data>$/s);
  }
});

test('沉默不会新降为戒备，也不会抹掉主动建立的戒备状态', (t) => {
  for (const [familiarity, expected] of [[80, '礼貌'], [0, '戒备']]) {
    const { service, clock } = makeHarness({ config: { relationship: {
      initial: { closeness: 0, familiarity, trust: 0, boundary: 30 }
    } } });
    t.after(() => service.close());
    const ctx = privateContext('u-a');
    assert.equal(service.getRelationship(ctx).relationship.tier, expected);
    clock.advance(365 * 86_400_000);
    const relation = service.getRelationship(ctx).relationship;
    assert.equal(relation.tier, expected);
    assert.equal(relation.dimensions.closeness, 0);
    assert.equal(relation.dimensions.trust, 0);
  }
});

test('v1 数据库事务迁移并隔离无法判断范围的旧别名，重启保留数据与墓碑', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-memory-migrate-'));
  const file = path.join(dir, 'prototype.db');
  const { policy, clock, service: unused } = makeHarness();
  unused.close();
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schema_version', '1');
    CREATE TABLE person_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL, alias TEXT NOT NULL,
      normalized TEXT NOT NULL, source TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL, UNIQUE(person_id, normalized)
    );
  `);
  legacy.close();
  let service;
  t.after(() => { service?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  service = createSocialMemory({ dbPath: file, policy, clock });
  const ctx = privateContext('u-a', '私聊新称呼');
  const memory = service.remember(ctx, { content: '可跨重启的虚构记录', sourceMessageId: 'persist-1' }).memory;
  const personId = service.getProfile(ctx).personId;
  service.close();
  // 重新构造带有一条旧别名的 v1 结构，验证真实迁移数据而不读取任何现有私库。
  const old = new DatabaseSync(file);
  old.exec('DROP TABLE person_aliases;');
  old.exec(`CREATE TABLE person_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL, alias TEXT NOT NULL,
    normalized TEXT NOT NULL, source TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL, UNIQUE(person_id, normalized)
  ); UPDATE schema_meta SET value='1' WHERE key='schema_version';`);
  old.prepare('INSERT INTO person_aliases (person_id,alias,normalized,source,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)')
    .run(personId, '范围不明的旧称呼', 'old', 'nickname', clock.now(), clock.now());
  old.close();
  const adapter = new MockIndexAdapter();
  service = createSocialMemory({ dbPath: file, policy, clock, adapter });
  assert.equal(service.getMemory(ctx, memory.memoryId).content, '可跨重启的虚构记录');
  assert.doesNotMatch(service.retrieveContext(groupContext('u-a', '群卡')).text, /范围不明/);
  assert.doesNotMatch(service.retrieveContext(ctx).text, /范围不明/);
  await service.syncOutbox({ force: true });
  service.forgetMemory(ctx, memory.memoryId);
  service.close();
  service = createSocialMemory({ dbPath: file, policy, clock, adapter });
  await service.syncOutbox({ force: true });
  assert.equal(adapter.get(memory.memoryId), null);
  assert.equal(service.remember(ctx, { content: '重启后不同表述', sourceMessageId: 'persist-1' }).suppressed, true);
});
