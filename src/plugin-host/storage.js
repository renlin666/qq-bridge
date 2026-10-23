import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// This is an SDK namespace, not an OS sandbox for arbitrary JavaScript.
export function createExtensionStorage(stateDir, id) {
  const directory = path.join(stateDir, 'extensions', id);
  const filename = name => {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error('插件存储名称无效');
    return path.join(directory, name + '.json');
  };
  return Object.freeze({
    get(name, fallback = null) {
      const file = filename(name);
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('插件存储损坏或不可读，已拒绝覆盖'); }
    },
    set(name, value) {
      const file = filename(name);
      // A corrupt existing file must not silently turn into an empty store.
      if (fs.existsSync(file)) JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temp = file + '.' + crypto.randomUUID() + '.tmp';
      try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file); }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    },
  });
}
