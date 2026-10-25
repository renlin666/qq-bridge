import { tokenize } from './text.js';

// Topic labels are retrieval hints, never conversation/identity permissions.
const TOPICS = {
  game: /游戏|开黑|排位|原神|星铁|抽卡|steam|counter.strike|\bcs2?\b/i,
  reading: /阅读|文章|小说|书籍|视频|b站|bilibili|链接|字幕/i,
  study: /学习|在学|专业|课程|考试|作业|论文|plc|自动化/i,
  work: /工作|项目|上班|同事|开发|编程/i,
  daily: /喜欢|讨厌|习惯|口头禅|口癖|喝茶|咖啡|饮食|相处/i
};
export const TOPIC_NAMES = Object.freeze(Object.keys(TOPICS));
// Preserve decimal points and signs: -1/1 and 1.5/15 must never be merged.
export const contentKey = value => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[\s，。！？、；,!?;“”「」『』"']+/gu, '').replace(/[.!?]+$/u,'');
export const topicsFor = value => Object.entries(TOPICS).filter(([, rule]) => rule.test(String(value))).map(([topic]) => topic);

// tokenize() intentionally caps prompt keywords. Index every bounded body chunk
// so a distinctive word near the end of a long memory remains searchable.
export function searchTerms(content, keywords = []) {
  const chars = Array.from(String(content));
  const terms = new Set(keywords.flatMap(tokenize));
  for (let at = 0; at < chars.length; at += 39) for (const term of tokenize(chars.slice(at, at + 40).join(''))) terms.add(term);
  for (const term of tokenize(content)) terms.add(term);
  return [...terms];
}

export function openSearchIndex(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_search_documents (
    memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    content_key TEXT NOT NULL,topics_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_memory_content_key ON memory_search_documents(content_key);
    CREATE TABLE IF NOT EXISTS memory_search_terms (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,token TEXT NOT NULL,
      PRIMARY KEY(memory_id,token));
    CREATE INDEX IF NOT EXISTS idx_memory_search_token ON memory_search_terms(token,memory_id);`);
  const upsert = db.prepare(`INSERT INTO memory_search_documents VALUES(?,?,?) ON CONFLICT(memory_id)
    DO UPDATE SET content_key=excluded.content_key,topics_json=excluded.topics_json`);
  const insert = db.prepare('INSERT OR IGNORE INTO memory_search_terms VALUES(?,?)');
  const clear = db.prepare('DELETE FROM memory_search_terms WHERE memory_id=?');
  function update(row) {
    upsert.run(row.id, contentKey(row.content), JSON.stringify(topicsFor(row.content)));
    clear.run(row.id);
    for (const token of searchTerms(row.content, JSON.parse(row.keywords_json || '[]'))) insert.run(row.id, token);
  }
  // Additive, transactional backfill; original records, evidence and reviews stay intact.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare(`SELECT m.* FROM memories m LEFT JOIN memory_search_documents s ON s.memory_id=m.id
      WHERE s.memory_id IS NULL`).iterate()) update(row);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { update };
}
