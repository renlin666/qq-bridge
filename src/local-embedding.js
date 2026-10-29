import fs from 'node:fs';

// Fixed authenticated tunnel; callers cannot choose the destination or credentials.
export async function embedLocal(text, config, { signal, timeoutMs = 10000, fetcher = fetch } = {}) {
  const key = fs.readFileSync(config.localSpeech?.tokenFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('本地向量服务配置无效');
  const timeout = Math.max(2000, Math.min(30000, timeoutMs));
  const response = await fetcher('http://127.0.0.1:23916/embed', {
    method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error('本地向量服务不可用');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 100000) throw new Error('向量响应过大');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  while (true) { const {done, value} = await reader.read(); if (done) break; size += value.length;
    if (size > 100000) { await reader.cancel(); throw new Error('向量响应过大'); } chunks.push(value); }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8')).embedding;
  if (!Array.isArray(result) || result.length !== 1024 || !result.every(Number.isFinite)) throw new Error('向量维度无效');
  return result;
}
