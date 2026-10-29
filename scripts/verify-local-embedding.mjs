import fs from 'node:fs';
import { embedLocal } from '../src/local-embedding.js';
const cfg = JSON.parse(fs.readFileSync('/opt/qq-stack/qq-bridge/config.json', 'utf8'));
const vector = await embedLocal('local embedding verification', cfg.extensions.ark.config, {timeoutMs:10000});
console.log('live embedding dimensions', vector.length);
