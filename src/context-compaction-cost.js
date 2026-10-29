import { ratesAt, normalizeUsage, costOfBuckets } from './model-prices.js';
import { usageOfEvent } from './token-ledger.js';

export const COST_POLICY = Object.freeze({ horizonRequests: 8, minSamples: 3, minOldTokens: 6000,
  cooldownRequests: 4, summaryTokens: 1200, checkpointTokens: 128 });
const FLASH = new Set(['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017']);
const observations = new WeakMap();

// Read the durable log, never another session's ledger. A header prices only
// the samples AFTER it. Bound work on very long logs; missing attribution defers
// economic compaction rather than inventing a cache ratio. Latest step wins.
export function recentInputUsage(session, target) {
  const key = `${target?.provider}/${target?.model}`;
  const cached = observations.get(session);
  if (cached?.seq === session.seq && cached.key === key) return cached.value;
  const samples = [], pending = [], seen = new Set();
  let checkpointSeq = -1;
  const flush = route => {
    if (route?.provider !== target?.provider || route?.model !== target?.model) return;
    for (const event of pending) {
      const id = `${event.data?.turn}/${event.data?.step}`;
      if (seen.has(id)) continue;
      const raw = usageOfEvent(event);
      // DSH omits optional zero-valued cache buckets. inputTokens is already
      // the disjoint uncached bucket, so absence means zero cache reads.
      if (!raw || !Number.isFinite(raw.inputTokens) || raw.inputTokens < 0) continue;
      seen.add(id);
      const buckets = normalizeUsage(raw);
      if (buckets.cacheMiss + buckets.cacheHit + buckets.cacheWrite > 0) samples.push({ seq: event.seq, buckets });
    }
  };
  for (let seq = session.seq - 1; seq >= Math.max(0, session.seq - 4000); seq--) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === 'compaction/summary' && checkpointSeq < 0) checkpointSeq = seq;
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') pending.push(event);
    if (event.type === 'request/header') {
      const route = event.data?.header?.config;
      flush(route); pending.length = 0;
      // Do not mix observations from a previous route, even after switching back.
      if (route?.provider !== target?.provider || route?.model !== target?.model || samples.length >= 8 && checkpointSeq >= 0) break;
    }
  }
  const recent = samples.slice(0, 8);
  const buckets = recent.reduce((sum, sample) => {
    for (const name of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output']) sum[name] += sample.buckets[name];
    return sum;
  }, { cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0 });
  const inputTokens = buckets.cacheHit + buckets.cacheMiss + buckets.cacheWrite;
  const value = { samples: recent.length, sampleSeqs: recent.map(sample => sample.seq), inputTokens, buckets,
    cacheHitRatio: inputTokens ? buckets.cacheHit / inputTokens : null,
    cacheWriteRatio: inputTokens ? buckets.cacheWrite / inputTokens : 0,
    checkpointSeq, callsSinceCompaction: samples.filter(sample => sample.seq > checkpointSeq).length };
  observations.set(session, { seq: session.seq, key, value });
  return value;
}

export function compactionEconomics({ totalTokens, selectedTokens, summaryTokens = COST_POLICY.summaryTokens,
  prefixTokens = totalTokens, mode = 'manual', usage, target, now = Date.now() }) {
  const rates = ratesAt(target?.model, now);
  const hit = usage?.cacheHitRatio ?? 1, write = usage?.cacheWriteRatio ?? 0;
  const inputRate = hit * rates.cacheHit + write * rates.cacheWrite + Math.max(0, 1 - hit - write) * rates.cacheMiss;
  const replacementTokens = summaryTokens + COST_POLICY.checkpointTokens;
  const removedTokens = selectedTokens - replacementTokens;
  const afterTokens = Math.max(0, totalTokens - removedTokens);
  const summaryOutputCny = summaryTokens * rates.output / rates.unit;
  const summaryInputCny = mode === 'automatic' ? (prefixTokens + 1500) * inputRate / rates.unit : 0;
  // Manual tool invocation adds a complete continuation. Auto has no extra
  // continuation, but its next normal request rebuilds the changed prefix.
  // Charge the whole remaining input cold, a conservative upper bound.
  const continuationCny = mode === 'manual' ? afterTokens * rates.cacheMiss / rates.unit : 0;
  const cacheRebuildCny = mode === 'automatic' ? afterTokens * Math.max(0, rates.cacheMiss - inputRate) / rates.unit : 0;
  const upfrontCny = summaryOutputCny + summaryInputCny + continuationCny + cacheRebuildCny;
  const savedPerRequestCny = Math.max(0, removedTokens) * inputRate / rates.unit;
  const breakEvenRequests = savedPerRequestCny > 0 ? Math.ceil(upfrontCny / savedPerRequestCny) : null;
  let reason = 'pays-back';
  if (!target?.provider || !FLASH.has(target.model)) reason = 'unknown-reference-model';
  else if ((usage?.samples ?? 0) < COST_POLICY.minSamples) reason = 'insufficient-usage';
  else if (selectedTokens < COST_POLICY.minOldTokens || removedTokens <= 0) reason = 'too-little-history';
  else if (usage.checkpointSeq >= 0 && usage.callsSinceCompaction < COST_POLICY.cooldownRequests) reason = 'cooldown';
  else if (breakEvenRequests === null || breakEvenRequests > COST_POLICY.horizonRequests) reason = 'not-paid-back-within-horizon';
  return { worthwhile: reason === 'pays-back', reason, priceBasis: 'DeepSeek-reference-CNY', rates,
    observations: { samples: usage?.samples ?? 0, inputTokens: usage?.inputTokens ?? 0, cacheHitRatio: usage?.cacheHitRatio ?? null,
      observedInputReferenceCny: usage ? costOfBuckets({ ...usage.buckets, output: 0 }, rates).total : 0 },
    estimated: true, horizonRequests: COST_POLICY.horizonRequests, breakEvenRequests,
    selectedTokens, summaryTokens, removedTokens, upfrontCny, savedPerRequestCny,
    components: { summaryOutputCny, summaryInputCny, continuationCny, cacheRebuildCny } };
}

export function evaluateCompaction(ctx, agent, selected, options = {}) {
  const session = agent.session, measurement = ctx.tokenMeter.measure(session);
  const target = session.requestHeader?.()?.config ?? agent.options;
  const set = new Set(selected);
  const selectedTokens = measurement.nodes.filter(node => set.has(node.seq)).reduce((sum, node) => sum + node.tokens, 0);
  const last = measurement.nodes.findIndex(node => node.seq === selected.at(-1));
  const overhead = Math.max(0, measurement.totalTokens - measurement.nodes.reduce((sum, node) => sum + node.tokens, 0));
  const prefixTokens = overhead + measurement.nodes.slice(0, last + 1).reduce((sum, node) => sum + node.tokens, 0);
  return compactionEconomics({ totalTokens: measurement.totalTokens, selectedTokens, prefixTokens,
    target, usage: recentInputUsage(session, target), ...options });
}
