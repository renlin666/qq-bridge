import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compactionEconomics, recentInputUsage } from '../src/context-compaction-cost.js';
import { createCostAwareEngine } from '../plugins/qq-agent-presets/qq-cost-aware-compaction.mjs';
import { apply as compressionTools } from '../plugins/qq-agent-presets/qq-context-compression.mjs';

const target = { provider: 'qq-chream-primary', model: 'deepseek-v4.1-flash' };
const now = Date.parse('2026-10-27T12:00:00Z'); // Off-peak, deterministic.
const observed = ratio => ({ samples: 3, cacheHitRatio: ratio, cacheWriteRatio: 0,
  inputTokens: 300000, buckets: { cacheHit: 300000 * ratio, cacheMiss: 300000 * (1 - ratio), cacheWrite: 0 }, checkpointSeq: -1 });
const evaluate = (ratio, extra = {}) => compactionEconomics({ totalTokens: 100000, selectedTokens: 60000,
  summaryTokens: 1200, usage: observed(ratio), target, now, ...extra });

test('low-cache history pays back, warm history defers the same manual rewrite', () => {
  assert.equal(evaluate(0).worthwhile, true);
  const warm = evaluate(.98);
  assert.equal(warm.worthwhile, false);
  assert.equal(warm.reason, 'not-paid-back-within-horizon');
  assert.ok(warm.breakEvenRequests > 8);
});
test('manual continuation and auto summary/cache rebuilding are all charged exactly once', () => {
  const manual = evaluate(.5), auto = evaluate(.5, { mode: 'automatic', prefixTokens: 65000 });
  assert.equal(manual.components.summaryInputCny, 0);
  assert.equal(manual.components.cacheRebuildCny, 0);
  assert.ok(manual.components.continuationCny > 0);
  assert.equal(auto.components.continuationCny, 0);
  assert.ok(auto.components.cacheRebuildCny > 0);
  assert.equal(auto.upfrontCny, Object.values(auto.components).reduce((a, b) => a + b, 0));
  assert.equal(auto.components.summaryInputCny, 66500 * .51 / 1e6);
});
test('a large retained prefix can make compression more expensive than leaving history cached', () => {
  assert.equal(evaluate(.9, { totalTokens: 500000, selectedTokens: 8000 }).worthwhile, false);
  assert.equal(evaluate(0, { selectedTokens: 6000, summaryTokens: 8192 }).reason, 'too-little-history');
});
test('unknown usage, unsupported models and cooldown cannot manufacture a saving', () => {
  assert.equal(evaluate(0, { usage: observed(0), target: { ...target, model: 'unknown' } }).reason, 'unknown-reference-model');
  assert.equal(evaluate(0, { usage: undefined }).reason, 'insufficient-usage');
  assert.equal(evaluate(0, { usage: { ...observed(0), checkpointSeq: 4, callsSinceCompaction: 3 } }).reason, 'cooldown');
  assert.equal(evaluate(0, { usage: { ...observed(0), checkpointSeq: 4, callsSinceCompaction: 4 } }).worthwhile, true);
});
test('peak price doubles amounts without inventing a different break-even', () => {
  const off = evaluate(.5), peak = evaluate(.5, { now: Date.parse('2026-10-27T02:00:00Z') });
  assert.equal(peak.upfrontCny, off.upfrontCny * 2);
  assert.equal(peak.breakEvenRequests, off.breakEvenRequests);
});

