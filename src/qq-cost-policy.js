// Budget permission travels through local state, never through model-visible text.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const QQ_COST_LIMIT = 'QQ_COST_LIMIT';
const GRANT_TTL = 24 * 60 * 60 * 1000;

export function isQqCostLimit(reason) {
  const error = reason?.error ?? reason?.failure ?? reason;
  return error?.code === QQ_COST_LIMIT
    || /^QQ (?:单轮|单条回复)估算预算保护：/.test(String(error?.message ?? ''));
}

// Provider quota exhaustion can arrive as a structured error or as JSON inside
// an HTTP error message. A generic 429 can instead mean a transient rate limit.
export function isAccountQuotaExceeded(reason) {
  const queue = [reason];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (value == null) continue;
    if (typeof value === 'string') {
      if (/\b(?:AccountQuotaExceeded|insufficient_quota|quota_exceeded|billing_hard_limit_reached)\b/i.test(value)
          || /(?:exceed(?:ed|s)?|exhaust(?:ed)?)\s+(?:the\s+|your\s+)?(?:\d+[- ]hour\s+|current\s+|usage\s+)?(?:usage\s+)?quota\b/i.test(value)
          || /(?:账户|账号|使用|调用|模型)额度(?:已|已经)?(?:耗尽|用完|超出)/.test(value)) return true;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const key of ['code', 'type', 'message', 'error', 'failure', 'cause']) {
      if (value[key] != null) queue.push(value[key]);
    }
  }
  return false;
}

function grantFile(root, sid, content) {
  const text = (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const hash = createHash('sha256').update(`${sid}\0${text}`).digest('hex');
  return path.join(root, 'state/cost-authorizations', hash);
}

export function grantOwnerCostExemption(root, config, sid, content) {
  if (config.costControl?.exemptOwner !== true || !config.ownerQQ) return () => {};
  const dir = grantFile(root, sid, content);
  fs.mkdirSync(dir, { recursive: true });
  // Identical queued requests each need their own one-use grant.
  const file = path.join(dir, `${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ sid, ownerQQ: String(config.ownerQQ), at: Date.now() }), { mode: 0o600 });
  return () => fs.rmSync(file, { force: true });
}

export function consumeOwnerCostExemption(root, sid, content, ownerQQ) {
  const dir = grantFile(root, sid, content);
  let files;
  try { files = fs.readdirSync(dir); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const now = Date.now();
  for (const name of files) {
    const file = path.join(dir, name);
    let grant;
    try {
      grant = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.unlinkSync(file); // one consumer; claim before granting permission
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (grant.sid === sid && grant.ownerQQ === String(ownerQQ)
        && now >= grant.at && now - grant.at < GRANT_TTL) return true;
  }
  return false;
}
