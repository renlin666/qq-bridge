import crypto from 'node:crypto';
import { fail, ERROR_CODES } from './errors.js';
import { json, parseJson } from './db.js';
import { clamp, round1, startOfLocalDay } from './text.js';

const DIMENSIONS = ['closeness', 'familiarity', 'trust', 'boundary'];

function scoreOf(state) {
  return state.closeness * 0.4 + state.familiarity * 0.3 + state.trust * 0.3;
}

export function tierForScore(score, config) {
  let selected = config.relationship.tiers[0];
  for (const tier of config.relationship.tiers) {
    if (score >= tier.min) selected = tier;
  }
  return selected.name;
}

function nextTier(score, currentTier, config) {
  const tiers = config.relationship.tiers;
  const hysteresis = config.relationship.tierHysteresis;
  let index = tiers.findIndex((tier) => tier.name === currentTier);
  if (index < 0) index = tiers.findIndex((tier) => tier.name === tierForScore(score, config));
  while (index < tiers.length - 1 && score >= tiers[index + 1].min + hysteresis) index += 1;
  while (index > 0 && score < tiers[index].min - hysteresis) index -= 1;
  return tiers[index].name;
}

function stateFromRow(row) {
  if (!row) return null;
  return {
    personId: row.person_id,
    closeness: Number(row.closeness),
    familiarity: Number(row.familiarity),
    trust: Number(row.trust),
    boundary: Number(row.boundary),
    tier: row.tier,
    moodLabel: row.mood_label ?? null,
    moodIntensity: row.mood_intensity === null ? null : Number(row.mood_intensity),
    moodExpiresAt: row.mood_expires_at === null ? null : Number(row.mood_expires_at),
    maintenanceAt: Number(row.maintenance_at),
    updatedAt: Number(row.updated_at),
    version: Number(row.version)
  };
}

function readState(db, personId) {
  return stateFromRow(db.prepare('SELECT * FROM relationships WHERE person_id = ?').get(personId));
}

