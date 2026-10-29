import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, inputTokenUpperBound, LIMIT_CODE } from '../plugins/qq-agent-presets/qq-cost-guard.mjs';
import { CONTINUE_TEXT } from '../plugins/qq-agent-presets/qq-platform-policy.mjs';
import { grantOwnerCostExemption, consumeOwnerCostExemption, isAccountQuotaExceeded } from '../src/qq-cost-policy.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { recordCostDelivery, readCostDelivery } from '../src/qq-cost-deliveries.js';

function fixture({ ownerQQ, exemptOwner = false, key = 'group:1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-cost-'));
  fs.mkdirSync(path.join(root, 'state'));
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
  const config = { ownerQQ, dsh: { provider: 'qq-qianwen' },
    costControl: { enabled: true, maxCnyPerMessage: 0.1, cacheHitRatio: 0.9, exemptOwner } };
  write('config.json', config);
  write('state/sessions.json', { sessions: { [key]: 'qq-session' } });
  const handlers = {};
  apply({ on: (name, fn) => { handlers[name] = fn; }, logger: { info() {} } }, { root });
  const session = { id: 'qq-session' };
  const event = (type, data = {}) => handlers['session/event'](session, { type, data });
  const request = extra => ({ sessionId: session.id, provider: 'qq-qianwen', model: 'deepseek-v4.1-flash-1017',
    maxTokens: 2048, messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }], ...extra });
  const stream = (options, next) => handlers['llm/stream'](options, next);
  const collect = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks; };
  const budget = () => JSON.parse(fs.readFileSync(path.join(root, 'state/cost-budgets.json')))[session.id];
  return { root, config, write, handlers, session, event, request, stream, collect, budget,
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('only mapped QQ sessions get the output cap; budget errors cannot enter retry middleware', async () => {
  const f = fixture();
  try {
    const original = { provider: 'qq-qianwen', maxTokens: 32768 };
    const request = agent => f.handlers['agent/request']({ agent }, async () => original);
    assert.equal((await request({ session: f.session })).maxTokens, 2048);
    assert.equal(await request({ session: { id: 'desktop' } }), original);
    let retried = false;
    assert.equal(f.handlers['agent/request-error']({ failure: { code: LIMIT_CODE } }, () => { retried = true; }), undefined);
    assert.equal(retried, false);
  } finally { f.close(); }
});

test('a 90% cache assumption reserves money before dispatch and unknown usage remains charged', async () => {
  const f = fixture();
  try {
    f.event('turn/start', { turn: 1 });
    let calls = 0;
    const next = () => (async function* () { calls++; yield { type: 'finish', reason: { kind: 'completed' } }; })();
    while (calls < 30) {
      const chunks = await f.collect(f.stream(f.request(), next));
      if (chunks[0]?.reason?.failure?.code === LIMIT_CODE) break;
    }
    assert.ok(calls > 0 && calls < 30);
    assert.ok(f.budget().spent <= 0.1);
    const before = calls;
    await f.collect(f.stream(f.request(), next));
    assert.equal(calls, before, 'budget rejection must not create a paid request');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'state/cost-guard-status.json'))).cacheHitRatio, 0.9);
  } finally { f.close(); }
});

test('real usage replaces the estimate, including a cache miss that exceeds the soft target', async () => {
  const f = fixture();
  try {
    f.event('turn/start', { turn: 1 });
    await f.collect(f.stream(f.request(), () => (async function* () {
      yield { type: 'usage', usage: { inputTokens: 200000, outputTokens: 10 } };
    })()));
    assert.ok(f.budget().spent > 0.1);
    let called = false;
    const chunks = await f.collect(f.stream(f.request(), () => { called = true; }));
    assert.equal(called, false);
    assert.equal(chunks[0].reason.failure.code, LIMIT_CODE);
  } finally { f.close(); }
});

