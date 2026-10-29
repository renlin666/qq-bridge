import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesizeSpeech } from '../src/speech-router.js';
import { createArkAssistant } from '../src/ark-assistant.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-router-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token'); fs.writeFileSync(tokenFile, 'a'.repeat(64));
  return { dir, config: { speechLanguage: 'Japanese', localSpeech: { enabled: true, tokenFile },
    qianwenSpeech: { enabled: true, apiKeyFile: 'unused', voice: 'qwen-audio-3.0-tts-flash-fixture' } } };
}
const localResponse = () => new Response(Buffer.from('ID3local-audio'), { headers: { 'content-type': 'audio/mpeg' } });

test('local response identifies the selected fine-tuned voice without accepting arbitrary worker metadata', async t => {
  const { config } = fixture(t);
  for (const [profile, expected] of [['yanami-sft-v2', 'yanami-local-sft-v2'], ['unknown/path/credential', 'yanami-local-icl']]) {
    const result = await synthesizeSpeech('やったね！', config, { cloud: () => { throw Error('must stay local'); },
      fetcher: async url => url.endsWith('/health') ? new Response('{}') : new Response(Buffer.from('ID3local-audio'),
        { headers: { 'content-type': 'audio/mpeg', 'x-voice-profile': profile } }) });
    assert.equal(result.speaker, expected);
  }
});

test('online worker receives only Japanese text and its own token on a fixed loopback address; cloud never billed', async t => {
  const { config } = fixture(t); let calls = 0;
  config.localSpeech.endpoint = 'https://evil.example';
  const result = await synthesizeSpeech('やったね！', config, { cloud: () => { throw Error('cloud must not run'); },
    fetcher: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
      assert.equal(init.redirect, 'error');
      if (++calls === 1) { assert.equal(url, 'http://127.0.0.1:23916/health'); return new Response('{}'); }
      assert.equal(url, 'http://127.0.0.1:23916/synthesize');
      assert.deepEqual(JSON.parse(init.body), { text: 'やったね！', language: 'Japanese' });
      return localResponse();
    } });
  assert.equal(result.provider, 'local-qwen3-tts'); assert.equal(calls, 2);
});

test('offline, busy, unauthorized, corrupt and oversized local responses fall back once to selected Qianwen', async t => {
  const { config } = fixture(t);
  const cases = [() => { throw Error('offline'); }, () => new Response('', { status: 401 }),
    () => new Response('', { status: 503 }),
    (url) => url.endsWith('/health') ? new Response('{}') : new Response('oops', { headers: { 'content-type': 'audio/mpeg' } }),
    (url) => url.endsWith('/health') ? new Response('{}') : new Response(Buffer.alloc(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'audio/mpeg' } })];
  for (const fetcher of cases) {
    let paid = 0;
    const result = await synthesizeSpeech('すごいね！', config, { fetcher, cloud: async (text, selected) => {
      paid++; assert.equal(text, 'すごいね！'); assert.equal(selected, config); return Buffer.from('ID3cloud');
    } });
    assert.equal(paid, 1); assert.equal(result.provider, 'qianwen'); assert.ok(result.fallbackReason);
  }
});

test('cancellation never starts a paid fallback, and local failure cannot switch to an unselected provider', async t => {
  const { config } = fixture(t); const abort = new AbortController(); let paid = 0;
  await assert.rejects(synthesizeSpeech('こんにちは', config, { signal: abort.signal,
    fetcher: () => { abort.abort(); throw Error('offline'); }, cloud: () => { paid++; } }), /abort/i);
  assert.equal(paid, 0);
  config.qianwenSpeech.enabled = false;
  await assert.rejects(synthesizeSpeech('こんにちは', config, { fetcher: () => { throw Error('offline'); }, cloud: () => { paid++; } }), /千问回退/);
  assert.equal(paid, 0);
});

test('Japanese-only policy rejects Chinese and long text before any remote call', async t => {
  const { config } = fixture(t);
  for (const text of ['今天好开心', 'あ'.repeat(121)]) {
    await assert.rejects(synthesizeSpeech(text, config, { fetcher: () => { throw Error('must not call'); },
      cloud: () => { throw Error('must not call'); } }), /只用日语短句/);
  }
});

test('assistant uses routing, writes returned audio to scoped library and leaves QQ sends to receipt-checked tools', async t => {
  const { dir, config } = fixture(t); config.localSpeech.enabled = false;
  const cfg = { extensions: { ark: { enabled: true, config } }, socialV2: { voice: { enabled: true, dir: 'audio' } } };
  const assistant = createArkAssistant({ stateDir: dir, projectRoot: dir, getConfig: () => cfg,
    synthesize: async () => Buffer.from('ID3cloud') });
  const result = await assistant.handle('private:12345', { action: 'tts', text: 'やったね！' }, () => {});
  assert.equal(result.provider, 'qianwen'); assert.equal(result.language, 'Japanese');
  assert.match(result.voice, /^ark-[a-f0-9]{16}-[a-f0-9]{24}\.mp3$/);
  assert.equal(fs.readFileSync(path.join(dir, 'audio', result.voice)).toString(), 'ID3cloud');
  assert.match(result.hint, /尚未发送/);
});
