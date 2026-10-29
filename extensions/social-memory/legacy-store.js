import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { keywordsFrom, tokenize } from '../../lib/social-memory/src/text.js';

export const legacyMemoryId = (bot, scope, origin, sourceId) => 'legacy:' + crypto.createHash('sha256').update(JSON.stringify([bot, scope, origin, String(sourceId)])).digest('hex');

export function indexMatches(index, query) {
  const tokens = tokenize(query);
  return !tokens.length || tokens.some(token => index.keywords.includes(token));
}

// A separate conversation archive: imported nickname impressions never become person profiles.
export class LegacyMemoryStore {
  constructor(directory) {
    this.db = new DatabaseSync(path.join(directory, 'legacy-memory.db'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS legacy_memory (id TEXT PRIMARY KEY, bot TEXT NOT NULL, scope TEXT NOT NULL,
        origin TEXT NOT NULL, content TEXT NOT NULL, keywords TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);`);
  }
  sync(bot, scope, entries) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE legacy_memory SET active=0 WHERE bot=? AND scope=? AND origin NOT IN ('daily-diary','daily-diary-all')").run(bot, scope);
      const upsert = this.db.prepare(`INSERT INTO legacy_memory VALUES (?,?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content,keywords=excluded.keywords,active=1`);
      for (const entry of entries) {
        const id = legacyMemoryId(bot, scope, entry.origin, entry.sourceId);
        upsert.run(id, bot, scope, entry.origin, entry.content, JSON.stringify(keywordsFrom(entry.content)));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  query(bot, scope, query = '') {
    const tokens = tokenize(query);
    return this.db.prepare('SELECT id,origin,keywords FROM legacy_memory WHERE bot=? AND scope=? AND active=1')
      .all(bot, scope).map(row => ({ memoryId: row.id, origin: row.origin, keywords: JSON.parse(row.keywords), scope: { id: scope }, identityBound: false }))
      .map(index => ({ index, score: tokens.filter(token => index.keywords.includes(token)).length }))
      .filter(item => !tokens.length || item.score > 0).sort((a, b) => b.score - a.score || a.index.memoryId.localeCompare(b.index.memoryId))
      .slice(0, 5).map(item => item.index);
  }
  addDiary(bot, scope, date, content, { combined = false } = {}) {
    if (!/^private:[1-9]\d+$/.test(scope) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || typeof content !== 'string' || !content.trim() || content.length > 24000) throw new Error('日记格式或私聊范围无效');
    const origin = combined ? 'daily-diary-all' : 'daily-diary';
    const id = legacyMemoryId(bot, scope, origin, date);
    // A diary is the bot's historical summary, never a confirmed person fact.
    this.db.prepare('INSERT OR IGNORE INTO legacy_memory VALUES (?,?,?,?,?,?,1)')
      .run(id, bot, scope, origin, content, JSON.stringify(keywordsFrom(content)));
    return id;
  }
  read(bot, scope, id) {
    const row = this.db.prepare('SELECT * FROM legacy_memory WHERE id=? AND bot=? AND scope=? AND active=1').get(id, bot, scope);
    if (!row) throw new Error('旧记忆已移除、过期或不在当前会话范围内');
    return { memoryId: row.id, origin: row.origin, content: row.content, identityBound: false,
      note: ['daily-diary', 'daily-diary-all'].includes(row.origin) ? '机器人私有日记，基于留存片段的整理与感受，不是人物已确认事实，不用于关系评分。'
        : '旧会话资料，未经重新核实；昵称不能作为真实人物身份或关系评分依据。' };
  }
  documents(bot, scope) {
    return this.db.prepare('SELECT * FROM legacy_memory WHERE bot=? AND scope=? AND active=1').all(bot, scope)
      .map(row => ({ memoryId: row.id, version: 1, text: row.content,
        index: { memoryId: row.id, origin: row.origin, keywords: JSON.parse(row.keywords), scope: { id: scope }, identityBound: false } }));
  }
  close() { this.db.close(); }
}
