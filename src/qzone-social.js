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
  let lastFriendPoll = 0;
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.posts) || !Array.isArray(saved.actions)) throw new Error('invalid qzone state');
      state = saved;
    }
  } catch { writable = false; }
  const options = () => getConfig().integrations?.qzone ?? {};
  const allowed = key => options().enabled === true && options().allowedKeys?.includes(key) && sessionAllowed(key);
  const leaderKey = () => options().commentKey || (options().allowedKeys ?? []).find(k => k === `private:${getConfig().ownerQQ}`)
    || (options().allowedKeys ?? []).find(allowed);
  const ownerOf = post => String(post.ownerUserId || post.accountId);
  const position = value => Math.max(0, Math.min(10000, Math.trunc(Number(value) || 0)));
  function save() {
    if (!writable) fail('空间互动记录无法读取，暂停写入以保护原数据', 503);
    state.actions = state.actions.slice(-1000);
    // Keep our monitored posts even when browsing friends' posts.
    const own = state.posts.filter(p => ownerOf(p) === p.accountId).slice(-100);
    const other = state.posts.filter(p => ownerOf(p) !== p.accountId).slice(-200);
    state.posts = [...own, ...other];
    fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  async function identity() {
    const login = await onebot('get_login_info', {});
    const id = String(login?.user_id ?? '');
    if (!/^[1-9]\d+$/.test(id)) fail('QQ 登录身份不可用', 503);
    return id;
  }
  async function posts(bot, owner = bot, key, pos = 0, num = 20) {
    const result = await onebot('get_qzone_msg_list', { num, pos, ...(owner !== bot ? { target_uin: Number(owner) } : {}) });
    if (!Array.isArray(result?.msglist)) fail('空间列表响应无效，未将其当作空列表', 502);
    let ledger = [];
    const ledgerFile = path.join(stateDir, 'qzone-posts.json');
    if (fs.existsSync(ledgerFile)) ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    const leader = leaderKey();
    for (const post of result.msglist) {
      const tid = String(post.tid ?? '');
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(tid)) continue;
      const existing = state.posts.find(p => p.accountId === bot && ownerOf(p) === owner && p.tid === tid);
      if (existing) {
        if (key) existing.readKeys = [...new Set([...(existing.readKeys || []), key])];
        continue;
      }
      const publisher = ledger.find(r => r.tid === tid && r.status === 'published');
      state.posts.push({ accountId: bot, ownerUserId: owner, tid, time: Number(post.time) || 0, readKeys: key ? [key] : [],
        key: owner === bot ? publisher?.key || leader : key || leader, initialized: false, seen: [], pending: [] });
    }
    save();
    return result.msglist.map(p => ({ targetUserId: owner, tid: String(p.tid), content: clean(p.content), time: p.time,
      commentCount: p.comment_num, images: (p.images ?? []).slice(0, 9) }));
  }
  async function friendFeed(bot, key) {
    const result = await onebot('get_qzone_feeds', { page_num: 1, count: 20 });
    if (!Array.isArray(result?.feeds)) fail('好友动态响应无效，未当作没有动态', 502);
    let authors = [...new Set(result.feeds.filter(f => Number(f.appid) === 311)
      .map(f => String(f.uin)).filter(id => /^[1-9]\d+$/.test(id) && id !== bot))].slice(0, 5);
    let source = 'friend-feed';
    // Some accounts receive only their own posts from feeds3. Fall back to
    // actual friends, not invented feed handles, and disclose the narrower view.
    if (!authors.length) {
      const friends = await onebot('get_friend_list', {});
      if (!Array.isArray(friends)) fail('好友列表响应无效', 502);
      authors = [...new Set(friends.map(f => String(f.user_id)).filter(id => /^[1-9]\d+$/.test(id) && id !== bot))].slice(0, 5);
      source = 'friend-list-fallback';
    }
    const all = []; const unavailable = [];
    for (const owner of authors) {
      try { all.push(...await posts(bot, owner, key, 0, 5)); }
      catch { unavailable.push(owner); }
    }
    return { posts: all, unavailable, source, hasMore: !!result.has_more,
      limit: '最多读取5位动态作者的各5条真实说说；动态未提供好友时改读真实好友列表前5位，未覆盖全部好友或全量时间线。' };
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
        content: clean(r.content), time: Number(r.time) || 0, parentId: String(c.comment_id), parentUserId: String(c.uin) });
    }
    return all;
  }
  async function comments(bot, tid, pos = 0, owner = bot) {
    const detail = await onebot('get_qzone_msg_detail', { tid, pos, num: 100, ...(owner !== bot ? { target_uin: Number(owner) } : {}) });
    if (String(detail?.tid) !== tid) fail('空间详情的说说 ID 不匹配', 502);
    return { tid, targetUserId: owner, content: clean(detail.content), commentCount: detail.comment_num,
      comments: flatten(detail).map(c => ({ ...c, canLike: !c.parentId && /^[1-9]\d*$/.test(c.commentId) && c.userId !== bot })),
      pos, limit: '二级回复仅含服务端内联部分；评论数大于返回数量时可继续翻页，不能断言已读完。' };
  }
  // True nested replies use QZone's web endpoint because SnowLuma comment_qzone only adds root comments.
  async function webWrite(bot, owner, endpoint, params, authorize) {
    const result = await onebot('get_cookies', { domain: 'qzone.qq.com' });
    authorize();
    const cookie = String(result?.cookies ?? '');
    const pairs = Object.fromEntries(cookie.split(';').map(p => p.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p.length === 2));
    const skey = pairs.p_skey || pairs.skey;
    if (!skey) fail('QQ 空间登录态不可用，请重新登录 QQ', 503);
    let gtk = 5381;
    for (const ch of skey) gtk += (gtk << 5) + ch.charCodeAt(0);
    const response = await fetcher(`https://user.qzone.qq.com/proxy/domain/${endpoint}?g_tk=${gtk & 0x7fffffff}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Referer: `https://user.qzone.qq.com/${owner}` },
      body: new URLSearchParams(params).toString()
    });
    if (!response.ok) fail('空间互动接口请求失败；请核实结果后再操作', 502);
    let value;
    try { value = JSON.parse(await response.text()); } catch { fail('空间互动结果未确认；请到空间核实，勿换编号重试', 502); }
    const codes = ['code', 'ret', 'subcode'].filter(k => value[k] != null);
    if (codes.some(k => Number(value[k]) !== 0)) {
      throw Object.assign(new Error('空间接口拒绝互动（' + codes.map(k => `${k}=${Number(value[k])}`).join(',') + '），请刷新评论后再处理'), { statusCode: 502, qzoneRejected: true });
    }
    if (!codes.some(k => k !== 'subcode')) fail('空间互动未成功确认；请到空间核实', 502);
    return value;
  }
  async function reply(bot, owner, tid, target, content, authorize) {
    return webWrite(bot, owner, 'taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds', {
      hostUin: owner, uin: bot, topicId: `${owner}_${tid}`, content: `@{uin:${target.userId},nick:${target.userId},auto:1} ${content}`,
      // Two levels only: the thread anchor belongs to the root author;
      // the mentioned/replied user may be a different person in that thread.
      paramstr: '2', commentId: target.parentId || target.commentId, commentUin: target.parentUserId || target.userId,
      replyUin: target.userId, t2_uin: target.userId, t2_tid: target.parentId || target.commentId,
      t1_uin: owner, t1_tid: tid, t1_source: '1', t1_commentid: target.parentId || target.commentId,
      t1_uin_to: target.userId, inCharset: 'utf-8', outCharset: 'utf-8', format: 'json',
      qzreferrer: `https://user.qzone.qq.com/${owner}`, ref: 'feeds', feedsType: '100', private: '0',
      plat: 'qzone', source: 'ic', platformid: '52'
    }, authorize);
  }
  async function likeComment(bot, owner, tid, target, authorize) {
    // qzone-api 1.1.0's published API: comment keys differ from post mood URLs.
    // Nested replies do not expose a proven unique like key; never like their parent by mistake.
    if (target.parentId || !/^[1-9]\d*$/.test(target.commentId)) fail('此回复没有可验证的独立评论点赞编号，不能拿父评论代替', 400);
    const curkey = `${owner}_${tid}_${target.commentId}`;
    return webWrite(bot, owner, 'w.qzone.qq.com/cgi-bin/likes/internal_dolike_app', {
      qzreferrer: `https://user.qzone.qq.com/${bot}`, opuin: bot, unikey: curkey, curkey,
      appid: '311', from: '-100', typeid: '0', abstime: String(target.time || Math.floor(Date.now() / 1000)),
      fid: tid, active: '0', fupdate: '1', face: '0', format: 'json'
    }, authorize);
  }
  async function handle(action, key, body, authorize = () => {}) {
    if (!['qzone-list', 'qzone-feed', 'qzone-comments', 'qzone-react', 'qzone-like', 'qzone-like-comment'].includes(action)) return null;
    if (!allowed(key)) fail('该会话未获得空间互动权限', 403);
    if (options().commentsEnabled !== true) fail('空间评论互动未启用', 403);
    const bot = await identity();
    const owner = String(body.targetUserId ?? bot);
    if (!/^[1-9]\d{4,11}$/.test(owner)) fail('targetUserId 必须是真实 QQ 号');
    const friendsEnabled = () => options().friendsEnabled === true;
    if ((owner !== bot || action === 'qzone-feed') && !friendsEnabled()) fail('好友空间互动未启用', 403);
    if (action === 'qzone-feed') return friendFeed(bot, key);
    if (action === 'qzone-list') {
      if (owner !== bot && !state.posts.some(p => p.accountId === bot && ownerOf(p) === owner && p.readKeys?.includes(key))) {
        const friends = await onebot('get_friend_list', {});
        if (!Array.isArray(friends)) fail('好友列表响应无效，无法判断是否为好友；不能推断对方空间权限，请稍后再查', 502);
        if (!friends.some(f => String(f.user_id) === owner)) fail(`QZONE_NOT_FRIEND: ${owner} 不在真实 QQ 好友列表，也不是本会话已读取的动态作者。桥接规则在访问空间前拦截，未验证对方空间权限；不要说对方设了权限或网页打不开。若是当前发言人邀请看空间，可调用 qq_request_friend_approval，先私聊管理员申请批准；未批准不得添加。可以向对方说明审批限制。`, 403);
      }
      return { posts: await posts(bot, owner, key, position(body.pos)) };
    }
    const tid = String(body.tid ?? '');
    let post = state.posts.find(p => p.accountId === bot && ownerOf(p) === owner && p.tid === tid);
    if (!post && owner === bot) { await posts(bot); post = state.posts.find(p => p.accountId === bot && ownerOf(p) === bot && p.tid === tid); }
    if (!post || (owner !== bot && !post.readKeys?.includes(key))) fail('只能操作机器人自己空间或本会话已读取的好友空间说说，请先读取真实列表', 403);
    if (action === 'qzone-comments') return comments(bot, tid, position(body.pos), owner);
    const isLike = action === 'qzone-like' || action === 'qzone-like-comment';
    const commentLike = action === 'qzone-like-comment';
    if (isLike && options().likesEnabled !== true) fail('空间点赞未启用', 403);
    const reason = String(body.reason ?? '').trim();
    if (isLike && (reason.length < 6 || reason.length > 200 || SENSITIVE_RE.test(reason))) fail('请先读懂内容，提供6～200字的具体点赞理由，不能批量或逢条点赞', 400);
    if (commentLike && (!body.commentId || !body.commentUserId)) fail('评论点赞必须指定真实 commentId 和 commentUserId', 400);
    if (commentLike && body.parentCommentId) fail('此二级回复没有可验证的独立评论点赞编号，不能拿父评论代替', 400);
    if (action === 'qzone-like' && owner === bot) fail('不自动给自己的说说点赞', 403);
    const content = String(body.content ?? '').trim();
    if (!isLike && (!content || content.length > 1000 || SENSITIVE_RE.test(content))) fail('评论内容为空、超长或包含敏感信息', 403);
    const requestId = String(body.requestId ?? '');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) fail('评论需要稳定的 requestId，重试复用');
    const digest = owner === bot && !isLike
      ? hash([tid, body.commentId ?? '', body.commentUserId ?? '', body.parentCommentId ?? '', content])
      : hash([action, owner, tid, body.commentId ?? '', body.commentUserId ?? '', body.parentCommentId ?? '', isLike ? '' : content]);
    const old = state.actions.find(a => a.accountId === bot && a.key === key && a.requestId === requestId);
    if (old) {
      if (old.digest !== digest) fail('requestId 已被其他评论内容使用', 409);
      if (old.status === 'confirmed') return { confirmed: true, duplicate: true, ...(isLike ? { liked: true } : {}), commentId: old.commentId };
      if (old.status !== 'rejected') fail('上次评论结果未确认，请先到空间核实', 409);
    }
    const same = state.actions.find(a => a.accountId === bot && a.digest === digest);
    if (isLike && same) {
      if (same.status !== 'confirmed') fail('上次点赞结果未确认，请先核实，不要换编号重试', 409);
      return { confirmed: true, liked: true, duplicate: true };
    }
    if (acting) fail('正在提交另一条空间互动', 429);
    const interval = isLike ? Math.max(0, Number(options().likeIntervalSeconds ?? 60)) * 1000 : 30000;
    if (state.actions.some(a => a.accountId === bot && a.status !== 'rejected' && (a.digest === digest || Date.now() - a.at < interval))) fail('相同互动已提交或空间互动仍在冷却', 429);
    const today = state.actions.filter(a => a.accountId === bot && Date.now() - a.at < 86400000);
    const likes = a => String(a.action ?? '').startsWith('qzone-like');
    if (today.filter(a => isLike ? likes(a) : !likes(a)).length >= (isLike ? Math.max(1, Math.min(60, Number(options().maxLikesPerDay) || 20)) : 30)) fail('空间互动达到每日上限', 429);
    if (commentLike && today.filter(a => a.action === action && a.ownerUserId === owner && a.tid === tid).length
      >= Math.max(1, Math.min(5, Number(options().maxCommentLikesPerPost) || 3))) fail('这条说说的评论已点赞足够多，请有所选择，不要每条都点', 429);
    acting = true;
    try {
      let target;
      if (body.commentId) {
        const detail = await comments(bot, tid, position(body.pos), owner);
        const matches = detail.comments.filter(c => c.commentId === String(body.commentId)
          && (!body.commentUserId || c.userId === String(body.commentUserId))
          && (!commentLike || !c.parentId)
          && (body.parentCommentId === undefined || c.parentId === String(body.parentCommentId)));
        if (matches.length !== 1) fail('评论不存在或编号不唯一，请携带真实 commentUserId/parentCommentId', 403);
        target = matches[0];
        if (target.userId === bot) fail('只能回复已读取且不是机器人自己的真实评论', 403);
        if (commentLike && !/^[1-9]\d*$/.test(target.commentId)) fail('此评论没有可验证的独立评论点赞编号', 400);
      }
      if (isLike && !commentLike) await comments(bot, tid, 0, owner);
      authorize();
      if (!allowed(key) || options().commentsEnabled !== true) fail('空间互动权限已撤销', 403);
      const record = old ?? { accountId: bot, ownerUserId: owner, tid, action, key, requestId, digest };
      Object.assign(record, { reason: isLike ? reason : undefined, at: Date.now(), status: 'pending',
        targetCommentId: target?.commentId, targetUserId: target?.userId, parentCommentId: target?.parentId });
      if (!old) state.actions.push(record); save();
      const recheck = () => { authorize(); if (!allowed(key) || options().commentsEnabled !== true
        || (owner !== bot && !friendsEnabled()) || (isLike && options().likesEnabled !== true)) fail('空间互动权限已撤销', 403); };
      recheck();
      let result;
      try {
      if (commentLike) result = await likeComment(bot, owner, tid, target, recheck);
      else if (isLike) { await onebot('like_qzone', { tid, target_uin: Number(owner), abstime: post.time || 0 }); result = {}; }
      else result = target ? await reply(bot, owner, tid, target, content, recheck)
        : await onebot('comment_qzone', { tid, content, ...(owner !== bot ? { target_uin: Number(owner) } : {}) });
      } catch (error) {
        if (error.qzoneRejected === true) { record.status = 'rejected'; save(); }
        throw error;
      }
      if (!isLike && !target && !result?.comment_id) fail('空间未返回评论 ID，结果未确认，请到空间核实', 502);
      record.status = 'confirmed'; record.commentId = String(result?.comment_id ?? result?.commentid ?? result?.commentId ?? ''); save();
      return { confirmed: true, ...(isLike ? { liked: true } : {}), targetUserId: owner,
        commentId: record.commentId || (commentLike ? target.commentId : null), replyTo: target?.commentId ?? null };
    } finally { acting = false; }
  }
  async function poll() {
    if (polling || !writable || options().enabled !== true || options().commentsEnabled !== true || options().autoReact !== true) return;
    polling = true;
    try {
      const bot = await identity();
      const latest = await posts(bot);
      const selected = state.posts.filter(p => p.accountId === bot && ownerOf(p) === bot && allowed(p.key)
        && (p.pending.length || latest.slice(0, 10).some(x => x.tid === p.tid))).slice(-20);
      for (const post of selected) {
        const detail = await comments(bot, post.tid);
        for (const c of detail.comments) {
          const id = hash([bot, post.tid, c.parentId, c.commentId, c.userId, c.time, c.content]);
          if (post.seen.includes(id)) continue;
          post.seen.push(id);
          if (post.initialized && c.userId !== bot) post.pending.push({ ...c, id, tid: post.tid, targetUserId: bot });
        }
        post.initialized = true; post.seen = post.seen.slice(-2000); post.pending = post.pending.slice(-50); save();
        for (const event of [...post.pending]) {
          if (!allowed(post.key)) break;
          await notify(post.key, event);
          post.pending = post.pending.filter(e => e.id !== event.id); save();
        }
      }
      const interval = Math.max(300000, Number(options().friendPollIntervalMs) || 1800000);
      const key = leaderKey();
      if (options().friendsEnabled === true && options().autoBrowseFriends === true && allowed(key)
        && Date.now() - lastFriendPoll >= interval) {
        const feed = await friendFeed(bot, key);
        state.friendFeeds ??= {};
        const inbox = state.friendFeeds[bot] ??= { initialized: false, seen: [], pending: [] };
        for (const post of feed.posts) {
          const id = hash(['friend-post', bot, post.targetUserId, post.tid]);
          if (inbox.seen.includes(id)) continue;
          inbox.seen.push(id);
          if (inbox.initialized) inbox.pending.push({ ...post, id, kind: 'friend-post', name: '好友空间' });
        }
        inbox.initialized = true; inbox.seen = inbox.seen.slice(-2000); inbox.pending = inbox.pending.slice(-30); save();
        for (const event of inbox.pending.slice(0, 3)) {
          if (!allowed(key) || options().friendsEnabled !== true || options().autoBrowseFriends !== true) break;
          await notify(key, event);
          inbox.pending = inbox.pending.filter(e => e.id !== event.id); save();
        }
        lastFriendPoll = Date.now();
      }
    } finally { polling = false; }
  }
  return { handle, poll };
}
