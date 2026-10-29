import fs from 'node:fs';
import crypto from 'node:crypto';
import { arkKey } from './ark-client.js';

// Administrator-only utility. Never registered as a QQ or model tool.
function check(config) {
  if (!config.apiKeyFile || !/^S_[A-Za-z0-9]+$/.test(config.speaker ?? '')) {
    throw new Error('需要声音复刻专用 apiKeyFile 和控制台提供的 S_ 音色 ID');
  }
}
async function call(action, config, body, { fetcher = fetch } = {}) {
  check(config);
  const response = await fetcher(`https://openspeech.bytedance.com/api/v3/tts/${action}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': arkKey(config), 'X-Api-Request-Id': crypto.randomUUID() },
    body: JSON.stringify({ speaker_id: config.speaker, ...body })
  });
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('声音复刻响应过大');
    chunks.push(Buffer.from(chunk));
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`声音复刻返回无效 JSON（HTTP ${response.status}）`); }
  if (!response.ok || (result.code != null && ![0, 20000000].includes(result.code))) {
    // Do not echo provider messages, credentials, base64 samples, or signed demo URLs.
    throw new Error(`声音复刻失败（HTTP ${response.status}，code=${Number(result.code) || 'unknown'}）；未重试`);
  }
  if (result.speaker_id !== config.speaker || ![0, 1, 2, 3, 4].includes(result.status)) {
    throw new Error('声音复刻返回音色 ID 或训练状态无效');
  }
  return result;
}
export function queryVoice(config, options) { return call('get_voice', config, {}, options); }
export function trainingWav(buffer) {
  if (buffer.length < 44 || buffer.length > 10 * 1024 * 1024
    || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE'
    || buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error('训练样本需要完整的 WAV，最大10MiB');
  let fmt, dataSize;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > buffer.length) throw new Error('WAV 数据不完整');
    const id = buffer.toString('ascii', offset, offset + 4);
    if (id === 'fmt ' && size >= 16) fmt = buffer.subarray(start, start + size);
    if (id === 'data') dataSize = size;
    offset = start + size + (size & 1);
  }
  if (!fmt || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1
    || fmt.readUInt32LE(4) !== 24000 || fmt.readUInt16LE(14) !== 16
    || fmt.readUInt32LE(8) !== 48000 || fmt.readUInt16LE(12) !== 2 || dataSize % 2 !== 0) {
    throw new Error('训练样本需要24kHz单声道16bit PCM WAV');
  }
  const seconds = dataSize / 48000;
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 25) throw new Error('请选择5～25秒的完整单人对白，整集音轨不能直接训练');
  return { seconds, bytes: buffer.length };
}
export async function trainVoice(config, audioFile, options) {
  check(config);
  const stat = fs.statSync(audioFile);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('训练样本文件无效或超过10MiB');
  const audio = fs.readFileSync(audioFile); trainingWav(audio);
  // Japanese reference audio. Provider separation is not a substitute for selecting one speaker.
  return call('voice_clone', config, { audio: { data: audio.toString('base64'), format: 'wav' }, language: 2,
    extra_params: { voice_clone_enable_mss: true, enable_audio_denoise: true,
      enable_check_audio_quality: true, enable_crop_by_asr: true } }, options);
}