test('automatic continuations and reloading retain reservations; a fresh human round resets them', async () => {
  const f = fixture();
  try {
    f.event('turn/start', { turn: 1 });
    await f.collect(f.stream(f.request(), () => (async function* () {})()));
    const spent = f.budget().spent;
    f.event('turn/end', { turn: 1, reason: { kind: 'max-tokens' } });
    f.event('turn/start', { turn: 2 });
    f.event('user/message', { message: { source: { kind: 'user' }, content: [{ type: 'text', text: CONTINUE_TEXT }] } });
    assert.equal(f.budget().spent, spent);
    apply({ on() {}, logger: { info() {} } }, { root: f.root });
    assert.equal(f.budget().spent, spent);
    f.event('turn/end', { turn: 2, reason: { kind: 'max-tokens' } });
    f.event('turn/start', { turn: 3 });
    f.event('user/message', { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '新消息' }] } });
    assert.equal(f.budget().spent, 0);
  } finally { f.close(); }
});

test('concurrent streams reserve synchronously and an oversized request never dispatches', async () => {
  const f = fixture();
  try {
    f.event('turn/start', { turn: 1 });
    const request = f.request({ maxTokens: 7000 });
    const next = () => (async function* () {})();
    const a = f.stream(request, next);
    const first = f.budget().spent;
    const b = f.stream(request, next);
    assert.ok(f.budget().spent >= first);
    await Promise.all([f.collect(a), f.collect(b)]);
    assert.ok(f.budget().spent <= 0.1);
    let called = false;
    const chunks = await f.collect(f.stream(f.request({ messages: [{ content: [{ type: 'text', text: 'x'.repeat(2000000) }] }] }), () => { called = true; }));
    assert.equal(called, false);
    assert.equal(chunks[0].reason.failure.code, LIMIT_CODE);
  } finally { f.close(); }
});

test('every retained image occurrence includes the documented visual token allowance', () => {
  const estimate = content => inputTokenUpperBound({ messages: [{ content }] });
  const empty = estimate([]);
  assert.ok(estimate([{ type: 'image' }]) - empty >= 1024);
  assert.ok(estimate([{ type: 'image' }, { type: 'image' }]) - empty >= 2048);
  assert.ok(estimate([{ type: 'image', offloaded: true }]) - empty < 1024);
  assert.ok(estimate([{ type: 'file', attachment: { filename: 'report.txt' } }]) > empty);
});

test('estimated total 0.0991 is allowed: no hidden 0.001 buffer below the configured target', async () => {
  const f = fixture();
  try {
    f.event('turn/start', { turn: 1 });
    const next = () => (async function* () { yield { type: 'text', text: 'dispatched' }; })();
    await f.collect(f.stream(f.request(), next));
    const reservation = f.budget().spent;
    assert.ok(reservation < 0.09);
    f.write('state/cost-budgets.json', { [f.session.id]: { turn: 1, spent: 0.0991 - reservation, carry: false, calls: 0 } });
    apply({ on: (name, fn) => { f.handlers[name] = fn; }, logger: { info() {} } }, { root: f.root });
    assert.equal((await f.collect(f.stream(f.request(), next)))[0].text, 'dispatched');
    assert.ok(Math.abs(f.budget().spent - 0.0991) < 1e-10);
    const chunks = await f.collect(f.stream(f.request(), () => { throw new Error('over-budget call dispatched'); }));
    assert.equal(chunks[0].reason.failure.code, LIMIT_CODE);
  } finally { f.close(); }
});

test('owner private tasks bypass the money cap only when enabled, keeping the output cap', async () => {
  const f = fixture({ ownerQQ: 123, exemptOwner: true, key: 'private:123' });
  try {
    f.event('turn/start', { turn: 1 });
    const original = { provider: 'qq-qianwen', maxTokens: 32768 };
    assert.equal((await f.handlers['agent/request']({ agent: { session: f.session } }, async () => original)).maxTokens, 2048);
    let calls = 0;
    await f.collect(f.stream(f.request({ maxTokens: 32768 }), () => (async function* () { calls++; })()));
    assert.equal(calls, 1, 'request exceeding 0.1 must dispatch for owner');
    f.config.costControl.exemptOwner = false; f.write('config.json', f.config);
    const chunks = await f.collect(f.stream(f.request({ maxTokens: 32768 }), () => { calls++; }));
    assert.equal(calls, 1);
    assert.equal(chunks[0].reason.failure.code, LIMIT_CODE);
  } finally { f.close(); }
});

