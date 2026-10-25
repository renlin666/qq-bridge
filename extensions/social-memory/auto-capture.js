import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SENSITIVE_RE } from '../../src/sensitive.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = value => String(value).normalize('NFKC').toLowerCase().replace(/[\s，。！？、；,.!?;]/g, '').replace(/^我/, '');
const UNSAFE = /https?:\/\/|```|\[引用|\[合并转发|\[转发|<\/?(?:system|script)|(?:^|\n)\s*>|提示词|系统指令|忽略.{0,8}(规则|指令)|假装|执行命令|(?:他说|她说|据说|转述|如果|假如|比如|例如)/i;
const PRIVATE = /身份证|手机号|电话号码|银行卡|住址|家庭地址|诊断|病历|抑郁|癌症|性取向|性生活|宗教信仰|政治立场|收入|工资|账户余额/;
const PREFERENCE = /^我(?:(?:平时|一直|比较|特别|最|很|更|不太|并不|不|也|真的|其实|个人){0,3})(?:喜欢|讨厌|偏爱|爱好是|的爱好是|的兴趣是|主玩|常玩|经常玩|擅长).{2,100}$/u;
const FACT = /^我(?:(?:最近|目前|现在|正在|平时|一直|已经|也){0,2})(?:在学(?!校|院|堂|术|生)|学习|在准备|准备考|在做|用的是|使用的是|常用|习惯用|的专业是|是.{1,16}专业的).{2,100}$/u;

// High precision statements are saved verbatim. No LLM guesses, scoring or paid extraction call.
export function extractSelfStatements(text) {
  const input = String(text ?? '').trim();
  if (!input || input.length > 2000 || UNSAFE.test(input) || SENSITIVE_RE.test(input) || PRIVATE.test(input)) return [];
  const result = [];
  for (let content of input.split(/[。！!；;\n]+/u)) {
    content = content.trim().replace(/^(?:请)?记住(?:一下)?[，,：:\s]*/u, '').replace(/[，,\s]+$/u, '');
    if (content.length < 5 || content.length > 140 || /[？?]|[“”「」『』"]|…|\.\.\.|\[.*截断/.test(content)
      || /(?:你|他|她)(?:说|觉得|要求)|你(?:也|会|能|要)|开玩笑|骗你的|才怪|才有鬼|并非|以前|曾经|不再|好像|可能|大概|做饭|吃饭|睡觉|上厕所|洗澡|准备睡/.test(content)) continue;
    const kind = PREFERENCE.test(content) ? 'preference' : FACT.test(content) ? 'fact' : null;
    if (!kind || /^(?:我很喜欢你|我喜欢你|我不喜欢你|我讨厌你)/u.test(content)) continue;
    result.push({ content, evidence: content, kind, confirmed: true });
    if (result.length === 3) break;
  }
  return result;
}

export function createAutoCapture(file, { now = Date.now } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS capture_decisions (
      id TEXT PRIMARY KEY, bot TEXT NOT NULL, scope TEXT NOT NULL, user TEXT NOT NULL,
      source_id TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
      memory_ids TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS captured_facts (
      fingerprint TEXT PRIMARY KEY, memory_id TEXT NOT NULL, bot TEXT NOT NULL, scope TEXT NOT NULL, user TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS observed_speakers (
      bot TEXT NOT NULL,scope TEXT NOT NULL,user TEXT NOT NULL,last_seen INTEGER NOT NULL,PRIMARY KEY(bot,scope,user));
    CREATE INDEX IF NOT EXISTS capture_at ON capture_decisions(at);`);
  const eventId = (key, message) => hash([message.botAccountId, key, message.messageId]);
  function record(key, message, status, reason, ids = []) {
    db.prepare('INSERT OR IGNORE INTO capture_decisions VALUES (?,?,?,?,?,?,?,?,?)').run(eventId(key, message),
      String(message.botAccountId), key, String(message.userId), String(message.messageId), now(), status, reason, JSON.stringify(ids));
    db.exec('DELETE FROM capture_decisions WHERE id IN (SELECT id FROM capture_decisions ORDER BY at DESC LIMIT -1 OFFSET 10000)');
    return { status, reason, memoryIds: ids };
  }
  async function process(message, call, service, trustedContext) {
    const key = call.key;
    if (!message?.messageId || !message.userId || !message.botAccountId || message.isSelf) return { status: 'ignored' };
    const old = db.prepare('SELECT status,reason,memory_ids FROM capture_decisions WHERE id=?').get(eventId(key, message));
    call.assertAuthorized();
    if (old && !(trustedContext && old.reason === 'person_or_scope_not_authorized')) return { status: old.status, reason: old.reason, duplicateEvent: true, memoryIds: JSON.parse(old.memory_ids) };
    if (old) db.prepare('DELETE FROM capture_decisions WHERE id=?').run(eventId(key, message));
    if (!trustedContext) return record(key, message, 'skipped', 'person_or_scope_not_authorized');
    const candidates = extractSelfStatements(message.plain ?? message.text);
    if (!candidates.length) return record(key, message, 'skipped', 'no_safe_explicit_self_statement');
    const ids = []; let added = 0;
    for (const item of candidates) {
      const fingerprint = hash([message.botAccountId, key, message.userId, item.kind, normalize(item.content)]);
      const prior = db.prepare('SELECT memory_id FROM captured_facts WHERE fingerprint=?').get(fingerprint);
      if (prior) { ids.push(prior.memory_id); continue; }
      call.assertAuthorized();
      const quote = String(message.plain ?? message.text);
      if (!quote.includes(item.evidence)) throw new Error('自动记忆缺少逐字原话证据');
      const saved = service.remember(trustedContext, { ...item, subjectUserId: String(message.userId),
        sourceMessageId: String(message.messageId), quote:item.evidence, origin: message.memoryReplay ? 'history-self-statement' : 'automatic-self-statement',
        occurredAt: Number(message.time) || now(), confidence: 0.9, deduplicate: true,
        ...(/最近|目前|现在|正在|准备|在学/.test(item.content) ? { validForMs: 90 * 86400000 } : {}) });
      if (saved.suppressed) continue; // A forgotten source must never be revived by replay.
      ids.push(saved.memory.memoryId);
      db.prepare('INSERT OR IGNORE INTO captured_facts VALUES (?,?,?,?,?)').run(fingerprint, saved.memory.memoryId,
        String(message.botAccountId), key, String(message.userId));
      if (!saved.duplicate) added++;
    }
    await service.syncOutbox(); call.assertAuthorized();
    return record(key, message, added ? 'stored' : ids.length ? 'duplicate' : 'suppressed',
      added ? 'explicit_self_statement_with_source' : ids.length ? 'fact_already_stored' : 'source_forgotten', ids);
  }
  return { process,
    observe(bot,scope,user) {
      db.prepare('INSERT INTO observed_speakers VALUES (?,?,?,?) ON CONFLICT(bot,scope,user) DO UPDATE SET last_seen=excluded.last_seen').run(String(bot),scope,String(user),now());
    },
    people(bot,groups) {
      const allowed=new Set(groups.map(id=>'group:'+id));
      return [...new Set(db.prepare('SELECT scope,user FROM observed_speakers WHERE bot=?').all(String(bot)).filter(r=>allowed.has(r.scope)).map(r=>r.user))];
    },
    find(key, message, content) {
      for (const kind of ['fact', 'preference', 'experience']) {
        const fingerprint = hash([message.botAccountId, key, message.userId, kind, normalize(content)]);
        const row = db.prepare('SELECT memory_id FROM captured_facts WHERE fingerprint=?').get(fingerprint);
        if (row) return row.memory_id;
      }
      return null;
    },
    close() { db.close(); } };
}
