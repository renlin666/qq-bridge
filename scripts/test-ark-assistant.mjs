import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { synthesizeArk, speechProfile, embedArk, composeArk, transcribeArk, parseAsrFrame } from '../src/ark-client.js';
import { queryVoice, trainVoice, trainingWav } from '../src/voice-clone.js';
import { createArkAssistant } from '../src/ark-assistant.js';
import { createPluginHost } from '../src/plugin-host/index.js';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { apiKeyFile: path.join(dir, 'key'), speaker: 'fixture-speaker' };
  fs.writeFileSync(config.apiKeyFile, 'fixture-key');
  return { dir, config };
}
test('real built-in Ark manifest activates with normalized enabled config and formats photo previews', async t => {
  const { dir, config } = fixture(t);
  const cfg = { extensions: Object.fromEntries(['bilibili', 'image-search', 'qzone', 'quark', 'social-memory', 'esports'].map(id => [id, { enabled: false }])) };
  cfg.extensions.ark = { enabled: true, config };
  const host = createPluginHost({ root: fileURLToPath(new URL('..', import.meta.url)), stateDir: dir,
    getConfig: () => cfg, services: { 'ark.assist': (_key, args) => ({ imageId: 'fixture-image', data: 'cGhvdG8=', mimeType: 'image/jpeg' }) } });
  t.after(() => host.close());
  assert.deepEqual((await host.catalog()).map(x => x.name), ['qq_synthesize_speech', 'qq_transcribe_voice', 'qq_compose_photo', 'qq_generate_image']);
  const result = await host.callTool('qq_compose_photo', { purpose: 'photo-composition', requestMessageId: 1, prompt: 'photo', photos: [{ messageId: 2 }] }, { key: 'group:12345', assertAuthorized() {} });
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].data, 'cGhvdG8=');
  assert.equal(JSON.parse(result.content[0].text).imageId, 'fixture-image');
  assert.equal('data' in JSON.parse(result.content[0].text), false);
});
test('Agent Plan endpoints and headers remain fixed; streamed TTS requires a final success', async t => {
  const { config } = fixture(t); const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"code":0,"data":"SUQz"}\n{"code":20000000}\n');
  };
  assert.equal((await synthesizeArk('hello', config, { fetcher })).toString(), 'ID3');
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional');
  assert.equal(calls[0].init.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'fixture-key');
  await assert.rejects(synthesizeArk('hello', config, { fetcher: async () => new Response('{"code":0,"data":"SUQz"}') }), /完整结束/);
  await assert.rejects(synthesizeArk('hello', { ...config, speaker: '' }, { fetcher }), /音色 ID/);
});
test('temporary pause blocks Ark requests before network while allowing Qianwen speech', async t => {
  const { config } = fixture(t); let calls = 0;
  const paused = { ...config, pauseUntil: Date.now() + 60000 };
  const fetcher = async () => { calls++; throw Error('unexpected network'); };
  await assert.rejects(embedArk('x', paused, { fetcher }), /暂时停用/);
  await assert.rejects(composeArk('x', [], paused, { fetcher }), /暂时停用/);
  await assert.rejects(synthesizeArk('hello', paused, { fetcher }), /暂时停用/);
  await assert.rejects(transcribeArk(Buffer.alloc(0), paused), /暂时停用/);
  assert.equal(calls, 0);
  const q = { ...paused, qianwenSpeech: { enabled: true, apiKeyFile: config.apiKeyFile, voice: 'qwen-audio-3.0-tts-flash-fixture' } };
  const audio = await synthesizeArk('hello', q, { fetcher: async () => new Response(JSON.stringify({ output: { audio: { url: 'https://example.com/a.mp3' } } })), download: async () => ({ statusCode: 200, buffer: Buffer.from('ID3data') }) });
  assert.equal(audio.toString(), 'ID3data');
});
test('embedding validates dimensions; Seedream is pinned to photo model and reference images', async t => {
  const { config } = fixture(t); let body, url;
  const fetcher = async (u, init) => { url = u; body = JSON.parse(init.body);
    return new Response(JSON.stringify(u.includes('embeddings') ? { data: { embedding: Array(1024).fill(0.1) } } : { data: [{ b64_json: 'cGhvdG8=' }] })); };
  assert.equal((await embedArk('hello', config, { fetcher })).length, 1024);
  assert.equal(body.model, 'doubao-embedding-vision');
  assert.ok(url.includes('/api/plan/v3/embeddings/multimodal'));
  assert.equal((await composeArk('photo', ['data:image/png;base64,abc'], config, { fetcher })).toString(), 'photo');
  assert.equal(body.model, 'doubao-seedream-5.0-flash');
  assert.equal(body.watermark, true);
  assert.equal(body.image, 'data:image/png;base64,abc');
  await assert.rejects(embedArk('x', config, { fetcher: async () => new Response('{"data":{"embedding":[1]}}') }), /向量响应/);
});

