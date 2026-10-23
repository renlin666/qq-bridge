// Validate the publishable tree without printing any private values.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverExtensions, BUILTIN_IDS } from '../src/plugin-host/catalog.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const problems = [];
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) problems.push('package/lock versions differ');
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) problems.push('invalid release version');
const cfg = { extensions: Object.fromEntries(BUILTIN_IDS.map(id => [id, { enabled: true }])) };
for (const row of discoverExtensions(root, cfg)) if (row.status !== 'discovered') problems.push('invalid built-in extension: ' + row.id);
const list = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (list.status !== 0) problems.push('git inventory unavailable');
const files = [...new Set((list.stdout ?? '').split('\0').filter(Boolean))];
const forbidden = /^(?:state|node_modules|audio|extensions-local)\/|^(?:config\.json|INSTALL-NOTES\.md|roles\/小鲸鱼\.md|assets\/deepseek娘\.png)$|(?:^|\/)privacy-rules\.json$/;
for (const file of files) if (forbidden.test(file)) problems.push('private path in publishable tree: ' + file);
// Check exact local secrets/IDs even in files the legacy heuristic scanner exempts.
const values = new Map();
function collect(value, key = '') {
  if (Array.isArray(value)) { for (const item of value) collect(item, key); return; }
  if (value && typeof value === 'object') { for (const [name, item] of Object.entries(value)) collect(item, name); return; }
  if (/token|api.?key|secret|password/i.test(key) && !/env$|ref$|header$|prefix$/i.test(key) && typeof value === 'string' && value.length >= 12) values.set(value, 'local credential');
  if (/ownerQQ|adminQQ|private|groups|allowedKeys|commentKey/i.test(key)) {
    for (const match of String(value ?? '').matchAll(/(?:^|:)([1-9]\d{5,11})$/g)) values.set(match[1], 'local account identifier');
  }
}
const localConfig = path.join(root, 'config.json');
if (fs.existsSync(localConfig)) collect(JSON.parse(fs.readFileSync(localConfig, 'utf8').replace(/^\uFEFF/, '')));
for (const file of files) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).size > 8 * 1024 * 1024) continue;
  const bytes = fs.readFileSync(absolute); if (bytes.includes(0)) continue;
  const content = bytes.toString('utf8');
  for (const [value, kind] of values) {
    if (content.includes(value)) problems.push(kind + ' appears in ' + file);
  }
}
if (problems.length) { for (const message of [...new Set(problems)]) console.error('FAIL', message); process.exit(1); }
const privacy = spawnSync(process.execPath, [path.join(root, 'scripts/privacy-scan.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
if (privacy.status !== 0) process.exit(privacy.status || 1);
console.log(`Release ${pkg.version}: ${files.length} publishable files; versions, manifests and private-data checks passed.`);
