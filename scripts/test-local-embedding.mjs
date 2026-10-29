import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { embedLocal } from '../src/local-embedding.js';

test('local embedding uses fixed authenticated endpoint and validates returned vectors', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-embed-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, 'a'.repeat(64));
  const config = {localSpeech:{tokenFile}};
  let seen;
  const vector = await embedLocal('hello', config, {fetcher:async (url, options) => {
    seen = {url, options}; return new Response(JSON.stringify({embedding:Array(1024).fill(0.5)}));
  }});
  assert.equal(vector.length, 1024); assert.equal(seen.url, 'http://127.0.0.1:23916/embed');
  assert.equal(seen.options.redirect, 'error'); assert.equal(seen.options.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
  await assert.rejects(embedLocal('hello', config, {fetcher:async () => new Response(JSON.stringify({embedding:[1]}))}), /维度/);
  await assert.rejects(embedLocal('hello', config, {fetcher:async () => new Response('', {status:503})}), /不可用/);
});
