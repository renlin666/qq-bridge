import crypto from 'node:crypto';
import { resolveConfig } from './config.js';
import { openDatabase, transaction, json, parseJson } from './db.js';
import { createWhitelistPolicy } from './policy.js';
import { resolveNow } from './clock.js';
import { ERROR_CODES, fail } from './errors.js';
import { applyInteraction, viewRelationship, revertMemoryLedger } from './relationship.js';
import { buildContextPack } from './retrieval.js';
import { MockIndexAdapter } from './index-adapter.js';
import { DeterministicFakeExtractor } from './extractor.js';
import {
  clamp,
  cleanDisplayName,
  cleanText,
  hashText,
  keywordsFrom,
  normalizeKeywords,
  normalizeName,
  truncateChars
} from './text.js';

const MEMORY_KINDS = new Set(['fact', 'preference', 'experience', 'group_event']);
const MEMORY_STATUSES = new Set(['proposed', 'active', 'forgotten']);

function id(prefix = '') {
  return `${prefix}${crypto.randomUUID()}`;
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(ERROR_CODES.INVALID_INPUT, message);
  return value;
}

function nonEmpty(value, max, message) {
  const text = cleanText(value);
  if (!text) fail(ERROR_CODES.INVALID_INPUT, message);
  if (Array.from(text).length > max) fail(ERROR_CODES.INVALID_INPUT, `${message}（最多 ${max} 字）`);
  return text;
}

function validTimestamp(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(number)) fail(ERROR_CODES.INVALID_INPUT, '时间格式无效');
  return Math.trunc(number);
}

