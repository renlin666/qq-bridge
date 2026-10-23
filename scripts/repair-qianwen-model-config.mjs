// Explicit local repair for the imported text-only/129024-token QQ route.
// Does not read credentials, send messages, or rewrite session history.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { buildPatches } from './build-agent-preset-patches.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop');
const patchFile = path.join(profile, 'cordis.patch.yml');
const configFile = path.join(root, 'config.json');
const models = ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash'];
// A conservative operating window, not a claim about the vendor's maximum.
// The existing route has already accepted ~243k prompt tokens. Compact early.
const contextWindow = 262144;
const backup = path.join(root, 'state', 'model-repair-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true });
function saveBackup(file) {
  const relative = file.startsWith(root + path.sep) ? path.relative(root, file) : path.join('profile', path.basename(file));
  const target = path.join(backup, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
}
const patch = yaml.load(fs.readFileSync(patchFile, 'utf8'));
let provider;
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.name === '@deepseek-ai/dsh-llm-pi-ai') provider = value.config?.providers?.['qq-qianwen'];
  if (value.id === 'qq-platform-policy') value.config.models = [...models];
  for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item);
}
visit(patch);
if (!provider) throw new Error('qq-qianwen provider is missing; no files changed');
// Validate every preset before mutating any files. A second run may reuse
// exactly these policies, but must not silently overwrite another policy.
for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const file = path.join(root, 'dsh', 'agent-presets', preset, 'agent.cordis.yml');
  const rows = yaml.load(fs.readFileSync(file, 'utf8'));
  const compact = rows.find(r => r.id === 'compaction')?.config?.find(r => r.id === 'compaction-basic');
  if (!compact) throw new Error('Compaction row missing: ' + file);
  const expected = { modelPolicies: models.map(model => ({ provider: 'qq-qianwen', model,
    thresholdRatio: 0.65, headroomTokens: 32768, retainTokens: 8192, maxTokens: 8192 })) };
  if (compact.config && JSON.stringify(compact.config) !== JSON.stringify(expected)) {
    throw new Error('Review existing compaction policies before applying this repair: ' + file);
  }
}
saveBackup(patchFile);
saveBackup(configFile);
provider.defaultInput = ['text', 'image'];
provider.defaultContextWindow = contextWindow;
provider.defaultMaxTokens = 32768;
provider.models = models.map(id => ({
  ...provider.models.find(m => m.id === id), id,
  input: ['text', 'image'], contextWindow, maxTokens: 32768
}));
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
config.dsh.allowedModels = [...models];
config.dsh.model = models[0];
config.dsh.reasoningEffort = null;
fs.writeFileSync(patchFile, yaml.dump(patch, { lineWidth: -1, noRefs: true }));
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const file = path.join(root, 'dsh', 'agent-presets', preset, 'agent.cordis.yml');
  saveBackup(file);
  const raw = fs.readFileSync(file, 'utf8');
  const marker = "      name: '@deepseek-ai/dsh-compaction-basic'";
  // Preserve persona text and the rest of the hand-authored YAML verbatim.
  const policies = yaml.dump({ config: { modelPolicies: models.map(model => ({
    provider: 'qq-qianwen', model, thresholdRatio: 0.65,
    headroomTokens: 32768, retainTokens: 8192, maxTokens: 8192
  })) } }, { lineWidth: -1, noRefs: true }).trimEnd().split('\n').map(l => '      ' + l).join('\n');
  if (!raw.includes(marker)) throw new Error('Compaction row missing: ' + file);
  if (!/modelPolicies:/.test(raw)) fs.writeFileSync(file, raw.replace(marker, marker + '\n' + policies));
}
for (const preset of ['qq-chat', 'qq-chat-v2']) saveBackup(path.join(root, 'plugins', 'qq-agent-presets', 'presets', preset + '.patch.yml'));
buildPatches({ log: () => {} });
fs.writeFileSync(path.join(backup, 'repair.json'), JSON.stringify({ models, contextWindow, summaryMaxTokens: 8192, backup }, null, 2));
console.log(JSON.stringify({ models, input: provider.defaultInput, contextWindow, backup }));