function fixture(ratio = 0) {
  const events = [], surface = [];
  const append = (type, data, visible = false) => {
    const seq = events.length; events.push({ seq, type, data }); if (visible) surface.push(seq);
  };
  append('request/header', { header: { config: target } });
  append('system/message', {}, true);
  for (let i = 0; i < 32; i++) append('user/message', {}, true);
  for (let step = 0; step < 3; step++) append('assistant/message', { turn: 0, step,
    usage: { inputTokens: (1 - ratio) * 100000, cacheReadTokens: ratio * 100000, outputTokens: 10 } });
  const session = { get seq() { return events.length; }, eventAt: seq => events[seq], surface: { nodes: surface }, requestHeader: () => ({ config: target }) };
  const meter = { measure: () => ({ totalTokens: 100000, nodes: surface.map(seq => ({ seq, tokens: seq === 1 ? 4000 : 3000 })) }), estimateMessage: () => 1000 };
  return { session, events, append, meter, agent: { session, options: target } };
}
test('durable usage handles restart, disjoint cache buckets and duplicate step observations', () => {
  const f = fixture(.8);
  f.append('assistant/attempt', { turn: 0, step: 2, stream: [{ type: 'usage', usage: { inputTokens: 20000, cacheReadTokens: 80000 } }] });
  const usage = recentInputUsage(f.session, target);
  assert.equal(usage.samples, 3); assert.equal(usage.inputTokens, 300000); assert.equal(usage.cacheHitRatio, .8);
  assert.equal(recentInputUsage(f.session, target), usage);
  const restarted = { ...f.session, seq: f.session.seq };
  assert.deepEqual(recentInputUsage(restarted, target), usage);
});
test('switching routes never borrows old samples; omitted DSH cache bucket means zero cache reads', () => {
  const f = fixture(0);
  f.append('request/header', { header: { config: { ...target, provider: 'qq-deepseek-official' } } });
  f.append('assistant/message', { turn: 1, step: 0, usage: { inputTokens: 5000, cacheReadTokens: 0 } });
  assert.equal(recentInputUsage(f.session, { ...target, provider: 'qq-deepseek-official' }).samples, 1);
  f.append('request/header', { header: { config: target } });
  f.append('assistant/message', { turn: 2, step: 0, usage: { inputTokens: 5000 } });
  const usage = recentInputUsage(f.session, target);
  assert.equal(usage.samples, 1); assert.equal(usage.cacheHitRatio, 0);
});
test('checkpoint cooldown counts only normal requests after the checkpoint', () => {
  const f = fixture(0); f.append('compaction/summary', {});
  assert.equal(recentInputUsage(f.session, target).callsSinceCompaction, 0);
  f.append('assistant/message', { turn: 1, step: 0, usage: { inputTokens: 5000, cacheReadTokens: 0 } });
  assert.equal(recentInputUsage(f.session, target).callsSinceCompaction, 1);
});

class NativeFixture {
  constructor(ctx, config) { this.ctx = ctx; this.config = { modelPolicies: [], retainTokens: 8192, maxTokens: 8192, ...config }; }
  async compactIfNeeded(_agent, trigger) { this.nativeTrigger = trigger; return 'native-recovery'; }
  async compactRegion(start, end) { this.range = { start, end }; if (this.fail) throw new Error('summary failed'); return this.range; }
}
function engineFixture(ratio = 0, balanced = () => true) {
  const f = fixture(ratio), Engine = createCostAwareEngine(NativeFixture, balanced);
  const ctx = { tokenMeter: f.meter, llm: { resolveModelInfo: async () => ({ context: { contextWindow: 200000 }, defaultMaxTokens: 2048 }) }, logger: { info() {}, debug() {} } };
  return { ...f, ctx, engine: new Engine(ctx) };
}
test('automatic economic compaction can run before the old length threshold and protects system/recent history', async () => {
  const f = engineFixture();
  await f.engine.compactIfNeeded(f.agent, 'pressure');
  assert.ok(f.engine.range.start > 1);
  assert.ok(f.engine.range.end < f.session.surface.nodes.at(-12));
  assert.equal(f.engine.nativeTrigger, undefined);
});
test('automatic compaction defers warm-cache rewrites', async () => {
  const f = engineFixture(.98);
  assert.equal(await f.engine.compactIfNeeded(f.agent, 'pressure'), null);
  assert.equal(f.engine.range, undefined);
});
test('failed economic summaries wait for new requests rather than retrying every step', async () => {
  const f = engineFixture(); f.engine.fail = true;
  await assert.rejects(f.engine.compactIfNeeded(f.agent, 'pressure'), /summary failed/);
  assert.equal(await f.engine.compactIfNeeded(f.agent, 'pressure'), null);
  for (let step = 0; step < 4; step++) f.append('assistant/message', { turn: 1, step, usage: { inputTokens: 100000 } });
  await assert.rejects(f.engine.compactIfNeeded(f.agent, 'pressure'), /summary failed/);
});
test('free native tool-result pruning is tried before paying for a summary under pressure', async () => {
  const f = engineFixture(); let pruned = false;
  f.engine.config.thresholdRatio = .4; f.engine.config.headroomTokens = 32768;
  f.ctx.get = () => ({ pruneSession() { pruned = true; } });
  const before = f.ctx.tokenMeter.measure;
  f.ctx.tokenMeter.measure = session => pruned ? { totalTokens: 1000, nodes: [] } : before(session);
  // Real pruning keeps measurement and surface in sync. Simulate its resulting
  // shortened surface, too, so the range validator sees the new generation.
  f.ctx.get = () => ({ pruneSession() { pruned = true; f.session.surface.nodes.length = 0; } });
  assert.equal(await f.engine.compactIfNeeded(f.agent, 'pressure'), null);
  assert.equal(pruned, true); assert.equal(f.engine.range, undefined);
});
test('automatic range backs away from a split tool pair', async () => {
  const f = engineFixture(0, (_session, seq) => seq <= 16);
  await f.engine.compactIfNeeded(f.agent, 'pressure');
  assert.equal(f.engine.range.end, 15);
});
test('near capacity delegates to native even when savings cannot be established', async () => {
  const f = engineFixture(.98);
  f.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 110000 }, defaultMaxTokens: 2048 });
  assert.equal(await f.engine.compactIfNeeded(f.agent, 'pressure'), 'native-recovery');
});
test('provider-confirmed overflow always retains native recovery and cancellation', async () => {
  const f = engineFixture(.98);
  assert.equal(await f.engine.compactIfNeeded(f.agent, 'context-overflow'), 'native-recovery');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.engine.compactIfNeeded(f.agent, 'pressure', controller.signal));
});
test('manual tool rechecks the requested subset and actual summary, not the larger status range', async () => {
  const f = fixture(0), tools = new Map(); let calls = 0;
  compressionTools({ tokenMeter: f.meter, compaction: { compactRegion() { calls++; } },
    tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} } });
  const status = tools.get('qq_context_status').execute({}, { agent: f.agent });
  assert.equal(status.worthwhile, true);
  const result = await tools.get('qq_compress_context').execute({ startSeq: status.range.startSeq,
    endSeq: status.range.startSeq + 1, summary: '旧的已结束任务及事实来源，不增加任何授权。'.repeat(6) }, { agent: f.agent });
  assert.equal(result.compressed, false); assert.equal(calls, 0);
});