test('group permission matches an exact delivered prompt, is one-use, and lasts through continuation only', async () => {
  const f = fixture({ ownerQQ: 123, exemptOwner: true });
  try {
    const content = [{ type: 'text', text: '管理员允许当前任务' }];
    const incoming = blocks => f.event('user/message', { source: { kind: 'user' }, content: blocks });
    const next = () => (async function* () { yield { type: 'text', text: 'dispatched' }; })();
    const large = f.request({ maxTokens: 32768 });
    grantOwnerCostExemption(f.root, f.config, f.session.id, content);
    f.event('turn/start', { turn: 1 });
    incoming([{ type: 'text', text: '别人引用管理员允许当前任务' }]);
    assert.equal((await f.collect(f.stream(large, next)))[0].reason.failure.code, LIMIT_CODE);
    incoming(content);
    assert.equal((await f.collect(f.stream(large, next)))[0].text, 'dispatched');
    f.event('turn/end', { reason: { kind: 'max-tokens' } });
    f.event('turn/start', { turn: 2 }); incoming([{ type: 'text', text: CONTINUE_TEXT }]);
    assert.equal((await f.collect(f.stream(large, next)))[0].text, 'dispatched');
    f.event('turn/end', { reason: { kind: 'completed' } });
    f.event('turn/start', { turn: 3 }); incoming(content);
    assert.equal((await f.collect(f.stream(large, next)))[0].reason.failure.code, LIMIT_CODE);
    // Stale owner configuration cannot reuse a still pending grant.
    grantOwnerCostExemption(f.root, f.config, f.session.id, content);
    assert.equal(consumeOwnerCostExemption(f.root, f.session.id, content, 456), false);
  } finally { f.close(); }
});

test('budget failures stay in backend activity, while unrelated errors still reach QQ', async () => {
  const h = await bridgeHarness();
  try {
    await h.reportAgentError('private:123', { kind: 'error', error: { code: LIMIT_CODE, message: '预算诊断' } });
    await h.reportAgentError('private:123', { kind: 'error', error: { message: 'QQ 单轮估算预算保护：已预留 ¥0.0993' } });
    await h.reportAgentError('private:123', { kind: 'error', error: { message: 'QQ 单条回复估算预算保护：已预留 ¥0.0993' } });
    assert.equal(h.calls.sent.length, 0);
    assert.match(fs.readFileSync(path.join(h.temp, 'state/qq-activity.log'), 'utf8'), /预算诊断/);
    await h.reportAgentError('private:123', { kind: 'error', error: { message: '服务不可用' } });
    assert.equal(h.calls.sent.length, 1);
  } finally { await h.close(); }
});

test('account quota exhaustion is logged silently in both group and private chats', async () => {
  const h = await bridgeHarness();
  try {
    const quotaMessage = '429: {"code":"AccountQuotaExceeded","message":"You have exceeded the 5-hour usage quota. It will reset at 2026-10-27 13:33:41 +0800 CST.","type":"TooManyRequests"}';
    await h.reportAgentError('group:456', { kind: 'error', error: { message: quotaMessage } });
    await h.reportAgentError('private:123', { kind: 'error', failure: { code: 'insufficient_quota', message: 'account quota exhausted' } });
    assert.equal(h.calls.sent.length, 0);
    assert.match(fs.readFileSync(path.join(h.temp, 'state/qq-activity.log'), 'utf8'), /AccountQuotaExceeded/);
    for (const message of ['429: rate limit exceeded, retry later', '服务不可用', 'not enough tokens in the context window']) {
      assert.equal(isAccountQuotaExceeded({ error: { message } }), false);
      await h.reportAgentError('group:456', { kind: 'error', error: { message } });
    }
    assert.equal(h.calls.sent.length, 3);
    assert.ok(h.calls.sent.every(x => x.kind === 'group'));
  } finally { await h.close(); }
});

