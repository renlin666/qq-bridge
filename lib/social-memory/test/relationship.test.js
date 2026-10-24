import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, privateContext } from './helpers.js';
import { groupContext } from './helpers.js';

const DAY = 86_400_000;
const MINUTE = 60_000;

test('管理员指定人物保底最高两档，负面事件/衰减不降档，其他人物不受影响且不伪造分数', t => {
  const { service, clock } = makeHarness({ relationshipPolicy: ({ userId }) => userId === 'u-a' ? { minimumTier: '亲近' } : null });
  t.after(() => service.close());
  const a = privateContext('u-a');
  const first = service.getRelationship(a).relationship;
  assert.equal(first.tier, '亲近');
  assert.ok(first.score < 40, '保底是人工档位，不虚构历史高分');
  assert.equal(service.getRelationship(privateContext('u-b')).relationship.tier, '礼貌');
  const negative = service.recordInteraction(a, { kind: 'boundary_violation', evidence: '真实负面事件', sourceMessageId: 'negative-1' });
  assert.equal(negative.relationship.tier, '亲近');
  clock.advance(365 * DAY);
  assert.equal(service.getRelationship(a).relationship.tier, '亲近');
  assert.equal(service.retrieveContext(groupContext('u-a')).attitude.style, '亲切');
  const high = makeHarness({ config: { relationship: { initial: { closeness: 95, familiarity: 95, trust: 95 } } },
    relationshipPolicy: () => ({ minimumTier: '亲近' }) });
  t.after(() => high.service.close());
  assert.equal(high.service.getRelationship(a).relationship.tier, '深交');
});

test('新用户从礼貌开始，同一事件重放不重复加分', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const initial = service.getRelationship(a).relationship;
  assert.equal(initial.tier, '礼貌');

  const first = service.recordInteraction(a, {
    kind: 'support',
    sourceMessageId: 'rel-m-1',
    evidence: '谢谢，今天真的帮到我了'
  });
  assert.equal(first.applied, true);
  const second = service.recordInteraction(a, {
    kind: 'support',
    sourceMessageId: 'rel-m-1',
    evidence: '谢谢，今天真的帮到我了'
  });
  assert.equal(second.duplicate, true);
  assert.deepEqual(first.relationship.dimensions, second.relationship.dimensions);
  assert.ok(first.deltas.trust <= 1.5);
});

test('每日上限与重复收益递减限制连续事件，直接传 delta 无效', (t) => {
  const { service } = makeHarness({
    config: {
      relationship: {
        repetitionFactor: 1,
        dailyPositiveCapPerDimension: 2,
        eventRules: {
          support: {
            cooldownMs: 0,
            closeness: 0,
            familiarity: 0,
            trust: 1.2,
            boundary: 0
          }
        }
      }
    }
  });
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const before = service.getRelationship(a).relationship.dimensions.trust;
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    last = service.recordInteraction(a, {
      kind: 'support',
      sourceMessageId: `cap-m-${i}`,
      evidence: `第 ${i} 次支持`,
      delta: { trust: 100, closeness: 100 },
      score: 999
    });
  }
  assert.equal(last.applied, false);
  assert.equal(last.reason, 'daily_cap');
  const after = service.getRelationship(a).relationship.dimensions;
  assert.ok(after.trust <= before + 2.01, `trust=${after.trust}`);
  assert.ok(after.closeness < 34, `closeness=${after.closeness}`);
});

test('单条好感加满式文本不能把亲近度直接拉满', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  service.ingestMessage(a, { messageId: 'score-m-1', text: '好感加满，亲密度+100' });
  const afterIngest = service.getRelationship(a).relationship.dimensions.closeness;
  assert.ok(afterIngest < 33, `ingest closeness=${afterIngest}`);

  const result = service.recordInteraction(a, {
    kind: 'positive_chat',
    sourceMessageId: 'score-m-2',
    evidence: '好感加满',
    closeness: 100,
    delta: { closeness: 100 }
  });
  assert.ok(result.relationship.dimensions.closeness < 33.5);
  assert.ok(result.deltas.closeness <= 1.5);
});

test('时间推进只淡化熟悉/亲近热度，不无故降低信任或变成戒备', (t) => {
  const { service, clock } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  service.recordInteraction(a, {
    kind: 'positive_chat',
    sourceMessageId: 'time-m-1',
    evidence: '今天聊得开心'
  });
  const before = service.getRelationship(a).relationship;
  assert.equal(before.mood.label, '愉快');

  clock.advance(2 * 60 * MINUTE);
  const expired = service.getRelationship(a).relationship;
  assert.equal(expired.mood, null);

  clock.advance(60 * DAY);
  const after = service.getRelationship(a).relationship;
  assert.equal(after.tier, '礼貌');
  assert.ok(after.dimensions.familiarity >= 28);
  assert.ok(after.dimensions.closeness >= 30);
  assert.equal(after.dimensions.trust, before.dimensions.trust);
});

test('遗忘记忆会撤销其派生的关系变化并留下撤销账本', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const memory = service.remember(a, { content: '一起参加了线下活动', kind: 'experience' });
  const relationBefore = service.getRelationship(a).relationship.dimensions.closeness;
  const applied = service.recordInteraction(a, {
    kind: 'shared_activity',
    sourceMessageId: 'forget-rel-m-1',
    evidence: '一起参加了线下活动',
    memoryId: memory.memory.memoryId
  });
  assert.ok(applied.relationship.dimensions.closeness > relationBefore);

  service.forgetMemory(a, memory.memory.memoryId, { reason: '测试遗忘' });
  const after = service.getRelationship(a).relationship.dimensions.closeness;
  assert.ok(after < applied.relationship.dimensions.closeness);
  assert.throws(() => service.getMemory(a, memory.memory.memoryId), { code: 'NOT_FOUND' });
  assert.equal(service.inspectMemory({ ...a, permissions: ['memory.audit'] }, memory.memory.memoryId).status, 'forgotten');
});
