import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { peakEconomyStatus, validatePeakEconomy, decidePeakWake } from '../src/peak-economy.js';
import { resolvePriceTable } from '../src/model-prices.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const peak = { enabled: true, mode: 'peak', probability: 0, minIntervalMs: 900000, replyChars: 80 };
const ms = time => Date.parse(time + '+08:00');

test('自动峰谷沿用北京时间、半开区间、周末、节假日和自定义价目规则', () => {
  const auto = { ...peak, mode: 'auto' };
  for (const [time, expected] of [['2026-10-23T08:59:59', false], ['2026-10-23T09:00:00', true],
    ['2026-10-23T12:00:00', false], ['2026-10-23T14:00:00', true], ['2026-10-23T18:00:00', false],
    ['2026-10-24T10:00:00', false], ['2026-10-01T10:00:00', false]]) {
    assert.equal(peakEconomyStatus(auto, ms(time)).active, expected, time);
  }
  assert.equal(peakEconomyStatus(auto, ms('2026-10-23T10:00:00'), resolvePriceTable({ peakWindows: [] })).active, false);
  assert.equal(peakEconomyStatus(peak, ms('2026-10-24T10:00:00')).active, true);
  assert.equal(peakEconomyStatus({ ...peak, mode: 'off' }).active, false);
});

test('设置严格校验并保留零值和未修改项', () => {
  assert.deepEqual(validatePeakEconomy({ probability: 0, minIntervalMs: 0 }, peak), { ...peak, minIntervalMs: 0 });
  for (const value of [null, [], false, { enabled: 'true' }, { mode: 'bad' }, { probability: '0.2' },
    { probability: 2 }, { minIntervalMs: -1 }, { minIntervalMs: 0.5 }, { replyChars: null }, { arbitrary: true }]) {
    assert.throws(() => validatePeakEconomy(value, peak), error => error.statusCode === 400);
  }
});

test('峰时只压可选唤醒，@在anyMessage模式下仍保留；谷时不追加限制', () => {
  const decide = extra => decidePeakWake({ key: 'group:456', reason: 'anyMessage', config: peak, random: () => 0, ...extra });
  assert.equal(decide().allowed, false);
  for (const reason of ['private', 'atMention', 'poke', 'admin', 'bootstrap','video']) assert.equal(decide({ reason }).allowed, true);
  assert.equal(decide({unread:[{plain:'[视频]'}]}).allowed,true,'合批原因为普通消息时仍不能漏掉新视频');
  assert.equal(decide({ key: 'private:123' }).allowed, true);
  for (const evidence of [{ directAtSelf: true }, { quoteTargetIsSelf: true }]) assert.equal(decide({ unread: [evidence] }).allowed, true);
  assert.equal(decide({ config: { ...peak, mode: 'off' }, lastAcceptedAt: Date.now() }).allowed, true);
  assert.equal(decide({ config: { ...peak, enabled: false } }).allowed, true);
  assert.equal(decide({ config: { ...peak, probability: 1 }, now: 1000000, lastAcceptedAt: 999999 }).reason, 'interval');
  assert.equal(decide({ config: { ...peak, probability: 1 }, now: 1000000, lastAcceptedAt: 1000001 }).retryAfterMs, 900000);
  assert.equal(decide({ config: { ...peak, probability: 1 }, now: 2000000, lastAcceptedAt: 1000000 }).allowed, true);
});