function insertState(db, personId, state, now) {
  db.prepare(`
    INSERT INTO relationships
      (person_id, closeness, familiarity, trust, boundary, tier, mood_label, mood_intensity,
       mood_expires_at, maintenance_at, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    personId,
    state.closeness,
    state.familiarity,
    state.trust,
    state.boundary,
    state.tier,
    state.moodLabel,
    state.moodIntensity,
    state.moodExpiresAt,
    now,
    now,
    now
  );
}

export function ensureRelationship(db, personId, now, config) {
  const existing = readState(db, personId);
  if (existing) return existing;
  const initial = config.relationship.initial;
  const state = {
    personId,
    closeness: initial.closeness,
    familiarity: initial.familiarity,
    trust: initial.trust,
    boundary: initial.boundary,
    tier: tierForScore(
      initial.closeness * 0.4 + initial.familiarity * 0.3 + initial.trust * 0.3,
      config
    ),
    moodLabel: null,
    moodIntensity: null,
    moodExpiresAt: null,
    maintenanceAt: now,
    updatedAt: now,
    version: 1
  };
  insertState(db, personId, state, now);
  return state;
}

function persistState(db, state, now) {
  db.prepare(`
    UPDATE relationships
       SET closeness = ?, familiarity = ?, trust = ?, boundary = ?, tier = ?,
           mood_label = ?, mood_intensity = ?, mood_expires_at = ?,
           maintenance_at = ?, updated_at = ?, version = version + 1
     WHERE person_id = ?
  `).run(
    state.closeness,
    state.familiarity,
    state.trust,
    state.boundary,
    state.tier,
    state.moodLabel,
    state.moodIntensity,
    state.moodExpiresAt,
    state.maintenanceAt,
    now,
    state.personId
  );
  return readState(db, state.personId);
}

function appendLedger(db, {
  personId,
  eventId = null,
  memoryId = null,
  sourceMessageId = null,
  kind,
  deltas,
  before,
  after,
  reason,
  status = 'applied',
  now
}) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO relationship_ledger
      (id, person_id, event_id, memory_id, source_message_id, kind, deltas_json,
       before_json, after_json, reason, status, created_at, reverted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    personId,
    eventId,
    memoryId,
    sourceMessageId,
    kind,
    json(deltas),
    json(before),
    json(after),
    reason,
    status,
    now,
    status === 'reverted' ? now : null
  );
  return id;
}

/**
 * 时间维护：熟悉度/亲近度缓慢向基线回落，信任不无故衰减，情绪到期清除。
 * 衰减不产生“敌人”档位；档位切换保留滞回缓冲。
 */
export function applyMaintenance(db, personId, now, config) {
  let state = ensureRelationship(db, personId, now, config);
  if (now <= state.maintenanceAt) {
    if (state.moodExpiresAt !== null && now >= state.moodExpiresAt) {
      state.moodLabel = null;
      state.moodIntensity = null;
      state.moodExpiresAt = null;
      state.updatedAt = now;
      state = persistState(db, state, now);
    }
    return state;
  }

  const days = (now - state.maintenanceAt) / 86_400_000;
  const before = { ...state };
  const decay = config.relationship.decay;
  // 保护地板只限制自然下降；不得抬高负面事件造成的低分。
  for (const dimension of ['closeness', 'familiarity', 'trust']) {
    state[dimension] = Math.min(state[dimension], Math.max(
      decay.floors[dimension], state[dimension] - days * decay[`${dimension}PerDay`]
    ));
  }

  if (state.moodExpiresAt !== null && now >= state.moodExpiresAt) {
    state.moodLabel = null;
    state.moodIntensity = null;
    state.moodExpiresAt = null;
  }

  state.tier = nextTier(scoreOf(state), state.tier, config);
  const tiers = config.relationship.tiers;
  const minimum = tiers.findIndex((tier) => tier.name === decay.minimumTier);
  const previous = tiers.findIndex((tier) => tier.name === before.tier);
  const current = tiers.findIndex((tier) => tier.name === state.tier);
  if (minimum >= 0 && previous >= minimum && current < minimum) state.tier = tiers[minimum].name;
  state.maintenanceAt = now;
  state.updatedAt = now;

  const deltas = {
    closeness: round1(state.closeness - before.closeness),
    familiarity: round1(state.familiarity - before.familiarity),
    trust: round1(state.trust - before.trust),
    boundary: 0
  };
  if (Object.values(deltas).some((value) => Math.abs(value) >= 0.05)) {
    appendLedger(db, {
      personId,
      kind: 'maintenance',
      deltas,
      before,
      after: state,
      reason: '自然时间衰减；信任不自动下降，档位不会因沉默降为戒备',
      now
    });
  }
  return persistState(db, state, now);
}

function cooldownRemaining(db, personId, kind, now) {
  const row = db.prepare(`
    SELECT created_at FROM relationship_ledger
     WHERE person_id = ? AND kind = ? AND status = 'applied'
     ORDER BY created_at DESC LIMIT 1
  `).get(personId, kind);
  return row ? Number(row.created_at) : null;
}

function repetitionCount(db, personId, kind, now, windowMs) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM relationship_ledger
     WHERE person_id = ? AND kind = ? AND status = 'applied' AND created_at >= ?
  `).get(personId, kind, now - windowMs);
  return Number(row?.count ?? 0);
}

function dailyUsage(db, personId, dimension, now) {
  const rows = db.prepare(`
    SELECT deltas_json FROM relationship_ledger
     WHERE person_id = ? AND status = 'applied'
       AND kind NOT IN ('maintenance', 'forget_reversal')
       AND created_at >= ?
  `).all(personId, startOfLocalDay(now));
  let positive = 0;
  let negative = 0;
  for (const row of rows) {
    const value = Number(parseJson(row.deltas_json, {})?.[dimension] ?? 0);
    if (value > 0) positive += value;
    else if (value < 0) negative += -value;
  }
  return { positive, negative };
}

