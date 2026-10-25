import { DatabaseSync } from 'node:sqlite';

export const POLICY_KINDS = new Set(['banter_preference', 'resolve_conflict']);
// Only narrow first-person declarations are confirmed automatically. Quoted,
// hypothetical and third-person material requires clarification, not inference.
export function explicitPreference(text) {
  const value = String(text ?? '').trim();
  if (value.length > 160 || /[“”"「」?？]|他说|她说|比如|举例|假如|如果|才怪|并不|不代表|不一定|(?:吗|么)[。！!]*$/.test(value)) return null;
  if (/^(?:请)?(?:别|不要|别再).*(?:拿我|对我|跟我|和我).*(?:开玩笑|互损|玩梗|调侃)|^我不喜欢.*(?:互损|调侃|拿我开玩笑)/.test(value)) return 'stop';
  if (/不喜欢|不接受|不是|才不|今天不|现在不|不行/.test(value)) return null;
  if (/^(?:我接受|我喜欢|我可以接受|咱们可以|我们可以).*(?:互损|互相调侃)/.test(value)) return 'mutual';
  if (/^(?:我接受|我喜欢|我可以接受|你可以跟我|你可以和我).*(?:轻松的玩笑|轻微调侃|适度玩笑|开点玩笑)/.test(value)) return 'light';
  return null;
}

// Durable preferences/conflict state and dedupe live separately from transient
// TTL reactions. Restart, idle cleanup and a high-affinity floor cannot erase them.
export function createSocialPolicy(filename, now = Date.now) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS social_policy_events (
      bot TEXT NOT NULL, scope TEXT NOT NULL, user TEXT NOT NULL, source TEXT NOT NULL,
      kind TEXT NOT NULL, at INTEGER NOT NULL, value TEXT,
      PRIMARY KEY(bot,scope,user,source,kind));
    CREATE TABLE IF NOT EXISTS social_policy_state (
      bot TEXT NOT NULL, scope TEXT NOT NULL, user TEXT NOT NULL,
      preference TEXT, preference_source TEXT, conflict TEXT, conflict_source TEXT,
      PRIMARY KEY(bot,scope,user));`);
  const get = (bot, scope, user) => db.prepare('SELECT * FROM social_policy_state WHERE bot=? AND scope=? AND user=?').get(bot, scope, user);
  return {
    record(bot, scope, user, source, kind, { text = '', preference, sourceAt = now() } = {}) {
      if (!['banter', 'banter_preference', 'conflict', 'boundary_violation', 'repair', 'resolve_conflict'].includes(kind)) return null;
      if (kind === 'banter_preference' && (!preference || explicitPreference(text) !== preference)) throw new Error('互损偏好需要本人明确自述；不能根据好感度或引用确认');
      if (kind === 'resolve_conflict' && (/[“”"「」?？]|他说|她说|比如|举例|假如|如果|才怪|不代表|(?:吗|么)[。！!]*$/.test(text)
        || !/^(?:没关系|没事了|这事翻篇|我们和好|咱们和好|我原谅你)/.test(text.trim()))) throw new Error('解除隔阂需要本人明确表示翻篇或和好');
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db.prepare('SELECT 1 FROM social_policy_events WHERE bot=? AND scope=? AND user=? AND source=? AND kind=?').get(bot, scope, user, source, kind);
        if (prior) { db.exec('COMMIT'); return { applied: false, duplicate: true }; }
        const category = kind === 'banter_preference' ? "kind='banter_preference'" : "kind IN ('conflict','boundary_violation','repair','resolve_conflict')";
        const latest = db.prepare(`SELECT MAX(at) AS at FROM social_policy_events WHERE bot=? AND scope=? AND user=? AND ${category}`).get(bot, scope, user).at;
        if (kind !== 'banter' && latest !== null && sourceAt < latest) {
          db.exec('COMMIT'); return { applied: false, ignored: true, reason: 'stale_source' };
        }
        const insert = db.prepare('INSERT OR IGNORE INTO social_policy_events VALUES(?,?,?,?,?,?,?)').run(bot, scope, user, source, kind, sourceAt, preference ?? null);
        if (!insert.changes) { db.exec('COMMIT'); return { applied: false, duplicate: true }; }
        const old = get(bot, scope, user);
        let conflict = old?.conflict ?? null;
        if (kind === 'boundary_violation') conflict = 'distant';
        else if (kind === 'conflict' && conflict !== 'distant') conflict = 'guarded';
        else if (kind === 'repair' && conflict) conflict = 'repairing';
        else if (kind === 'resolve_conflict') conflict = 'resolved';
        db.prepare(`INSERT INTO social_policy_state VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(bot,scope,user) DO UPDATE SET preference=excluded.preference,
          preference_source=excluded.preference_source,conflict=excluded.conflict,conflict_source=excluded.conflict_source`)
          .run(bot, scope, user, kind === 'banter_preference' ? preference : old?.preference ?? null,
            kind === 'banter_preference' ? source : old?.preference_source ?? null,
            conflict, ['banter_preference', 'banter'].includes(kind) ? old?.conflict_source ?? null : source);
        db.exec('COMMIT'); return { applied: true, duplicate: false };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    compile(bot, scope, user, attitude, reaction) {
      const state = get(bot, scope, user);
      const observed = db.prepare("SELECT COUNT(*) AS n FROM social_policy_events WHERE bot=? AND scope=? AND user=? AND kind='banter'").get(bot, scope, user).n;
      const preference = state?.preference ?? (observed >= 3 ? 'light' : 'unknown');
      const conflict = state?.conflict === 'resolved' ? null : state?.conflict ?? (attitude?.caution ? 'guarded' : null);
      const blocked = preference === 'stop' || !!conflict || reaction?.kind === 'serious';
      const stageGuide = {
        '初识': '接公开的梗可以推进一小步，不假装已有共同经历。',
        '认识': '回应已确认的兴趣线索，接梗补一个具体细节，可自然追问。',
        '熟络': '主动沿梗多演一步、补反转，也可以反将一军，不只附和叫好。',
        '亲近': '熟人可以主动接话、嘴硬或就事怼一句；高好感不是讨好。',
        '深交': '有已证实的共同经历才接旧梗，也会主动抛新梗；有分歧直说，能收住。'
      }[attitude?.stage] ?? '';
      const guidance = blocked
        ? '停止对人的互损；认真回应当前事情，可就事论事表达不满。道歉可缓和语气，不抹掉信任变化，不牵连别人。'
        : preference === 'mutual'
          ? '对方明确接受互损：顺当前梗补细节、反转或反将一军，能收住；高好感不是讨好，不编共同经历。'
          : preference === 'light' ? '调侃保持轻微，随时观察对方反应；不升级为互损。'
            : '尚未确认玩笑偏好，先接公开的梗，不擅自升级为互损。';
      return { attitude: { stage: attitude?.stage, style: attitude?.style, banter: preference,
        preferenceConfirmed: !!state?.preference, ...(conflict ? { conflict } : {}), guidance: blocked ? guidance : stageGuide + guidance },
        ...(reaction && !(blocked && reaction.kind === 'banter') ? { reaction } : {}) };
    },
    close() { db.close(); }
  };
}
