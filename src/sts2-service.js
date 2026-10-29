import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const fail = (message, code = 400) => { throw Object.assign(new Error(message), { statusCode: code }); };
const READS = { health: '/health', state: '/state', request: '/request', map: '/map', next: '/map/next', potions: '/potions' };
export const STS2_CHAT_GUIDANCE = '玩游戏时先用 qq_get_prompt 读取当前会话完整角色卡；后续保持角色的说话方式，角色变化时重新读取。游玩过程中主动用 qq_send_message 向当前管理员私聊分享实际进展：遇到新事件、关键选择、精英或首领、危险局面及本局结束时，结合真实工具结果自然聊一两句，也可以说说打算；文字思考不会自动发送。只说已读到的事实，不编造画面或战况；同一事件不要反复播报，每次出牌无需汇报。发现新消息先处理，管理员要求停止就停止游戏操作。发消息使用当前会话 key 和 token，socialEvents 无合适证据时填 []，遵循发送回执与权限规则。必须使用实际工具调用，绝不在普通文字中输出工具调用格式或令牌；动作结果未知先读状态，不重复动作。本局结束且不再继续时，如果有近期管理员消息可用于 control，就关闭授权；授权关闭或过期后恢复普通模型线路。';
export function createSts2Service({ stateDir, getConfig, readMessage, fetcher = fetch, now = Date.now,
  onControlChange = () => ({}), onObservation = () => false, sessionReady = () => true,
  waitForState = (ms, signal) => delay(ms, undefined, { signal }) }) {
  let busy = false;
  const dir = path.join(stateDir, 'sts2');
  function config(key, authorize) {
    authorize(); const c = getConfig();
    if (key !== 'private:' + String(c.ownerQQ)) fail('仅管理员本人私聊可控制本机游戏', 403);
    if (c.extensions?.sts2?.enabled !== true) fail('游戏插件未启用', 403);
    return c.extensions.sts2.config || {};
  }
  function ledger() { try { return JSON.parse(fs.readFileSync(path.join(dir, 'ledger.json'))); } catch (e) { if (e.code === 'ENOENT') return { calls: {} }; throw e; } }
  function save(data) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const p = path.join(dir, 'ledger.json'); fs.writeFileSync(p + '.tmp', JSON.stringify(data), { mode: 0o600 }); fs.renameSync(p + '.tmp', p); }
  async function request(route, body, c, signal, timeoutMs = 25000) {
    const token = fs.readFileSync(c.tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) fail('游戏连接凭据格式错误', 503);
    let response;
    try { response = await fetcher('http://127.0.0.1:23928' + route, { method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); }
    catch { fail('本机游戏桥接离线或请求结果未知；动作不得换编号重发', 503); }
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > 512 * 1024) fail('游戏响应过大', 502);
    if (!response.ok) {
      let detail = '';
      try { const result = JSON.parse(raw.toString()); if (typeof result.error === 'string') detail = '：' + result.error.slice(0, 300); } catch {}
      fail('本机游戏桥接返回 HTTP ' + response.status + detail, response.status >= 400 && response.status < 500 ? response.status : 502);
    }
    try { return JSON.parse(raw.toString()); } catch { fail('游戏响应不是 JSON', 502); }
  }
  async function actionState(key, c, authorize, signal) {
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(6000)]);
    const active = () => {
      config(key, authorize);
      return (ledger().leaseUntil || 0) > now() && sessionReady(key);
    };
    let state, nextRequest, previous, same = 0;
    const result = status => ({ ...(state ? { state, nextRequest } : {}),
      stateStatus: status, stateReadRequired: status !== 'stable' });
    try {
      for (let i = 0; i < 9; i++) {
        if (!active()) return result('stopped');
        const observed = await request('/state', null, c, bounded, 1500);
        if (!active()) return result('stopped');
        if (!observed || typeof observed.inRun !== 'boolean') return result('unavailable');
        state = observed;
        const choices = await request('/request', null, c, bounded, 1500);
        if (!active()) return result('stopped');
        if (!choices || !Object.hasOwn(choices, 'pending')) return result('unavailable');
        nextRequest = choices.pending;
        const choiceReady = Number.isSafeInteger(nextRequest?.id) && nextRequest.id >= 0
          && Array.isArray(nextRequest.candidates);
        if (nextRequest !== null && !choiceReady) return result('unavailable');
        const ready = !state.note && (choiceReady || state.inRun === false || state.gameOver === true
          || (Array.isArray(state.players) && state.players.length > 0 && (!state.combat
            || (state.combatState === 'PlayPhase' && state.combat.side === 'Player'))));
        const fingerprint = JSON.stringify([state, nextRequest]);
        same = ready ? (fingerprint === previous ? same + 1 : 1) : 0;
        previous = fingerprint;
        // Three equal, actionable observations span at least 600 ms. Enemy
        // phases without a pending choice and changing choices stay pending.
        if (same >= 3) return result('stable');
        if (i < 8) await waitForState(300, bounded);
      }
      return result('pending');
    } catch (error) {
      signal?.throwIfAborted();
      if (!active()) return result('stopped');
      return result(state ? 'pending' : 'unavailable');
    }
  }
  async function handle(key, args, authorize, signal) {
    const c = config(key, authorize);
    if (args.operation === 'read') {
      if (!Object.hasOwn(READS, args.view)) fail('游戏读取类型无效');
      const result = await request(READS[args.view], null, c, signal); config(key, authorize);
      if (await onObservation(key, result)) {
        const ended = ledger(); ended.leaseUntil = 0; ended.pausedAt = now(); save(ended);
        await onControlChange({ key, enabled: false, reason: '已回到主菜单' });
      }
      return { result, controls: { enabled: (ledger().leaseUntil || 0) > now() },
        instructions: '只控制杀戮尖塔2。开局和选项用request/respond；先处理当前奖励和事件选项，房间结束需要点击前进/继续时用 qq_sts2_action(kind="proceed",arguments={})，不要让管理员代点，也不要跳过未处理的奖励；商店面板先用request/respond关闭。地图只用next返回的可达节点；动作返回stateStatus="stable"且stateReadRequired=false时直接用state和nextRequest继续，不重复读state/request；其他状态先读取确认，duplicate仅是旧动作回执，不是当前局面。proceed没有可用按钮时不要盲目重试。禁用/start、自动刷局、重载和存档修改。' + STS2_CHAT_GUIDANCE };
    }
    if (args.operation === 'control') {
      if (typeof args.enabled !== 'boolean') fail('enabled 必须是布尔值');
      const m = readMessage(key, args.requestMessageId);
      if (!m || m.isSelf || String(m.userId) !== String(getConfig().ownerQQ)) fail('需要管理员在当前私聊真实发送的授权消息', 403);
      const text = String(m.plain || m.text || '');
      if (args.enabled && (!/杀戮|尖塔|sts2|打牌|玩.{0,6}(游戏|一局)/i.test(text) || /不要|别玩|停止|暂停/.test(text))) fail('原消息未明确要求玩游戏', 403);
      if (!Number.isFinite(Number(m.time)) || now() - Number(m.time) > 15 * 60000 || Number(m.time) > now() + 60000) fail('游戏授权消息过期', 403);
      const state = ledger();
      if (args.enabled && state.pausedAt && Number(m.time) <= state.pausedAt) fail('游戏已暂停，需要管理员在暂停后重新发送明确的游玩请求，不能复用旧授权消息', 403);
      state.leaseUntil = args.enabled ? now() + 2 * 3600000 : 0;
      if (!args.enabled) state.pausedAt = now();
      state.authorizedBy = String(m.messageId); save(state);
      let handoff;
      try { handoff = await onControlChange({ key, enabled: args.enabled, leaseUntil: state.leaseUntil, authorizedBy: state.authorizedBy }); }
      catch (error) {
        const stopped = ledger(); stopped.leaseUntil = 0; stopped.pausedAt = now(); save(stopped);
        throw error;
      }
      return { enabled: args.enabled, leaseUntil: state.leaseUntil, note: '仅游戏动作授权，最长两小时；停止时调用本工具enabled=false。', ...handoff };
    }
    if (args.operation !== 'action') fail('游戏操作类型无效');
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.requestId || '')) fail('动作需要稳定requestId');
    if (busy) fail('上一个游戏动作尚未完成', 409);
    const state = ledger(), fingerprint = crypto.createHash('sha256').update(JSON.stringify([args.kind, args.arguments])).digest('hex');
    const prior = state.calls[args.requestId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('相同编号不能用于不同动作', 409);
      if (prior.status !== 'done') fail('该动作结果未知，先读游戏状态，禁止重复执行', 409);
      return { ...prior.result, duplicate: true, stateStatus: 'cached', stateReadRequired: true };
    }
    if (!state.leaseUntil || state.leaseUntil <= now()) fail('尚未取得当前管理员的游戏授权或授权已过期', 403);
    if (!sessionReady(key)) fail('正在切换到独立游戏会话；当前回合请停止操作', 409);
    const a = args.arguments || {};
    let route, body;
    if (['play_card', 'end_turn', 'move'].includes(args.kind)) { route = '/act'; body = { ...a, kind: args.kind }; }
    else if (args.kind === 'respond') {
      if (!a || typeof a !== 'object' || Array.isArray(a) || !Array.isArray(a.picks) || a.picks.length > 32 || a.picks.some(p => typeof p !== 'string' || p.length > 300) || Object.keys(a).some(k => k !== 'id' && k !== 'picks')) fail('respond 需要 picks 字符串数组与当前请求 id');
      if (Object.hasOwn(a, 'id') && (!Number.isSafeInteger(a.id) || a.id < 0)) fail('respond 的 id 必须是有效的请求编号');
      route = '/respond'; body = { ...a };
    }
    else if (args.kind === 'proceed') {
      if (typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length !== 0) fail('proceed 的 arguments 必须是空对象');
      route = '/proceed'; body = {};
    }
    else if (args.kind === 'use_potion') { route = '/potion/use'; body = a; }
    else if (args.kind === 'discard_potion') { route = '/potion/discard'; body = a; }
    else fail('游戏动作未开放');
    busy = true;
    try {
      if (args.kind === 'respond' && !Object.hasOwn(body, 'id')) {
        const current = await request('/request', null, c, signal);
        config(key, authorize);
        const pending = current?.pending;
        if (!Number.isSafeInteger(pending?.id) || pending.id < 0 || !Array.isArray(pending.candidates)) fail('没有可应答的当前请求，请重新读取 request');
        const keys = new Set(pending.candidates.flatMap(x => [x.key, x.id]).filter(x => typeof x === 'string'));
        if (body.picks.some(p => !keys.has(p)) || body.picks.length < (pending.min ?? 0) || body.picks.length > (pending.max ?? 0)) fail('选项不属于当前请求或数量不符，请重新读取 request');
        body.id = pending.id;
      }
      const latest = ledger();
      if (!latest.leaseUntil || latest.leaseUntil <= now()) fail('游戏控制已停止或授权已过期', 403);
      if (!sessionReady(key)) fail('正在切换到独立游戏会话；当前回合请停止操作', 409);
      latest.calls[args.requestId] = { fingerprint, status: 'pending' }; save(latest);
      const result = await request(route, body, c, signal); config(key, authorize);
      const completed = ledger();
      completed.calls[args.requestId] = { fingerprint, status: 'done', result }; save(completed);
      if (await onObservation(key, result, args.kind)) {
        const ended = ledger(); ended.leaseUntil = 0; ended.pausedAt = now(); save(ended);
        await onControlChange({ key, enabled: false, reason: '已回到主菜单' });
      }
      if (result?.ok !== true) return { ...result,
        stateStatus: result?.ok === false ? 'rejected' : 'unavailable', stateReadRequired: true };
      // The action receipt is durable BEFORE observation: a failed/aborted read
      // must never turn an accepted action into a retryable action.
      const observed = await actionState(key, c, authorize, signal);
      config(key, authorize);
      if (observed.state && await onObservation(key, observed.state)) {
        const ended = ledger(); ended.leaseUntil = 0; ended.pausedAt = now(); save(ended);
        await onControlChange({ key, enabled: false, reason: '已回到主菜单' });
        observed.stateStatus = 'stopped'; observed.stateReadRequired = true;
      }
      return { ...result, ...observed };
    } finally { busy = false; }
  }
  return { handle };
}