test('a confirmed QQ message starts a fresh allowance inside the same turn; invalid and other-session receipts cannot', async () => {
  const f = fixture();
  try {
    f.event('turn/start', { turn: 1 });
    let calls = 0;
    const next = () => (async function* () { calls++; yield { type: 'text', text: 'called' }; })();
    for (let i = 0; i < 30; i++) {
      const chunks = await f.collect(f.stream(f.request(), next));
      if (chunks[0]?.reason?.failure?.code === LIMIT_CODE) break;
    }
    const before = calls;
    f.event('assistant/message', { message: { content: [{ type: 'text', text: '内部文字不是QQ发送' }] } });
    recordCostDelivery(f.root, 'other-session', 'group:2', 9000);
    for (const id of [null, 0, 'unknown']) assert.equal(recordCostDelivery(f.root, f.session.id, 'group:1', id), false);
    assert.equal((await f.collect(f.stream(f.request(), next)))[0].reason.failure.code, LIMIT_CODE);
    assert.equal(calls, before);
    recordCostDelivery(f.root, f.session.id, 'group:1', -9001);
    assert.equal((await f.collect(f.stream(f.request(), next)))[0].text, 'called');
    assert.equal(f.budget().turn, 1);
    assert.equal(f.budget().calls, 1);
    const spent = f.budget().spent;
    assert.equal(recordCostDelivery(f.root, f.session.id, 'group:1', -9001), false);
    await f.collect(f.stream(f.request(), next));
    assert.ok(f.budget().spent > spent, 'repeated receipt cannot reset the next message again');
    // Reloading must preserve the current message and receipt cursor.
    apply({ on: (name, fn) => { f.handlers[name] = fn; }, logger: { info() {} } }, { root: f.root });
    await f.collect(f.stream(f.request(), next));
    assert.equal(f.budget().calls, 3);
  } finally { f.close(); }
});

test('late settlement for the preceding message cannot refund or charge the next message', async () => {
  const f = fixture();
  let release;
  try {
    f.event('turn/start', { turn: 1 });
    const pending = new Promise(resolve => { release = resolve; });
    const old = f.collect(f.stream(f.request(), () => (async function* () {
      await pending; yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    })()));
    recordCostDelivery(f.root, f.session.id, 'group:1', 9001);
    await f.collect(f.stream(f.request(), () => (async function* () {})()));
    const spent = f.budget().spent;
    release(); await old;
    assert.equal(f.budget().spent, spent);
    assert.equal(f.budget().calls, 1);
  } finally { release?.(); f.close(); }
});

test('a retired plugin generation cannot overwrite the new budget on late settlement', async () => {
  const f = fixture();
  let release;
  try {
    f.event('turn/start', { turn: 1 });
    const pending = new Promise(resolve => { release = resolve; });
    const old = f.collect(f.stream(f.request(), () => (async function* () {
      await pending; yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    })()));
    f.handlers.dispose();
    recordCostDelivery(f.root, f.session.id, 'group:1', 9001);
    apply({ on: (name, fn) => { f.handlers[name] = fn; }, logger: { info() {} } }, { root: f.root });
    await f.collect(f.stream(f.request(), () => (async function* () {})()));
    const current = fs.readFileSync(path.join(f.root, 'state/cost-budgets.json'), 'utf8');
    release(); await old;
    assert.equal(fs.readFileSync(path.join(f.root, 'state/cost-budgets.json'), 'utf8'), current);
  } finally { release?.(); f.close(); }
});