test('cloned TTS uses its own key and fixed paid endpoint only when explicitly enabled', async t => {
  const { dir, config } = fixture(t); const calls = [];
  const clone = { enabled: true, apiKeyFile: path.join(dir, 'speech-key'), speaker: 'S_fixture123' };
  fs.writeFileSync(clone.apiKeyFile, 'speech-only-key');
  config.voiceClone = clone;
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response('{"code":0,"data":"SUQz"}\n{"code":20000000}\n');
  };
  await synthesizeArk('你好', config, { fetcher });
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(calls[0].init.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'speech-only-key');
  assert.equal(calls[0].body.req_params.speaker, clone.speaker);
  clone.enabled = false;
  await synthesizeArk('你好', config, { fetcher });
  assert.equal(calls[1].url, 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional');
  assert.equal(calls[1].init.headers['X-Api-Key'], 'fixture-key');
  clone.enabled = true;
  await assert.rejects(synthesizeArk('你好', config, { fetcher: async () => new Response('{}', { status: 403 }) }), /HTTP 403/);
  clone.speaker = 'custom_speaker_id';
  await assert.rejects(synthesizeArk('你好', config, { fetcher }), /复刻语音/);
  assert.equal(calls.length, 2);
  assert.equal(speechProfile({ ...config, voiceClone: { enabled: true, speaker: 'S_ok', apiKeyFile: '/file', endpoint: 'https://evil.example' } }).endpoint,
    'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
});

test('Qianwen clone synthesis pins platform/model, keeps keys off storage requests and preserves other Ark capabilities', async t => {
  const { dir, config } = fixture(t); const calls = [];
  const voice = 'qwen-audio-3.0-tts-flash-yanami-fixture';
  config.qianwenSpeech = { enabled: true, apiKeyFile: path.join(dir, 'qianwen-key'), voice };
  fs.writeFileSync(config.qianwenSpeech.apiKeyFile, 'qianwen-only-key');
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (url.includes('embeddings')) return new Response(JSON.stringify({ data: { embedding: Array(1024).fill(0.1) } }));
    return new Response(JSON.stringify({ output: { audio: { url: 'https://storage.example/voice.mp3?signature=fixture' } } }));
  };
  let downloadArgs;
  const download = async (...args) => { downloadArgs = args; return { statusCode: 200, buffer: Buffer.from('ID3fixture-audio') }; };
  const bytes = await synthesizeArk('你好', config, { fetcher, download });
  assert.equal(bytes.toString(), 'ID3fixture-audio');
  assert.equal(calls[0].url, 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer qianwen-only-key');
  assert.deepEqual(calls[0].body, { model: 'qwen-audio-3.0-tts-flash', input: { text: '你好', voice, format: 'mp3', sample_rate: 24000 } });
  assert.deepEqual(downloadArgs, ['https://storage.example/voice.mp3?signature=fixture', 8 * 1024 * 1024]);
  assert.equal((await embedArk('hello', config, { fetcher })).length, 1024);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer fixture-key');
  const profile = speechProfile({ ...config, qianwenSpeech: { ...config.qianwenSpeech, endpoint: 'https://evil.example', model: 'other' } });
  assert.equal(profile.model, 'qwen-audio-3.0-tts-flash');
  assert.equal(profile.endpoint, calls[0].url);
  await synthesizeArk('你好', config, { fetcher: async () => new Response(JSON.stringify({ output: { audio: {
    url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/voice.mp3?Signature=fixture' } } })), download });
  assert.equal(downloadArgs[0], 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/voice.mp3?Signature=fixture');
});

test('Qianwen rejects missing credentials, failed synthesis, unsafe or incomplete audio without fallback', async t => {
  const { config } = fixture(t);
  config.qianwenSpeech = { enabled: true, apiKeyFile: config.apiKeyFile, voice: 'qwen-audio-3.0-tts-flash-yanami-fixture' };
  let count = 0;
  await assert.rejects(synthesizeArk('你好', config, { fetcher: async () => { count++; return new Response('{}', { status: 403 }); } }), /千问语音接口 HTTP 403/);
  assert.equal(count, 1);
  await assert.rejects(synthesizeArk('你好', config, { fetcher: async () => new Response('{"output":{}}') }), /完整音频/);
  const response = url => async () => new Response(JSON.stringify({ output: { audio: { url } } }));
  await assert.rejects(synthesizeArk('你好', config, { fetcher: response('http://storage.example/file.mp3') }), /地址无效/);
  await assert.rejects(synthesizeArk('你好', config, { fetcher: response('https://127.0.0.1/file.mp3') }), /私有|本地|受限|禁止|公共|安全|IP|地址/);
  await assert.rejects(synthesizeArk('你好', config, { fetcher: response('https://storage.example/file.mp3'),
    download: async () => ({ statusCode: 200, buffer: Buffer.from('<html>not audio</html>') }) }), /不是 MP3/);
  await assert.rejects(synthesizeArk('你好', config, { fetcher: response('https://storage.example/file.mp3'),
    download: async () => ({ statusCode: 200, truncated: true, buffer: Buffer.from('ID3partial') }) }), /不完整/);
  config.qianwenSpeech.apiKeyFile = '';
  await assert.rejects(synthesizeArk('你好', config), /独立凭据/);
});

function sampleWav(seconds = 6) {
  const bytes = 48000 * seconds, b = Buffer.alloc(44 + bytes);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
test('voice training rejects whole episodes, malformed WAV and multiple channels before any upload', () => {
  assert.equal(trainingWav(sampleWav()).seconds, 6);
  assert.throws(() => trainingWav(sampleWav(26)), /完整单人对白/);
  assert.throws(() => trainingWav(sampleWav(4)), /完整单人对白/);
  const stereo = sampleWav(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => trainingWav(stereo), /单声道/);
  assert.throws(() => trainingWav(sampleWav().subarray(0, 100)), /完整/);
});

test('admin clone protocol uses Japanese, provider source separation, bounded response and no automatic retries', async t => {
  const { dir, config } = fixture(t); config.speaker = 'S_fixture123';
  const audio = path.join(dir, 'sample.wav'); fs.writeFileSync(audio, sampleWav());
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ speaker_id: config.speaker, status: url.endsWith('get_voice') ? 2 : 1 }));
  };
  assert.equal((await queryVoice(config, { fetcher })).status, 2);
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/get_voice');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'fixture-key');
  assert.deepEqual(calls[0].body, { speaker_id: config.speaker });
  assert.equal((await trainVoice(config, audio, { fetcher })).status, 1);
  assert.equal(calls[1].url, 'https://openspeech.bytedance.com/api/v3/tts/voice_clone');
  assert.equal(calls[1].body.language, 2);
  assert.equal(calls[1].body.extra_params.voice_clone_enable_mss, true);
  assert.equal(calls[1].body.extra_params.enable_check_audio_quality, true);
  assert.equal(calls[1].body.audio.format, 'wav');
  assert.deepEqual(Buffer.from(calls[1].body.audio.data, 'base64'), fs.readFileSync(audio));
  let failed = 0;
  await assert.rejects(queryVoice(config, { fetcher: async () => { failed++; return new Response('{"code":45000000,"message":"secret-provider-content"}', { status: 403 }); } }),
    e => /HTTP 403/.test(e.message) && !e.message.includes('secret-provider-content'));
  assert.equal(failed, 1);
  await assert.rejects(queryVoice(config, { fetcher: async () => new Response('{"speaker_id":"S_foreign","status":2}') }), /音色 ID/);
  await assert.rejects(queryVoice(config, { fetcher: async () => new Response('{"speaker_id":"S_fixture123"}') }), /训练状态/);
  await assert.rejects(queryVoice({ ...config, speaker: 'ICL_official' }, { fetcher }), /S_/);
  assert.equal(calls.length, 2);
});

test('clone configuration survives plugin normalization without registering training as a chat tool', async t => {
  const { dir, config } = fixture(t);
  config.voiceClone = { enabled: true, apiKeyFile: config.apiKeyFile, speaker: 'S_fixture123' };
  const cfg = { extensions: Object.fromEntries(['bilibili', 'image-search', 'qzone', 'quark', 'social-memory', 'esports'].map(id => [id, { enabled: false }])) };
  cfg.extensions.ark = { enabled: true, config };
  let seen;
  const host = createPluginHost({ root: fileURLToPath(new URL('..', import.meta.url)), stateDir: dir,
    getConfig: () => cfg, services: { 'ark.assist': () => { seen = cfg.extensions.ark.config.voiceClone; return { ok: true }; } } });
  t.after(() => host.close());
  assert.equal((await host.catalog()).some(x => /clone|train/.test(x.name)), false);
  await host.callTool('qq_synthesize_speech', { text: '你好' }, { key: 'group:12345', assertAuthorized() {} });
  assert.deepEqual(seen, config.voiceClone);
});
function serverFrame(data, last = true) {
  const payload = gzipSync(Buffer.from(JSON.stringify(data)));
  const head = Buffer.from([0x11, last ? 0x93 : 0x91, 0x11, 0]);
  const meta = Buffer.alloc(8); meta.writeInt32BE(last ? -1 : 1); meta.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, meta, payload]);
}
test('streaming ASR waits for the negative final frame and reports incomplete close', async t => {
  const { config } = fixture(t); let instance;
  class Socket extends EventEmitter {
    constructor(url, options) { super(); instance = this; this.sent = [];
      assert.equal(url, 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async');
      assert.equal(options.headers['X-Api-Key'], 'fixture-key');
      queueMicrotask(() => this.emit('open'));
    }
    send(frame) { this.sent.push(frame); if (frame[1] === 0x22) queueMicrotask(() => this.emit('message', serverFrame({ result: { text: '你好' } }))); }
    terminate() {}
  }
  const wav = Buffer.alloc(684); wav.write('RIFF'); wav.write('WAVE', 8); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  assert.equal((await transcribeArk(wav, config, { Socket })).text, '你好');
  assert.equal(instance.sent.length, 2);
  assert.equal(parseAsrFrame(serverFrame({ result: { text: 'partial' } }, false)).last, false);
  class Broken extends Socket { send() { queueMicrotask(() => this.emit('close')); } }
  await assert.rejects(transcribeArk(wav, config, { Socket: Broken }), /提前关闭/);
});
test('auxiliary services reject foreign photos and credentials, recheck revocation, and never send QQ messages', async t => {
  const { dir, config } = fixture(t); let active = true, calls = 0;
  const cfg = { extensions: { ark: { enabled: true, config } }, socialV2: { voice: { dir: 'audio' } } };
  const create = () => createArkAssistant({ stateDir: dir, projectRoot: dir, getConfig: () => cfg,
    readMessage: () => null, sanitizeText: s => s.replace('known-fixture-token', '[redacted]'),
    synthesize: async () => { calls++; active = false; return Buffer.from('audio'); } });
  const authorize = () => { if (!active) throw new Error('revoked'); };
  await assert.rejects(create().handle('group:1', { action: 'tts', text: 'known-fixture-token' }, authorize), /凭据/);
  await assert.rejects(create().handle('group:1', { action: 'photo', purpose: 'drawing', prompt: 'photo' }, authorize), /用于照片/);
  await assert.rejects(create().handle('group:1', { action: 'photo', purpose: 'photo-composition', requestMessageId: 4, prompt: 'photo', photos: [{ messageId: 8 }] }, authorize), /真实用户/);
  await assert.rejects(create().handle('group:1', { action: 'tts', text: 'hello' }, authorize), /revoked/);
  assert.equal(fs.existsSync(path.join(dir, 'audio')), false);
  assert.equal(calls, 1);
});
test('text-to-image needs no reference photo; search references are read through the scoped cache', async t => {
  const { dir, config } = fixture(t); config.imageGenerationEnabled = true;
  let refs, stores = 0, sourceKey;
  const image = Buffer.from('fixture-png');
  const assistant = createArkAssistant({ stateDir: dir, projectRoot: dir,
    getConfig: () => ({ extensions: { ark: { enabled: true, config } } }),
    readMessage: (_key, id) => id === 'request' ? { plain: '试试画画功能', userId: '12345' } : null,
    readSearchImage: (key, id) => { assert.equal(id, 'img_fixture'); sourceKey = key; return image; },
    validateImage: buffer => ({ buffer, mimeType: 'image/png' }),
    compose: async (_prompt, images) => { refs = images; return image; },
    storeImage: () => { stores++; return { imageId: 'generated' }; } });
  const result = await assistant.handle('private:12345', { action: 'image', requestMessageId: 'request', prompt: '画一只小鲸鱼' }, () => {});
  assert.equal(result.imageId, 'generated'); assert.deepEqual(refs, []);
  await assistant.handle('private:12345', { action: 'photo', purpose: 'photo-composition', requestMessageId: 'request',
    prompt: '合成照片', imageIds: ['img_fixture'] }, () => {});
  assert.equal(sourceKey, 'private:12345'); assert.equal(refs.length, 1); assert.equal(stores, 2);
});
