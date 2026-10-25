import { transaction } from './db.js';

// Presentation stages supplement the original dimensions and ledger. Older
// versions can still open schema v2; no historical scores/events are rewritten.
export const STAGES = ['初识', '认识', '熟络', '亲近', '深交'];
export function createStages(db) {
  transaction(db, () => {
    const existed = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relationship_stage_origins'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS relationship_stage_origins (
      person_id TEXT PRIMARY KEY REFERENCES people(id), legacy_tier TEXT NOT NULL,
      migrated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS relationship_stage_state (
        person_id TEXT PRIMARY KEY REFERENCES people(id), stage INTEGER NOT NULL CHECK(stage BETWEEN 0 AND 4))`);
    if (!existed) db.prepare(`INSERT INTO relationship_stage_origins
      SELECT person_id,tier,updated_at FROM relationships`).run();
  });
  return (personId, relationship) => {
    const d = relationship.dimensions;
    const stats = db.prepare(`WITH usable AS (SELECT e.kind,e.occurred_at FROM interaction_events e
      WHERE e.person_id=? AND e.status='applied' AND NOT EXISTS (
        SELECT 1 FROM relationship_ledger l WHERE l.event_id=e.id AND l.status='reverted')),
      positive AS (SELECT * FROM usable WHERE kind IN ('positive_chat','shared_activity','support','deep_talk'))
      SELECT (SELECT COUNT(*) FROM usable) AS total,COUNT(*) AS n,
        COUNT(DISTINCT CAST(occurred_at/86400000 AS INTEGER)) AS days,COUNT(DISTINCT kind) AS kinds FROM positive`).get(personId);
    const legacy = db.prepare('SELECT legacy_tier FROM relationship_stage_origins WHERE person_id=?').get(personId)?.legacy_tier;
    // Retain established familiarity during migration, not a permanent trust floor.
    const inherited = { '熟悉': 2, '亲近': 3, '深交': 4 }[legacy] ?? 0;
    function eligible(level, margin = 0) {
      if (level === 0) return true;
      if (level === 1) return stats.total > 0 || inherited > 0;
      if (inherited >= level && d.familiarity >= 38 - margin && (level <= 2 || d.trust >= 40 - margin)) return true;
      if (level === 2) return stats.n >= 5 && stats.days >= 2 && d.familiarity >= 40 - margin;
      const deep = level === 4, threshold = (deep ? 75 : 55) - margin;
      return stats.n >= (deep ? 40 : 15) && stats.days >= (deep ? 14 : 5) && stats.kinds >= (deep ? 3 : 2)
        && d.familiarity >= threshold && d.closeness >= threshold && d.trust >= threshold
        && d.boundary >= (deep ? 70 : 50) - margin;
    }
    let stage = 4;
    while (!eligible(stage)) stage--;
    const previous = db.prepare('SELECT stage FROM relationship_stage_state WHERE person_id=?').get(personId)?.stage;
    if (previous > stage && eligible(previous, 3)) stage = previous;
    if (previous !== stage) db.prepare(`INSERT INTO relationship_stage_state VALUES(?,?)
      ON CONFLICT(person_id) DO UPDATE SET stage=excluded.stage`).run(personId, stage);
    return { ...relationship, legacyTier: relationship.tier, tier: STAGES[stage], stage: STAGES[stage],
      ...(legacy === '戒备' ? { legacyCaution: true } : {}) };
  };
}
