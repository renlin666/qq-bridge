import { eligibleNodes } from './qq-context-compression.mjs';
import { COST_POLICY, evaluateCompaction, recentInputUsage } from '../../src/context-compaction-cost.js';

export const name = 'qq-cost-aware-compaction';
export const inject = ['loader'];

// The installed host owns the native backend and its dependencies. Resolve via
// its loader, rather than vendoring native code or depending on a machine path.
export async function apply(ctx, config) {
  const loader = ctx.fiber.entry?.parent.tree ?? ctx.loader;
  const [native, pairing] = await Promise.all([
    loader.import('@deepseek-ai/dsh-compaction-basic'), loader.import('@deepseek-ai/dsh-compaction'),
  ]);
  await ctx.plugin(createCostAwareEngine(native.BasicCompactionEngine, pairing.toolPairingBalancedBefore), config);
}

export function createCostAwareEngine(Basic, balancedBefore) {
  return class CostAwareCompaction extends Basic {
    failedEconomicAttempts = new WeakMap();
    async compactIfNeeded(agent, trigger, signal) {
      signal?.throwIfAborted();
      // Keep native provider-confirmed overflow recovery, retry bounds, locks,
      // pruning, durable checkpoints and manual /compact behavior intact.
      if (trigger !== 'pressure') return super.compactIfNeeded(agent, trigger, signal);
      const session = agent.session, target = session.requestHeader?.()?.config;
      if (!target?.provider || !target?.model) return null;
      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      const window = info.context?.contextWindow;
      const reserved = target.maxTokens ?? info.defaultMaxTokens ?? 0;
      if (!Number.isSafeInteger(window) || window <= reserved) return super.compactIfNeeded(agent, trigger, signal);
      let measurement = this.ctx.tokenMeter.measure(session);
      const budget = window - reserved;
      const override = this.config.modelPolicies.find(row => row.provider === target.provider && row.model === target.model) ?? {};
      const pressure = Math.min(window * (override.thresholdRatio ?? this.config.thresholdRatio),
        budget - (override.headroomTokens ?? this.config.headroomTokens));
      const pruner = this.ctx.get?.('toolResultPruner');
      if (measurement.totalTokens >= pressure && pruner) {
        pruner.pruneSession(session);
        measurement = this.ctx.tokenMeter.measure(session);
      }
      // Preserve room for another step and the summarizer. Cost cannot veto
      // necessary capacity recovery; native policies still select the range.
      if (measurement.totalTokens >= Math.min(budget * 0.9, budget - 8192)) {
        this.ctx.logger.info('context-economy: capacity safety override');
        return super.compactIfNeeded(agent, trigger, signal);
      }
      if (override.summarizationProvider || this.config.summarizationProvider) return null; // No cross-route price assumption.
      const retain = override.retainTokens ?? (override.retainRatio !== undefined ? Math.floor(budget * override.retainRatio)
        : this.config.retainTokens ?? Math.floor(budget * this.config.retainRatio));
      const eligible = new Set(eligibleNodes(session));
      const priced = measurement.nodes;
      const surface = [...session.surface.nodes];
      if (surface.length !== priced.length || surface.some((seq, i) => seq !== priced[i].seq)) throw new Error('token-meter surface mismatch');
      let tail = 0, end = priced.length;
      while (end > 0 && tail < retain) tail += priced[--end].tokens;
      while (end > 0 && !eligible.has(priced[end - 1].seq)) end--;
      while (end > 0 && end < surface.length && !balancedBefore(session, surface[end])) end--;
      const selected = surface.slice(0, end).filter(seq => eligible.has(seq));
      if (!selected.length) return null;
      const cost = evaluateCompaction(this.ctx, agent, selected, { mode: 'automatic', summaryTokens: override.maxTokens ?? this.config.maxTokens });
      // Only amounts/counts/reasons enter logs, never prompts or identities.
      this.ctx.logger.debug(`context-economy: ${JSON.stringify({ reason: cost.reason, samples: cost.observations.samples,
        breakEvenRequests: cost.breakEvenRequests, upfrontCny: cost.upfrontCny, savedPerRequestCny: cost.savedPerRequestCny })}`);
      if (!cost.worthwhile) return null;
      const failed = this.failedEconomicAttempts.get(session);
      const usage = recentInputUsage(session, target);
      const routeKey = `${target.provider}/${target.model}`;
      if (failed?.routeKey === routeKey && measurement.totalTokens - failed.tokens < COST_POLICY.minOldTokens
        && usage.sampleSeqs.filter(seq => seq >= failed.seq).length < COST_POLICY.cooldownRequests) return null;
      this.failedEconomicAttempts.set(session, { routeKey, seq: session.seq, tokens: measurement.totalTokens });
      this.ctx.logger.info(`context-economy: DeepSeek-reference breakEven=${cost.breakEvenRequests} horizon=${cost.horizonRequests}`);
      const result = await super.compactRegion(selected[0], selected.at(-1), agent, signal);
      this.failedEconomicAttempts.delete(session);
      return result;
    }
  };
}
