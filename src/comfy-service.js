import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalComfyClient } from './local-comfy-client.js';
import { SENSITIVE_RE } from './sensitive.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export function createComfyService({ stateDir, getConfig, readMessage, readMessageImages, validateImage,
  storeImage, sendVideo, onebot, sanitizeText = String, client, sleep = delay, imageWaitMs = 150000 }) {
  const config = () => getConfig().extensions?.comfy?.config ?? {};
  client ??= createLocalComfyClient({ getConfig: config });
  const file = path.join(stateDir, 'comfy-jobs.json');
  let rows = [], writable = true;
  try { if (fs.existsSync(file)) rows = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(rows)) throw new Error('invalid ledger'); }
  catch { rows = []; writable = false; }
  const save = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(rows), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  const check = authorize => {
    authorize();
    if (getConfig().extensions?.comfy?.enabled !== true) fail('本地生成插件未启用', 403);
    if (!writable) fail('本地生成任务记录损坏，已暂停该功能以防重复生成或发送', 503);
  };
  const clean = value => {
    const text = String(value ?? '').trim();
    if (!text || text.length > 1000 || SENSITIVE_RE.test(text) || sanitizeText(text) !== text) fail('生成描述为空、超长或包含凭据', 403);
    return text;
  };
  const find = (key, id) => {
    const row = rows.find(r => r.key === key && r.id === id);
    if (!row) fail('没有当前会话可查询的生成任务', 404);
    return row;
  };
  const meta = row => ({ jobId: row.id, kind: row.kind, state: row.state, provider: 'local-comfyui',
    model: row.kind === 'video' ? 'MiniMax-H3' : row.kind === 'edit' ? 'FLUX.2-Klein-4B' : 'Z-Image-Turbo',
    ...(row.error ? { error: row.error } : {}), ...(row.imageId ? { imageId: row.imageId } : {}),
    sent: row.send?.state === 'sent', ...(row.send ? { delivery: row.send } : {}),
    hint: row.state === 'failed' ? '本地任务已失败，不能声称已生成或发送。'
      : row.state === 'ready' ? '已生成，生成不等于发送。图片用qq_send_image；视频用qq_send_generated_video。明确说明AI生成。'
      : '本机异步生成中，约10～30秒后用qq_get_local_generation查询同一jobId；不重复新建，不声称已经发出。' });
  async function submit(key, kind, prompt, images, requestId, authorize, signal) {
    check(authorize);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([kind, prompt, images])).digest('hex');
    const old = rows.find(r => r.key === key && r.requestId === requestId);
    if (old) {
      if (old.fingerprint !== fingerprint) fail('requestId 已用于其他生成内容', 409);
      return old;
    }
    await client.call('/health', { signal }); check(authorize);
    const concurrent = rows.find(r => r.key === key && r.requestId === requestId);
    if (concurrent) {
      if (concurrent.fingerprint !== fingerprint) fail('requestId 已用于其他生成内容', 409);
      return concurrent;
    }
    const limit = kind === 'video' ? 2 : 8;
    if (rows.filter(r => r.key === key && r.kind === kind && Date.now() - r.at < 3600000).length >= limit) fail('本地生成每小时额度已用完', 429);
    const row = { id: 'gen_' + crypto.randomBytes(16).toString('hex'), key, kind, requestId, fingerprint, state: 'submitting', at: Date.now() };
    rows.push(row); save();
    try {
      const result = await client.call('/jobs', { body: { id: row.id, kind, prompt, images, seed: crypto.randomInt(2 ** 48 - 1) }, signal });
      check(authorize);
      if (result.id !== row.id || !['queued', 'running', 'ready'].includes(result.state)) throw new Error('本地生成未返回有效任务编号');
      row.state = result.state; save();
    } catch (error) {
      if (error.statusCode === 429) rows.splice(rows.indexOf(row), 1);
      else { row.state = 'uncertain'; error.message += '；jobId=' + row.id; }
      save(); throw Object.assign(error, { jobId: row.id });
    }
    return row;
  }
  async function refresh(row, authorize, signal) {
    check(authorize);
    const result = await client.call('/jobs/' + row.id, { signal }); check(authorize);
    if (result.id !== row.id || !['queued', 'running', 'ready', 'failed'].includes(result.state)) throw new Error('本地任务状态无效');
    row.state = result.state;
    if (result.state === 'ready') {
      if (!/^[a-f0-9]{64}$/.test(result.sha256) || !Number.isInteger(result.bytes) || result.bytes < 100 || result.bytes > 16 * 1024 * 1024) throw new Error('本地生成产物信息无效');
      row.sha256 = result.sha256; row.bytes = result.bytes;
    }
    if (result.state === 'failed') row.error = '本地生成失败（' + String(result.error || 'unknown').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) + '）';
    save(); return row;
  }
  async function artifact(row, authorize, signal) {
    const buffer = await client.call('/jobs/' + row.id + '/result', { binary: true, signal }); check(authorize);
    if (buffer.length !== row.bytes || crypto.createHash('sha256').update(buffer).digest('hex') !== row.sha256) throw new Error('本地生成产物完整性校验失败');
    return buffer;
  }
  async function generateImage(key, prompt, images, requestMessageId, authorize, signal) {
    const id = 'image_' + crypto.createHash('sha256').update(JSON.stringify([requestMessageId, prompt, images])).digest('hex').slice(0, 48);
    const row = await submit(key, images.length ? 'edit' : 'image', clean(prompt), images, id, authorize, signal);
    const deadline = Date.now() + imageWaitMs;
    while (Date.now() < deadline) {
      await refresh(row, authorize, signal);
      if (row.state === 'failed') throw Object.assign(new Error(row.error), { fallbackAllowed: true });
      if (row.state === 'ready') return { buffer: await artifact(row, authorize, signal), provider: 'local-comfyui', model: meta(row).model, jobId: row.id };
      await sleep(3000, undefined, { signal });
    }
    throw new Error(`本地生成仍在执行，jobId=${row.id}；用qq_get_local_generation查询，不自动启动火山重复生成`);
  }
  async function handle(key, args, authorize, signal) {
    check(authorize);
    if (args.action === 'generate-video') {
      if (config().videoGenerationEnabled !== true) fail('本地视频生成尚未启用', 403);
      const message = readMessage(key, args.requestMessageId);
      const text = String(message?.plain ?? message?.text ?? '');
      if (!message || message.isSelf || !/(生成|制作|做|变成).{0,12}(视频|动画|短片)|动起来/.test(text)
        || /(不要|别|不许|不用).{0,12}(生成|制作|做|视频|动画|动起来)/.test(text)) fail('需要当前会话真实用户提出视频生成请求', 403);
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.requestId)) fail('需要稳定的requestId');
      const images = [];
      if (args.imageMessageId !== undefined) {
        const source = readMessage(key, args.imageMessageId);
        if (!source) fail('参考图片不属于当前会话', 403);
        const raw = await readMessageImages(key, source.messageId, args.imageIndex || 1); check(authorize);
        const image = validateImage(raw, '视频首帧');
        if (!image || image.buffer.length > 8 * 1024 * 1024) fail('视频首帧无效或过大');
        images.push(`data:${image.mimeType};base64,${image.buffer.toString('base64')}`);
      }
      return meta(await submit(key, 'video', clean(args.prompt), images, args.requestId, authorize, signal));
    }
    const row = find(key, args.jobId);
    if (args.action === 'status') {
      await refresh(row, authorize, signal);
      if (row.state !== 'ready') return meta(row);
      if (row.send?.messageId && row.send.verified !== true) {
        const actual = await onebot('get_msg', { message_id: Number(row.send.messageId) }); check(authorize);
        row.send.verified = actual?.message?.some(segment => segment.type === 'video') === true;
        row.send.state = row.send.verified ? 'sent' : 'uncertain'; save();
      }
      if (row.kind !== 'video') {
        const raw = await artifact(row, authorize, signal);
        const image = validateImage(raw, '本地生成图片');
        if (!image) throw new Error('本地生成图片格式无效');
        if (!row.imageId) { row.imageId = storeImage(key, image.buffer, 'AI本地生成图片').imageId; save(); }
        return { ...meta(row), mimeType: image.mimeType, data: image.buffer.toString('base64') };
      }
      const preview = await client.call('/jobs/' + row.id + '/preview', { binary: true, signal, maxBytes: 1024 * 1024 }); check(authorize);
      const image = validateImage(preview, '视频预览');
      if (!image) throw new Error('视频预览格式无效');
      return { ...meta(row), mimeType: image.mimeType, data: image.buffer.toString('base64'), previewOnly: true };
    }
    if (args.action === 'send-video') {
      if (row.kind !== 'video' || config().videoSendEnabled !== true) fail('视频发送未启用或任务类型不符', 403);
      if (row.send) return meta(row); // Persisted intent prevents duplicates after timeout/restart.
      await refresh(row, authorize, signal);
      if (row.state !== 'ready') fail('视频尚未生成完成');
      const buffer = await artifact(row, authorize, signal);
      if (buffer.toString('ascii', 4, 8) !== 'ftyp') fail('本地结果不是有效MP4');
      if (row.send) return meta(row);
      row.send = { state: 'sending' }; save();
      try {
        const receipt = await sendVideo(key, buffer, () => check(authorize));
        if (!/^-?[1-9]\d*$/.test(String(receipt?.messageId ?? ''))) throw new Error('QQ网关未返回有效消息编号');
        row.send.messageId = String(receipt.messageId); save();
        const actual = await onebot('get_msg', { message_id: Number(receipt.messageId) }); check(authorize);
        row.send.verified = actual?.message?.some(segment => segment.type === 'video') === true;
        row.send.state = row.send.verified ? 'sent' : 'uncertain'; save();
      } catch (error) { row.send.state = error.notSent === true ? 'not_sent' : 'uncertain'; save(); throw error; }
      return meta(row);
    }
    fail('未知本地生成任务');
  }
  return { handle, generateImage };
}
