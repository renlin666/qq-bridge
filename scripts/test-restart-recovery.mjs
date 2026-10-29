import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RestartRecovery } from '../src/restart-recovery.js';
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-recovery-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('only checkpointed bridge work resumes; explicit rejection permits bounded retry', async t => {
  const dir = fixture(t), first = new RestartRecovery(dir);
  assert.equal(first.rows.length, 0);
  first.checkpoint([{ key: 'private:12345', sessionId: 's1', seq: 4, lastOutgoingAt: 10 }]);
  const second = new RestartRecovery(dir), ids = [];
  await second.resume(() => true, async row => { ids.push(row.requestId); return { ok: false }; });
  second.rows[0].retryAt = 0;
  await second.resume(() => true, async row => { ids.push(row.requestId); return { ok: true }; });
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]); assert.equal(second.rows.length, 0);
  await new RestartRecovery(dir).resume(() => true, async () => assert.fail('already accepted continuation must not replay'));
});
test('ambiguous transport failure or crash during dispatch never blindly replays a prompt', async t => {
  const dir = fixture(t), recovery = new RestartRecovery(dir);
  recovery.checkpoint([{ key: 'private:12345', sessionId: 's1', seq: 4 }]);
  await recovery.resume(() => true, async () => { throw new Error('response lost after possible acceptance'); });
  recovery.rows[0].retryAt = 0; recovery.save();
  await new RestartRecovery(dir).resume(() => true, async () => assert.fail('must not duplicate uncertain dispatch'));
  recovery.rows[0].dispatchState = 'dispatching'; recovery.save();
  await new RestartRecovery(dir).resume(() => true, async () => assert.fail('crash during dispatch is also uncertain'));
});
test('revoked, reset or already-completed sessions do not resume; unknown checkpoint data stays untouched', async t => {
  const dir = fixture(t), recovery = new RestartRecovery(dir);
  recovery.checkpoint([{ key: 'group:456', sessionId: 'old', seq: 3, lastOutgoingAt: 10 }]);
  await recovery.resume(() => false, async () => assert.fail('must not dispatch'));
  assert.equal(recovery.rows.length, 0);
  fs.writeFileSync(recovery.file, '{broken'); const broken = new RestartRecovery(dir);
  broken.checkpoint([]); await broken.resume(() => true, async () => assert.fail());
  assert.equal(fs.readFileSync(recovery.file, 'utf8'), '{broken');
});
