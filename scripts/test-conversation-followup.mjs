import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isConversationFollowup } from '../src/conversation-followup.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const textSegments = text => [{ type: 'text', data: { text } }];
const at = '2026-10-26T14:15:34+08:00';
const now = Date.parse('2026-10-26T14:26:31+08:00');
const history = () => [
  { userId: '789', isSelf: false, time: Date.parse(at) - 7000, text: '你怎么不说说你聪明在哪里' },
  { isSelf: true, time: Date.parse(at), text: '我一眼就看出来你在羡慕人家那一万块，这还不算聪明啊' }
];
const input = overrides => ({ history: history(), userId: '789', event: { message: textSegments('那个一万块是配电脑办公用的，是公司的财产，又不是我们个人的') },
  text: '那个一万块是配电脑办公用的，是公司的财产，又不是我们个人的', now, ...overrides });

test('截图中的延迟纠正可接续：同一成员、无@、无问号，潜水和标读不结束15分钟的接话窗口', () => {
  assert.equal(isConversationFollowup(input()), true);
  assert.equal(isConversationFollowup(input({ text: '你个蠢货', event: { message: textSegments('你个蠢货') } })), true);
  const rows = history(); rows.push({ userId: '789', isSelf: false, time: now - 17000, text: '你个蠢货' });
  assert.equal(isConversationFollowup(input({ history: rows })), true);
});

test('其他成员、转向别人、图片、未知身份和过期对话不能借接话条件唤醒，来信不延长窗口', () => {
  const cases = [
    { userId: '888' }, { userId: null }, { history: [] }, { text: ' ' },
    { event: { message: [{ type: 'reply', data: { id: 'someone-else' } }, ...textSegments('那个不是私人的') ] } },
    { event: { message: [{ type: 'at', data: { qq: '888' } }, ...textSegments('那个不是私人的') ] } },
    { event: { message: [{ type: 'image', data: { file: 'fixture.jpg' } }] }, text: '[图片]' },
    { now: Date.parse(at) + 15 * 60000 + 1 }, { now: Date.parse(at) - 1 },
    { history: [...history(), { isSelf: false, userId: '888', time: now - 1, text: '我的新话题' }] },
    { history: [...history(), { isSelf: false, userId: '789', replyToMessageId: 'other', quoteTargetIsSelf: false, time: now - 1 }] },
    { history: [{ ...history()[0], userId: null }, history()[1]] },
    { history: [{ ...history()[0], time: Date.parse(at) - 16 * 60000 }, history()[1]] },
    { history: [...history(), { isSelf: false, userId: '789', time: now }], now: Date.parse(at) + 16 * 60000 }
  ];
  for (const overrides of cases) assert.equal(isConversationFollowup(input(overrides)), false, JSON.stringify(overrides));
});

test('机器人的明确引用/@对象优先于最近发言者，避免多人交错时认错接话人', () => {
  const rows = history(); rows[0].messageId = 'peer-789';
  rows.splice(0, 0, { isSelf: false, userId: '888', messageId: 'peer-888', time: Date.parse(at) - 8000, text: '另一个人的问题' });
  rows.at(-1).replyToMessageId = 'peer-888';
  assert.equal(isConversationFollowup(input({ history: rows })), false);
  assert.equal(isConversationFollowup(input({ history: rows, userId: '888' })), true);
  rows.at(-1).replyToMessageId = 'missing';
  assert.equal(isConversationFollowup(input({ history: rows, userId: '888' })), false);
  delete rows.at(-1).replyToMessageId; rows.at(-1).atUserId = '888';
  assert.equal(isConversationFollowup(input({ history: rows })), false);
  assert.equal(isConversationFollowup(input({ history: rows, userId: '888' })), true);
});

