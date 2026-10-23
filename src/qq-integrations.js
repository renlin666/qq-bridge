import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { biliReferences } from './bilibili.js';
import { readBilibiliMedia } from './bilibili-media.js';
import { inspectMagnet, normalizeMagnet, quarkStatus } from './quark-drive.js';
import { safeFetchBuffer } from './safe-fetch.js';
import { SENSITIVE_RE } from './sensitive.js';
import { createQzoneSocial } from './qzone-social.js';

export const INTEGRATION_PREFIX = '/api/socialV2/integrations/';
export function createIntegrations({ stateDir, getConfig, onebot, getConversation, sessionAllowed, tokenOk, socialHub,
  readMessageImages, readSelfImage, validateImage, notifyQzone = async () => {}, fetchImage = safeFetchBuffer,
  readVideo = readBilibiliMedia, readMagnet = inspectMagnet, driveStatus = quarkStatus }) {
  const ledgerFile = path.join(stateDir, 'qzone-posts.json');
  const qzone = createQzoneSocial({ stateDir, getConfig, onebot, sessionAllowed, notify: notifyQzone });
  let publishing = false;
  let magnetReading = false;
  let videoReading = false;
  const lastRead = new Map();
  const videoCache = new Map();
  function error(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
  function checkScope(body, req) {
    const key = String(body.key ?? '').trim();
    if (!/^(group|private):[1-9]\d*$/.test(key)) error('key 格式无效');
    const token = req.headers['x-agent-token'];
    if ((token || req.headers['x-agent-call'] !== undefined) && (!token || !tokenOk(key, token))) error('agent token 无效', 403);
    if (!sessionAllowed(key)) error('会话不在当前允许范围内', 403);
    return key;
  }
  function receivedText(key, body) {
    const st = getConversation(key);
    const messages = [...(st?.recentMessages ?? []), ...(st?.unread ?? [])];
    const ref = String(body.messageId ?? '');
    const msg = messages.find(m => String(m.seq) === ref || String(m.messageId) === ref);
    if (!ref || !msg) error('只能读取当前会话已收到的消息，请传真实 messageId 或 seq', 404);
    return `${(msg.sharedLinks ?? []).join('\n')}\n${msg.text ?? ''}\n${msg.plain ?? ''}\n${msg.tail ?? ''}`;
  }
  function readThrottle(key, kind) {
    const id = `${key}:${kind}`;
    if (Date.now() - (lastRead.get(id) ?? 0) < 5000) error('读取过于频繁，请稍后重试', 429);
    lastRead.set(id, Date.now());
    if (lastRead.size > 2000) lastRead.delete(lastRead.keys().next().value);
  }
  function readLedger() {
    if (!fs.existsSync(ledgerFile)) return [];
    const rows = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    if (!Array.isArray(rows)) error('空间发布记录损坏，暂停发布，请管理员检查', 503);
    return rows;
  }
  function saveLedger(rows) {
    const temp = `${ledgerFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    fs.renameSync(temp, ledgerFile);
  }

  async function handle({ req, url, readBody, sendJson }) {
    if (!url.pathname.startsWith(INTEGRATION_PREFIX)) return false;
    if (req.method !== 'POST') { sendJson({ ok: false, error: '请使用 POST' }, 405); return true; }
    const body = await readBody();
    const key = checkScope(body, req);
    const cfg = getConfig();
    const integrations = cfg.integrations ?? {};
    const action = url.pathname.slice(INTEGRATION_PREFIX.length);
    const socialResult = await socialHub?.handle(action, key, body, () => checkScope(body, req));
    if (socialResult != null) {
      checkScope(body, req);
      sendJson({ ok: true, key, ...socialResult }); return true;
    }
    const spaceResult = await qzone.handle(action, key, body, () => checkScope(body, req));
    if (spaceResult != null) { checkScope(body, req); sendJson({ ok: true, key, ...spaceResult }); return true; }
    if (action === 'bilibili') {
      if (integrations.bilibili?.enabled === false) error('B站解析已关闭', 403);
      const refs = biliReferences(receivedText(key, body));
      const reference = refs[Math.max(0, Math.trunc(Number(body.index) || 1) - 1)];
      if (!reference) error('这条消息没有对应的 B站视频链接');
      const cacheKey = JSON.stringify([reference, body.page ?? 1, body.startSeconds ?? 0, body.endSeconds ?? null, body.frameCount ?? 16]);
      const cached = videoCache.get(cacheKey);
      let video;
      if (cached && Date.now() - cached.at < 600000) video = cached.value;
      else {
        if (videoReading) error('正在读取另一个视频，请稍后重试', 429);
        readThrottle(key, action);
        videoReading = true;
        try {
          video = await readVideo(reference, { page: body.page, startSeconds: body.startSeconds,
            endSeconds: body.endSeconds, frameCount: body.frameCount, media: integrations.bilibili, stateDir });
          videoCache.set(cacheKey, { at: Date.now(), value: video });
          if (videoCache.size > 12) videoCache.delete(videoCache.keys().next().value);
        } finally { videoReading = false; }
      }
      checkScope(body, req);
      if (getConfig().integrations?.bilibili?.enabled === false) error('B站解析已关闭', 403);
      sendJson({ ok: true, key, video }); return true;
    }
    if (action === 'quark-status') {
      sendJson({ ok: true, enabled: integrations.quark?.enabled === true, ...await driveStatus(integrations.quark) }); return true;
    }
    if (action === 'magnet') {
      if (integrations.quark?.enabled !== true) error('夸克磁力解析未启用', 403);
      const text = receivedText(key, body).replace(/&amp;/g, '&');
      const magnets = [...new Set(text.match(/magnet:\?[^\s<>"'\]]+/gi) ?? [])];
      const value = magnets[Math.max(0, Math.trunc(Number(body.index) || 1) - 1)];
      if (!value) error('这条消息没有对应的磁力链接');
      const magnet = normalizeMagnet(value);
      if (magnetReading) error('夸克正在解析另一条链接', 429);
      readThrottle(key, action);
      magnetReading = true;
      try {
        const result = await readMagnet(magnet, integrations.quark);
        // Recheck after the desktop operation, before releasing private results.
        checkScope(body, req);
        sendJson({ ok: true, key, result });
      } finally { magnetReading = false; }
      return true;
    }
    if (action === 'qzone-publish') {
      const options = integrations.qzone ?? {};
      if (options.enabled !== true) error('QQ 空间发布未启用', 403);
      if (!Array.isArray(options.allowedKeys) || !options.allowedKeys.map(String).includes(key)) error('该会话未获得空间发布权限', 403);
      const content = String(body.content ?? '').trim();
      if (!content || content.length > 2000) error('说说正文应为 1～2000 字');
      if (SENSITIVE_RE.test(content)) error('正文被敏感信息审计拦截', 403);
      const requestId = String(body.requestId ?? '').trim();
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) error('requestId 需为 8～100 位字母数字、下划线或连字符；重试必须复用同一个值');
      const urls = body.imageUrls ?? [];
      if (!Array.isArray(urls) || urls.length > 9 || urls.some(u => typeof u !== 'string' || !/^https:\/\//i.test(u))) error('最多 9 张公开 HTTPS 图片');
      const refs = body.imageMessages ?? [];
      if (!Array.isArray(refs) || refs.some(r => !r || !['string', 'number'].includes(typeof r.messageId)
        || (r.index != null && (!Number.isInteger(r.index) || r.index < 1 || r.index > 9)))) error('imageMessages 需要真实 messageId 和可选图片序号 index');
      if (urls.length + refs.length + (body.includeSelfImage === true ? 1 : 0) > 9) error('每条空间最多 9 张图片');
      const visibility = Number(options.visibility ?? 4);
      if (![1, 4, 64].includes(visibility)) error('空间可见范围配置无效');
      if (publishing) error('空间正在发布另一条内容', 429);
      publishing = true;
      try {
        const now = Date.now();
        let rows = readLedger().filter(r => now - r.at < 7 * 86400000);
        const sources = refs.map(r => ({ messageId: String(r.messageId), index: r.index ?? 1 }));
        const digest = crypto.createHash('sha256').update(JSON.stringify({ key, content, urls, visibility,
          ...(sources.length ? { sources } : {}), ...(body.includeSelfImage === true ? { selfImage: true } : {}) })).digest('hex');
        const duplicate = rows.find(r => r.key === key && r.requestId === requestId);
        if (duplicate) {
          if (duplicate.digest !== digest) error('requestId 已被其他内容使用', 409);
          if (duplicate.status !== 'published') error('上次发布结果未确认，为避免重复发帖，请管理员先到空间核实', 409);
          sendJson({ ok: true, published: true, duplicate: true, tid: duplicate.tid,
            imageCount: duplicate.imageCount ?? 0, imagesVerified: duplicate.imagesVerified ?? false }); return true;
        }
        const sameContent = rows.find(r => r.digest === digest && now - r.at < 86400000);
        if (sameContent) error('24 小时内已有相同发布内容或待核实记录', 409);
        const day = rows.filter(r => now - r.at < 86400000);
        const dailyLimit = Math.max(1, Math.min(20, Number(options.maxPerDay) || 3));
        const interval = Math.max(60, Number(options.minIntervalSeconds) || 1800) * 1000;
        if (day.length >= dailyLimit || day.some(r => now - r.at < interval)) error('空间发布达到每日上限或仍在冷却中', 429);
        const images = [];
        let totalBytes = 0;
        const addImage = buffer => {
          if (!buffer?.length || buffer.length > 8 * 1024 * 1024) error('图片为空或超过 8MB');
          if (!validateImage?.(buffer, '空间配图')) error('空间配图不是有效的 PNG/JPEG/GIF/WebP 图片');
          totalBytes += buffer.length;
          if (totalBytes > 24 * 1024 * 1024) error('空间配图总大小超过 24MB');
          images.push(`base64://${buffer.toString('base64')}`);
        };
        for (const url of urls) {
          const image = await fetchImage(url, 8 * 1024 * 1024);
          addImage(image.buffer);
        }
        for (const source of sources) {
          if (!readMessageImages) error('聊天配图读取未就绪', 503);
          addImage(await readMessageImages(key, source.messageId, source.index));
        }
        if (body.includeSelfImage === true) {
          if (!readSelfImage) error('角色形象未就绪', 503);
          addImage(await readSelfImage());
        }
        checkScope(body, req);
        if (getConfig().integrations?.qzone?.enabled !== true || !getConfig().integrations.qzone.allowedKeys?.includes(key)) error('QQ 空间发布权限已撤销', 403);
        const record = { key, requestId, digest, at: now, status: 'pending' };
        rows.push(record);
        saveLedger(rows); // reserve BEFORE external side effect; a timeout is not success
        const result = await onebot('send_qzone_msg', { content, ugc_right: visibility, ...(images.length ? { images } : {}) });
        const tid = result?.tid ?? result?.t1_tid ?? result?.data?.tid;
        if (!tid) error('空间接口未返回说说 ID，发布结果未确认，请到空间核实；不要自动重试', 502);
        record.status = 'published'; record.tid = String(tid);
        record.imageCount = images.length;
        saveLedger(rows);
        let imagesVerified = images.length === 0;
        if (images.length) {
          try {
            const list = await onebot('get_qzone_msg_list', { pos: 0, num: 20 });
            const post = list?.msglist?.find(p => String(p.tid) === record.tid);
            imagesVerified = Array.isArray(post?.images) && post.images.length === images.length;
          } catch { /* the publication already happened; never repost on verification failure */ }
        }
        record.imagesVerified = imagesVerified; saveLedger(rows);
        sendJson({ ok: true, published: true, tid: record.tid, visibility, imageCount: images.length, imagesVerified,
          ...(imagesVerified ? {} : { warning: '说说已发布，但配图尚未读回确认；不要重复发布，请到空间核实。' }) });
      } finally { publishing = false; }
      return true;
    }
    sendJson({ ok: false, error: '未知扩展功能' }, 404); return true;
  }
  handle.pollQzone = qzone.poll;
  return handle;
}
