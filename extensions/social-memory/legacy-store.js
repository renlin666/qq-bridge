import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { keywordsFrom, tokenize } from '../../lib/social-memory/src/text.js';

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
      this.db.prepare('UPDATE legacy_memory SET active=0 WHERE bot=? AND scope=?').run(bot, scope);
      const upsert = this.db.prepare(`INSERT INTO legacy_memory VALUES (?,?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content,keywords=excluded.keywords,active=1`);
      for (const entry of entries) {
        const id = 'legacy:' + crypto.createHash('sha256').update(JSON.stringify([bot, scope, entry.origin, entry.sourceId])).digest('hex');
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
  read(bot, scope, id) {
    const row = this.db.prepare('SELECT * FROM legacy_memory WHERE id=? AND bot=? AND scope=? AND active=1').get(id, bot, scope);
    if (!row) throw new Error('旧记忆已移除、过期或不在当前会话范围内');
    return { memoryId: row.id, origin: row.origin, content: row.content, identityBound: false,
      note: '旧会话资料，未经重新核实；昵称不能作为真实人物身份或关系评分依据。' };
  }
  close() { this.db.close(); }
}