function prepare(h, { minutes = 11, triggers = { atMention: true, question: true, probability: 0 } } = {}) {
  h.setMode('reserved2'); h.setSelfIdentity('fixture-bot', '10001');
  const st = h.getSocialV2State('group:456'); st.bootstrapSent = true;
  st.wakeConfig = { mode: 'diving', infinite: true, triggers, batchWindowMs: 8000 };
  const replyAt = Date.now() - minutes * 60000;
  st.recentMessages = history().map((m, index) => ({ ...m, time: replyAt - (index ? 0 : 7000) }));
  st.lastAiReplyAt = replyAt; st.lastActionAt = Date.now() - 6 * 60000; st.lastReadThroughSeq = 373; st.lastUnreadSeq = 373;
  return st;
}
const incoming = (h, text, userId = '789', extra = []) => h.handleIncoming('group', 456, {
  self_id: 10001, user_id: Number(userId), group_id: 456, message_id: 'followup-' + Date.now(),
  sender: { nickname: 'fixture-person' }, message: [...extra, ...textSegments(text)]
}, h.cfg);

test('真实收消息到调度/模型投递：零概率与峰时节流下仍唤醒，合批保留两条原文且不提前标读', async () => {
  const h = await bridgeHarness({ config: { socialV2: { peakEconomy: { enabled: true, mode: 'peak', probability: 0, minIntervalMs: 900000 } } } });
  try {
    const st = prepare(h); st.lastEconomyWakeAt = Date.now();
    await incoming(h, '你个蠢货');
    assert.equal(st.pendingWakeReason, 'conversationFollowup');
    await incoming(h, '那个一万块是配电脑办公用的，是公司的财产，又不是我们个人的');
    assert.equal(st.pendingWakeReason, 'conversationFollowup');
    clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null; st.pendingWakeReason = null;
    await h.sendWakePromptV2('group:456', 'conversationFollowup');
    assert.equal(h.calls.prompts.length, 1);
    const prompt = h.calls.prompts[0].content.map(part => part.text || '').join('\n');
    assert.match(prompt, /你个蠢货/); assert.match(prompt, /是公司的财产/);
    assert.equal(st.lastReadThroughSeq, 373); assert.equal(st.unread.length, 2);
    assert.equal(h.calls.sent.length, 0, '唤醒不是强制发言');
  } finally { await h.close(); }
});

test('接话提问/anyMessage优先保留接续原因；对其他人和已关闭的回复触发保持原有规则', async () => {
  for (const scenario of [
    { text: '你怎么还没听懂', anyMessage: true, expected: 'conversationFollowup' },
    { text: '公司的电脑又不是我的', userId: '888', expected: null },
    { text: '公司的电脑又不是我的', extra: [{ type: 'at', data: { qq: '888' } }], expected: null },
    { text: '公司的电脑又不是我的', minutes: 16, expected: null },
    { text: '公司的电脑又不是我的', disabled: true, expected: null }
  ]) {
    const h = await bridgeHarness();
    try {
      const st = prepare(h, { minutes: scenario.minutes ?? 11,
        triggers: scenario.disabled ? { probability: 0 } : { atMention: true, question: true, probability: 0, anyMessage: scenario.anyMessage === true } });
      await incoming(h, scenario.text, scenario.userId, scenario.extra);
      assert.equal(st.pendingWakeReason || null, scenario.expected, JSON.stringify(scenario));
    } finally { await h.close(); }
  }
});

test('重启后从已保存的最近消息恢复接话判断，无需本地新增会话状态', async () => {
  const first = await bridgeHarness(); let saved;
  try {
    prepare(first); first.recordSentMessagesV2('group:456', ['确认过的真实发言']);
    saved = fs.readFileSync(path.join(first.temp, 'state/social-v2.json'), 'utf8');
  } finally { await first.close(); }
  const h = await bridgeHarness({ files: { 'state/social-v2.json': saved } });
  try {
    h.setMode('reserved2'); h.setSelfIdentity('fixture-bot', '10001');
    await incoming(h, '那个一万块是配电脑办公用的');
    assert.equal(h.getSocialV2State('group:456').pendingWakeReason, 'conversationFollowup');
  } finally { await h.close(); }
});
