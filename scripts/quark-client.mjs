import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openQuark, quarkStatus } from '../src/quark-drive.js';
const config = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8').replace(/^\uFEFF/, ''));
const options = config.integrations?.quark;
try {
  if (process.argv.includes('--open')) {
    await openQuark(options);
    console.log('已启动本机夸克解析连接。请在夸克内完成登录，然后把磁力链接发到已允许的 QQ 会话。');
  } else console.log(JSON.stringify(await quarkStatus(options), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
