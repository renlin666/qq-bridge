import fs from 'node:fs';
import { synthesizeArk, speechProfile } from './ark-client.js';

// Deployment-owned loopback tunnel only. Agents cannot supply a URL, key or path.
const LOCAL = 'http://127.0.0.1:23916';
const MAX_AUDIO = 8 * 1024 * 1024;
export function checkSpeechText(text, config) {
  if (config.speechLanguage === 'Japanese' && (text.length > 120 || !/[\u3041-\u3096\u30a1-\u30fa]/u.test(text))) {
    throw new Error('语音目前只用日语短句：请将内容写成自然日语（含假名，最多120字符），中文继续用文字回复');
  }
}
export async function synthesizeSpeech(text, config, { signal, fetcher = fetch, cloud = synthesizeArk } = {}) {
  checkSpeechText(text, config);
  const local = config.localSpeech;
  let fallbackReason;
  if (local?.enabled === true) {
    try {
      const key = fs.readFileSync(local.tokenFile, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('local_configuration');
      const headers = { Authorization: `Bearer ${key}` };
      const health = await fetcher(LOCAL + '/health', { headers, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000) });
      if (!health.ok) throw new Error('local_unavailable');
      const response = await fetcher(LOCAL + '/synthesize', { method: 'POST', redirect: 'error',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language: 'Japanese' }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000) });
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') throw new Error('local_generation_failed');
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_AUDIO) { await response.body.cancel().catch(() => {}); throw new Error('local_audio_invalid'); }
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4 || !(buffer.toString('ascii', 0, 3) === 'ID3'
        || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))) throw new Error('local_audio_invalid');
      signal?.throwIfAborted();
      const speaker = response.headers.get('x-voice-profile') === 'yanami-sft-v2' ? 'yanami-local-sft-v2' : 'yanami-local-icl';
      return { buffer, provider: 'local-qwen3-tts', speaker, language: 'Japanese' };
    } catch (error) {
      signal?.throwIfAborted(); // Cancellation must never start a paid fallback.
      fallbackReason = ['local_configuration', 'local_unavailable', 'local_generation_failed', 'local_audio_invalid'].includes(error.message)
        ? error.message : 'local_offline_or_timeout';
    }
    // Only the explicitly selected pay-as-you-go provider is permitted here.
    if (config.qianwenSpeech?.enabled !== true) throw new Error('本地语音不可用，千问回退尚未启用');
  }
  const buffer = await cloud(text, config, { signal });
  const profile = speechProfile(config);
  return { buffer, provider: profile.provider || 'doubao', speaker: profile.speaker,
    ...(config.speechLanguage ? { language: config.speechLanguage } : {}), ...(fallbackReason ? { fallbackReason } : {}) };
}
