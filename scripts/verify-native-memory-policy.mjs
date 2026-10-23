// Verifies existing sessions only. No model requests or QQ sends are made.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { probeCookie, probeRpc } from './probe-auth.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const cfg = read('config.json'), before = read('state/memory-policy-before.json');
const sessions = read('state/sessions.json').sessions;
const ids = Object.values(sessions);
const base = cfg.dsh.baseUrl, cookie = probeCookie({ base });
const report = { at: new Date().toISOString(), readOnly: true, checks: {} };
const response = await fetch(new URL('/meow-memory/skip-dreams', base), { headers: { cookie } });
const current = await response.json();
if (!response.ok || !Array.isArray(current.scopes)) throw new Error('Cannot verify native memory scope');
report.checks.qqPolicy = { sessions: ids.length, allSkipDreamAndReflection: ids.every(id => current.scopes.find(s => s.sessionId === id)?.dream === true),
  allSkipNativeInjection: ids.every(id => current.scopes.find(s => s.sessionId === id)?.inject === true),
  allSkipNativeWrite: ids.every(id => current.scopes.find(s => s.sessionId === id)?.write === true) };
const order = rows => rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
report.checks.otherSessionScopesUnchanged = JSON.stringify(order(before.scopes.scopes.filter(s => !ids.includes(s.sessionId))))
  === JSON.stringify(order(current.scopes.filter(s => !ids.includes(s.sessionId))));
const originalModels = read('state/routing-models-before.json');
const rpc = probeRpc(cookie, { base });
const afterModels = [];
for (const row of originalModels) {
  const result = await rpc('session/projections', { request: { sessionId: row.sessionId } });
  if (!result?.ok) throw new Error('Cannot verify models');
  afterModels.push(result.value.values.modelSelection);
}
report.checks.mappingsUnchanged = Object.entries(before.sessions).every(([key, id]) => sessions[key] === id);
report.checks.modelsUnchanged = originalModels.every((row, i) => JSON.stringify(row.selection.next) === JSON.stringify(afterModels[i].next));
const profile = fs.readFileSync('C:/Users/LEGION/.dsh/profiles/desktop/cordis.patch.yml');
report.checks.globalProfileUnchanged = crypto.createHash('sha256').update(profile).digest('hex') === read('state/native-memory-profile-hash.json').sha256;
const plugins = await rpc('pluginManager/listPlugins', {});
report.checks.nativePluginStillActiveForOtherSessions = plugins?.ok && plugins.value.some(p => p.moduleName === 'meow-memory' && p.enabled && p.fiberPhase === 'active');
report.checks.noFailedProfilePlugins = plugins?.ok && !plugins.value.some(p => p.enabled && p.fiberPhase === 'failed');
fs.writeFileSync(path.join(root, 'state/native-memory-live-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!Object.values(report.checks.qqPolicy).every(Boolean) || Object.entries(report.checks).some(([key, val]) => key !== 'qqPolicy' && val !== true)) throw new Error('Native memory policy verification failed');