test('真实投递前节流：不创建会话、不调模型、不清未读，有限睡眠不会永眠；私聊和@可投递', async () => {
  const h = await bridgeHarness({ config: { socialV2: { peakEconomy: peak } } });
  try {
    h.setMode('reserved2');
    h.appendSocialV2Message('group:456', 'fixture', '普通聊天', '普通聊天', false, false, 's1', [], '123');
    const st = h.getSocialV2State('group:456');
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() + 1000).toISOString();
    for (const reason of ['probability', 'anyMessage', 'proactiveCheck', 'timeout', 'replyCheck']) await h.sendWakePromptV2('group:456', reason);
    assert.equal(h.calls.created.length, 0);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.unread.length, 1);
    assert.equal(st.lastReadThroughSeq || 0, 0);
    assert.equal(st.wakeTimes.length, 0);
    assert.ok(st.sleepTimer);
    assert.ok(Date.parse(st.wakeConfig.sleepUntil) > Date.now());
    assert.equal(h.isConversationBusyV2('group:456', st), false);
    st.unread[0].directAtSelf = true;
    await h.sendWakePromptV2('group:456', 'anyMessage');
    assert.equal(h.calls.prompts.length, 1);
    const text = h.calls.prompts[0].content.map(part => part.text || '').join('\n');
    assert.match(text, /峰时节流/);
    assert.ok(!text.includes('不要习惯性潜水'));
    await h.sendWakePromptV2('private:123', 'private');
    assert.equal(h.calls.prompts.length, 2);
  } finally { await h.close(); }
});

test('离线排队按真正投递时的峰谷状态重判，跳过不消耗唤醒配额', async () => {
  const h = await bridgeHarness({ config: { socialV2: { peakEconomy: { ...peak, mode: 'off' } } } });
  try {
    h.setMode('reserved2'); h.setReady(false);
    await h.sendWakePromptV2('group:456', 'proactiveCheck');
    h.cfg.socialV2.peakEconomy.mode = 'peak'; h.setReady(true);
    await h.flushQueue();
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.getSocialV2State('group:456').wakeTimes.length, 0);
  } finally { await h.close(); }
});

test('成功唤醒的间隔记录落盘，重启后仍抑制可选唤醒，谷时立刻恢复原策略', async () => {
  const config = { socialV2: { peakEconomy: { ...peak, probability: 1 }, wake: { maxWakePerMinute: 0, maxWakePerHour: 0 } } };
  const first = await bridgeHarness({ config });
  let saved;
  try {
    first.setMode('reserved2'); await first.sendWakePromptV2('group:456', 'admin');
    saved = fs.readFileSync(path.join(first.temp, 'state/social-v2.json'), 'utf8');
    assert.ok(JSON.parse(saved).conversations['group:456'].lastEconomyWakeAt > 0);
  } finally { await first.close(); }
  const h = await bridgeHarness({ config, files: { 'state/social-v2.json': saved } });
  try {
    h.setMode('reserved2'); await h.sendWakePromptV2('group:456', 'proactiveCheck');
    assert.equal(h.calls.prompts.length, 0);
    h.cfg.socialV2.peakEconomy.mode = 'off';
    await h.sendWakePromptV2('group:456', 'proactiveCheck');
    assert.equal(h.calls.prompts.length, 1);
    assert.ok(!h.calls.prompts[0].content[0].text.includes('【峰时节流】'));
  } finally { await h.close(); }
});

test('设置 API 即时保存/读取、拒绝无效参数与智能体修改', async () => {
  const h = await bridgeHarness({ config: { socialV2: { peakEconomy: peak } } });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/socialV2/config`;
  const headers = { 'x-console-token': 'fixture-console-token', 'content-type': 'application/json' };
  try {
    let response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ peakEconomy: { mode: 'off', probability: 0 } }) });
    assert.equal(response.status, 200);
    assert.equal(h.cfg.socialV2.peakEconomy.minIntervalMs, 900000);
    assert.equal((await (await fetch(url, { headers })).json()).peakEconomyStatus.active, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).socialV2.peakEconomy.probability, 0);
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ peakEconomy: { probability: 2 } }) });
    assert.equal(response.status, 400);
    assert.equal(h.cfg.socialV2.peakEconomy.probability, 0);
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ peakEconomy: peak }) });
    assert.ok([401, 403].includes(response.status));
  } finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
});
