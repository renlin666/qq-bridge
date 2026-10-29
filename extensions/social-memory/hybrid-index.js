import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
export const retrievalNamespace = trusted => JSON.stringify([
  trusted.platform, String(trusted.botAccountId), trusted.conversation.id, String(trusted.actor.userId)
]);
export class HybridMemoryIndex {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS embeddings (
        namespace TEXT NOT NULL,memory_id TEXT NOT NULL,content_hash TEXT NOT NULL,
        vector BLOB,updated_at INTEGER NOT NULL,PRIMARY KEY(namespace,memory_id));`);
    this.pending = new Map();
    this.queryVectors = new Map();
    this.running = false;
    this.closed = false;
    this.stats = { embedded: 0, queries: 0, semanticHits: 0, failures: 0 };
  }
  sync(trusted, documents) {
    const ns = retrievalNamespace(trusted), allowed = new Set(documents.map(d => d.memoryId));
    const rows = this.db.prepare('SELECT memory_id,content_hash,vector IS NOT NULL AS ready FROM embeddings WHERE namespace=?').all(ns);
    const old = new Map(rows.map(r => [r.memory_id, r]));
    const remove = this.db.prepare('DELETE FROM embeddings WHERE namespace=? AND memory_id=?');
    for (const row of rows) if (!allowed.has(row.memory_id)) { remove.run(ns, row.memory_id); this.pending.delete(ns + ':' + row.memory_id); }
    const upsert = this.db.prepare(`INSERT INTO embeddings VALUES(?,?,?,NULL,?) ON CONFLICT(namespace,memory_id)
      DO UPDATE SET content_hash=excluded.content_hash,vector=NULL,updated_at=excluded.updated_at`);
    for (const doc of documents) {
      const digest = hash(doc.text), previous = old.get(doc.memoryId), id = ns + ':' + doc.memoryId;
      if (previous?.content_hash === digest && previous.ready) { this.pending.delete(id); continue; }
      if (previous?.content_hash !== digest) upsert.run(ns, doc.memoryId, digest, Date.now());
      this.pending.set(id, { ns, trusted, memoryId: doc.memoryId, hash: digest, text: doc.text, retryAt: this.pending.get(id)?.retryAt || 0 });
    }
  }
  async drain(embed, authorize) {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      const jobs = [...this.pending.entries()].filter(([, job]) => job.retryAt <= Date.now()).slice(0, 2);
      await Promise.all(jobs.map(async ([id, job]) => {
        try {
          if (!await authorize(job.trusted, job.memoryId, job.hash)) { if (this.pending.get(id) === job) this.pending.delete(id); return; }
          const vector = await embed(job.text, job.trusted);
          if (this.closed || !await authorize(job.trusted, job.memoryId, job.hash)) return;
          const array = new Float32Array(vector);
          if (array.length !== 1024 || !array.every(Number.isFinite)) throw new Error('向量维度无效');
          const result = this.db.prepare('UPDATE embeddings SET vector=?,updated_at=? WHERE namespace=? AND memory_id=? AND content_hash=?')
            .run(Buffer.from(array.buffer), Date.now(), job.ns, job.memoryId, job.hash);
          if (this.pending.get(id) === job) this.pending.delete(id);
          this.stats.embedded += Number(result.changes);
        } catch {
          this.stats.failures++;
          if (this.pending.get(id) === job) job.retryAt = Date.now() + 30000;
        }
      }));
    } finally { this.running = false; }
  }
  async query(trusted, query, documents, lexical, embed, { limit = 8, complete = true } = {}) {
    const ns = retrievalNamespace(trusted), allowed = new Map(documents.map(d => [d.memoryId, d]));
    if (complete) this.sync(trusted, documents);
    const key = ns + ':' + hash(query);
    let vector = this.queryVectors.get(key), unavailable = false;
    if (query && !vector && documents.length) {
      try {
        vector = await embed(query, trusted);
        if (vector.length !== 1024 || !vector.every(Number.isFinite)) throw new Error('向量无效');
        this.queryVectors.set(key, vector);
        if (this.queryVectors.size > 64) this.queryVectors.delete(this.queryVectors.keys().next().value);
      } catch { unavailable = true; }
    }
    const semantic = [];
    if (vector) {
      const norm = Math.hypot(...vector);
      for (const row of this.db.prepare('SELECT memory_id,content_hash,vector FROM embeddings WHERE namespace=? AND vector IS NOT NULL').iterate(ns)) {
        const doc = allowed.get(row.memory_id);
        if (!doc || hash(doc.text) !== row.content_hash) continue;
        const b = new Float32Array(Uint8Array.from(row.vector).buffer);
        const score = norm ? vector.reduce((sum, x, i) => sum + x * b[i], 0) / (norm * Math.hypot(...b)) : 0;
        if (score >= 0.3) semantic.push({ id: doc.memoryId, score });
      }
      semantic.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    }
    const fused = new Map();
    const add = (id, rank, source, score) => {
      if (!allowed.has(id)) return;
      const item = fused.get(id) ?? { index: allowed.get(id).index, rrf: 0, sources: [] };
      item.rrf += 1 / (60 + rank); item.sources.push(source);
      if (score !== undefined) item.semanticScore = Number(score.toFixed(4));
      fused.set(id, item);
    };
    lexical.forEach((row, i) => add(row.memoryId, i + 1, 'keyword'));
    semantic.slice(0, 12).forEach((row, i) => add(row.id, i + 1, 'vector', row.score));
    let observed = 0, legacy = 0;
    const indexes = [...fused.values()].sort((a, b) => b.rrf - a.rrf || a.index.memoryId.localeCompare(b.index.memoryId))
      .filter(item => {
        if (item.index.evidenceLevel === 'observation' && ++observed > 1) return false;
        if (item.index.origin && ++legacy > 5) return false;
        return true;
      }).slice(0, limit).map(item => ({ ...item.index, retrievalSources: item.sources,
        ...(item.semanticScore === undefined ? {} : { semanticScore: item.semanticScore }) }));
    this.stats.queries++;
    this.stats.semanticHits += indexes.filter(i => i.retrievalSources.includes('vector')).length;
    return { indexes, rankingProvider: vector ? 'keyword+qwen3-embedding-0.6b' : 'keyword',
      semanticUnavailable: unavailable, indexingPending: [...this.pending.values()].filter(j => j.ns === ns).length };
  }
  validHash(text, digest) { return hash(text) === digest; }
  close() { this.closed = true; this.pending.clear(); this.db.close(); }
}