function insertIgnoredEvent(db, {
  dedupeKey, platform, botAccountId, personId, kind, sourceMessageId,
  memoryId, evidence, occurredAt, now, reason
}) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO interaction_events
      (id, dedupe_key, platform, bot_account_id, person_id, kind, source_message_id,
       memory_id, evidence, occurred_at, created_at, payload_json, status, ignore_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'ignored', ?)
  `).run(
    id,
    dedupeKey,
    platform,
    botAccountId,
    personId,
    kind,
    sourceMessageId,
    memoryId,
    evidence,
    occurredAt,
    now,
    reason
  );
  return id;
}

/**
 * 抽取器只能提交“发生了什么”（kind + evidence + sourceMessageId），
 * 数值变化由这里的事件规则、冷却、每日上限和重复收益递减决定。
 * 任何 delta/score 字段都不会被读取。
 */
export function applyInteraction(db, {
  platform,
  botAccountId,
  personId,
  kind,
  sourceMessageId,
  memoryId = null,
  evidence,
  occurredAt,
  now,
  config
}) {
  const normalizedEvidence = String(evidence ?? '').trim();
  const normalizedSource = String(sourceMessageId ?? '').trim();
  if (!normalizedEvidence) fail(ERROR_CODES.INVALID_INPUT, '互动事件必须有证据文本');
  if (!normalizedSource) fail(ERROR_CODES.INVALID_INPUT, '互动事件必须有来源消息编号');
  const rule = config.relationship.eventRules[kind];
  if (!rule) fail(ERROR_CODES.INVALID_INPUT, `不支持的互动事件类型：${kind}`);

  const dedupeKey = crypto
    .createHash('sha256')
    .update([platform, botAccountId, personId, kind, normalizedSource].join('\u0001'))
    .digest('hex');
  // 正式插件每条来源仅接受一次关系判断，重分类/重放不能另加一次分。
  const duplicate = db.prepare('SELECT id FROM interaction_events WHERE platform = ? AND bot_account_id = ? AND person_id = ? AND source_message_id = ?')
    .get(platform, botAccountId, personId, normalizedSource);
  if (duplicate) {
    return { applied: false, duplicate: true, ignored: false, state: viewRelationship(db, personId, now, config) };
  }

  let state = applyMaintenance(db, personId, now, config);
  const last = cooldownRemaining(db, personId, kind, now);
  if (last !== null && now - last < rule.cooldownMs) {
    const eventId = insertIgnoredEvent(db, {
      dedupeKey, platform, botAccountId, personId, kind, sourceMessageId,
      memoryId, evidence: normalizedEvidence, occurredAt, now,
      reason: `冷却中（${Math.ceil((rule.cooldownMs - (now - last)) / 1000)} 秒）`
    });
    return {
      applied: false,
      duplicate: false,
      ignored: true,
      eventId,
      reason: 'cooldown',
      state: readState(db, personId)
    };
  }

  const repeat = repetitionCount(db, personId, kind, now, config.relationship.repetitionWindowMs);
  const factor = Math.pow(config.relationship.repetitionFactor, repeat);
  const raw = {};
  for (const dimension of DIMENSIONS) raw[dimension] = Number(rule[dimension] ?? 0);
  if (!Object.values(raw).some((value) => value !== 0)) {
    fail(ERROR_CODES.INVALID_INPUT, `事件规则 ${kind} 没有可应用的变化`);
  }

  const deltas = {};
  for (const dimension of DIMENSIONS) {
    let value = raw[dimension] * factor;
    if (value !== 0) {
      const cap = dimension === 'boundary'
        ? (value > 0 ? config.relationship.dailyPositiveCapPerDimension : config.relationship.dailyNegativeCapPerDimension)
        : (value > 0 ? config.relationship.dailyPositiveCapPerDimension : config.relationship.dailyNegativeCapPerDimension);
      const usage = dailyUsage(db, personId, dimension, now);
      const used = value > 0 ? usage.positive : usage.negative;
      const remaining = Math.max(0, cap - used);
      value = Math.sign(value) * Math.min(Math.abs(value), remaining);
    }
    value = clamp(value, -config.relationship.maxSingleDelta, config.relationship.maxSingleDelta);
    deltas[dimension] = round1(value);
  }

  if (!Object.values(deltas).some((value) => value !== 0)) {
    const eventId = insertIgnoredEvent(db, {
      dedupeKey, platform, botAccountId, personId, kind, sourceMessageId,
      memoryId, evidence: normalizedEvidence, occurredAt, now,
      reason: '当日该维度变化上限已用尽'
    });
    return {
      applied: false,
      duplicate: false,
      ignored: true,
      eventId,
      reason: 'daily_cap',
      state: readState(db, personId)
    };
  }

  const before = { ...state };
  state = {
    ...state,
    closeness: clamp(state.closeness + deltas.closeness, 0, 100),
    familiarity: clamp(state.familiarity + deltas.familiarity, 0, 100),
    trust: clamp(state.trust + deltas.trust, 0, 100),
    boundary: clamp(state.boundary + deltas.boundary, 0, 100),
    maintenanceAt: now,
    updatedAt: now
  };
  state.tier = nextTier(scoreOf(state), state.tier, config);
  if (rule.mood && rule.mood.label) {
    state.moodLabel = String(rule.mood.label).slice(0, 20);
    state.moodIntensity = clamp(Number(rule.mood.intensity) || 0, 0, 1);
    state.moodExpiresAt = now + Math.max(0, Number(rule.mood.ttlMs) || 0);
  }
  state = persistState(db, state, now);

  const eventId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO interaction_events
      (id, dedupe_key, platform, bot_account_id, person_id, kind, source_message_id,
       memory_id, evidence, occurred_at, created_at, payload_json, status, ignore_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', NULL)
  `).run(
    eventId,
    dedupeKey,
    platform,
    botAccountId,
    personId,
    kind,
    normalizedSource,
    memoryId,
    normalizedEvidence,
    occurredAt,
    now,
    json({ factor, repeat, deltas })
  );

  appendLedger(db, {
    personId,
    eventId,
    memoryId,
    sourceMessageId: normalizedSource,
    kind,
    deltas,
    before,
    after: state,
    reason: `规则 ${kind}；重复次数 ${repeat}，收益系数 ${factor.toFixed(3)}`,
    now
  });

  return {
    applied: true,
    duplicate: false,
    ignored: false,
    eventId,
    deltas,
    factor,
    state
  };
}

