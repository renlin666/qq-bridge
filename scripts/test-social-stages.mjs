import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSocialMemory, createWhitelistPolicy } from '../lib/social-memory/src/index.js';
import { createSocialPolicy, explicitPreference } from '../extensions/social-memory/social-policy.js';
import { createIntegrations } from '../src/project-integrations.js';
import { parseSocialEvents } from '../src/social-event-metadata.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const day = 86400000;
const context = { botAccountId: '10001', actor: { userId: '123' }, conversation: { kind: 'private' } };
const policy = () => createWhitelistPolicy({ bots: { '10001': { people: ['123'], groups: ['456'] } } });
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stage-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('五阶段需要多维度、来源和跨日证据；重启不把新关系误当旧高分迁移', t => {
  const dir = temp(t), dbPath = path.join(dir, 'memory.db');
  let time = Date.UTC(2026, 0, 1);
  const options = { dbPath, policy: policy(), relationshipStages: true, clock: () => time,
    config: { relationship: { initial: { closeness: 90, familiarity: 90, trust: 90, boundary: 90 },
      decay: { familiarityPerDay: 0, closenessPerDay: 0 } } } };
  let service = createSocialMemory(options);
  try {
    assert.equal(service.getRelationship(context).relationship.tier, '初识');
    service.close(); service = createSocialMemory(options);
    assert.equal(service.getRelationship(context).relationship.tier, '初识');
    for (let i = 0; i < 40; i++) {
      time += day;
      const result = service.recordInteraction(context, { kind: ['support','shared_activity','deep_talk'][i % 3], sourceMessageId: `fixture-${i}`, evidence: '虚构验证事件' });
      assert.equal(result.applied, true);
      if (i === 0) assert.equal(result.relationship.tier, '认识');
      if (i === 4) assert.equal(result.relationship.tier, '熟络');
      if (i === 14) assert.equal(result.relationship.tier, '亲近');
      if (i === 39) assert.equal(result.relationship.tier, '深交');
    }
  } finally { service.close(); }
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE relationships SET trust=74').run(); db.close();
  service = createSocialMemory(options);
  assert.equal(service.getRelationship(context).relationship.tier, '深交', '3点迟滞保留临界附近阶段'); service.close();
  const changed = new DatabaseSync(dbPath); changed.prepare('UPDATE relationships SET trust=70').run(); changed.close();
  service = createSocialMemory(options);
  assert.equal(service.getRelationship(context).relationship.tier, '亲近'); service.close();
});

test('旧阶段迁移保留维度和事件；旧戒备独立标记，旧版本仍可打开数据库', t => {
  const dir = temp(t), dbPath = path.join(dir, 'memory.db');
  let service = createSocialMemory({ dbPath, policy: policy(), config: { relationship: { initial: { closeness: 90, familiarity: 90, trust: 90, boundary: 90 } } } });
  const before = service.getRelationship(context).relationship;
  service.close();
  service = createSocialMemory({ dbPath, policy: policy(), relationshipStages: true });
  const migrated = service.getRelationship(context).relationship;
  assert.equal(migrated.tier, '深交'); assert.deepEqual(migrated.dimensions, before.dimensions); service.close();
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE relationship_stage_origins SET legacy_tier='戒备'").run(); db.close();
  service = createSocialMemory({ dbPath, policy: policy(), relationshipStages: true });
  assert.equal(service.getRelationship(context).relationship.legacyCaution, true); service.close();
  service = createSocialMemory({ dbPath, policy: policy() });
  assert.deepEqual(service.getRelationship(context).relationship.dimensions, before.dimensions); service.close();
});

