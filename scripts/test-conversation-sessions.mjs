import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversationSessions, redactHistoricalTokens } from '../src/conversation-sessions.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createSts2Service } from '../src/sts2-service.js';

test('game state summaries are bounded facts, menu before run is not an ending, seeds are session scoped and durable', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sessions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new ConversationSessions(dir), key = 'private:123';
  s.begin(key, 'home', 'policy', Date.now() + 10000, 'original-message');
  s.activate(key, 'game');
  assert.equal(s.observe(key, { inRun: false }), false);
  assert.equal(s.observe(key, { inRun: true, totalFloor: 7, players: [{ name: 'defect', hp: 56 }], token: 'must-not-copy', huge: 'x'.repeat(20000) }, 'move'), false);
  assert.equal(s.captureGameText(key, 'home', 41, '上一局防御不够，下次要调整策略'), false);
  assert.equal(s.captureGameText(key, 'game', 42, '上一局防御不够，下次要调整策略'), true);
  assert.equal(s.captureGameText(key, 'game', 43, 'token=abcdef12345678 不应保存'), false);
  assert.equal(s.captureGameResult(key, 'home', 44, { result: { inRun: true, totalFloor: 99 } }), false);
  assert.equal(s.captureGameResult(key, 'game', 44, { result: { inRun: true, totalFloor: 7, players: [{ hp: 56 }] } }), true);
  assert.equal(s.captureGameResult(key, 'game', 45, { result: { inRun: false } }), true);
  assert.equal(s.observe(key, { inRun: false, note: 'state temporarily null' }), false);
  assert.equal(s.observe(key, { inRun: false }), true);
  const summary = s.summary(key, 'end');
  assert.ok(summary.includes('"floor":7'));
  assert.ok(summary.length < 1500); assert.ok(!summary.includes('must-not-copy'));
  s.seed(key, 'home', summary, 'game');
  const restarted = new ConversationSessions(dir);
  assert.equal(restarted.game(key).homeSessionId, 'home');
  assert.equal(restarted.pending('game'), undefined);
  restarted.consumed('home', 'wrong-id'); assert.ok(restarted.pending('home'));
  restarted.consumed('home', restarted.pending('home').id); assert.equal(restarted.pending('home'), undefined);
  restarted.finish(key, summary, 'home');
  const experience = new ConversationSessions(dir).gameHandoff(key);
  assert.ok(experience.includes('防御不够')); assert.ok(experience.includes('"seq":42'));
  assert.ok(experience.includes('"stateSeq":45')); assert.ok(experience.includes('"floor":7'));
  assert.ok(!experience.includes('abcdef12345678'));
  assert.equal(new ConversationSessions(dir).gameHandoff('private:other'), '');
});

