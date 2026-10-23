import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, FLASH_MODELS, CONTINUE_TEXT } from '../plugins/qq-agent-presets/qq-platform-policy.mjs';
import { createOutputContinuation } from '../src/output-continuation.js';
import { setTimeout as tick } from 'node:timers/promises';

function fixture(config = {}) {
  const handlers = {};
  const messages = [];
  const agent = { inbox: { nextTurn: [], nextStep: [] }, followup: m => messages.push(m) };
  const session = { id: 'test', requestHeader: () => ({ config: { provider: 'qq-qianwen', model: FLASH_MODELS[0] } }) };
  apply({ on: (event, fn) => { handlers[event] = fn; }, agents: { get: () => agent }, logger: { info() {} } }, config);
  return { handlers, agent, session, messages };
}

test('token limit queues continuation once, preserves history and caps attempts', async () => {
  const f = fixture({ maxContinuations: 2 });
  const end = turn => f.handlers['session/event'](f.session, { type: 'turn/end', data: { turn, reason: { kind: 'max-tokens' } } });
  end(1); end(1);
  assert.equal(f.messages.length, 0, 'must not reenter session publication');
  await tick(5);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].content[0].text, CONTINUE_TEXT);
  f.handlers['session/event'](f.session, { type: 'user/message', data: f.messages[0] });
  end(2); await tick(5); end(3); await tick(5);
  assert.equal(f.messages.length, 2);
  f.handlers['session/event'](f.session, { type: 'user/message', data: { id: 'human', source: { kind: 'user' } } });
  end(4);
  await tick(5);
  assert.equal(f.messages.length, 3);
});

test('completion, cancellation and queued human input never cause automatic restart', () => {
  const f = fixture();
  for (const kind of ['completed', 'aborted', 'error']) f.handlers['session/event'](f.session, { type: 'turn/end', data: { turn: 1, reason: { kind } } });
  f.agent.inbox.nextTurn.push({});
  f.handlers['session/event'](f.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } });
  assert.equal(f.messages.length, 0);
});

test('stop pressed after cutoff cancels the pending continuation', async () => {
  const f = fixture(); const ctrl = new AbortController();
  await f.handlers['agent/request']({ agent: f.agent, turn: 1, step: 1, signal: ctrl.signal }, async () => ({ provider: 'qq-qianwen' }));
  f.handlers['session/event'](f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } });
  ctrl.abort(); await tick(5);
  assert.equal(f.messages.length, 0);
});

test('request retry stays on platform, prefers 1017 and exhausts only Flash models', async () => {
  const f = fixture();
  const payload = { agent: f.agent, turn: 1, step: 1 };
  const request = () => f.handlers['agent/request'](payload, async () => ({ provider: 'qq-qianwen', model: 'old', reasoningEffort: 'high' }));
  const error = () => f.handlers['agent/request-error']({ ...payload, provider: 'qq-qianwen', signal: new AbortController().signal }, async () => undefined);
  for (let i = 0; i < FLASH_MODELS.length; i++) {
    const r = await request();
    assert.equal(r.model, FLASH_MODELS[i]); assert.equal(r.provider, 'qq-qianwen');
    assert.equal(r.maxTokens, 32768); assert.ok(!Object.hasOwn(r, 'reasoningEffort'));
    assert.deepEqual(await error(), i + 1 < FLASH_MODELS.length ? { kind: 'retry' } : undefined);
  }
  payload.step++;
  assert.equal((await request()).model, FLASH_MODELS[0]);
  assert.deepEqual(await f.handlers['agent/request'](payload, async () => ({ provider: 'other', model: 'untouched' })), { provider: 'other', model: 'untouched' });
});

test('QQ joins truncated segments and emits only the final result, bounded by policy', () => {
  const c = createOutputContinuation({ enabled: true, maxContinuations: 2 });
  const end = (text, kind = 'max-tokens') => ({ text, reason: { kind } });
  assert.equal(c.finish('s', end('A')).continuing, true);
  c.observe('s', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ text: CONTINUE_TEXT }] } });
  assert.equal(c.finish('s', end('B')).continuing, true);
  assert.equal(c.finish('s', end('C', 'completed')).ended.text, 'ABC');
  assert.equal(c.has('s'), false);
  c.finish('s', end('X')); c.finish('s', end('Y'));
  assert.equal(c.finish('s', end('Z')).ended.text, 'XYZ');
  c.finish('s', end('old'));
  c.observe('s', { type: 'user/message', data: { source: { kind: 'user' }, content: [{ text: 'new task' }] } });
  assert.equal(c.finish('s', end('new', 'completed')).ended.text, 'new');
});

test('one-token context clamp and failed compaction stop both continuation layers', async () => {
  for (const failure of [
    { type: 'assistant/message', data: { usage: { outputTokens: 1 }, message: { content: [{ type: 'reasoning', text: 'Let' }] } } },
    { type: 'compaction/end', data: { error: 'context overflow' } }
  ]) {
    const f = fixture();
    const c = createOutputContinuation({ enabled: true });
    const observe = event => { f.handlers['session/event'](f.session, event); c.observe('s', event); };
    observe({ type: 'turn/start', data: { turn: 1 } });
    observe(failure);
    observe({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } });
    await tick(5);
    assert.equal(f.messages.length, 0, 'do not retry a context problem as an output cutoff');
    assert.equal(c.finish('s', { text: '', reason: { kind: 'max-tokens' } }).continuing, false);
    assert.equal(c.has('s'), false, 'bridge must not wait for a continuation that will not run');
    observe({ type: 'turn/start', data: { turn: 2 } });
    observe({ type: 'assistant/message', data: { usage: { outputTokens: 100 }, message: { content: [{ type: 'text', text: 'useful partial answer' }] } } });
    observe({ type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } });
    await tick(5);
    assert.equal(f.messages.length, 1, 'a healthy later turn can continue');
    assert.equal(c.finish('s', { text: 'useful partial answer', reason: { kind: 'max-tokens' } }).continuing, true);
  }
});
