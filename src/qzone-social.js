import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SENSITIVE_RE } from './sensitive.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = value => String(value ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 2000);

// Uses the already installed SnowLuma for reads/uploads; cookies never leave this module.
export function createQzoneSocial({ stateDir, getConfig, onebot, sessionAllowed, notify, fetcher = fetch }) {
  const file = path.join(stateDir, 'qzone-interactions.json');
  let state = { version: 1, posts: [], actions: [] };
  let writable = true;
  let polling = false;
  let acting = false;
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.posts) || !Array.isArray(saved.actions)) throw new Error('invalid qzone state');
      state = saved;
    }
  } catch { writable = false; }
  const options = () => getConfig().integrations?.qzone ?? {};
  const allowed = key => options().enabled === true && options().allowedKeys?.includes(key) && sessionAllowed(key);
  function save() {
    if (!writable) fail('空间互动记录无法读取，暂停写入以保护原数据', 503);
    state.actions = state.actions.slice(-1000);
    state.posts = state.posts.slice(-100);
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  async function identity() {
    const login = await onebot('get_login_info', {});
    const id = String(login?.user_id ?? '');
    if (!/^[1-9]\d+$/.test(id)) fail('QQ 登录身份不可用', 503);
    return id;
  }
  async function posts(bot) {
    const result = await onebot('get_qzone_msg_list', { num: 20, pos: 0 });
    if (!Array.isArray(result?.msglist)) fail('空间列表响应无效，未将其当作空列表', 502);
    let ledger = [];
    const ledgerFile = path.join(stateDir, 'qzone-posts.json');
    if (fs.existsSync(ledgerFile)) ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const leader = options().commentKey || (options().allowedKeys ?? []).find(k => k === `private:${getConfig().ownerQQ}`)
      || (options().allowedKeys ?? []).find(allowed);
    for (const post of result.msglist) {
      const tid = String(post.tid ?? '');
      if (!tid || state.posts.some(p => p.accountId === bot && p.tid === tid)) continue;
      const publisher = ledger.find(r => r.tid === tid && r.status === 'published');
      state.posts.push({ accountId: bot, tid, key: publisher?.key || leader, initialized: false, seen: [], pending: [] });
    }
    save();
    return result.msglist.map(p => ({ tid: String(p.tid), content: clean(p.content), time: p.time,
      commentCount: p.comment_num, images: (p.images ?? []).slice(0, 9) }));
  }
  function flatten(detail) {
    if (!Array.isArray(detail?.comments)) fail('空间评论响应无效，不能认定为没有评论', 502);
    const all = [];
    for (const c of detail.comments) {
      if (!c || !c.comment_id || !c.uin) continue;
      all.push({ commentId: String(c.comment_id), userId: String(c.uin), name: clean(c.name).slice(0, 64),
        content: clean(c.content), time: Number(c.time) || 0, parentId: null });
      for (const r of (c.replies ?? [])) if (r?.comment_id && r.uin) all.push({
        commentId: String(r.comment_id), userId: String(r.uin), name: clean(r.name).slice(0, 64),
        content: clean(r.content), time: Number(r.time) || 0, parentId: String(c.comment_id) });
    }
    return all;
  }
  async function comments(bot, tid, pos = 0) {
    const detail = await onebot('get_qzone_msg_detail', { tid, pos, num: 100 });
    if (String(detail?.tid) !== tid) fail('空间详情的说说 ID 不匹配', 502);
    return { tid, content: clean(detail.content), commentCount: detail.comment_num, comments: flatten(detail),
      pos, limit: '二级回复仅含服务端内联部分；评论数大于返回数量时可继续翻页，不能断言已读完。' };
  }
  // True nested replies use QZone's web endpoint because SnowLuma comment_qzone only adds root comments.
  async function reply(bot, tid, target, content, authorize) {
    const result = await onebot('get_cookies', { domain: 'qzone.qq.com' });
    authorize();
    const cookie = String(result?.cookies ?? '');
    const pairs = Object.fromEntries(cookie.split(';').map(p => p.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p.length === 2));
    const skey = pairs.p_skey || pairs.skey;
    if (!skey) fail('QQ 空间登录态不可用，请重新登录 QQ', 503);
    let gtk = 5381;
    for (const ch of skey) gtk += (gtk << 5) + ch.charCodeAt(0);
    const body = new URLSearchParams({ hostUin: bot, uin: bot, topicId: `${bot}_${tid}`, content: `@{uin:${target.userId},nick:${target.userId},auto:1} ${content}`,
      paramstr: '2', commentId: target.parentId || target.commentId, commentUin: target.userId,
      replyUin: target.userId, t2_uin: target.userId, t2_tid: target.parentId || target.commentId,
      t1_uin: bot, t1_tid: tid, t1_source: '1', t1_commentid: target.parentId || target.commentId,
      t1_uin_to: target.userId, inCharset: 'utf-8', outCharset: 'utf-8', format: 'json',
      qzreferrer: `https://user.qzone.qq.com/${bot}`, ref: 'feeds', feedsType: '100', private: '0',
      plat: 'qzone', source: 'ic', platformid: '52' });
    const response = await fetcher(`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${gtk & 0x7fffffff}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Referer: `https://user.qzone.qq.com/${bot}` }, body: body.toString()
    });
    if (!response.ok) fail('空间回复接口请求失败；请核实结果后再操作', 502);
    const raw = await response.text();
    let value;
    try { value = JSON.parse(raw); } catch { fail('空间回复结果未确认；请到空间核实，勿换编号重试', 502); }
    if ((value.code !== 0 && value.ret !== 0) || (value.subcode != null && value.subcode !== 0)) fail('空间回复未成功确认；请到空间核实', 502);
    return value;
  }
  async function handle(action, key, body, authorize = () => {}) {
    if (!['qzone-list', 'qzone-comments', 'qzone-react'].includes(action)) return null;
    if (!allowed(key)) fail('该会话未获得空间互动权限', 403);
    if (options().commentsEnabled !== true) fail('空间评论互动未启用', 403);
    const bot = await identity();
    if (action === 'qzone-list') return { posts: await posts(bot) };
    const tid = String(body.tid ?? '');
    let post = state.posts.find(p => p.accountId === bot && p.tid === tid);
    if (!post) { await posts(bot); post = state.posts.find(p => p.accountId === bot && p.tid === tid); }
    if (!post) fail('只能操作机器人自己空间已读取的说说', 403);
    if (action === 'qzone-comments') return comments(bot, tid, Math.max(0, Math.min(10000, Math.trunc(Number(body.pos) || 0))));
    const content = String(body.content ?? '').trim();
    if (!content || content.length > 1000 || SENSITIVE_RE.test(content)) fail('评论内容为空、超长或包含敏感信息', 403);
    const requestId = String(body.requestId ?? '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) fail('评论需要稳定的 requestId，重试复用');
    const digest = hash([tid, body.commentId ?? '', body.commentUserId ?? '', body.parentCommentId ?? '', content]);
    const old = state.actions.find(a => a.accountId === bot && a.key === key && a.requestId === requestId);
    if (old) {
      if (old.digest !== digest) fail('requestId 已被其他评论内容使用', 409);
      if (old.status !== 'confirmed') fail('上次评论结果未确认，请先到空间核实', 409);
      return { confirmed: true, duplicate: true, commentId: old.commentId };
    }
    if (acting) fail('正在提交另一条空间评论', 429);
    if (state.actions.some(a => a.accountId === bot && (a.digest === digest || Date.now() - a.at < 30000))) fail('相同评论已提交或评论仍在冷却', 429);
    if (state.actions.filter(a => a.accountId === bot && Date.now() - a.at < 86400000).length >= 30) fail('空间评论达到每日上限', 429);
    acting = true;
    try {
      let target;
      if (body.commentId) {
        const detail = await comments(bot, tid, Math.max(0, Math.trunc(Number(body.pos) || 0)));
        const matches = detail.comments.filter(c => c.commentId === String(body.commentId)
          && (!body.commentUserId || c.userId === String(body.commentUserId))
          && (body.parentCommentId === undefined || c.parentId === String(body.parentCommentId)));
        if (matches.length !== 1) fail('评论不存在或编号不唯一，请携带真实 commentUserId/parentCommentId', 403);
        target = matches[0];
        if (target.userId === bot) fail('只能回复已读取且不是机器人自己的真实评论', 403);
      }
      authorize();
      if (!allowed(key) || options().commentsEnabled !== true) fail('空间互动权限已撤销', 403);
      const record = { accountId: bot, key, requestId, digest, at: Date.now(), status: 'pending' };
      state.actions.push(record); save();
      const recheck = () => { authorize(); if (!allowed(key) || options().commentsEnabled !== true) fail('空间互动权限已撤销', 403); };
      const result = target ? await reply(bot, tid, target, content, recheck) : await onebot('comment_qzone', { tid, content });
      if (!target && !result?.comment_id) fail('空间未返回评论 ID，结果未确认，请到空间核实', 502);
      record.status = 'confirmed'; record.commentId = String(result?.comment_id ?? result?.commentid ?? result?.commentId ?? ''); save();
      return { confirmed: true, commentId: record.commentId || null, replyTo: target?.commentId ?? null };
    } finally { acting = false; }
  }
  async function poll() {
    if (polling || !writable || options().enabled !== true || options().commentsEnabled !== true || options().autoReact !== true) return;
    polling = true;
    try {
      const bot = await identity();
      const latest = await posts(bot);
      const selected = state.posts.filter(p => p.accountId === bot && allowed(p.key)
        && (p.pending.length || latest.slice(0, 10).some(x => x.tid === p.tid))).slice(-20);
      for (const post of selected) {
        const detail = await comments(bot, post.tid);
        for (const c of detail.comments) {
          const id = hash([bot, post.tid, c.parentId, c.commentId, c.userId, c.time, c.content]);
          if (post.seen.includes(id)) continue;
          post.seen.push(id);
          if (post.initialized && c.userId !== bot) post.pending.push({ ...c, id, tid: post.tid });
        }
        post.initialized = true; post.seen = post.seen.slice(-2000); post.pending = post.pending.slice(-50); save();
        for (const event of [...post.pending]) {
          if (!allowed(post.key)) break;
          await notify(post.key, event);
          post.pending = post.pending.filter(e => e.id !== event.id); save();
        }
      }
    } finally { polling = false; }
  }
  return { handle, poll };
}
