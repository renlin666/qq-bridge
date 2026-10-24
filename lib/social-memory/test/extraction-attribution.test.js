import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, privateContext, groupContext } from './helpers.js';

test('自动抽取只产生提案，确认后才进入可检索画像', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const result = service.ingestMessage(a, {
    messageId: 'private-m-1',
    text: '我喜欢喝乌龙茶'
  });
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].status, 'proposed');

  const before = service.retrieveContext(a, { query: '乌龙茶' });
  assert.doesNotMatch(before.text, /乌龙茶/);
  assert.equal(service.listProposals(a).length, 1);

  service.confirmMemory(a, result.memories[0].memoryId);
  const after = service.retrieveContext(a, { query: '乌龙茶' });
  assert.match(after.text, /乌龙茶/);
  assert.equal(service.getProfile(a).facts[0].content, '我喜欢喝乌龙茶');
});

test('群聊里 A 评价/感谢 B 只改变 A 的关系，不变成 B 的自述', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const aGroup = groupContext('u-a', '小白');
  const bPrivate = privateContext('u-b', '阿青');
  const result = service.ingestMessage(aGroup, {
    messageId: 'group-m-2',
    text: '谢谢阿青，今天很靠谱',
    mentions: [{ userId: 'u-b', displayName: '阿青' }]
  });
  assert.equal(result.interactions[0].kind, 'support');
  assert.equal(result.interactions[0].applied, true);
  const memory = service.getMemory(aGroup, result.memories[0].memoryId);
  assert.equal(memory.subjectPersonId, null);
  assert.ok(memory.people.some((item) => item.userId === 'u-a' && item.role === 'speaker'));
  assert.ok(memory.people.some((item) => item.userId === 'u-b' && item.role === 'mentioned'));

  const aRelationship = service.getRelationship(groupContext('u-a', '小白')).relationship;
  const bRelationship = service.getRelationship(groupContext('u-b', '阿青')).relationship;
  assert.ok(aRelationship.dimensions.trust > bRelationship.dimensions.trust);
  assert.equal(service.getProfile(bPrivate).facts.length, 0);
});

test('引用发言只作为来源和参与者，不被当作当前说话人的事实', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const aGroup = groupContext('u-a', '小白');
  const bPrivate = privateContext('u-b', '阿青');
  const result = service.ingestMessage(aGroup, {
    messageId: 'group-m-3',
    text: '他说自己很喜欢猫',
    quoted: {
      messageId: 'old-m-1',
      text: '我喜欢猫',
      author: { userId: 'u-b', displayName: '阿青' }
    }
  });
  assert.equal(result.interactions.length, 0);
  const memory = service.getMemory(aGroup, result.memories[0].memoryId);
  assert.equal(memory.subjectPersonId, null);
  assert.ok(memory.people.some((item) => item.userId === 'u-b' && item.role === 'quoted'));
  assert.equal(service.getProfile(bPrivate).facts.length, 0);
});

test('A 描述 B 的偏好不会生成 B 的画像', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const group = groupContext('u-a', '小白');
  const b = privateContext('u-b', '阿青');
  service.ingestMessage(group, {
    messageId: 'group-m-4',
    text: '阿青很喜欢猫',
    mentions: [{ userId: 'u-b', displayName: '阿青' }]
  });
  assert.equal(service.getProfile(b).facts.length, 0);
});