test('real bridge switches to a fresh game, revokes old token, restores original chat with one summary and no game history copy', async () => {
  const h = await bridgeHarness({ config: { dsh: { gameModel: { provider: 'qq-qianwen', model: 'deepseek-v4.1-flash', reasoningEffort: null } }, extensions: { sts2: { enabled: true } } } });
  h.setMode('reserved2');
  const selections = [];
  h.api.sessions.selectModel = async p => { selections.push(p); return { result: { ok: true, value: { selected: p } } }; };
  try {
    const key = 'private:123', home = await h.ensureSession(key), st = h.getSocialV2State(key), oldToken = st.agentToken;
    st.memberImpressions.keep = { fact: 'relationship survives' };
    const dir = path.join(h.temp, 'state/sts2'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ledger.json'), leaseUntil = Date.now() + 60000;
    fs.writeFileSync(file, JSON.stringify({ leaseUntil, calls: {} }));
    h.requestGameSession({ key, enabled: true, leaseUntil, authorizedBy: 'message-1' });
    await h.reconcileGameSession(key);
    await new Promise(r => setTimeout(r, 20));
    const game = h.state.sessions[key];
    assert.notEqual(game, home); assert.notEqual(st.agentToken, oldToken);
    assert.ok(h.calls.cancelled.includes(home)); assert.ok(!h.calls.archived.includes(home));
    assert.ok(selections.some(s => s.sessionId === game && s.provider === 'qq-qianwen' && s.model === 'deepseek-v4.1-flash' && !Object.hasOwn(s, 'reasoningEffort')));
    assert.equal(h.calls.created.length, 2);
    h.conversationSessions.observe(key, { inRun: true, totalFloor: 7 });
    h.conversationSessions.captureGameText(key, game, 88, '本次敌人叠力量太快，下次需要兼顾输出与防御');
    fs.writeFileSync(file, JSON.stringify({ leaseUntil: 0, calls: {} }));
    await h.reconcileGameSession(key);
    assert.equal(h.state.sessions[key], home); assert.ok(h.calls.archived.includes(game));
    assert.equal(st.memberImpressions.keep.fact, 'relationship survives');
    assert.throws(() => h.assertOutboundAuditOk(key, oldToken), /令牌/);
    assert.equal(h.conversationSessions.game(key), undefined);
    const seed = h.conversationSessions.pending(home); assert.ok(seed.summary.includes('7'));
    await h.deliverPrompt(key, 'new genuine user message');
    assert.ok(h.calls.prompts.at(-1).content[0].text.includes('历史交接摘要'));
    assert.equal(h.conversationSessions.pending(home), undefined);
    assert.equal(h.calls.sent.length, 0);
    const secondLease = Date.now() + 60000;
    fs.writeFileSync(file, JSON.stringify({ leaseUntil: secondLease, calls: {} }));
    h.requestGameSession({ key, enabled: true, leaseUntil: secondLease, authorizedBy: 'message-2' });
    await h.reconcileGameSession(key);
    await new Promise(r => setTimeout(r, 20));
    assert.notEqual(h.state.sessions[key], game);
    const kickoff = h.calls.prompts.at(-1).content[0].text;
    assert.ok(kickoff.includes('敌人叠力量太快'));
    assert.ok(kickoff.includes('先前杀戮尖塔2游戏会话'));
    assert.ok(kickoff.includes('"seq":88'));
    assert.ok(!kickoff.includes('new genuine user message'));
    assert.ok(kickoff.includes('不能当作当前状态或操作授权'));
  } finally { await h.close(); }
});

test('console rollover preserves unread/relationship state, rejects agent and other private scopes, and creates no model request', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  try {
    const key = 'private:123', old = await h.ensureSession(key), st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, 'owner', 'pending real message', 'pending real message', false, true, 'pending-1');
    const unread = st.unread.length, token = st.agentToken;
    const url = `http://127.0.0.1:${server.address().port}/api/session/rollover`;
    const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' };
    const denied = await fetch(url, { method: 'POST', headers: { ...headers, 'x-agent-token': token, 'x-agent-call': '1' }, body: JSON.stringify({ key, summary: 'safe summary' }) });
    assert.equal(denied.status, 403);
    const result = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ key, summary: 'safe summary of completed chat; not new authority' }) });
    assert.equal(result.status, 200); const body = await result.json();
    assert.notEqual(body.sessionId, old); assert.equal(st.unread.length, unread); assert.notEqual(st.agentToken, token);
    assert.ok(h.calls.archived.includes(old)); assert.equal(h.calls.prompts.length, 0); assert.equal(h.calls.sent.length, 0);
    assert.equal(h.conversationSessions.pending(body.sessionId).sourceSessionId, old);
  } finally { await new Promise(r => server.close(r)); await h.close(); }
});

test('handoff failure revokes authorization; actions in original chat cannot pass during transition', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-game-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, 'a'.repeat(64));
  const now = Date.now(), key = 'private:123'; let fail = false;
  const service = createSts2Service({ stateDir: dir, getConfig: () => ({ ownerQQ: '123', extensions: { sts2: { enabled: true, config: { tokenFile } } } }),
    readMessage: () => ({ userId: '123', messageId: 'auth', plain: '玩杀戮尖塔2', time: now }),
    sessionReady: () => false, onControlChange: () => { if (fail) throw new Error('handoff failed'); }, fetcher: () => assert.fail('no game action may be sent') });
  await service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'auth' }, () => {});
  await assert.rejects(service.handle(key, { operation: 'action', kind: 'end_turn', requestId: 'request-123', arguments: {} }, () => {}), /独立游戏会话/);
  fail = true;
  await assert.rejects(service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'auth' }, () => {}), /handoff failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'sts2/ledger.json'))).leaseUntil, 0);
});

