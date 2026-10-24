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
