// 在现有 profile patch 加入独立预算插件；保留所有现有行及凭据引用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = process.argv[2] ?? 'desktop';
if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new Error('Invalid DSH profile');
const patch = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', profile, 'cordis.patch.yml');
const text = fs.readFileSync(patch, 'utf8');
const rows = yaml.load(text);
if (!Array.isArray(rows)) throw new Error('Profile patch must contain an array');
if (!rows.some(row => row.id === 'qq-cost-guard' || row.insert?.some(x => x.id === 'qq-cost-guard'))) {
  fs.copyFileSync(patch, `${patch}.bak-cost-${Date.now()}`);
  const insertion = [{ insert: [{ id: 'qq-cost-guard',
    name: pathToFileURL(path.join(root, 'plugins/qq-agent-presets/qq-cost-guard.mjs')).href,
    config: { root: path.resolve(root) } }] }];
  fs.appendFileSync(patch, '\n' + yaml.dump(insertion, { lineWidth: -1 }));
}
console.log('QQ cost guard installed in profile patch; verify the live HMR status before claiming activation.');
