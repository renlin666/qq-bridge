import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Only bridge-owned shutdown checkpoints authorize continuation. A manually
// cancelled DSH turn is never inferred to need replay from transcript status.
export class RestartRecovery {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'restart-recovery.json');
    this.rows = []; this.running = false; this.writable = true;
    try {
      if (fs.existsSync(this.file)) {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (saved.version !== 1 || !Array.isArray(saved.items)) throw new Error('invalid checkpoint');
        this.rows = saved.items.filter(r => /^(group|private):[1-9]\d*$/.test(r.key)
          && typeof r.sessionId === 'string' && typeof r.requestId === 'string'
          && Number.isFinite(r.at) && Date.now() - r.at < 2 * 3600000);
      }
    } catch { this.writable = false; }
  }
  save() {
    if (!this.writable) throw new Error('重启恢复记录损坏，保留原文件');
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, items: this.rows }), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  checkpoint(items) {
    if (!this.writable) return;
    for (const item of items) {
      this.rows = this.rows.filter(r => r.key !== item.key);
      this.rows.push({ ...item, at: Date.now(), requestId: crypto.randomUUID(), attempts: 0, retryAt: 0 });
    }
    this.save();
  }
  async resume(eligible, deliver) {
    if (this.running || !this.writable) return;
    this.running = true;
    try {
      for (const row of [...this.rows]) {
        if (Date.now() - row.at >= 2 * 3600000 || !eligible(row)) {
          this.rows = this.rows.filter(r => r !== row); this.save(); continue;
        }
        // Prompt request IDs alone are not a verified replay guarantee. Persist dispatch before
        // the call; a timeout/crash may have accepted it, so never blindly replay.
        if (row.dispatchState === 'dispatching' || row.dispatchState === 'uncertain'
            || row.attempts >= 3 || row.retryAt > Date.now()) continue;
        row.attempts++; row.retryAt = Date.now() + 30000;
        row.dispatchState = 'dispatching'; this.save();
        try {
          const result = await deliver(row);
          if (result?.ok === true && !result.queued && !result.skipped && !result.retried) {
            this.rows = this.rows.filter(r => r !== row); this.save();
          } else {
            row.dispatchState = result?.queued || result?.retried ? 'uncertain' : 'pending';
            this.save();
          }
        } catch {
          row.dispatchState = 'uncertain'; this.save();
        }
      }
    } finally { this.running = false; }
  }
}
