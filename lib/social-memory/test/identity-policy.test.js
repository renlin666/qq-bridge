import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, privateContext, groupContext } from './helpers.js';

test('同名人物按 platform + bot + userId 隔离，改名只增加别名', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '同名');
  const b = privateContext('u-b', '同名');

  const memoryA = service.remember(a, { content: '我喜欢抹茶', kind: 'preference' });
  service.remember(b, { content: '我喜欢咖啡', kind: 'preference' });

  const profileA = service.getProfile(a);
  const profileB = service.getProfile(b);
  assert.notEqual(profileA.personId, profileB.personId);
  assert.match(profileA.facts.map((item) => item.content).join(' '), /抹茶/);
  assert.doesNotMatch(profileA.facts.map((item) => item.content).join(' '), /咖啡/);
  assert.match(profileB.facts.map((item) => item.content).join(' '), /咖啡/);

  const renamed = privateContext('u-a', '新名字');
  const renamedProfile = service.getProfile(renamed);
  assert.equal(renamedProfile.displayName, '新名字');
  assert.ok(renamedProfile.aliases.includes('同名'));
  assert.ok(renamedProfile.aliases.includes('新名字'));
  assert.ok(memoryA.memory.memoryId);
  assert.equal(service.getProfile(b).displayName, '同名');
});

test('私聊/群聊、跨机器人账号之间先过滤范围再检索', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const groupA = groupContext('u-a', '小白');
  const botB = privateContext('u-a', '小白', 'bot-b');

  service.remember(a, { content: '私聊里说过的秘密是蓝色盒子', kind: 'fact' });
  service.remember(groupA, { content: '群里一起参加了周末读书会', kind: 'group_event' });
  service.remember(botB, { content: '另一个机器人账号里的独立记忆', kind: 'fact' });

  const privatePack = service.retrieveContext(a, { query: '秘密 读书会 机器人' });
  const groupPack = service.retrieveContext(groupA, { query: '秘密 读书会 机器人' });
  const otherBotPack = service.retrieveContext(botB, { query: '秘密 读书会 机器人' });

  assert.match(privatePack.text, /蓝色盒子/);
  assert.doesNotMatch(privatePack.text, /读书会/);
  assert.match(groupPack.text, /读书会/);
  assert.doesNotMatch(groupPack.text, /蓝色盒子/);
  assert.match(otherBotPack.text, /独立记忆/);
  assert.doesNotMatch(otherBotPack.text, /蓝色盒子|读书会/);
});

test('撤销人物/群聊白名单和停用人物立即阻止新读写', (t) => {
  const { service, policy } = makeHarness();
  t.after(() => service.close());
  const a = privateContext('u-a', '小白');
  const groupA = groupContext('u-a', '小白');
  service.remember(a, { content: '允许期间的记忆' });

  policy.revokePerson('bot-a', 'u-a');
  assert.throws(() => service.retrieveContext(a), { code: 'FORBIDDEN' });
  assert.throws(() => service.remember(a, { content: '撤销后不能写' }), { code: 'FORBIDDEN' });

  policy.grantPerson('bot-a', 'u-a');
  policy.revokeGroup('bot-a', 'group-1');
  assert.throws(() => service.retrieveContext(groupA), { code: 'FORBIDDEN' });
  assert.match(service.retrieveContext(a).text, /允许期间的记忆/);
  policy.grantGroup('bot-a', 'group-1');

  service.setPersonStatus('bot-a', 'u-a', 'disabled');
  assert.throws(() => service.retrieveContext(a), { code: 'PERSON_DISABLED' });
  service.setPersonStatus('bot-a', 'u-a', 'active');
  assert.match(service.retrieveContext(a).text, /允许期间的记忆/);
});

test('群白名单与允许建档人物名单分离，未获准人物不能出现在群记忆链接中', (t) => {
  const { service } = makeHarness();
  t.after(() => service.close());
  const a = groupContext('u-a', '小白');
  const result = service.ingestMessage(a, {
    messageId: 'group-m-1',
    text: '阿青今天也来了',
    mentions: [
      { userId: 'u-b', displayName: '阿青' },
      { userId: 'u-x', displayName: '未授权路人' }
    ]
  });
  assert.equal(result.memories.length, 1);
  const detail = service.getMemory(a, result.memories[0].memoryId);
  const linked = detail.people.map((item) => item.userId);
  assert.ok(linked.includes('u-a'));
  assert.ok(linked.includes('u-b'));
  assert.ok(!linked.includes('u-x'));
});