test('偏好确认、推测、叫停、未解隔阂与和解持久且按人/会话隔离；去重永久保留', t => {
  const dir = temp(t), filename = path.join(dir, 'policy.db'); let time = 1000;
  let state = createSocialPolicy(filename, () => time);
  const args = ['10001', 'group:456', '123'];
  const attitude = { stage: '亲近', style: '亲切' };
  const view = () => state.compile(...args, attitude, null).attitude;
  assert.equal(view().banter, 'unknown');
  assert.equal(explicitPreference('他说“我喜欢互损”'), null);
  for (const text of ['我喜欢互损吗？','我喜欢互损才怪','如果我喜欢互损呢','我喜欢互损，但是今天不行']) assert.equal(explicitPreference(text), null);
  assert.throws(() => state.record(...args, 'fake', 'banter_preference', { preference: 'mutual', text: '他说我喜欢互损' }), /本人明确/);
  for (let i = 0; i < 3; i++) state.record(...args, `joke-${i}`, 'banter');
  assert.equal(view().banter, 'light'); assert.equal(view().preferenceConfirmed, false);
  state.record(...args, 'yes', 'banter_preference', { preference: 'mutual', text: '我可以接受互损' });
  assert.equal(view().banter, 'mutual'); assert.equal(view().preferenceConfirmed, true);
  state.record(...args, 'stop', 'banter_preference', { preference: 'stop', text: '别再拿我开玩笑了' });
  assert.equal(view().banter, 'stop'); assert.match(view().guidance, /停止/);
  assert.equal(state.compile('10001','private:123','123',attitude,null).attitude.banter, 'unknown');
  assert.equal(state.compile('10001','group:456','789',attitude,null).attitude.banter, 'unknown');
  state.record(...args, 'fight', 'boundary_violation');
  assert.equal(view().conflict, 'distant');
  time += 90 * day; state.close(); state = createSocialPolicy(filename, () => time);
  assert.equal(view().conflict, 'distant'); assert.equal(view().banter, 'stop');
  state.record(...args, 'sorry', 'repair'); assert.equal(view().conflict, 'repairing');
  assert.throws(() => state.record(...args, 'not-sorry', 'resolve_conflict', { text: '普通闲聊' }), /明确/);
  state.record(...args, 'peace', 'resolve_conflict', { text: '这事翻篇了' });
  assert.equal(view().conflict, undefined); assert.equal(view().banter, 'stop');
  assert.equal(state.record(...args, 'yes', 'banter_preference', { preference: 'mutual', text: '我可以接受互损' }).duplicate, true);
  assert.equal(view().banter, 'stop'); state.close();
});

test('旧消息不能解除新冲突或覆盖更新的叫停偏好', t => {
  const state = createSocialPolicy(path.join(temp(t), 'policy.db'));
  const args = ['bot','group:456','123'];
  state.record(...args,'new-conflict','conflict', { sourceAt: 200 });
  assert.equal(state.record(...args,'old-peace','resolve_conflict', { text: '没关系', sourceAt: 100 }).reason, 'stale_source');
  state.record(...args,'new-stop','banter_preference', { text: '别拿我开玩笑', preference: 'stop', sourceAt: 200 });
  assert.equal(state.record(...args,'old-permission','banter_preference', { text: '我喜欢互损', preference: 'mutual', sourceAt: 100 }).reason, 'stale_source');
  const view = state.compile(...args,{stage:'深交'},null).attitude;
  assert.equal(view.banter, 'stop'); assert.equal(view.conflict, 'guarded'); state.close();
});

test('事件元数据不能携带伪身份/分数、空证据或超限批次', () => {
  const event = { messageId: 'x', kind: 'support', evidence: '谢谢' };
  assert.deepEqual(parseSocialEvents(undefined), []);
  for (const value of [[{ ...event, userId: '789' }], [{ ...event, delta: 100 }], [{ ...event, evidence: '' }], Array(4).fill(event), [{ ...event, preference: 'mutual' }]]) {
    assert.throws(() => parseSocialEvents(value), /格式无效/);
  }
});

test('真实入线的明确叫停立即覆盖高档位，转认真压住玩闹；道歉不恢复信任', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stage-incoming-'));
  const message = { messageId: 'stop', botAccountId: '10001', userId: '123', sender: 'fixture', plain: '别再拿我开玩笑了' };
  const cfg = { allow: { private: ['123'], groups: ['456'] }, extensions: { 'social-memory': { enabled: true, config: { minimumTiers: { '123': '深交' } } } } };
  const f = createIntegrations({ stateDir: dir, getConfig: () => cfg, getConversation: () => ({ recentMessages: [message] }), sessionAllowed: () => true, tokenOk: () => true });
  t.after(async () => { await f.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const scope = { key: 'group:456', assertAuthorized() {} };
  await f.host.dispatchMessage(message, scope);
  const pack = () => f.contextFor(scope.key);
  assert.match(await pack(), /"stage":"深交"/); assert.match(await pack(), /"banter":"stop"/);
  const call = async (kind, plain) => {
    message.messageId = kind; message.plain = plain;
    return JSON.parse((await f.host.callTool('qq_social_relationship_event', { messageId: kind, kind, evidence: plain }, scope)).content[0].text);
  };
  const conflict = await call('conflict', '这件事确实让我生气');
  const trust = conflict.relationship.dimensions.trust;
  await call('repair', '刚才是我不对，对不起');
  assert.match(await pack(), /"conflict":"repairing"/);
  const db = new DatabaseSync(path.join(dir, 'extensions/social-memory/memory.db'), { readOnly: true });
  assert.equal(db.prepare('SELECT trust FROM relationships').get().trust, trust); db.close();
  await call('banter', '换个梗继续玩吧');
  assert.doesNotMatch(await pack(), /"reaction":\{"kind":"banter"/);
  assert.doesNotMatch(await f.contextFor('private:123'), /"banter":"stop"|"conflict"/);
});

async function realBridge(t, globals = {}, cfg = {}) {
  let integration;
  const h = await bridgeHarness({ config: { extensions: { 'social-memory': { enabled: true } }, socialV2: { send: { gapMinMs: 0, gapMaxMs: 0 } }, ...cfg },
    globals: { createIntegrations: options => integration = createIntegrations({ ...options, localRoot: path.join(options.stateDir, 'extensions-local') }), ...globals } });
  h.setMode('reserved2'); h.setSelfIdentity('fixture','10001');
  const key = 'group:456', st = h.getSocialV2State(key), token = st.agentToken;
  h.appendSocialV2Message(key, 'fixture', '我来帮你解决这件事', '我来帮你解决这件事', false, false, 'source-1', [], '123', [], false, '10001');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  let db;
  t.after(async () => { db?.close(); await new Promise(resolve => server.close(resolve)); await h.close(); });
  await integration.ready;
  db = new DatabaseSync(path.join(h.temp, 'state/extensions/social-memory/memory.db'), { readOnly: true });
  const post = async (body = {}, actualToken = token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-call': '1', 'x-agent-token': actualToken },
      body: JSON.stringify({ key, messages: '谢谢，接着说', socialEvents: [], ...body }) });
    return { status: res.status, data: await res.json() };
  };
  return { h, post, db, integration, st };
}
const support = { messageId: 'source-1', kind: 'support', evidence: '我来帮你解决这件事' };

