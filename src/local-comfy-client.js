import fs from 'node:fs';

const BASE = 'http://127.0.0.1:23918';
export function createLocalComfyClient({ getConfig, fetcher = fetch }) {
  async function call(route, { body, binary = false, signal, maxBytes = 16 * 1024 * 1024 } = {}) {
    const token = fs.readFileSync(getConfig().tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('本地生成凭据配置无效');
    let response;
    try {
      response = await fetcher(BASE + route, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    } catch (error) {
      signal?.throwIfAborted();
      throw Object.assign(new Error('本机生成服务离线或连接超时'), { fallbackAllowed: route === '/health', cause: error });
    }
    if (!response.ok) throw Object.assign(new Error(response.status === 429 ? '本地生成任务正在执行，请稍后查询或重试' : `本地生成服务请求失败（${response.status}）`), { statusCode: response.status });
    if (binary && !['image/png', 'video/mp4'].includes(response.headers.get('content-type')?.split(';')[0])) throw new Error('本地生成返回类型无效');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > (binary ? maxBytes : 16 * 1024)) throw new Error('本地生成返回超出大小限制');
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    return binary ? buffer : JSON.parse(buffer.toString('utf8'));
  }
  return { call };
}
