import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { SENSITIVE_RE } from './sensitive.js';

export function friendApproverQQ(config) {
  const value = String(config?.ownerQQ ?? '');
  return /^[1-9]\d{4,11}$/.test(value) ? value : '';
}
const DAY = 86400000;
const fail = (message, statusCode = 403) => { throw Object.assign(new Error(message), { statusCode }); };
export function requestFriendUi(id) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection('/run/qq-friend-ui/control.sock');
    let text = '';
    socket.setTimeout(90000, () => socket.destroy(new Error('客户端操作超时，结果未知，禁止自动重试')));
    socket.on('connect', () => socket.write(JSON.stringify({ id }) + '\n'));
    socket.on('data', chunk => {
      text += chunk;
      if (text.length > 16000) return socket.destroy(new Error('客户端响应过大'));
      if (text.includes('\n')) {
        try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); }
        socket.end();
      }
    });
    socket.on('error', reject);
    socket.on('end', () => { if (!text.includes('\n')) reject(new Error('客户端连接中断，结果未知')); });
  });
}

export function createFriendApproval({ stateDir, getConfig, getConversation, sessionAllowed, onebot,
  notify, dispatchUi = requestFriendUi, now = Date.now, log = () => {} }) {
  const FRIEND_APPROVER = friendApproverQQ(getConfig());
  const ADMIN = FRIEND_APPROVER ? `private:${FRIEND_APPROVER}` : '';
  const approverUnchanged = () => !!FRIEND_APPROVER && friendApproverQQ(getConfig()) === FRIEND_APPROVER;
  const file = path.join(stateDir, 'friend-requests.json');
  let rows = [];
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.requests)) throw new Error('好友审批记录无效');
    rows = saved.requests;
  }
  let busy = false;
  const save = () => {
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, requests: rows }, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  for (const row of rows) if (row.status === 'dispatching') {
    row.status = 'uncertain'; row.detail = '上次客户端操作被中断，禁止自动重试'; save();
  }
  const enabled = key => {
    const q = getConfig().integrations?.qzone;
    return q?.enabled === true && q.friendsEnabled === true && q.allowedKeys?.includes(key) && sessionAllowed(key);
  };
  const check = key => { if (!approverUnchanged() || !enabled(key) || !sessionAllowed(ADMIN)) fail('好友审批功能或管理员私聊未获授权'); };
  const view = row => ({ id: row.id, targetUserId: row.targetUserId, status: row.status,
    approverQQ: FRIEND_APPROVER, requestSubmitted: row.status === 'request_submitted' || row.status === 'friends',
    isFriend: row.status === 'friends', notifiedAdmin: row.notifiedAdmin === true, detail: row.detail,
    hint: '仅管理员私聊明确批准后才能操作；申请提交不代表已成为好友。验证/结果未知时暂停；可向对方说明审批限制。' });
  async function friends() {
    const result = await onebot('get_friend_list', {});
    if (!Array.isArray(result)) fail('好友列表响应无效，无法判断好友关系', 502);
    return result;
  }
  async function message(target, text, id, authorize = () => {}) {
    authorize();
    if (!sessionAllowed(target)) fail('通知会话授权已撤销');
    const receipt = await notify(target, [text], `friend_${id}`, () => {
      authorize(); if (!sessionAllowed(target)) fail('通知会话授权已撤销');
    });
    return receipt?.sent === true && receipt.receipts?.length > 0;
  }
  async function resultNotice(row) {
    const text = `好友申请 ${row.id}（QQ ${row.targetUserId}）：${row.detail}`;
    await message(ADMIN, text, `${row.id}_${row.status}_admin`);
    if (sessionAllowed(row.key) && row.key !== ADMIN) await message(row.key, text, `${row.id}_${row.status}_source`);
  }
  async function propose(key, body, authorize = () => {}) {
    check(key); authorize();
    const st = getConversation(key);
    const msg = [...(st?.recentMessages ?? []), ...(st?.unread ?? [])]
      .find(m => String(m.messageId) === String(body.messageId) && !m.isSelf && !m.isOwner && String(m.userId) === String(body.targetUserId));
    if (!msg || !/^[1-9]\d{4,11}$/.test(String(msg.userId)) || now() - Number(msg.time) > DAY
      || !msg.botAccountId || !msg.time) fail('申请对象必须是当前会话24小时内真实发言人，不能代第三人申请');
    const invitation = String(msg.plain ?? msg.text ?? '');
    if (!/空间|说说|加.{0,6}(好友|我)|添加|好友/.test(invitation)
      || /(别|不要|不许|拒绝).{0,8}(加|好友)/.test(invitation)) fail('需要对方本人邀请看空间或添加好友的真实消息');
    const reason = String(body.reason ?? '').trim();
    if (reason.length < 6 || reason.length > 180 || SENSITIVE_RE.test(reason)) fail('请提供6～180字的具体原因，不含敏感信息');
    if ((await friends()).some(f => String(f.user_id) === String(msg.userId))) return { status: 'friends', isFriend: true, hint: '已是好友，直接重新读取空间；不要申请。' };
    authorize(); check(key);
    const old = rows.find(r => r.accountId === String(msg.botAccountId) && r.targetUserId === String(msg.userId) && now() - r.at < 7 * DAY);
    if (old) {
      if (old.key !== key && key !== ADMIN) return { status: 'already_under_review', hint: '该对象已有审批或申请记录；不会重复申请，不返回其他会话资料。' };
      return { ...view(old), duplicate: true };
    }
    if (rows.filter(r => now() - r.at < DAY).length >= 5) fail('今日好友审批申请已达5次，请等待管理员处理');
    const row = { id: crypto.randomBytes(8).toString('hex'), accountId: String(msg.botAccountId), key,
      targetUserId: String(msg.userId), messageId: String(msg.messageId), reason, at: now(), status: 'pending_approval' };
    rows.push(row); save();
    const text = `我想添加 QQ ${row.targetUserId} 为好友，申请编号 ${row.id}。\n来源：${key}。原因：${reason}\n目前尚未操作 QQ 添加。若同意，请在本私聊单独回复：同意加好友 ${row.id}\n拒绝请回复：拒绝加好友 ${row.id}\n批准后通过客户端发送；遇验证会暂停，申请提交不代表已成为好友。24小时内有效。`;
    row.notifiedAdmin = await message(ADMIN, text, `${row.id}_approval`, () => { authorize(); check(key); });
    save();
    return view(row);
  }
  async function incoming(key, msg, authorize = () => {}) {
    if (key !== ADMIN || String(msg.userId) !== FRIEND_APPROVER) return { handled: false };
    const match = /^(同意|拒绝)加好友\s+([a-f0-9]{16})[。！!]?\s*$/.exec(String(msg.text ?? '').trim());
    if (!match) return { handled: false };
    const row = rows.find(r => r.id === match[2]);
    if (!row) return { handled: true, status: 'not_found' };
    authorize(); check(row.key);
    if (String(msg.botAccountId) !== row.accountId || !/^-?\d+$/.test(String(msg.messageId))) fail('审批消息身份无效');
    if (row.status !== 'pending_approval') return { handled: true, ...view(row), duplicate: true };
    row.status = now() - row.at > DAY ? 'expired' : match[1] === '同意' ? 'approved' : 'rejected';
    row.approvedBy = match[1] === '同意' ? FRIEND_APPROVER : null;
    row.approvalMessageId = String(msg.messageId); row.approvalKey = ADMIN; row.approvalAt = now();
    row.detail = row.status === 'approved' ? '管理员已批准，等待客户端执行。' : row.status === 'expired' ? '审批已过期，未添加。' : '管理员已拒绝，未添加。';
    save();
    await message(ADMIN, `好友申请 ${row.id}：${row.detail}`, `${row.id}_decision`);
    return { handled: true, ...view(row) };
  }
  async function run() {
    if (busy) return;
    busy = true;
    try {
      const authorized = row => approverUnchanged() && enabled(row.key) && sessionAllowed(ADMIN);
      const cancel = row => {
        row.status = 'cancelled_authorization';
        row.detail = '来源会话或好友审批授权已撤销，批准已作废，未操作添加。';
      };
      // A revoked request must not remain at the head of the executable queue.
      for (const row of rows) if (row.status === 'approved' && !authorized(row)) {
        cancel(row); save();
      }
      const row = rows.find(r => r.status === 'approved');
      if (row) {
        check(row.key);
        if (now() - row.approvalAt > DAY) { row.status = 'expired'; row.detail = '批准已过期，未添加。'; }
        else {
          const list = await friends();
          if (!authorized(row)) cancel(row);
          else if (list.some(f => String(f.user_id) === row.targetUserId)) { row.status = 'friends'; row.detail = '真实好友列表已确认是好友。'; }
          else {
            check(row.key); row.status = 'dispatching'; save();
            try {
              const out = await dispatchUi(row.id);
              const statuses = ['request_submitted', 'friends', 'paused_verification', 'paused_ui', 'uncertain'];
              row.status = statuses.includes(out.status) ? out.status : 'uncertain';
              row.detail = String(out.detail ?? '客户端未返回确定结果，已暂停。').slice(0, 250);
            } catch { row.status = 'uncertain'; row.detail = '客户端操作未确认，已暂停，禁止自动重试；请在 noVNC 核实。'; }
          }
        }
        save(); if (authorized(row)) await resultNotice(row);
      }
      const pending = rows.filter(r => r.status === 'request_submitted' && authorized(r) && now() - (r.checkedAt || 0) > 60000);
      if (pending.length) {
        const list = await friends();
        for (const row of pending) {
          if (!authorized(row)) continue;
          row.checkedAt = now();
          if (list.some(f => String(f.user_id) === row.targetUserId)) {
            row.status = 'friends'; row.detail = '已从真实好友列表确认添加成功，可以重新读取空间。'; save(); await resultNotice(row);
          }
        }
        save();
      }
    } finally { busy = false; }
  }
  return {
    propose, incoming,
    status(key, { id }) { const row = rows.find(r => r.id === id && (r.key === key || key === ADMIN)); if (!row) fail('没有当前会话可查询的审批'); check(row.key); return view(row); },
    poll() { if (!busy) run().catch(error => log('好友审批后台暂停', error.message)); },
  };
}