test('真实发送API把附带事件写入关系库、返回回执，补记去重，中性回复不评分', async t => {
  const f = await realBridge(t);
  const count = () => f.db.prepare('SELECT COUNT(*) AS n FROM interaction_events').get().n;
  assert.equal((await f.post()).data.socialEventReceipts.length, 0); assert.equal(count(), 0);
  const sourceAt = Date.now() - 2 * day;
  f.st.recentMessages.find(message => message.messageId === 'source-1').time = sourceAt;
  const result = await f.post({ socialEvents: [support] });
  assert.equal(result.status, 200); assert.equal(result.data.socialEventReceipts[0].status, 'applied'); assert.equal(count(), 1);
  assert.equal(f.db.prepare('SELECT occurred_at FROM interaction_events').get().occurred_at, sourceAt);
  assert.equal((await f.post({ socialEvents: [support] })).data.socialEventReceipts[0].status, 'duplicate'); assert.equal(count(), 1);
  const sent = f.h.calls.http.length;
  assert.equal((await f.post({ socialEvents: [{ ...support, delta: 100 }] })).status, 400);
  assert.equal((await f.post({}, 'bad-token')).status, 403); assert.equal(f.h.calls.http.length, sent);
  assert.equal(f.h.calls.prompts.length, 0);
  assert.ok(f.h.calls.http.every(c => !JSON.stringify(c.body).includes('socialEvents')));
});

test('伪造证据、跨会话来源及禁用插件被拒绝，但不把已发QQ误报为失败', async t => {
  const f = await realBridge(t);
  for (const event of [{ ...support, evidence: '编造证据' }, { ...support, messageId: 'other-scope' }]) {
    const result = await f.post({ socialEvents: [event] });
    assert.equal(result.data.ok, true); assert.equal(result.data.socialEventReceipts[0].status, 'rejected');
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM interaction_events').get().n, 0);
  f.h.cfg.extensions['social-memory'].enabled = false;
  const disabled = await f.post({ socialEvents: [support] });
  assert.equal(disabled.data.ok, true); assert.equal(disabled.data.socialEventReceipts[0].status, 'rejected');
});

test('无消息编号的回执不能写入关系；完整失败与部分失败均跳过附带事件', async t => {
  for (const mode of ['unknown', 'failed', 'partial']) {
    let sends = 0;
    await t.test(mode, async sub => {
      const f = await realBridge(sub, { fetch: async () => {
        sends++;
        return { ok: true, status: 200, json: async () => mode === 'failed' || (mode === 'partial' && sends === 2)
          ? { status: 'failed', retcode: 1 } : { status: 'ok', retcode: 0, data: mode === 'unknown' ? {} : { message_id: sends } } };
      } });
      const result = await f.post({ messages: mode === 'partial' ? ['一条','二条'] : '一条', gapMode: 'fixed', gapMs: 0, gaps: [0], socialEvents: [support] });
      assert.equal(result.data.socialEventReceipts[0].status, 'skipped');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM interaction_events').get().n, 0);
    });
  }
});

test('出站等待期间令牌轮换后，不能写入附带关系事件', async t => {
  let bridge;
  const f = await realBridge(t, { fetch: async () => {
    bridge.getSocialV2State('group:456').agentToken = 'rotated';
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
  } });
  bridge = f.h;
  const result = await f.post({ socialEvents: [support] });
  assert.equal(result.data.socialEventReceipts[0].status, 'rejected');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM interaction_events').get().n, 0);
});
