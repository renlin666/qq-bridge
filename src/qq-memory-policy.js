// The plugin owns its store. Use its authenticated per-session API instead of
// editing SQLite or disabling memory for unrelated DSH sessions/workspaces.
import { randomUUID } from 'node:crypto';

export function createQqMemoryPolicy({ request, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  let inventoryCache, inventoryPending;
  async function pluginAbsent() {
    if (inventoryCache && now() - inventoryCache.at < 60000) return inventoryCache.absent;
    if (inventoryPending) return inventoryPending;
    inventoryPending = (async () => {
      try {
        const rpcId = randomUUID();
        const response = await request('/api/pluginManager/listPlugins', {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ type: 'client-request', rpcId, method: 'pluginManager/listPlugins', payload: { args: {} } })
        });
        const body = await response.json();
        const rows = body.result?.value;
        if (!response.ok || body.type !== 'server-response' || body.rpcId !== rpcId || body.result?.ok !== true
          || !Array.isArray(rows) || !rows.every(row => row && typeof row.moduleName === 'string' && typeof row.enabled === 'boolean')) return false;
        const absent = !rows.some(row => row.moduleName.toLowerCase().includes('meow-memory'));
        inventoryCache = { at: now(), absent };
        return absent;
      } catch { return false; } // Failed discovery cannot establish absence.
    })().finally(() => { inventoryPending = null; });
    return inventoryPending;
  }
  async function apply(sessionId) {
    for (const field of ['dream', 'inject', 'write']) {
      const response = await request('/meow-memory/skip-dreams', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, field, value: true }), signal: AbortSignal.timeout(5000)
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 404 && !(typeof body.error === 'string' && body.error.includes('unknown session'))) return { applied: false, unavailable: true };
      // DSH's static fallback returns 405 when an optional plugin has no route.
      // Only a validated live inventory may establish absence; a loaded plugin's
      // broken/moved endpoint must continue to report an isolation failure.
      if (response.status === 405 && !(typeof body.error === 'string' && body.error.includes('unknown session'))
        && await pluginAbsent()) return { applied: false, unavailable: true, reason: 'plugin_absent' };
      if (!response.ok || body.ok !== true || body.field !== field || body.value !== true) {
        throw new Error(`QQ 记忆隔离未确认：${field}（HTTP ${response.status}）`);
      }
    }
    return { applied: true };
  }
  async function sync(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('需要真实会话编号');
    const old = cache.get(sessionId);
    if (old && now() - old.at < (old.result.applied ? 600000 : 60000)) return old.result;
    if (pending.has(sessionId)) return pending.get(sessionId);
    const work = apply(sessionId).then(result => {
      cache.set(sessionId, { at: now(), result });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return result;
    }).finally(() => pending.delete(sessionId));
    pending.set(sessionId, work);
    return work;
  }
  return { sync };
}