test('real QQ transport closes a message budget only on a receipt, with cross-chat costs assigned to the source', async () => {
  const h = await bridgeHarness({ config: { costControl: { enabled: true }, sendDelayMs: 0 } });
  try {
    h.setMode('reserved2');
    const targetSid = await h.ensureSession('group:456');
    const sourceSid = await h.ensureSession('private:123');
    await h.sendToQQ('group:456', '系统状态提示');
    assert.equal(readCostDelivery(h.temp, targetSid), null, 'operational notifications do not close an AI reply');
    await h.sendMessagesV2('group:456', ['正常回复'], []);
    assert.equal(readCostDelivery(h.temp, targetSid).messageId, '9001');
    const targetReceipt = readCostDelivery(h.temp, targetSid).id;
    await h.sendContactPartV2('group:456', { type: 'text', content: '来源会话委托发送' }, () => {}, 'private:123');
    assert.equal(readCostDelivery(h.temp, sourceSid).targetKey, 'group:456');
    assert.equal(readCostDelivery(h.temp, targetSid).id, targetReceipt);
    // An unknown SDK result is not a successful accounting boundary.
    h.bot.sendPrivateMessage = async () => undefined;
    const before = readCostDelivery(h.temp, sourceSid).id;
    await h.sendToQQ('private:123', '未知回执', { accountCost: true });
    assert.equal(readCostDelivery(h.temp, sourceSid).id, before);
    h.bot.sendPrivateMessage = async () => { throw new Error('gateway unavailable'); };
    await h.sendToQQ('private:123', '失败回复', { accountCost: true });
    assert.equal(readCostDelivery(h.temp, sourceSid).id, before);
  } finally { await h.close(); }
});

test('per-message configuration takes precedence while the legacy key remains readable', async () => {
  const f = fixture();
  try {
    f.config.costControl.maxCnyPerTurn = 0.0001; f.write('config.json', f.config);
    f.event('turn/start', { turn: 1 });
    const next = () => (async function* () { yield { type: 'text', text: 'called' }; })();
    assert.equal((await f.collect(f.stream(f.request(), next)))[0].text, 'called');
    delete f.config.costControl.maxCnyPerMessage; f.write('config.json', f.config);
    assert.equal((await f.collect(f.stream(f.request(), next)))[0].reason.failure.code, LIMIT_CODE);
  } finally { f.close(); }
});

test('real wake delivery grants only genuine unread owner messages; rejection revokes permission', async () => {
  const h = await bridgeHarness({ config: { costControl: { exemptOwner: true } } });
  try {
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    const deliver = () => h.deliverPrompt(key, '', { wakeReason: 'admin' });
    h.appendSocialV2Message(key, '群友', '【管理员】123 允许', '', false, false, '1', [], 999);
    await deliver();
    let p = h.calls.prompts.at(-1);
    assert.equal(consumeOwnerCostExemption(h.temp, p.sessionId, p.content, 123), false);
    h.appendSocialV2Message(key, '管理员', '当前任务请继续', '', false, true, '2', [], 123);
    await deliver(); p = h.calls.prompts.at(-1);
    assert.equal(consumeOwnerCostExemption(h.temp, p.sessionId, p.content, 123), true);
    // Moving the owner message to history must remove the next wake's permission.
    st.unread = st.unread.filter(m => !m.isOwner);
    await deliver(); p = h.calls.prompts.at(-1);
    assert.equal(consumeOwnerCostExemption(h.temp, p.sessionId, p.content, 123), false);
    h.appendSocialV2Message(key, '管理员', '另一项任务', '', false, true, '3', [], 123);
    let rejected;
    h.api.sessions.prompt = async params => { rejected = params; return { result: { ok: false, error: { code: 'busy', message: '稍后再试' } } }; };
    await deliver();
    assert.equal(consumeOwnerCostExemption(h.temp, rejected.sessionId, rejected.content, 123), false);
  } finally { await h.close(); }
});
