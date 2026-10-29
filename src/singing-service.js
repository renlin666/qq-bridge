import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const LOCAL = 'http://127.0.0.1:23916';
const MODEL_HASH = 'ad0f36aba2a369cf80d1894c5c6fd0684a7c8a6f45dc61ef2bd87f6c0cc84b78';
const SPEAKER = 'manbo-zh-rvc-slot-0';
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export function createSingingService({ stateDir, projectRoot, getConfig, readMessage, fetcher = fetch }) {
  const ledger = path.join(stateDir, 'singing-jobs.json');
  let rows = [], writable = true;
  try { if (fs.existsSync(ledger)) rows = JSON.parse(fs.readFileSync(ledger, 'utf8')); if (!Array.isArray(rows)) throw Error(); }
  catch { writable = false; }
  const save = () => { fs.writeFileSync(ledger + '.tmp', JSON.stringify(rows), { mode: 0o600 }); fs.renameSync(ledger + '.tmp', ledger); };
  function check(authorize) {
    authorize();
    const cfg = getConfig();
    if (!writable || cfg.extensions?.singing?.enabled !== true || !['Japanese', 'Auto'].includes(cfg.extensions.singing.config?.language)
      || cfg.socialV2?.voice?.enabled === false) fail('唱歌功能未启用', 403);
  }
  async function call(route, authorize, signal, body) {
    check(authorize);
    const token = fs.readFileSync(getConfig().extensions.singing.config.tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) fail('本地唱歌连接未配置', 503);
    let response;
    // Search can retry one risk-control response, with a 25 s limit per attempt.
    const timeoutMs = route.startsWith('/sing/search?') ? 55000 : 10000;
    try {
      response = await fetcher(LOCAL + route, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      signal?.throwIfAborted();
      throw Object.assign(new Error('本地电脑离线或唱歌服务暂不可用；不会调用付费替代服务'),
        { statusCode: 503, notSubmitted: error?.cause?.code === 'ECONNREFUSED' });
    }
    check(authorize);
    if (!response.ok) {
      if (response.status === 429) {
        const detail = await response.json().catch(() => ({}));
        fail(detail.error === 'daily_limit' ? '本机滚动24小时最多处理20个唱歌任务，请稍后再试' : '本地正在生成，请稍后查询原任务', 429);
      }
      fail('本地唱歌任务暂不可用', 503);
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { await response.body.cancel().catch(() => {}); fail('唱歌结果大小无效', 502); }
      chunks.push(Buffer.from(chunk));
    }
    check(authorize);
    return Buffer.concat(chunks);
  }
  const meta = row => ({ jobId: row.id, state: row.state, language: row.speaker ? 'Auto' : 'Japanese', provider: 'local-rvc', speaker: row.speaker || 'yanami-ja-rvc-v1',
    ...(row.voice ? { voice: row.voice } : {}), ...(row.error ? { error: row.error } : {}), sent: false,
    hint: row.state === 'ready' ? '已生成，尚未发送；用qq_send_voice或已授权的qq_send_to_contact发送voice。'
      : row.state === 'failed' ? '生成失败，不可声称已唱好或已发送。' : '约15～30秒后查询同一jobId，不重复提交。' });
  async function handle(key, args, authorize, signal) {
    check(authorize);
    if (args.action === 'generate') {
      if ((args.language != null && (typeof args.language !== 'string' || !args.language.trim() || args.language.length > 40 || /[\u0000-\u001f\u007f]/u.test(args.language))) || !/^BV[0-9A-Za-z]{10}$/.test(args.bvid || '')
        || !Number.isFinite(args.startSeconds) || args.startSeconds < 0 || args.startSeconds > 600
        || !Number.isInteger(args.durationSeconds ?? 30) || (args.durationSeconds ?? 30) < 15 || (args.durationSeconds ?? 30) > 30
        || !/^[A-Za-z0-9_-]{8,100}$/.test(args.requestId || '')) fail('只支持15～30秒歌曲和真实B站编号');
      const message = readMessage(key, args.requestMessageId);
      const text = String(message?.plain ?? message?.text ?? '');
      if (!message || message.isSelf || !/(唱|翻唱|点歌|歌って|歌を)/u.test(text)
        || /(不要|不许|不用|别).{0,8}(唱|点歌)/u.test(text)) fail('需要当前会话真实用户的点歌请求', 403);
      const input = { bvid: args.bvid, startSeconds: args.startSeconds, durationSeconds: args.durationSeconds ?? 30, language: 'Auto' };
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      let row = rows.find(r => r.key === key && r.requestId === args.requestId);
      if (row) {
        if (row.fingerprint !== fingerprint) fail('requestId已用于其他歌曲', 409);
        if (row.state !== 'not_submitted') return meta(row);
        rows.splice(rows.indexOf(row), 1);
      }
      if (rows.filter(r => r.key === key && !r.quotaExempt && !['not_submitted', 'failed'].includes(r.state)
        && Date.now() - r.at < 3600000).length >= 3) fail('每个会话滚动一小时最多3段翻唱', 429);
      row = { id: 'sing_' + crypto.randomBytes(16).toString('hex'), key, requestId: args.requestId, fingerprint, at: Date.now(), state: 'submitting', speaker: SPEAKER };
      rows.push(row); save();
      try {
        const result = JSON.parse((await call('/sing/jobs', authorize, signal, { id: row.id, ...input })).toString());
        if (result.id !== row.id || !['queued', 'running', 'ready'].includes(result.state)) throw Error('无效任务状态');
        row.state = result.state;
      } catch (error) {
        if (error.notSubmitted || error.statusCode === 429) {
          rows.splice(rows.indexOf(row), 1); save(); throw error;
        }
        row.state = 'uncertain'; row.error = String(error.message).slice(0, 160);
      }
      save(); return meta(row);
    }
    if (args.action === 'search') {
      const query = String(args.query ?? '').replace(/\s+/gu, ' ').trim();
      if (!query || query.length > 60 || /[\u0000-\u001f]/u.test(query)) fail('歌名无效');
      const route = '/sing/search?' + new URLSearchParams({ q: query });
      let raw;
      try { raw = await call(route, authorize, signal); }
      catch (error) { if (error?.statusCode === 503) fail('搜索暂时不可用：本机离线或被B站限流，稍后重试', 503); throw error; }
      const result = JSON.parse(raw.toString());
      const candidates = (Array.isArray(result.candidates) ? result.candidates : []).slice(0, 5)
        .filter(row => /^BV[0-9A-Za-z]{10}$/.test(String(row?.bvid ?? '')))
        .map(row => ({ bvid: String(row.bvid), title: String(row.title ?? '').slice(0, 80),
          author: String(row.author ?? '').slice(0, 40), durationSeconds: Number(row.durationSeconds) || 0,
          suggestedStartSeconds: Math.min(600, Math.max(0, Number(row.suggestedStartSeconds) || 0)) }));
      return { query, candidates, hint: candidates.length
        ? '选含清晰人声的原唱或现场编号（跳过纯伴奏、卡拉OK和鬼畜），用qq_generate_singing(bvid,startSeconds,durationSeconds=15~30,language="Auto",requestId,requestMessageId)生成。'
        : '没搜到可翻唱的视频：换歌手名或歌名再搜，仍没有再如实说没找到。' };
    }
    if (args.action !== 'status' || !/^sing_[a-f0-9]{32}$/.test(args.jobId || '')) fail('唱歌任务参数无效');
    const row = rows.find(r => r.key === key && r.id === args.jobId);
    if (!row) fail('没有当前会话可查询的唱歌任务', 404);
    if (row.state === 'ready' && row.voice) return meta(row);
    const result = JSON.parse((await call('/sing/jobs/' + row.id, authorize, signal)).toString());
    if (result.id !== row.id || !['queued', 'running', 'ready', 'failed'].includes(result.state)) fail('本地任务状态无效', 502);
    row.state = result.state; delete row.error;
    if (result.state === 'failed') row.error = String(result.error || '生成失败').slice(0, 160);
    if (result.state === 'ready') {
      if (result.language !== 'Auto' || result.modelSha256 !== MODEL_HASH || result.speakerId !== 0) fail('唱歌语言或音色校验失败', 502);
      row.speaker = SPEAKER;
      const buffer = await call('/sing/jobs/' + row.id + '/audio', authorize, signal);
      if (buffer.length < 128 || !(buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 255 && (buffer[1] & 224) === 224))
        || crypto.createHash('sha256').update(buffer).digest('hex') !== result.sha256) fail('唱歌音频校验失败', 502);
      const dir = path.resolve(projectRoot, getConfig().socialV2?.voice?.dir || 'audio');
      fs.mkdirSync(dir, { recursive: true });
      row.voice = 'ark-sing-' + row.id.slice(5) + '.mp3';
      check(authorize); fs.writeFileSync(path.join(dir, row.voice), buffer, { mode: 0o600 });
    }
    save(); return meta(row);
  }
  return { handle };
}
