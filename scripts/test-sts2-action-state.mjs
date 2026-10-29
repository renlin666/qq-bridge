import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSts2Service } from '../src/sts2-service.js';

const board = () => ({ inRun: true, room: 'Combat', combatState: 'PlayPhase',
  players: [{ hp: 50, energy: 2, hand: [{ uid: 11 }] }], combat: { side: 'Player', round: 2 } });
const key = 'private:12345';

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sts2-action-state-'));
  t.after(() => { assert.ok(directory.startsWith(path.join(os.tmpdir(), 'qq-sts2-action-state-'))); fs.rmSync(directory, { recursive: true, force: true }); });
  const tokenFile = path.join(directory, 'token'); fs.writeFileSync(tokenFile, 'f'.repeat(64));
  const cfg = { ownerQQ: '12345', extensions: { sts2: { enabled: true, config: { tokenFile } } } };
  const calls = [], waits = [];
  let authorized = true;
  const allow = () => { if (!authorized) throw new Error('scope revoked'); };
  const create = () => createSts2Service({ stateDir: directory, getConfig: () => cfg,
    readMessage: () => ({ userId: '12345', messageId: 'auth', plain: '玩杀戮尖塔2', time: Date.now() }),
    waitForState: async (ms, signal) => { waits.push(ms); await options.wait?.(ms, signal); },
    onObservation: options.onObservation, onControlChange: options.onControlChange,
    fetcher: async (url, init) => {
      const route = new URL(url).pathname; calls.push({ route, ...init });
      const result = init.method === 'POST' ? await (options.act?.(route, init) ?? { ok: true, played: 11 })
        : route === '/state' ? await (options.state?.(init) ?? board())
          : await (options.choices?.(init) ?? { pending: null });
      return new Response(JSON.stringify(result));
    } });
  const service = create();
  await service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'auth' }, allow);
  const action = (args = {}, signal, selected = service) => selected.handle(key,
    { operation: 'action', kind: 'play_card', arguments: { uid: 11 }, requestId: 'action_state_001', ...args }, allow, signal);
  return { service, cfg, calls, waits, create, action, allow,
    revoke: () => { authorized = false; }, restore: () => { authorized = true; },
    stop: () => service.handle(key, { operation: 'control', enabled: false, requestMessageId: 'auth' }, allow) };
}

for (const [kind, args] of Object.entries({ play_card: { uid: 11 }, end_turn: {}, move: { col: 1, row: 2 },
  respond: { id: 7, picks: ['option#1'] }, proceed: {}, use_potion: { index: 0 }, discard_potion: { index: 0 } })) {
  test(`${kind} returns the post-action board and choices in the same tool result`, async t => {
    const f = await fixture(t);
    const result = await f.action({ kind, arguments: args });
    assert.equal(result.ok, true); assert.equal(result.played, 11);
    assert.deepEqual(result.state, board()); assert.equal(result.nextRequest, null);
    assert.equal(result.stateStatus, 'stable'); assert.equal(result.stateReadRequired, false);
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.deepEqual(f.waits, [300, 300]);
    const count = f.calls.length;
    const duplicate = await f.action({ kind, arguments: args }, undefined, f.create());
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.stateStatus, 'cached');
    assert.equal(duplicate.stateReadRequired, true); assert.equal(f.calls.length, count);
  });
}

test('enemy phases and changing choices cannot satisfy the stable-state check', async t => {
  let reads = 0, choices = 0;
  const f = await fixture(t, {
    state: () => { reads++; const state = board(); if (reads < 3) { state.combatState = 'EndTurnPhaseOne'; state.combat.side = 'Enemy'; } return state; },
    choices: () => ({ pending: ++choices < 3 ? null : { id: choices < 5 ? choices : 5, candidates: [{ key: '选择#1' }] } }) });
  const result = await f.action();
  assert.equal(result.stateStatus, 'stable'); assert.equal(reads, 7);
  assert.equal(result.nextRequest.id, 5); assert.equal(result.state.combat.side, 'Player');
});

test('a real pending choice is actionable even outside PlayPhase', async t => {
  const state = board(); state.combatState = 'NotPlayPhase';
  const pending = { id: 18, min: 1, max: 1, candidates: [{ key: '选牌#1' }] };
  const f = await fixture(t, { state: () => state, choices: () => ({ pending }) });
  const result = await f.action();
  assert.equal(result.stateReadRequired, false); assert.deepEqual(result.nextRequest, pending);
});