export function viewRelationship(db, personId, now, config) {
  const state = applyMaintenance(db, personId, now, config);
  const mood = state.moodExpiresAt !== null && now < state.moodExpiresAt
    ? {
        label: state.moodLabel,
        intensity: round1(state.moodIntensity),
        expiresAt: state.moodExpiresAt
      }
    : null;
  return {
    personId,
    tier: state.tier,
    dimensions: {
      closeness: round1(state.closeness),
      familiarity: round1(state.familiarity),
      trust: round1(state.trust),
      boundary: round1(state.boundary)
    },
    score: round1(scoreOf(state)),
    mood,
    updatedAt: state.updatedAt
  };
}

/**
 * 遗忘一条记忆时，撤销由它派生的关系变化。撤销会写独立账本，
 * 但不会删除原事件，因此同一来源重试仍会命中原事件的幂等键。
 */
export function revertMemoryLedger(db, memoryId, now, config) {
  const rows = db.prepare(`
    SELECT * FROM relationship_ledger
     WHERE memory_id = ? AND status = 'applied'
     ORDER BY created_at ASC, id ASC
  `).all(memoryId);
  if (!rows.length) return { reverted: 0 };
  let count = 0;
  for (const row of rows) {
    const personId = row.person_id;
    let state = applyMaintenance(db, personId, now, config);
    const original = parseJson(row.deltas_json, {});
    const inverse = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, -Number(original[dimension] ?? 0)]));
    const before = { ...state };
    state = {
      ...state,
      closeness: clamp(state.closeness + inverse.closeness, 0, 100),
      familiarity: clamp(state.familiarity + inverse.familiarity, 0, 100),
      trust: clamp(state.trust + inverse.trust, 0, 100),
      boundary: clamp(state.boundary + inverse.boundary, 0, 100),
      maintenanceAt: now,
      updatedAt: now
    };
    state.tier = nextTier(scoreOf(state), state.tier, config);
    state = persistState(db, state, now);
    db.prepare("UPDATE relationship_ledger SET status = 'reverted', reverted_at = ? WHERE id = ?")
      .run(now, row.id);
    appendLedger(db, {
      personId,
      eventId: row.event_id,
      memoryId: null,
      sourceMessageId: row.source_message_id,
      kind: 'forget_reversal',
      deltas: inverse,
      before,
      after: state,
      reason: `遗忘记忆 ${memoryId}，撤销对应关系变化`,
      now
    });
    count += 1;
  }
  return { reverted: count };
}