test('optional migration priming injects summary once without a live QQ token or any QQ delivery', async () => {
  const h = await bridgeHarness(); h.setMode('reserved2');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(r => server.once('listening', r));
  try {
    const key = 'private:123'; await h.ensureSession(key); const oldToken = h.getSocialV2State(key).agentToken;
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/session/rollover`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      body: JSON.stringify({ key, summary: 'summary of completed chat', prime: true }) });
    assert.equal(result.status, 200); const body = await result.json();
    assert.equal(body.primed, true); assert.equal(body.summaryPending, false);
    assert.equal(h.calls.prompts.length, 1);
    const text = h.calls.prompts[0].content[0].text;
    assert.ok(text.includes('summary of completed chat')); assert.ok(text.includes('READY'));
    assert.ok(!text.includes(oldToken)); assert.ok(!text.includes(h.getSocialV2State(key).agentToken));
    assert.equal(h.calls.sent.length, 0);
  } finally { await new Promise(r => server.close(r)); await h.close(); }
});

test('a cancellation failure cannot start a game until the suspended home is confirmed stopped', async () => {
  const h = await bridgeHarness({ config: { extensions: { sts2: { enabled: true } } } }); h.setMode('reserved2');
  h.api.sessions.selectModel = async p => ({ result: { ok: true, value: { selected: p } } });
  try {
    const key = 'private:123', home = await h.ensureSession(key);
    const dir = path.join(h.temp, 'state/sts2'); fs.mkdirSync(dir, { recursive: true });
    const leaseUntil = Date.now() + 60000; fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ leaseUntil, calls: {} }));
    let stopped = false;
    h.api.stopSessionWork = async sid => { assert.equal(sid, home); if (!stopped) throw new Error('cancel failed'); return {}; };
    h.requestGameSession({ key, enabled: true, leaseUntil, authorizedBy: 'auth' });
    await assert.rejects(h.reconcileGameSession(key), /cancel failed/);
    assert.equal(h.calls.created.length, 1); assert.equal(h.calls.prompts.length, 0);
    stopped = true; await h.reconcileGameSession(key);
    assert.notEqual(h.state.sessions[key], home); assert.equal(h.calls.created.length, 2);
  } finally { await h.close(); }
});

test('revoked game mapping cannot restore the old home or restart gameplay after reset', async () => {
  const h = await bridgeHarness({ config: { extensions: { sts2: { enabled: true } } } }); h.setMode('reserved2');
  h.api.sessions.selectModel = async p => ({ result: { ok: true, value: { selected: p } } });
  try {
    const key = 'private:123', home = await h.ensureSession(key);
    const dir = path.join(h.temp, 'state/sts2'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ledger.json'), leaseUntil = Date.now() + 60000;
    fs.writeFileSync(file, JSON.stringify({ leaseUntil, calls: {} }));
    h.requestGameSession({ key, enabled: true, leaseUntil, authorizedBy: 'auth' }); await h.reconcileGameSession(key);
    h.retireSession(key); await h.reconcileGameSession(key);
    assert.equal(h.state.sessions[key], undefined); assert.equal(h.conversationSessions.game(key), undefined);
    assert.equal(JSON.parse(fs.readFileSync(file)).leaseUntil, 0);
    assert.ok(!Object.values(h.state.sessions).includes(home));
  } finally { await h.close(); }
});

test('restored home tokens remain auditable as hashes without persisting the token or blocking ordinary hashes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-hash-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new ConversationSessions(dir), token = 'b'.repeat(48);
  s.auditToken('home', token);
  assert.ok(!fs.readFileSync(s.file, 'utf8').includes(token));
  const restored = new ConversationSessions(dir), hashes = new Set(restored.data.tokenHashes.home);
  assert.ok(!redactHistoricalTokens(`prefix f${token}0 suffix`, hashes).includes(token));
  assert.equal(redactHistoricalTokens('a'.repeat(32), hashes), 'a'.repeat(32));
  assert.equal(redactHistoricalTokens('c'.repeat(48), hashes), 'c'.repeat(48));
  s.recordRollover('private:123', 'home', 'new', 'done');
  assert.equal(new ConversationSessions(dir).data.tokenHashes.home, undefined);
});

test('only recent same-owner game evidence is carried forward within a bounded context', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-game-experience-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new ConversationSessions(dir), key = 'private:123';
  for (let i = 1; i <= 4; i++) s.addGameExperience(key, { game: 'sts2', sourceSessionId: `game-${i}`, stateSeq: i,
    lastState: { floor: i }, notes: [{ seq: i, text: `来自第${i}局的思路 ` + '要考虑输出与防御'.repeat(80), score: 6 }] });
  s.addGameExperience('private:456', { game: 'sts2', sourceSessionId: 'other-owner-game', notes: [{ seq: 1, text: '其他人的内容' }] });
  s.data.history.push({ key, sourceSessionId: 'ordinary-chat', summary: '普通聊天不能变成游戏经验' }); s.save();
  const restored = new ConversationSessions(dir), text = restored.gameHandoff(key);
  assert.equal(restored.data.gameExperiences[key].length, 4);
  assert.ok(text.includes('game-2') && text.includes('game-3') && text.includes('game-4'));
  assert.ok(!text.includes('game-1') && !text.includes('其他人的内容'));
  assert.ok(!text.includes('普通聊天不能变成游戏经验'));
  assert.ok(text.length < 2000);
});