test('an unchanged enemy phase remains pending within a bounded number of reads', async t => {
  const state = board(); state.combatState = 'NotPlayPhase'; state.combat.side = 'Enemy';
  const f = await fixture(t, { state: () => state });
  const result = await f.action();
  assert.equal(result.ok, true); assert.equal(result.stateStatus, 'pending'); assert.equal(result.stateReadRequired, true);
  assert.equal(f.calls.filter(call => call.route === '/state').length, 9);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('failed follow-up reads preserve the accepted action receipt across process restart', async t => {
  const f = await fixture(t, { state: () => { throw new Error('read unavailable'); } });
  const result = await f.action();
  assert.equal(result.ok, true); assert.equal(result.stateStatus, 'unavailable'); assert.equal(result.stateReadRequired, true);
  const count = f.calls.length;
  assert.equal((await f.action({}, undefined, f.create())).duplicate, true);
  assert.equal(f.calls.length, count);
});

test('unknown action delivery never polls a board or repeats the action after restart', async t => {
  const f = await fixture(t, { act: () => { throw new Error('unknown delivery'); } });
  await assert.rejects(f.action(), /结果未知/);
  await assert.rejects(f.action({}, undefined, f.create()), /结果未知/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'POST');
});

test('a stalled state read has a finite deadline without losing the accepted action', async t => {
  const f = await fixture(t, { state: ({ signal }) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('deadline was not enforced')), 3000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) });
  const started = Date.now(), result = await f.action();
  assert.ok(Date.now() - started < 2500);
  assert.equal(result.ok, true); assert.equal(result.stateStatus, 'unavailable');
  const count = f.calls.length;
  assert.equal((await f.action()).duplicate, true); assert.equal(f.calls.length, count);
});

test('stopping during post-action observation cancels further polling without reopening authorization', async t => {
  let finish, started;
  const observing = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { state: async () => { started(); return new Promise(resolve => { finish = () => resolve(board()); }); } });
  const operation = f.action(); await observing;
  await f.stop(); finish();
  const result = await operation;
  assert.equal(result.ok, true); assert.equal(result.stateStatus, 'stopped'); assert.equal(result.stateReadRequired, true);
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.action({ requestId: 'action_after_stop' }), /尚未取得/);
});

test('revoking scope during a read hides its state and never replays the accepted action', async t => {
  let finish, started;
  const observing = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { state: async () => { started(); return new Promise(resolve => { finish = () => resolve(board()); }); } });
  const operation = f.action(); await observing;
  f.revoke(); finish(); await assert.rejects(operation, /scope revoked/);
  f.restore(); const count = f.calls.length;
  assert.equal((await f.action()).duplicate, true); assert.equal(f.calls.length, count);
});

test('aborted observations retain the action receipt and concurrent actions remain blocked', async t => {
  let started;
  const observing = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const f = await fixture(t, { wait: async (_ms, signal) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const operation = f.action({}, controller.signal); await observing;
  await assert.rejects(f.action({ requestId: 'concurrent_action' }), /上一个游戏动作/);
  controller.abort(new Error('cancel observation')); await assert.rejects(operation, /cancel observation/);
  const count = f.calls.length;
  assert.equal((await f.action()).duplicate, true); assert.equal(f.calls.length, count);
});

test('only confirmed action execution is counted; observed menu state closes the existing game lease', async t => {
  const seen = [], controls = [];
  const f = await fixture(t, { state: () => ({ inRun: false }),
    onObservation: (_key, result, kind) => { seen.push({ result, kind }); return result.inRun === false; },
    onControlChange: value => controls.push(value) });
  const result = await f.action();
  assert.equal(seen.filter(item => item.kind).length, 1);
  assert.equal(result.state.inRun, false); assert.equal(result.stateStatus, 'stopped');
  assert.equal(controls.at(-1).enabled, false);
});

test('invalid post-action state or choices never masquerade as ready', async t => {
  for (const options of [{ state: () => ({ ok: true }) }, { choices: () => ({ pending: { id: 'bad', candidates: [] } }) }]) {
    const f = await fixture(t, options);
    const result = await f.action();
    assert.equal(result.ok, true); assert.equal(result.stateStatus, 'unavailable'); assert.equal(result.stateReadRequired, true);
  }
});

test('rejected or unrecognized acknowledgements never invent successful execution or poll the board', async t => {
  for (const ack of [{ ok: false, error: 'not playable' }, { note: 'unrecognized ack' }]) {
    const f = await fixture(t, { act: () => ack });
    const result = await f.action();
    assert.equal(result.ok, ack.ok); assert.equal(result.stateReadRequired, true);
    assert.equal(result.stateStatus, ack.ok === false ? 'rejected' : 'unavailable'); assert.equal(f.calls.length, 1);
  }
});
