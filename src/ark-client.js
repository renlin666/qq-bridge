import fs from 'node:fs';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { safeFetchAudioBuffer } from './safe-fetch.js';

const BASE = 'https://ark.cn-beijing.volces.com/api/plan/v3';
const VOICE = 'https://openspeech.bytedance.com/api/v3/plan';
const fail = message => { throw new Error(message); };
export function arkPaused(config) {
  return Number.isFinite(config?.pauseUntil) && Date.now() < config.pauseUntil;
}
function checkArkPause(config) {
  if (arkPaused(config)) fail('火山方舟模型线路暂时停用');
}
export function arkKey(config) {
  const key = fs.readFileSync(config.apiKeyFile, 'utf8').trim();
  if (!key || /\s/.test(key)) fail('方舟凭据文件无效');
  return key;
}
export function speechProfile(config) {
  if (config.qianwenSpeech?.enabled === true) {
    const speech = config.qianwenSpeech;
    if (!speech.apiKeyFile || !/^qwen-audio-3\.0-tts-flash-[A-Za-z0-9-]{1,200}$/.test(speech.voice ?? '')) fail('千问语音需要独立凭据文件及已创建的音色 ID');
    return { apiKeyFile: speech.apiKeyFile, speaker: speech.voice, provider: 'qianwen',
      endpoint: 'https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer', model: 'qwen-audio-3.0-tts-flash' };
  }
  if (config.voiceClone?.enabled === true) {
    const clone = config.voiceClone;
    if (!/^S_[A-Za-z0-9]+$/.test(clone.speaker ?? '') || !clone.apiKeyFile) fail('复刻语音需要独立凭据文件及有效的 S_ 音色 ID');
    return { ...clone, endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', resource: 'seed-icl-2.0' };
  }
  return { apiKeyFile: config.apiKeyFile, speaker: config.speaker,
    endpoint: `${VOICE}/tts/unidirectional`, resource: 'seed-tts-2.0' };
}
async function bounded(response, maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail('方舟响应超过大小限制');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function signalFor(signal, ms) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms); }
async function request(config, endpoint, body, { fetcher = fetch, signal, maxBytes = 4 * 1024 * 1024, headers, timeoutMs = 120000 } = {}) {
  checkArkPause(config);
  const response = await fetcher(endpoint, { method: 'POST', redirect: 'error',
    signal: signalFor(signal, timeoutMs), headers: { 'Content-Type': 'application/json',
      ...(headers ?? { Authorization: `Bearer ${arkKey(config)}` }) }, body: JSON.stringify(body) });
  if (!response.ok) fail(`方舟接口 HTTP ${response.status}（未切换到其他计费接口）`);
  return bounded(response, maxBytes);
}
export async function synthesizeArk(text, config, options = {}) {
  const speech = speechProfile(config);
  if (!speech.speaker) fail('尚未配置已确认的音色 ID');
  if (speech.provider === 'qianwen') return synthesizeQianwen(text, speech, options);
  checkArkPause(config);
  const raw = await request(speech, speech.endpoint, {
    user: { uid: 'qq-bridge' }, req_params: { text, speaker: speech.speaker,
      audio_params: { format: 'mp3', sample_rate: 24000 } }
  }, { ...options, maxBytes: 12 * 1024 * 1024, headers: {
    'X-Api-Key': arkKey(speech), 'X-Api-Resource-Id': speech.resource, 'X-Api-Request-Id': crypto.randomUUID() } });
  const audio = []; let done = false;
  for (const line of raw.toString('utf8').split(/\r?\n/).filter(s => s.trim())) {
    const row = JSON.parse(line);
    if (![0, 1000, 20000000].includes(row.code)) fail(`豆包语音合成失败（code=${Number(row.code) || 'unknown'}）`);
    if (row.data) audio.push(Buffer.from(row.data, 'base64'));
    if (row.code === 1000 || row.code === 20000000) done = true;
  }
  const buffer = Buffer.concat(audio);
  if (!done || !buffer.length || buffer.length > 8 * 1024 * 1024) fail('豆包语音流未完整结束，未生成可发送语音');
  return buffer;
}
async function synthesizeQianwen(text, speech, { fetcher = fetch, download = safeFetchAudioBuffer, signal } = {}) {
  const response = await fetcher(speech.endpoint, { method: 'POST', redirect: 'error',
    signal: signalFor(signal, 120000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${arkKey(speech)}` },
    body: JSON.stringify({ model: speech.model, input: { text, voice: speech.speaker, format: 'mp3', sample_rate: 24000 } }) });
  if (!response.ok) fail(`千问语音接口 HTTP ${response.status}（未自动重试或切换平台）`);
  const result = JSON.parse((await bounded(response, 1024 * 1024)).toString('utf8'));
  if (result.code || !result.output?.audio?.url) fail('千问语音未返回完整音频，未生成可发送语音');
  const url = new URL(result.output.audio.url);
  // This provider returns signed OSS links with http even though OSS supports TLS.
  if (url.protocol === 'http:' && /^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)) url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.username || url.password) fail('千问音频地址无效');
  signal?.throwIfAborted();
  // Signed public audio URL only; never forward the platform API key to storage.
  const audio = await download(url.href, 8 * 1024 * 1024);
  signal?.throwIfAborted();
  const buffer = audio.buffer;
  if (audio.statusCode !== 200 || audio.truncated || !Buffer.isBuffer(buffer) || buffer.length < 4
    || buffer.length > 8 * 1024 * 1024 || !(buffer.toString('ascii', 0, 3) === 'ID3'
      || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))) fail('千问音频下载不完整或不是 MP3，未生成可发送语音');
  return buffer;
}
export async function embedArk(text, config, options = {}) {
  const raw = JSON.parse((await request(config, `${BASE}/embeddings/multimodal`, {
    model: 'doubao-embedding-vision', dimensions: 1024, input: [{ type: 'text', text }]
  }, options)).toString('utf8'));
  const vector = raw.data?.embedding ?? raw.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 1024 || !vector.every(Number.isFinite)) fail('豆包向量响应无效');
  return vector;
}
export async function composeArk(prompt, images, config, options = {}) {
  const raw = JSON.parse((await request(config, `${BASE}/images/generations`, {
    model: 'doubao-seedream-5.0-flash', prompt,
    ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}), size: '2K',
    response_format: 'b64_json', watermark: true
  }, { ...options, maxBytes: 16 * 1024 * 1024 })).toString('utf8'));
  if (!raw.data?.[0]?.b64_json) fail('照片合成未返回图片');
  const buffer = Buffer.from(raw.data[0].b64_json, 'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) fail('合成照片大小无效');
  return buffer;
}
export function asrFrame(type, payload, { last = false, json = false } = {}) {
  const bytes = gzipSync(json ? Buffer.from(JSON.stringify(payload)) : payload);
  const header = Buffer.from([0x11, (type << 4) | (last ? 2 : 0), (json ? 0x10 : 0) | 1, 0]);
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  return Buffer.concat([header, size, bytes]);
}
export function parseAsrFrame(buffer) {
  if (buffer.length < 8 || buffer[0] >> 4 !== 1) fail('豆包语音识别帧无效');
  const type = buffer[1] >> 4, flags = buffer[1] & 15;
  let offset = (buffer[0] & 15) * 4;
  let sequence;
  if (flags & 1) { sequence = buffer.readInt32BE(offset); offset += 4; }
  if (flags & 4) offset += 4; // optional event ID
  if (type === 15) {
    const code = buffer.readUInt32BE(offset);
    fail(`豆包语音识别失败（code=${code}）`);
  }
  if (type !== 9 || offset + 4 > buffer.length) fail('豆包语音识别响应类型无效');
  const size = buffer.readUInt32BE(offset); offset += 4;
  if (size > 1024 * 1024 || size !== buffer.length - offset) fail('豆包语音识别载荷大小无效');
  let payload = buffer.subarray(offset);
  if ((buffer[2] & 15) === 1) payload = gunzipSync(payload, { maxOutputLength: 1024 * 1024 });
  return { data: JSON.parse(payload.toString('utf8')), last: !!(flags & 2) || sequence < 0 };
}
export async function transcribeArk(wav, config, { signal, Socket = WebSocket } = {}) {
  checkArkPause(config);
  // Callers provide canonical 16-kHz mono PCM WAV; refuse arbitrary paths/URLs.
  if (!Buffer.isBuffer(wav) || wav.length < 46 || wav.length > 10 * 1024 * 1024
    || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE'
    || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16
    || wav.toString('ascii', 36, 40) !== 'data') fail('需要规范的16kHz单声道PCM WAV');
  const pcm = wav.subarray(44), audioSeconds = pcm.length / 32000;
  if (audioSeconds > 300) fail('单次语音识别最多5分钟');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = new Socket(`${VOICE.replace('https:', 'wss:')}/sauc/bigmodel_async`, {
      headers: { 'X-Api-Key': arkKey(config), 'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
        'X-Api-Request-Id': crypto.randomUUID(), 'X-Api-Sequence': '-1' },
      maxPayload: 1024 * 1024, handshakeTimeout: 15000, perMessageDeflate: false
    });
    let settled = false, latest = '';
    const finish = (error, result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      socket.terminate(); error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new Error('语音识别已取消'));
    const timer = setTimeout(() => finish(new Error('语音识别超时')), Math.min(360000, audioSeconds * 1000 + 45000));
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish(new Error('豆包语音识别连接失败')));
    socket.on('unexpected-response', (_req, res) => { res.resume(); finish(new Error(`豆包语音识别握手 HTTP ${res.statusCode}`)); });
    socket.on('close', () => finish(new Error('语音识别连接提前关闭，未收到最终结果')));
    socket.on('message', bytes => {
      try {
        const frame = parseAsrFrame(Buffer.from(bytes));
        if (frame.data.code && ![0, 20000000].includes(frame.data.code)) fail(`语音识别失败（code=${Number(frame.data.code)}）`);
        const text = frame.data.result?.text ?? frame.data.payload_msg?.result?.text;
        if (typeof text === 'string') latest = text;
        if (frame.last) finish(null, { text: latest, audioSeconds, source: 'doubao-seed-asr-2.0' });
      } catch (error) { finish(error); }
    });
    socket.on('open', async () => {
      try {
        socket.send(asrFrame(1, { user: { uid: 'qq-bridge' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
          request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, show_utterances: true, result_type: 'full' } }, { json: true }));
        for (let offset = 0; offset < pcm.length && !settled; offset += 6400) {
          socket.send(asrFrame(2, pcm.subarray(offset, offset + 6400), { last: offset + 6400 >= pcm.length }));
          if (offset + 6400 < pcm.length) await new Promise(r => setTimeout(r, 100));
        }
      } catch { finish(new Error('语音识别发送失败')); }
    });
  });
}
