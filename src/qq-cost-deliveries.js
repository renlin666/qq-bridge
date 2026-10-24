// Only the bridge writes delivery checkpoints, after a gateway message receipt.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

function checkpointFile(root, sessionId) {
  const key = createHash('sha256').update(String(sessionId)).digest('hex');
  return path.join(root, 'state/cost-deliveries', `${key}.json`);
}

export function readCostDelivery(root, sessionId) {
  try { return JSON.parse(fs.readFileSync(checkpointFile(root, sessionId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function recordCostDelivery(root, sessionId, targetKey, messageId) {
  if (!sessionId || !/^-?[1-9]\d*$/.test(String(messageId ?? ''))) return false;
  const file = checkpointFile(root, sessionId);
  const id = `${targetKey}/${messageId}`;
  if (readCostDelivery(root, sessionId)?.id === id) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ id, sessionId, targetKey, messageId: String(messageId), at: Date.now() }), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return true;
}