const host = process.env.DSH_INSTALL_MODULES || path.resolve('../dsh-asar/dsh/node_modules');
const hostAvailable = fs.existsSync(path.join(host, '@deepseek-ai/dsh-compaction-basic/lib/index.js'));
test('real host loader installs the subclass service with native automatic recovery listeners', { skip: !hostAvailable }, async () => {
  const load = name => import(pathToFileURL(path.join(host, `@deepseek-ai/${name}/lib/index.js`)).href);
  const [{ Context }, native, { default: Loader }] = await Promise.all([load('cordis'), load('dsh-compaction-basic'), load('cordis-plugin-loader')]);
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(path.resolve(host, '../cordis.yml')).href;
  for (const key of ['llm', 'tokenMeter', 'sessions']) ctx.provide(key);
  ctx.set('llm', {}); ctx.set('tokenMeter', {}); ctx.set('sessions', {});
  const loader = ctx.plugin(Loader, { baseUrl: pathToFileURL(path.resolve(host, '../cordis.yml')).href });
  await loader;
  await ctx.loader.root.create({ id: 'test-cost-aware', name: new URL('../plugins/qq-agent-presets/qq-cost-aware-compaction.mjs', import.meta.url).href,
    config: { maxTokens: 8192, retainTokens: 8192 } });
  await ctx.loader.store['test-cost-aware'].fiber.await();
  try {
    assert.ok(ctx.compaction, 'compaction service must be provided');
    const loaded = await ctx.loader.import('@deepseek-ai/dsh-compaction-basic');
    assert.ok(ctx.compaction instanceof loaded.BasicCompactionEngine);
    assert.equal(ctx.compaction.config.auto, true);
    assert.equal(ctx.compaction.config.maxOverflowRetries, 1);
    assert.ok(ctx.compaction.compactNow);
    assert.notEqual(ctx.compaction.compactIfNeeded, native.BasicCompactionEngine.prototype.compactIfNeeded);
  } finally { await ctx.loader.store['test-cost-aware'].fiber.dispose(); await loader.dispose(); }
});