function mapMemory(row) {
  if (!row) return null;
  return {
    memoryId: row.id,
    platform: row.platform,
    botAccountId: row.bot_account_id,
    scope: { type: row.scope_type, id: row.scope_id },
    subjectPersonId: row.subject_person_id ?? null,
    kind: row.kind,
    content: row.content,
    keywords: parseJson(row.keywords_json, []),
    status: row.status,
    confirmed: row.confirmed === 1,
    confidence: Number(row.confidence),
    origin: row.origin,
    sourceMessageId: row.source_message_id ?? null,
    occurredAt: Number(row.occurred_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    validFrom: Number(row.valid_from),
    validTo: row.valid_to === null ? null : Number(row.valid_to),
    version: Number(row.version),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    forgetReason: row.forget_reason ?? null
  };
}

function memoryTombstone(row) {
  return { memoryId: row.id, status: row.status, version: Number(row.version) };
}

function indexDocument(row, deleted = false) {
  return {
    memoryId: row.id,
    identity: {
      platform: row.platform,
      botAccountId: row.bot_account_id
    },
    scope: { type: row.scope_type, id: row.scope_id },
    keywords: deleted ? [] : parseJson(row.keywords_json, []),
    version: Number(row.version),
    deleted
  };
}

/**
 * 创建原型服务。所有身份/会话参数都必须来自宿主上下文的独立参数，
 * 服务从不根据记忆正文、模型参数或昵称推断权限主体。
 */
export function createSocialMemory({
  dbPath = ':memory:',
  clock = Date.now,
  policy = createWhitelistPolicy(),
  adapter = new MockIndexAdapter(),
  relationshipPolicy = () => null,
  extractor = new DeterministicFakeExtractor(),
  config: configOverrides = {}
} = {}) {
  const config = resolveConfig(configOverrides);
  const db = openDatabase(dbPath);
  const now = () => resolveNow(clock);

  function normalizeContext(context) {
    const source = requireObject(context, '缺少可信宿主上下文');
    const platform = String(source.platform ?? config.platform);
    if (platform !== config.platform) fail(ERROR_CODES.INVALID_CONTEXT, '不支持的平台');
    const botAccountId = String(source.botAccountId ?? '').trim();
    if (!botAccountId) fail(ERROR_CODES.INVALID_CONTEXT, '缺少机器人账号');
    if (!policy.isBotConfigured(botAccountId)) fail(ERROR_CODES.FORBIDDEN, '机器人账号未获授权');

    const conversation = requireObject(source.conversation, '缺少会话上下文');
    const kind = conversation.kind;
    if (kind !== 'private' && kind !== 'group') fail(ERROR_CODES.INVALID_CONTEXT, '会话类型必须是 private 或 group');
    const actor = requireObject(source.actor, '缺少可信人物身份');
    const userId = String(actor.userId ?? '').trim();
    if (!userId) fail(ERROR_CODES.INVALID_CONTEXT, '缺少可信人物 QQ 号');
    if (!policy.isPersonAllowed(botAccountId, userId)) fail(ERROR_CODES.FORBIDDEN, '该人物未加入允许建档名单');
    if (!policy.isPrivateAllowed(botAccountId, userId)) fail(ERROR_CODES.FORBIDDEN, '该人物未获授权');

    let groupId = null;
    let scopeId;
    if (kind === 'private') {
      scopeId = `private:${userId}`;
    } else {
      const raw = String(conversation.groupId ?? conversation.id ?? '').trim();
      groupId = raw.startsWith('group:') ? raw.slice(6) : raw;
      if (!groupId) fail(ERROR_CODES.INVALID_CONTEXT, '群聊上下文缺少群号');
      if (!policy.isGroupAllowed(botAccountId, groupId)) fail(ERROR_CODES.FORBIDDEN, '该群未加入群聊白名单');
      scopeId = `group:${groupId}`;
    }

    return {
      platform,
      botAccountId,
      conversation: {
        kind,
        id: String(conversation.id ?? groupId ?? `${kind}:${userId}`),
        groupId
      },
      actor: {
        userId,
        displayName: cleanDisplayName(actor.displayName, userId)
      },
      sessionId: source.sessionId ? String(source.sessionId) : null,
      scopeType: kind,
      scopeId
    };
  }

  function personRow(norm) {
    return db.prepare(`
      SELECT * FROM people
       WHERE platform = ? AND bot_account_id = ? AND user_id = ?
    `).get(norm.platform, norm.botAccountId, norm.actor.userId);
  }

  function aliasesFor(personId, norm) {
    return db.prepare(`
      SELECT alias, normalized, source, first_seen_at, last_seen_at
        FROM person_aliases
       WHERE person_id = ? AND scope_type = ? AND scope_id = ?
       ORDER BY last_seen_at DESC, id DESC
    `).all(personId, norm.scopeType, norm.scopeId).map((row) => ({
      alias: row.alias,
      source: row.source,
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at)
    }));
  }

  function upsertAlias(personId, alias, source, timestamp, norm) {
    const display = cleanDisplayName(alias);
    const normalized = normalizeName(display);
    if (!normalized) return;
    const existing = db.prepare('SELECT id FROM person_aliases WHERE person_id = ? AND normalized = ? AND scope_type = ? AND scope_id = ?')
      .get(personId, normalized, norm.scopeType, norm.scopeId);
    if (existing) {
      db.prepare('UPDATE person_aliases SET alias = ?, last_seen_at = ? WHERE id = ?')
        .run(display, timestamp, existing.id);
    } else {
      db.prepare(`
        INSERT INTO person_aliases (person_id, alias, normalized, source, scope_type, scope_id, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(personId, display, normalized, source, norm.scopeType, norm.scopeId, timestamp, timestamp);
    }
  }

  function ensurePerson(norm, { create = true, displayName = norm.actor.displayName, aliasSource = null } = {}) {
    if (!policy.isPersonAllowed(norm.botAccountId, norm.actor.userId)) {
      fail(ERROR_CODES.FORBIDDEN, '该人物未加入允许建档名单');
    }
    let row = personRow(norm);
    const timestamp = now();
    if (!row && !create) return null;
    if (!row) {
      const personId = id('person_');
      db.prepare(`
        INSERT INTO people
          (id, platform, bot_account_id, user_id, status, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, 'active', ?, ?, 1)
      `).run(personId, norm.platform, norm.botAccountId, norm.actor.userId, timestamp, timestamp);
      row = personRow(norm);
    }
    if (row.status !== 'active') fail(ERROR_CODES.PERSON_DISABLED, '该人物已停用，不能读写记忆');
    upsertAlias(row.id, displayName, aliasSource ?? (norm.conversation.kind === 'group' ? 'group_card' : 'nickname'), timestamp, norm);
    return row;
  }

  function requireActiveActor(norm) {
    const person = ensurePerson(norm, { create: false });
    if (!person) fail(ERROR_CODES.NOT_FOUND, '人物尚未建档');
    return person;
  }

  function maybeEnsureParticipant(norm, userId, displayName, role) {
    const idText = String(userId ?? '').trim();
    if (!idText || idText === norm.actor.userId) return null;
    if (!policy.isPersonAllowed(norm.botAccountId, idText)) return null;
    const cleaned = cleanDisplayName(displayName, '');
    if (!cleaned) {
      // 结构化抽取器可能只给 userId；此时不要用 QQ 号覆盖已有昵称。
      const existing = db.prepare(`
        SELECT * FROM people
         WHERE platform = ? AND bot_account_id = ? AND user_id = ?
      `).get(norm.platform, norm.botAccountId, idText);
      if (existing) return existing.status === 'active' ? existing : null;
    }
    const participantNorm = {
      ...norm,
      actor: { userId: idText, displayName: cleaned || idText }
    };
    try {
      const row = ensurePerson(participantNorm, {
        create: true,
        displayName: participantNorm.actor.displayName,
        aliasSource: role === 'quoted' ? 'quoted_display' : (norm.conversation.kind === 'group' ? 'group_card' : 'nickname')
      });
      return row;
    } catch {
      return null;
    }
  }

  function queueOutbox(row, op) {
    if (!row) return;
    const existing = db.prepare('SELECT op, version FROM sync_outbox WHERE memory_id = ?').get(row.id);
    if (existing?.op === 'delete' && op === 'upsert') return;
    if (existing?.op === op && Number(existing.version) === Number(row.version)) return;
    const document = indexDocument(row, op === 'delete');
    const timestamp = now();
    db.prepare(`
      INSERT INTO sync_outbox
        (memory_id, op, version, payload_json, status, attempts, next_attempt_at,
         last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        op = excluded.op,
        version = excluded.version,
        payload_json = excluded.payload_json,
        status = 'pending',
        attempts = 0,
        next_attempt_at = 0,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(row.id, op, Number(row.version), json(document), timestamp, timestamp);
  }

  function assertScope(row, norm) {
    if (!row
      || row.platform !== norm.platform
      || row.bot_account_id !== norm.botAccountId
      || row.scope_type !== norm.scopeType
      || row.scope_id !== norm.scopeId) {
      fail(ERROR_CODES.NOT_FOUND, '记忆不存在或不在当前会话的授权范围');
    }
    return row;
  }

  function memoryRow(memoryId) {
    return db.prepare('SELECT * FROM memories WHERE id = ?').get(String(memoryId ?? ''));
  }

  function accessibleMemory(norm, memoryId) {
    const row = assertScope(memoryRow(memoryId), norm);
    if (!memoryPeopleAllowed(row, norm)) fail(ERROR_CODES.NOT_FOUND, '记忆不存在或涉及未获授权的人物');
    return row;
  }

  function memoryPeopleAllowed(row, norm) {
    const people = db.prepare(`
      SELECT DISTINCT p.* FROM people p WHERE p.id = ? OR p.id IN
        (SELECT person_id FROM memory_people WHERE memory_id = ?)
    `).all(row.subject_person_id, row.id);
    return people.every((person) => person.platform === norm.platform
      && person.bot_account_id === norm.botAccountId && person.status === 'active'
      && policy.isPersonAllowed(norm.botAccountId, person.user_id));
  }

  // 检查完整依赖链，避免来源过期、撤销或更正后沿用旧画像。
  function memoryUsable(row, norm, timestamp, { proposed = false } = {}, seen = new Set()) {
    if (!row || seen.has(row.id) || row.platform !== norm.platform
      || row.bot_account_id !== norm.botAccountId || row.scope_type !== norm.scopeType || row.scope_id !== norm.scopeId
      || !((row.status === 'active' && row.confirmed === 1) || (proposed && row.status === 'proposed'))
      || Number(row.valid_from) > timestamp || (row.valid_to !== null && Number(row.valid_to) <= timestamp)
      || !memoryPeopleAllowed(row, norm)) return false;
    seen.add(row.id);
    return !row.derived_from_memory_id
      || memoryUsable(memoryRow(row.derived_from_memory_id), norm, timestamp, {}, seen);
  }

  function resolveSubject(norm, subjectUserId, actorPerson) {
    if (subjectUserId === undefined || subjectUserId === null || subjectUserId === '') {
      return norm.conversation.kind === 'private' ? actorPerson.id : null;
    }
    const subject = String(subjectUserId);
    if (subject === norm.actor.userId) return actorPerson.id;
    if (norm.conversation.kind !== 'group') {
      fail(ERROR_CODES.FORBIDDEN, '私聊记忆只能归属于当前对话人物');
    }
    return null;
  }

  function memoryPeople(norm, inputPeople, actorPerson, subjectPersonId) {
    const links = new Map();
    const add = (personId, role) => {
      if (personId) links.set(`${personId}:${role}`, { personId, role });
    };
    add(actorPerson.id, 'speaker');
    if (subjectPersonId) add(subjectPersonId, 'subject');
    for (const item of Array.isArray(inputPeople) ? inputPeople : []) {
      if (!item || !['speaker', 'mentioned', 'quoted', 'participant', 'subject'].includes(item.role)) continue;
      const userId = String(item.userId ?? '');
      if (!userId) continue;
      if (userId === norm.actor.userId) {
        add(actorPerson.id, item.role);
        continue;
      }
      if (norm.conversation.kind !== 'group') continue;
      const participant = maybeEnsureParticipant(norm, userId, item.displayName, item.role);
      add(participant?.id, item.role);
    }
    return [...links.values()];
  }

  function attachSources(memoryId, sources, norm, actorPersonId) {
    for (const source of sources) {
      const messageId = String(source.sourceMessageId ?? '').trim();
      const quote = truncateChars(cleanText(source.quote ?? ''), config.limits.quoteChars);
      if (!messageId || !quote) continue;
      const hash = hashText(`${messageId}\u0001${quote}`);
      db.prepare(`
        INSERT INTO memory_sources
          (memory_id, source_message_id, author_person_id, quote, content_hash, captured_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id, source_message_id, content_hash) DO NOTHING
      `).run(memoryId, messageId, source.authorPersonId ?? actorPersonId, quote, hash, now());
    }
  }

  function createMemoryInternal(norm, {
    content,
    kind = 'fact',
    subjectUserId,
    confirmed = true,
    confidence = 1,
    status = confirmed ? 'active' : 'proposed',
    origin = 'manual',
    sourceMessageId = null,
    quote = null,
    people = [],
    keywords = null,
    occurredAt = now(),
    validForMs = null,
    validTo = null,
    derivedFromMemoryId = null,
    actorPerson
  }) {
    if (!MEMORY_KINDS.has(kind)) fail(ERROR_CODES.INVALID_INPUT, '不支持的记忆类型');
    if (!MEMORY_STATUSES.has(status)) fail(ERROR_CODES.INVALID_INPUT, '不支持的记忆状态');
    const text = nonEmpty(content, config.limits.contentChars, '记忆正文不能为空或过长');
    const occurred = validTimestamp(occurredAt, now());
    const sourceId = sourceMessageId ? String(sourceMessageId) : null;

    if (sourceId) {
      // 遗忘按稳定来源压制重放，不依赖可更正的正文；同来源的后续提案也保守阻止。
      const forgotten = db.prepare(`
        SELECT m.* FROM memories m WHERE m.platform = ? AND m.bot_account_id = ?
          AND m.scope_type = ? AND m.scope_id = ? AND m.status = 'forgotten'
          AND (m.source_message_id = ? OR m.id IN
            (SELECT memory_id FROM memory_sources WHERE source_message_id = ?))
        ORDER BY m.created_at ASC LIMIT 1
      `).get(norm.platform, norm.botAccountId, norm.scopeType, norm.scopeId, sourceId, sourceId);
      if (forgotten) return { row: forgotten, duplicate: true, suppressed: true };
      const duplicate = db.prepare(`
        SELECT * FROM memories
         WHERE platform = ? AND bot_account_id = ? AND scope_type = ? AND scope_id = ?
           AND source_message_id = ? AND kind = ? AND content = ?
         ORDER BY created_at ASC LIMIT 1
      `).get(norm.platform, norm.botAccountId, norm.scopeType, norm.scopeId, sourceId, kind, text);
      if (duplicate) {
        return { row: duplicate, duplicate: true, suppressed: duplicate.status === 'forgotten' };
      }
    }

    const subject = resolveSubject(norm, subjectUserId, actorPerson);
    const memoryId = id('mem_');
    const keywordList = normalizeKeywords(keywords?.length ? keywords : keywordsFrom(text));
    let expiry = validTo === undefined || validTo === null ? null : validTimestamp(validTo, null);
    if (validForMs !== undefined && validForMs !== null) {
      const duration = Number(validForMs);
      if (!Number.isFinite(duration) || duration <= 0) fail(ERROR_CODES.INVALID_INPUT, 'validForMs 必须是正数');
      expiry = occurred + Math.trunc(duration);
    }
    if (expiry !== null && expiry <= occurred) fail(ERROR_CODES.INVALID_INPUT, '有效期必须晚于发生时间');
    if (derivedFromMemoryId) {
      const parent = accessibleMemory(norm, derivedFromMemoryId);
      if (!memoryUsable(parent, norm, now())) fail(ERROR_CODES.CONFLICT, '派生来源必须是当前有效且已确认的记忆');
      if (parent.valid_to !== null) expiry = expiry === null ? Number(parent.valid_to) : Math.min(expiry, Number(parent.valid_to));
      if (expiry !== null && expiry <= occurred) fail(ERROR_CODES.CONFLICT, '派生记忆不能晚于来源失效时间');
    }
    const timestamp = now();
    const confidenceNumber = Number(confidence);
    const confidenceValue = Number.isFinite(confidenceNumber) ? clamp(confidenceNumber, 0, 1) : 0;
    const confirmedValue = confirmed && status === 'active' ? 1 : 0;

    db.prepare(`
      INSERT INTO memories
        (id, platform, bot_account_id, scope_type, scope_id, subject_person_id, kind,
         content, keywords_json, status, confirmed, confidence, origin, source_message_id,
         occurred_at, created_at, updated_at, valid_from, valid_to, version,
         derived_from_memory_id, deleted_at, forget_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL)
    `).run(
      memoryId,
      norm.platform,
      norm.botAccountId,
      norm.scopeType,
      norm.scopeId,
      subject,
      kind,
      text,
      json(keywordList),
      status,
      confirmedValue,
      confidenceValue,
      String(origin),
      sourceId,
      occurred,
      timestamp,
      timestamp,
      occurred,
      expiry,
      derivedFromMemoryId
    );

    for (const link of memoryPeople(norm, people, actorPerson, subject)) {
      db.prepare('INSERT OR IGNORE INTO memory_people (memory_id, person_id, role) VALUES (?, ?, ?)')
        .run(memoryId, link.personId, link.role);
    }

    const sources = [{
      sourceMessageId: sourceId ?? `manual:${memoryId}`,
      quote: quote || text,
      authorPersonId: actorPerson.id
    }];
    attachSources(memoryId, sources, norm, actorPerson.id);

    const row = memoryRow(memoryId);
    if (row.status === 'active' && row.confirmed === 1) queueOutbox(row, 'upsert');
    return { row, duplicate: false, suppressed: false };
  }

  function relationshipView(norm, personId) {
    const view = viewRelationship(db, personId, now(), config);
    const person = db.prepare('SELECT platform,bot_account_id,user_id FROM people WHERE id=?').get(personId);
    const override = person && relationshipPolicy({ platform: person.platform, botAccountId: person.bot_account_id, userId: person.user_id });
    const minimum = config.relationship.tiers.findIndex(tier => tier.name === override?.minimumTier);
    if (minimum < 0) return view;
    const actual = config.relationship.tiers.findIndex(tier => tier.name === view.tier);
    // Explicit operator classification, without inventing scored interactions or rewriting history.
    return { ...view, tier: config.relationship.tiers[Math.max(actual, minimum)].name, minimumTier: override.minimumTier };
  }

  function publicRelationship(norm, personId) {
    const view = relationshipView(norm, personId);
    return view;
  }

  function groupAttitude(personId) {
    const relation = relationshipView(null, personId);
    const index = config.relationship.tiers.findIndex((tier) => tier.name === relation.tier);
    const styles = ['克制', '礼貌', '自然', '亲切', '默契'];
    const guidance = [
      '保持距离，也可以就事论事地反驳，不强行熟络。',
      '可以接公开的梗并推进一小步；不套近乎，也不用事事附和。',
      '顺梗补细节或反转，可以反问、吐槽、轻微互损，不只复述或叫好。',
      '主动顺梗往下演、熟人互损；可以嘴硬和短暂不耐烦，高好感不是讨好。',
      '自然接旧梗、抛新梗、反将一军；怼一句能收住，认真或不舒服时停。'
    ];
    const level = Math.max(0, index);
    return { style: styles[level], guidance: guidance[level] };
  }

  function profileFor(norm, person, aliases) {
    const timestamp = now();
    const facts = db.prepare(`
      SELECT * FROM memories
       WHERE subject_person_id = ? AND status = 'active' AND confirmed = 1
         AND scope_type = ? AND scope_id = ?
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY occurred_at DESC, updated_at DESC LIMIT ?
    `).all(person.id, norm.scopeType, norm.scopeId, timestamp, config.retrieval.candidateLimit)
      .filter((row) => memoryUsable(row, norm, timestamp))
      .slice(0, config.retrieval.maxFacts)
      .map((row) => ({
        memoryId: row.id,
        kind: row.kind,
        content: row.content,
        confidence: Number(row.confidence),
        occurredAt: Number(row.occurred_at)
      }));
    return {
      personId: person.id,
      userId: person.user_id,
      displayName: aliases[0]?.alias ?? person.user_id,
      aliases: aliases.map((item) => item.alias),
      scope: { type: norm.scopeType, id: norm.scopeId },
      facts,
      relationship: norm.conversation.kind === 'private'
        ? publicRelationship(norm, person.id)
        : null,
      attitude: groupAttitude(person.id),
      derived: true,
      note: '人物卡按当前可访问的已确认记忆即时派生；推测/未确认内容不进入画像。'
    };
  }

  function ingestMessage(context, message) {
    const norm = normalizeContext(context);
    const input = requireObject(message, '缺少消息');
    const text = nonEmpty(input.text, config.limits.contentChars, '消息正文不能为空或过长');
    const messageId = String(input.messageId ?? '').trim();
    if (!messageId) fail(ERROR_CODES.INVALID_INPUT, '消息必须有稳定 messageId');
    const mentions = Array.isArray(input.mentions) ? input.mentions.slice(0, config.limits.maxMentions) : [];

    const result = transaction(db, () => {
      const actorPerson = ensurePerson(norm, {
        displayName: norm.actor.displayName,
        aliasSource: norm.conversation.kind === 'group' ? 'group_card' : 'nickname'
      });
      if (actorPerson.status !== 'active') fail(ERROR_CODES.PERSON_DISABLED, '该人物已停用');

      for (const mention of mentions) {
        maybeEnsureParticipant(norm, mention?.userId, mention?.displayName, 'mentioned');
      }
      if (input.quoted?.author?.userId) {
        maybeEnsureParticipant(norm, input.quoted.author.userId, input.quoted.author.displayName, 'quoted');
      }

      const extracted = config.extraction.enabled
        ? (extractor.extract({
            context: {
              platform: norm.platform,
              botAccountId: norm.botAccountId,
              conversation: norm.conversation,
              actor: norm.actor
            },
            message: {
              messageId,
              text,
              mentions,
              quoted: input.quoted ?? null
            }
          }) ?? { interactions: [], memories: [] })
        : { interactions: [], memories: [] };

      const interactions = [];
      for (const proposal of Array.isArray(extracted.interactions) ? extracted.interactions : []) {
        if (!proposal || typeof proposal.kind !== 'string') continue;
        const applied = applyInteraction(db, {
          platform: norm.platform,
          botAccountId: norm.botAccountId,
          personId: actorPerson.id,
          kind: proposal.kind,
          sourceMessageId: messageId,
          memoryId: null,
          evidence: truncateChars(proposal.evidence ?? text, config.limits.evidenceChars),
          occurredAt: now(),
          now: now(),
          config
        });
        interactions.push({
          kind: proposal.kind,
          applied: applied.applied,
          duplicate: applied.duplicate === true,
          ignored: applied.ignored === true,
          reason: applied.reason ?? null,
          deltas: applied.deltas ?? null
        });
      }

      const memories = [];
      const proposals = Array.isArray(extracted.memories) ? extracted.memories.slice(0, config.limits.maxMemoriesPerMessage) : [];
      for (const proposal of proposals) {
        if (!proposal || typeof proposal.content !== 'string') continue;
        const created = createMemoryInternal(norm, {
          content: proposal.content,
          kind: MEMORY_KINDS.has(proposal.kind) ? proposal.kind : 'experience',
          subjectUserId: proposal.subjectUserId ?? null,
          confirmed: false,
          confidence: Number(proposal.confidence) || 0.5,
          status: 'proposed',
          origin: extractor.name ?? 'extractor',
          sourceMessageId: messageId,
          quote: text,
          people: Array.isArray(proposal.people) ? proposal.people : [],
          occurredAt: now(),
          actorPerson
        });
        memories.push({
          memoryId: created.row.id,
          duplicate: created.duplicate,
          suppressed: created.suppressed,
          status: created.row.status,
          kind: created.row.kind
        });
      }
      return {
        personId: actorPerson.id,
        userId: actorPerson.user_id,
        interactions,
        memories
      };
    });
    return result;
  }

  function remember(context, input) {
    const norm = normalizeContext(context);
    const data = requireObject(input, '缺少记忆内容');
    return transaction(db, () => {
      const actorPerson = ensurePerson(norm, {
        displayName: norm.actor.displayName,
        aliasSource: norm.conversation.kind === 'group' ? 'group_card' : 'nickname'
      });
      const created = createMemoryInternal(norm, {
        content: data.content,
        kind: data.kind ?? 'fact',
        subjectUserId: data.subjectUserId,
        confirmed: data.confirmed !== false,
        confidence: data.confidence ?? 1,
        status: data.confirmed === false ? 'proposed' : 'active',
        origin: data.origin ?? 'manual',
        sourceMessageId: data.sourceMessageId ?? null,
        quote: data.quote ?? null,
        people: Array.isArray(data.people) ? data.people : [],
        keywords: Array.isArray(data.keywords) ? data.keywords : null,
        occurredAt: data.occurredAt,
        validForMs: data.validForMs ?? null,
        validTo: data.validTo ?? null,
        derivedFromMemoryId: data.derivedFromMemoryId ?? null,
        actorPerson
      });
      return {
        memory: created.suppressed
          ? memoryTombstone(created.row)
          : mapMemory(created.row),
        duplicate: created.duplicate,
        suppressed: created.suppressed
      };
    });
  }

  function confirmMemory(context, memoryId) {
    const norm = normalizeContext(context);
    return transaction(db, () => {
      requireActiveActor(norm);
      const row = accessibleMemory(norm, memoryId);
      if (row.status === 'forgotten') fail(ERROR_CODES.CONFLICT, '已遗忘的记忆不能确认');
      if (!memoryUsable(row, norm, now(), { proposed: true })) fail(ERROR_CODES.CONFLICT, '记忆或其来源当前无效，不能确认');
      if (row.status === 'active' && row.confirmed === 1) return { memory: mapMemory(row), duplicate: true };
      const timestamp = now();
      db.prepare(`
        INSERT INTO memory_revisions
          (memory_id, version, content, keywords_json, status, changed_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, 'confirm')
      `).run(row.id, row.version, row.content, row.keywords_json, row.status, timestamp);
      db.prepare(`
        UPDATE memories
           SET status = 'active', confirmed = 1, updated_at = ?, version = version + 1
         WHERE id = ?
      `).run(timestamp, row.id);
      const updated = memoryRow(row.id);
      queueOutbox(updated, 'upsert');
      return { memory: mapMemory(updated), duplicate: false };
    });
  }

  function correctMemory(context, memoryId, input) {
    const norm = normalizeContext(context);
    const data = requireObject(input, '缺少更正内容');
    return transaction(db, () => {
      requireActiveActor(norm);
      const row = accessibleMemory(norm, memoryId);
      if (row.status === 'forgotten') fail(ERROR_CODES.CONFLICT, '已遗忘的记忆不能更正');
      const content = nonEmpty(data.content, config.limits.contentChars, '更正后的正文不能为空或过长');
      if (content === row.content && !data.keywords) return { memory: mapMemory(row), duplicate: true };
      const timestamp = now();
      db.prepare(`
        INSERT INTO memory_revisions
          (memory_id, version, content, keywords_json, status, changed_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, row.version, row.content, row.keywords_json, row.status, timestamp, String(data.reason ?? 'correction'));
      const keywords = normalizeKeywords(data.keywords?.length ? data.keywords : keywordsFrom(content));
      db.prepare(`
        UPDATE memories
           SET content = ?, keywords_json = ?, updated_at = ?, version = version + 1
         WHERE id = ?
      `).run(content, json(keywords), timestamp, row.id);
      if (data.sourceMessageId) {
        attachSources(row.id, [{
          sourceMessageId: data.sourceMessageId,
          quote: data.quote ?? content,
          authorPersonId: null
        }], norm, null);
      }
      const updated = memoryRow(row.id);
      if (updated.status === 'active' && updated.confirmed === 1) queueOutbox(updated, 'upsert');
      invalidateDerivedChildren(norm, row.id, 'source_memory_corrected');
      return { memory: mapMemory(updated), duplicate: false };
    });
  }

  function invalidateDerivedChildren(norm, parentId, reason) {
    const children = db.prepare(`
      SELECT * FROM memories
       WHERE derived_from_memory_id = ? AND status <> 'forgotten'
    `).all(parentId);
    for (const child of children) {
      if (child.scope_type !== norm.scopeType || child.scope_id !== norm.scopeId) continue;
      const timestamp = now();
      db.prepare(`
        INSERT INTO memory_revisions
          (memory_id, version, content, keywords_json, status, changed_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(child.id, child.version, child.content, child.keywords_json, child.status, timestamp, reason);
      db.prepare(`
        UPDATE memories
           SET status = 'forgotten', confirmed = 0, deleted_at = ?, forget_reason = ?,
               updated_at = ?, version = version + 1
         WHERE id = ?
      `).run(timestamp, reason, timestamp, child.id);
      const updated = memoryRow(child.id);
      queueOutbox(updated, 'delete');
      revertMemoryLedger(db, child.id, timestamp, config);
      invalidateDerivedChildren(norm, child.id, reason);
    }
  }

  function forgetMemory(context, memoryId, { reason = 'user_request' } = {}) {
    const norm = normalizeContext(context);
    return transaction(db, () => {
      requireActiveActor(norm);
      // 删除不回传正文；同会话获准调用者应能清理涉及已撤销人物的数据。
      const row = assertScope(memoryRow(memoryId), norm);
      if (row.status === 'forgotten') {
        queueOutbox(row, 'delete');
        return { memory: memoryTombstone(row), alreadyForgotten: true };
      }
      const timestamp = now();
      const finalReason = truncateChars(cleanText(reason) || 'user_request', 120);
      db.prepare(`
        INSERT INTO memory_revisions
          (memory_id, version, content, keywords_json, status, changed_at, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, row.version, row.content, row.keywords_json, row.status, timestamp, `forget:${finalReason}`);
      db.prepare(`
        UPDATE memories
           SET status = 'forgotten', confirmed = 0, deleted_at = ?, forget_reason = ?,
               updated_at = ?, version = version + 1
         WHERE id = ?
      `).run(timestamp, finalReason, timestamp, row.id);
      const updated = memoryRow(row.id);
      queueOutbox(updated, 'delete');
      invalidateDerivedChildren(norm, row.id, 'source_memory_forgotten');
      revertMemoryLedger(db, row.id, timestamp, config);
      return { memory: memoryTombstone(updated), alreadyForgotten: false };
    });
  }

  function getMemory(context, memoryId) {
    const norm = normalizeContext(context);
    requireActiveActor(norm);
    const row = accessibleMemory(norm, memoryId);
    if (!memoryUsable(row, norm, now(), { proposed: true })) fail(ERROR_CODES.NOT_FOUND, '记忆不存在或当前不可读');
    const people = db.prepare(`
      SELECT mp.role, p.user_id, p.id AS person_id
        FROM memory_people mp JOIN people p ON p.id = mp.person_id WHERE mp.memory_id = ?
    `).all(row.id).map((item) => ({ personId: item.person_id, userId: item.user_id, role: item.role }));
    return { ...mapMemory(row), people };
  }

  // 仅供可信宿主管理界面使用；普通模型读取不返回遗忘正文、旧版本或证据原文。
  function inspectMemory(context, memoryId) {
    if (!Array.isArray(context?.permissions) || !context.permissions.includes('memory.audit')) {
      fail(ERROR_CODES.FORBIDDEN, '审计读取需要宿主授予 memory.audit 权限');
    }
    const norm = normalizeContext(context);
    requireActiveActor(norm);
    const row = accessibleMemory(norm, memoryId);
    const people = db.prepare(`
      SELECT mp.role, p.user_id, p.id AS person_id
        FROM memory_people mp JOIN people p ON p.id = mp.person_id
       WHERE mp.memory_id = ?
    `).all(row.id).map((item) => ({ personId: item.person_id, userId: item.user_id, role: item.role }));
    const sources = db.prepare(`
      SELECT source_message_id, author_person_id, quote, captured_at
        FROM memory_sources WHERE memory_id = ? ORDER BY id ASC
    `).all(row.id).map((item) => ({
      sourceMessageId: item.source_message_id,
      authorPersonId: item.author_person_id,
      quote: item.quote,
      capturedAt: Number(item.captured_at)
    }));
    const revisions = db.prepare(`
      SELECT version, content, status, changed_at, reason
        FROM memory_revisions WHERE memory_id = ? ORDER BY id ASC
    `).all(row.id).map((item) => ({
      version: Number(item.version),
      content: item.content,
      status: item.status,
      changedAt: Number(item.changed_at),
      reason: item.reason
    }));
    return { ...mapMemory(row), people, sources, revisions };
  }

  function listProposals(context) {
    const norm = normalizeContext(context);
    const person = ensurePerson(norm, { create: false });
    if (!person) return [];
    const timestamp = now();
    return db.prepare(`
      SELECT * FROM memories
       WHERE platform = ? AND bot_account_id = ? AND scope_type = ? AND scope_id = ?
         AND status = 'proposed' AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY updated_at DESC LIMIT 100
    `).all(norm.platform, norm.botAccountId, norm.scopeType, norm.scopeId, timestamp)
      .filter((row) => memoryUsable(row, norm, timestamp, { proposed: true }))
      .map(mapMemory);
  }

  function getProfile(context) {
    const norm = normalizeContext(context);
    const person = ensurePerson(norm, { create: false });
    if (!person) return null;
    const aliases = aliasesFor(person.id, norm);
    return profileFor(norm, person, aliases);
  }

  function getRelationship(context) {
    const norm = normalizeContext(context);
    return transaction(db, () => {
      const person = ensurePerson(norm);
      return {
        personId: person.id,
        userId: person.user_id,
        relationship: publicRelationship(norm, person.id)
      };
    });
  }

  function recordInteraction(context, input) {
    const norm = normalizeContext(context);
    const data = requireObject(input, '缺少互动事件');
    return transaction(db, () => {
      const person = ensurePerson(norm);
      const sourceMessageId = String(data.sourceMessageId ?? '').trim();
      const evidence = String(data.evidence ?? '').trim();
      if (!sourceMessageId) fail(ERROR_CODES.INVALID_INPUT, '互动事件必须有来源消息编号');
      if (!evidence) fail(ERROR_CODES.INVALID_INPUT, '互动事件必须有证据文本');
      let memoryId = null;
      if (data.memoryId) {
        const linked = accessibleMemory(norm, data.memoryId);
        if (linked.status === 'forgotten') fail(ERROR_CODES.CONFLICT, '不能把新互动挂到已遗忘的记忆上');
        memoryId = linked.id;
      }
      const result = applyInteraction(db, {
        platform: norm.platform,
        botAccountId: norm.botAccountId,
        personId: person.id,
        kind: data.kind,
        sourceMessageId,
        memoryId,
        evidence: truncateChars(evidence, config.limits.evidenceChars),
        occurredAt: validTimestamp(data.occurredAt, now()),
        now: now(),
        config
      });
      return {
        applied: result.applied,
        duplicate: result.duplicate === true,
        ignored: result.ignored === true,
        reason: result.reason ?? null,
        eventId: result.eventId ?? null,
        deltas: result.deltas ?? null,
        factor: result.factor ?? null,
        relationship: publicRelationship(norm, person.id)
      };
    });
  }

  function retrieveContext(context, { query = '', budget = config.retrieval.defaultBudget } = {}) {
    const norm = normalizeContext(context);
    const timestamp = now();
    const person = ensurePerson(norm, { create: false });
    if (!person) {
      return {
        text: '',
        budget: config.retrieval.defaultBudget,
        used: 0,
        items: [],
        personId: null,
        scope: { type: norm.scopeType, id: norm.scopeId }
      };
    }
    const aliases = aliasesFor(person.id, norm);
    const requestedBudget = Number(budget);
    const effectiveBudget = clamp(
      Number.isFinite(requestedBudget) ? requestedBudget : config.retrieval.defaultBudget,
      config.retrieval.minBudget,
      config.retrieval.maxBudget
    );
    const relationship = norm.conversation.kind === 'private'
      ? publicRelationship(norm, person.id)
      : null;
    const rows = db.prepare(`
      SELECT * FROM memories
       WHERE platform = ? AND bot_account_id = ? AND scope_type = ? AND scope_id = ?
         AND status = 'active' AND confirmed = 1
         AND (valid_to IS NULL OR valid_to > ?)
       ORDER BY updated_at DESC
       LIMIT ?
    `).all(
      norm.platform,
      norm.botAccountId,
      norm.scopeType,
      norm.scopeId,
      timestamp,
      config.retrieval.candidateLimit
    ).filter((row) => memoryUsable(row, norm, timestamp));
    const attitude = groupAttitude(person.id);
    const pack = buildContextPack({
      kind: norm.conversation.kind,
      person: {
        displayName: aliases[0]?.alias ?? person.user_id,
        userId: person.user_id
      },
      aliases: aliases.map((item) => item.alias),
      relationship,
      attitude,
      memories: rows,
      query: String(query ?? '').slice(0, 200),
      budget: effectiveBudget,
      now: timestamp,
      config
    });
    return {
      ...pack,
      personId: person.id,
      userId: person.user_id,
      scope: { type: norm.scopeType, id: norm.scopeId },
      relationship,
      attitude
    };
  }

  function setPersonStatus(botAccountId, userId, status) {
    if (!['active', 'disabled'].includes(status)) fail(ERROR_CODES.INVALID_INPUT, '人物状态只能是 active 或 disabled');
    const bot = String(botAccountId ?? '');
    const user = String(userId ?? '');
    if (!policy.isPersonAllowed(bot, user)) fail(ERROR_CODES.FORBIDDEN, '该人物不在允许名单');
    const row = db.prepare(`
      SELECT * FROM people WHERE platform = ? AND bot_account_id = ? AND user_id = ?
    `).get(config.platform, bot, user);
    if (!row) fail(ERROR_CODES.NOT_FOUND, '人物尚未建档');
    db.prepare('UPDATE people SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(status, now(), row.id);
    return { personId: row.id, userId: user, status };
  }

  function outboxState() {
    return db.prepare(`
      SELECT memory_id, op, version, status, attempts, next_attempt_at, last_error
        FROM sync_outbox ORDER BY id ASC
    `).all().map((row) => ({
      memoryId: row.memory_id,
      op: row.op,
      version: Number(row.version),
      status: row.status,
      attempts: Number(row.attempts),
      nextAttemptAt: Number(row.next_attempt_at),
      lastError: row.last_error ?? null
    }));
  }

  let syncInFlight = null;
  function syncOutbox(options = {}) {
    if (syncInFlight) return syncInFlight;
    syncInFlight = syncBatch(options);
    syncInFlight.then(() => { syncInFlight = null; }, () => { syncInFlight = null; });
    return syncInFlight;
  }

  async function syncBatch({ limit = config.sync.batchSize, force = false } = {}) {
    const batchLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit) || config.sync.batchSize)));
    const timestamp = now();
    transaction(db, () => {
      const expired = db.prepare("SELECT * FROM memories WHERE status IN ('active', 'proposed') AND valid_to <= ?").all(timestamp);
      const seen = new Set();
      const expire = (row) => {
        if (seen.has(row.id)) return;
        seen.add(row.id);
        queueOutbox(row, 'delete');
        const children = db.prepare("SELECT * FROM memories WHERE derived_from_memory_id = ? AND status IN ('active', 'proposed')").all(row.id);
        for (const child of children) expire(child);
      };
      // 同时处理 v1 遗留的无继承期限子记录，不只依赖新建记录的 valid_to。
      for (const row of expired) expire(row);
    });
    const due = force
      ? db.prepare("SELECT * FROM sync_outbox WHERE status = 'pending' ORDER BY id ASC LIMIT ?").all(batchLimit)
      : db.prepare("SELECT * FROM sync_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?")
        .all(timestamp, batchLimit);
    const details = [];
    for (const outbox of due) {
      const row = memoryRow(outbox.memory_id);
      let op = outbox.op;
      let document;
      let version = Number(outbox.version);
      if (row) {
        version = Number(row.version);
        if (row.status === 'forgotten' || outbox.op === 'delete') {
          op = 'delete';
          document = indexDocument(row, true);
        } else {
          op = 'upsert';
          document = indexDocument(row, false);
          const norm = { platform: row.platform, botAccountId: row.bot_account_id, scopeType: row.scope_type, scopeId: row.scope_id };
          if (!policy.isBotConfigured(norm.botAccountId)
            || (norm.scopeType === 'group' && !policy.isGroupAllowed(norm.botAccountId, norm.scopeId.slice(6)))
            || !memoryUsable(row, norm, now())) {
            updateFailure(outbox, '记忆当前未获授权或未生效，暂停同步', now());
            details.push({ memoryId: row.id, ok: false, skipped: true });
            continue;
          }
        }
      } else {
        document = parseJson(outbox.payload_json, null);
        if (!document) {
          updateFailure(outbox, 'outbox 载荷损坏', timestamp);
          details.push({ memoryId: outbox.memory_id, ok: false, error: 'payload' });
          continue;
        }
      }

      try {
        if (op === 'delete') await adapter.delete(document);
        else await adapter.upsert(document);
        const acknowledged = db.prepare(`
          UPDATE sync_outbox
             SET op = ?, version = ?, payload_json = ?, status = 'done',
                 attempts = attempts + 1, last_error = NULL, updated_at = ?
           WHERE id = ? AND version = ? AND op = ? AND status = 'pending'
        `).run(op, version, json(document), now(), outbox.id, outbox.version, outbox.op);
        details.push({ memoryId: outbox.memory_id, ok: true, op, version, superseded: acknowledged.changes === 0 });
      } catch (error) {
        updateFailure(outbox, error.message, now());
        details.push({
          memoryId: outbox.memory_id,
          ok: false,
          op,
          version,
          error: String(error.message ?? error)
        });
      }
    }
    const pending = db.prepare("SELECT COUNT(*) AS count FROM sync_outbox WHERE status = 'pending'").get();
    return {
      attempted: details.filter((item) => !item.skipped).length,
      skipped: details.filter((item) => item.skipped).length,
      succeeded: details.filter((item) => item.ok).length,
      failed: details.filter((item) => !item.ok && !item.skipped).length,
      pending: Number(pending?.count ?? 0),
      details
    };
  }

  function updateFailure(outbox, message, timestamp) {
    const attempts = Number(outbox.attempts) + 1;
    const exponent = Math.min(attempts, config.sync.maxAttemptsBeforeSlowRetry);
    const delay = Math.min(config.sync.maxBackoffMs, config.sync.baseBackoffMs * (2 ** exponent));
    db.prepare(`
      UPDATE sync_outbox
         SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND version = ? AND op = ? AND status = 'pending'
    `).run(attempts, timestamp + delay, truncateChars(String(message ?? '同步失败'), 300), timestamp, outbox.id, outbox.version, outbox.op);
  }

  return {
    policy,
    adapter,
    config,
    ingestMessage,
    remember,
    confirmMemory,
    correctMemory,
    forgetMemory,
    getMemory,
    inspectMemory,
    getProfile,
    getRelationship,
    listProposals,
    recordInteraction,
    retrieveContext,
    setPersonStatus,
    syncOutbox,
    outboxState,
    close() {
      db.close();
    }
  };
}
