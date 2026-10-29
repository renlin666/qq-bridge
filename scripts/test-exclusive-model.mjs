import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { webSearch } from '../src/web-search.js';

const config = { dsh: { provider: 'fixture-platform', model: 'fixture-1017', exclusiveModel: true, reasoningEffort: null } };

for (const effort of ['off', 'medium']) test(`Ark ${effort} survives bridge startup and session reuse`, async () => {
  const h = await bridgeHarness({ config: { dsh: {
    provider: 'qq-ark', model: 'deepseek-v4.1-flash', exclusiveModel: true,
    allowedModels: ['deepseek-v4.1-flash'], reasoningEffort: effort
  } } });
  const selections = [];
  h.api.sessions.selectModel = async params => {
    selections.push(params);
    if (params.reasoningEffort !== effort) throw new Error('unsupported reasoning effort');
    return { result: { ok: true, value: { selected: { ...params } } } };
  };
  try {
    const id = await h.ensureSession('private:123');
    assert.equal(await h.ensureSession('private:123'), id);
    assert.equal(selections.length, 2);
    assert.ok(selections.every(s => s.provider === 'qq-ark' && s.reasoningEffort === effort));
  } finally { await h.close(); }
});
test('exclusive route is reasserted on reuse and omits unsupported reasoning effort', async () => {
  const h = await bridgeHarness({ config });
  const selections = [];
  h.api.sessions.selectModel = async params => {
    selections.push(params);
    return { result: { ok: true, value: { selected: { provider: params.provider, model: params.model } } } };
  };
  try {
    const first = await h.ensureSession('group:456');
    assert.equal(await h.ensureSession('group:456'), first);
    assert.equal(selections.length, 2);
    assert.ok(selections.every(s => s.provider === 'fixture-platform' && s.model === 'fixture-1017' && !Object.hasOwn(s, 'reasoningEffort')));
  } finally { await h.close(); }
});
test('exclusive route rejects a provider/model substituted by DSH', async () => {
  const h = await bridgeHarness({ config });
  try {
    // The ordinary harness deliberately returns fixture/fixture, representing
    // an old selection that must not be accepted under the exclusive policy.
    await assert.rejects(h.ensureSession('group:456'), /禁止回退/);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});
test('model-not-found cannot be mistaken for a missing session and fall back', async () => {
  const h = await bridgeHarness({ config });
  h.api.sessions.selectModel = async () => { throw new Error('model not-found'); };
  try {
    await assert.rejects(h.ensureSession('group:456'), /禁止回退/);
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(h.calls.created.length, 1);
  } finally { await h.close(); }
});
test('cached slang learner is also pinned before every use', async () => {
  const h = await bridgeHarness({ config });
  let selections = 0;
  h.api.sessions.selectModel = async params => {
    selections++;
    return { result: { ok: true, value: { selected: { provider: params.provider, model: params.model } } } };
  };
  try {
    const sid = await h.ensureSlangLearnerSession();
    assert.equal(await h.ensureSlangLearnerSession(), sid);
    assert.equal(selections, 2);
  } finally { await h.close(); }
});
test('disabled search refuses both native search and explicit Bing override', async () => {
  const h = await bridgeHarness({ config: { webSearch: { enabled: false } } });
  try {
    await assert.rejects(webSearch('fixture', { root: h.temp }), /联网搜索已关闭/);
    await assert.rejects(webSearch('fixture', { root: h.temp, provider: 'bing' }), /联网搜索已关闭/);
  } finally { await h.close(); }
});

test('unavailable preferred selection falls back only to another allowed Flash', async () => {
  const models = ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash', 'gpt-forbidden'];
  const h = await bridgeHarness({ config: { dsh: { provider: 'qq-qianwen', model: models[0], allowedModels: models, exclusiveModel: true, reasoningEffort: null } } });
  const calls = [];
  h.api.sessions.selectModel = async params => {
    calls.push(params);
    if (params.model === models[0]) throw new Error('model unavailable');
    return { result: { ok: true, value: { selected: { provider: params.provider, model: params.model } } } };
  };
  try {
    await h.ensureSession('group:456');
    assert.deepEqual(calls.map(x => x.model), [models[0], models[0], models[1]]);
    assert.ok(calls.every(x => x.provider === 'qq-qianwen'));
  } finally { await h.close(); }
});

test('per-conversation model override is preserved across reuse without affecting other sessions', async () => {
  const h = await bridgeHarness({ config: { dsh: { provider: 'qq-ark', model: 'deepseek-v4.1-flash', exclusiveModel: true,
    allowedModels: ['deepseek-v4.1-flash'], reasoningEffort: 'high',
    sessionModelOverrides: { 'private:123': { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' } } } } });
  const selections = [];
  h.api.sessions.selectModel = async params => { selections.push(params); return { result: { ok: true, value: { selected: { ...params } } } }; };
  try {
    const own = await h.ensureSession('private:123');
    assert.equal(await h.ensureSession('private:123'), own);
    await h.ensureSession('group:456');
    assert.deepEqual(selections.map(({provider,model,reasoningEffort}) => ({provider,model,reasoningEffort})), [
      {provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'low'},
      {provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'low'},
      {provider:'qq-ark',model:'deepseek-v4.1-flash',reasoningEffort:'high'}]);
  } finally { await h.close(); }
});

test('per-conversation model refuses provider substitution even when global mode is not exclusive', async () => {
  const h = await bridgeHarness({ config: { dsh: { exclusiveModel: false,
    sessionModelOverrides: { 'private:123': { provider:'deepseek-official',model:'deepseek-flash' } } } } });
  h.api.sessions.selectModel = async () => ({ result: { ok: true, value: { selected: { provider:'qq-ark',model:'deepseek-v4.1-flash' } } } });
  try { await assert.rejects(h.ensureSession('private:123'), /禁止回退/); }
  finally { await h.close(); }
});
