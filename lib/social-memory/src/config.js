const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_CONFIG = Object.freeze({
  platform: 'qq',
  limits: {
    contentChars: 1000,
    quoteChars: 500,
    evidenceChars: 500,
    maxMemoriesPerMessage: 8,
    maxMentions: 20
  },
  extraction: {
    enabled: true,
    minimumConfidence: 0.5
  },
  retrieval: {
    defaultBudget: 800,
    minBudget: 32,
    maxBudget: 4000,
    candidateLimit: 120,
    maxFacts: 3,
    maxExperiences: 4,
    recencyHalfLifeDays: 60,
    includeRelationship: true
  },
  relationship: {
    initial: {
      closeness: 32,
      familiarity: 30,
      trust: 30,
      boundary: 40
    },
    tiers: [
      { name: '戒备', min: 0 },
      { name: '礼貌', min: 20 },
      { name: '熟悉', min: 40 },
      { name: '亲近', min: 60 },
      { name: '深交', min: 80 }
    ],
    tierHysteresis: 3,
    maxSingleDelta: 1.5,
    dailyPositiveCapPerDimension: 5,
    dailyNegativeCapPerDimension: 6,
    repetitionWindowMs: 6 * HOUR,
    repetitionFactor: 0.5,
    eventRules: {
      greeting: {
        closeness: 0.1,
        familiarity: 0.3,
        trust: 0,
        boundary: 0.1,
        cooldownMs: 10 * MINUTE
      },
      positive_chat: {
        closeness: 0.45,
        familiarity: 0.3,
        trust: 0.1,
        boundary: 0.1,
        cooldownMs: 15 * MINUTE,
        mood: { label: '愉快', intensity: 0.55, ttlMs: 30 * MINUTE }
      },
      shared_activity: {
        closeness: 0.5,
        familiarity: 1.0,
        trust: 0.2,
        boundary: 0.1,
        cooldownMs: 20 * MINUTE,
        mood: { label: '放松', intensity: 0.4, ttlMs: 45 * MINUTE }
      },
      support: {
        closeness: 0.4,
        familiarity: 0.35,
        trust: 1.2,
        boundary: 0.5,
        cooldownMs: 20 * MINUTE
      },
      deep_talk: {
        closeness: 0.7,
        familiarity: 0.8,
        trust: 0.6,
        boundary: 0.2,
        cooldownMs: 45 * MINUTE
      },
      conflict: {
        closeness: -0.8,
        familiarity: 0,
        trust: -1.2,
        boundary: -1.0,
        cooldownMs: 30 * MINUTE,
        mood: { label: '不悦', intensity: 0.65, ttlMs: 20 * MINUTE }
      },
      boundary_violation: {
        closeness: -0.7,
        familiarity: 0,
        trust: -1.5,
        boundary: -1.5,
        cooldownMs: 60 * MINUTE,
        mood: { label: '警惕', intensity: 0.6, ttlMs: 30 * MINUTE }
      }
    },
    moodDecay: {
      // 保留字段方便未来从线性衰减切换为指数衰减；本原型按 expiresAt 快速清除。
      mode: 'expire'
    },
    decay: {
      familiarityPerDay: 0.35,
      closenessPerDay: 0.1,
      trustPerDay: 0,
      floors: {
        closeness: 30,
        familiarity: 28,
        trust: 30
      },
      minimumTier: '礼貌'
    }
  },
  sync: {
    batchSize: 20,
    baseBackoffMs: 2_000,
    maxBackoffMs: 5 * MINUTE,
    maxAttemptsBeforeSlowRetry: 8
  }
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, extra) {
  if (Array.isArray(extra)) return extra.map((item) => (isPlainObject(item) ? merge({}, item) : item));
  if (!isPlainObject(extra)) return extra === undefined ? base : extra;
  const result = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(extra)) {
    result[key] = isPlainObject(value) ? merge(result[key], value) : value;
  }
  return result;
}

export function resolveConfig(overrides = {}) {
  const merged = merge(structuredClone(DEFAULT_CONFIG), overrides);
  const tiers = [...merged.relationship.tiers].sort((a, b) => a.min - b.min);
  if (tiers.length !== 5) throw new Error('relationship.tiers 必须恰好有五个档位');
  if (tiers[0].min !== 0) throw new Error('第一个关系档位必须从 0 开始');
  for (let i = 1; i < tiers.length; i += 1) {
    if (!(tiers[i].min > tiers[i - 1].min)) throw new Error('关系档位阈值必须递增');
  }
  merged.relationship.tiers = tiers;
  for (const [kind, rule] of Object.entries(merged.relationship.eventRules)) {
    for (const dim of ['closeness', 'familiarity', 'trust', 'boundary']) {
      if (rule[dim] !== undefined && (!Number.isFinite(rule[dim]) || Math.abs(rule[dim]) > merged.relationship.maxSingleDelta)) {
        throw new Error(`事件规则 ${kind}.${dim} 超过单次变化上限`);
      }
    }
    if (!Number.isFinite(rule.cooldownMs) || rule.cooldownMs < 0) throw new Error(`事件规则 ${kind} 冷却无效`);
  }
  return merged;
}

export const TIME = Object.freeze({ MINUTE, HOUR, DAY });
