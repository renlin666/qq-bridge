import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MockIndexAdapter } from '../../lib/social-memory/src/index-adapter.js';

// Uses the validated index contract, but stores documents and tombstones across restarts.
export class PersistentIndexAdapter extends MockIndexAdapter {
  constructor(file) {
    super();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS keyword_index (id TEXT PRIMARY KEY, deleted INTEGER NOT NULL, payload TEXT NOT NULL);');
    for (const row of this.db.prepare('SELECT * FROM keyword_index').all()) {
      (row.deleted ? this.tombstones : this.documents).set(row.id, JSON.parse(row.payload));
    }
  }
  persist(document, deleted) {
    this.db.prepare('INSERT INTO keyword_index VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET deleted=excluded.deleted,payload=excluded.payload')
      .run(document.memoryId, deleted ? 1 : 0, JSON.stringify(document));
    if (this.operations.length > 100) this.operations.splice(0, this.operations.length - 100);
  }
  async upsert(document) { const result = await super.upsert(document); this.persist(this.get(document.memoryId), false); return result; }
  async delete(document) {
    const result = await super.delete(document);
    this.persist(this.tombstones.get(document.memoryId), true);
    return result;
  }
  close() { this.db.close(); }
}
