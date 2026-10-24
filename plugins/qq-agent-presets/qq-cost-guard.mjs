// QQ 调用前估算预算。缓存命中率是用户选定的预算假设，不是服务器保证。
// 输入按字节上界保守估算；失败/未知用量保留预留款，有回执才按真实桶结算。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTINUE_TEXT, FLASH_MODELS } from './qq-platform-policy.mjs';
import { resolvePriceTable, ratesAt, costOfBuckets, normalizeUsage } from '../../src/model-prices.js';
import { QQ_COST_LIMIT, consumeOwnerCostExemption } from '../../src/qq-cost-policy.js';
import { readCostDelivery } from '../../src/qq-cost-deliveries.js';

export const name = 'qq-cost-guard';
export const inject = ['agents', 'llm'];
export const LIMIT_CODE = QQ_COST_LIMIT;

export function inputTokenUpperBound(options) {
  if (!Array.isArray(options.messages)) throw new Error('缺少完整模型输入');
  // JSON 连同 ID、工具历史等一起计入，另为模板/分隔符留余量。
  const text = JSON.stringify({ system: options.system, messages: options.messages,
    tools: options.tools, toolHistory: options.toolHistory });
  let visual = 0;
  for (const message of options.messages) for (const block of message.content ?? []) {
    if (block.type !== 'image' || block.offloaded) continue;
    // Flash 服务端缩放后每图最多 1024 token，逐次出现独立计入。
    // https://api-docs.deepseek.com/guides/vision/
    visual += 1024;
  }
  return Math.ceil(Buffer.byteLength(text, 'utf8') * 1.25) + 4096 + visual;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

export function apply(ctx, config = {}) {
  const root = config.root ?? fileURLToPath(new URL('../../', import.meta.url));
  const stateFile = path.join(root, 'state/cost-budgets.json');
  let budgets;
  try { budgets = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; budgets = {}; }
  const persist = () => atomicJson(stateFile, budgets);
  let disposed = false;
  ctx.on('dispose', () => { disposed = true; });
  const settings = () => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const enabled = raw.costControl?.enabled === true;
    const maxCny = Number(raw.costControl?.maxCnyPerMessage ?? raw.costControl?.maxCnyPerTurn ?? 0.1);
    if (enabled && (!(maxCny > 0) || maxCny > 0.1)) throw new Error('QQ 预算必须在 (0, 0.1] 元内');
    const cacheHitRatio = Number(raw.costControl?.cacheHitRatio ?? 0.9);
    if (!(cacheHitRatio >= 0 && cacheHitRatio <= 1)) throw new Error('缓存命中率必须在 [0, 1] 内');
    return { enabled, maxCny, cacheHitRatio, exemptOwner: raw.costControl?.exemptOwner === true,
      ownerQQ: String(raw.ownerQQ ?? ''), provider: raw.dsh?.provider ?? 'qq-qianwen',
      table: resolvePriceTable(raw.pricing) };
  };
  const owns = sid => {
    if (!sid) return false;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state/sessions.json'), 'utf8'));
    if (Object.values(state.sessions ?? {}).includes(sid)) return true;
    const learner = path.join(root, 'state/slang-session.json');
    if (fs.existsSync(learner) && JSON.parse(fs.readFileSync(learner, 'utf8')).sessionId === sid) return true;
    return false;
  };
  const inScope = (sid, provider) => {
    const policy = settings();
    return policy.enabled && (!provider || provider === policy.provider) && owns(sid);
  };
  const fresh = (turn, sid) => ({ turn, spent: 0, carry: false, calls: 0,
    deliveryId: readCostDelivery(root, sid)?.id ?? null });
  const syncDelivery = sid => {
    const budget = budgets[sid];
    if (!budget) return;
    const receipt = readCostDelivery(root, sid);
    if (!receipt || receipt.sessionId !== sid || receipt.id === budget.deliveryId) return;
    // Replace the object: a late usage/refund for a pre-delivery request belongs
    // to that completed message, never to the next message's allowance.
    budgets[sid] = { ...budget, spent: 0, calls: 0, deliveryId: receipt.id };
    persist();
  };
  const exempt = sid => {
    const policy = settings();
    if (!policy.exemptOwner || !policy.ownerQQ) return false;
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state/sessions.json'), 'utf8'));
    return state.sessions?.[`private:${policy.ownerQQ}`] === sid
      || budgets[sid]?.authorizedBy === policy.ownerQQ;
  };
  const blockedStream = (sid, reason) => {
    ctx.logger.info(`QQ budget stopped ${sid}: ${reason}`);
    atomicJson(path.join(root, 'state/cost-guard-last-block.json'), { at: Date.now(), sid, reason });
    return (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: LIMIT_CODE,
        message: `QQ 单条回复估算预算保护：${reason}。已停止，未发送本次模型请求。` } } };
    })();
  };

  ctx.on('agent/request', async ({ agent }, next) => {
    const request = await next();
    if (!inScope(agent.session?.id, request.provider)) return request;
    return { ...request, maxTokens: Math.min(Number(request.maxTokens) || 2048, 2048) };
  }, { prepend: true });
  ctx.on('agent/request-error', (payload, next) =>
    payload.failure?.code === LIMIT_CODE ? undefined : next(), { prepend: true });
  ctx.on('session/event', (session, event) => {
    if (!inScope(session.id)) return;
    const old = budgets[session.id];
    if (event.type === 'turn/start') {
      budgets[session.id] = old?.carry ? { ...old, turn: event.data.turn, carry: false, continued: true } : fresh(event.data.turn, session.id);
      persist();
    } else if (event.type === 'user/message') {
      const message = event.data.message ?? event.data;
      const isContinuation = message.content?.some(b => b.type === 'text' && b.text === CONTINUE_TEXT);
      if (message.source?.kind === 'user' && !(old?.continued && isContinuation)) {
        if (!old) return;
        if (old.continued) budgets[session.id] = fresh(old.turn, session.id);
        const policy = settings();
        const authorized = policy.exemptOwner && policy.ownerQQ
          && consumeOwnerCostExemption(root, session.id, message.content, policy.ownerQQ);
        budgets[session.id].authorizedBy = authorized ? policy.ownerQQ : null;
        persist();
      }
    } else if (event.type === 'turn/end' && old) {
      old.carry = event.data.reason?.kind === 'max-tokens';
      persist();
    }
  });
  ctx.on('llm/stream', (options, next) => {
    if (!inScope(options.sessionId, options.provider)) return next();
    const sid = options.sessionId;
    syncDelivery(sid);
    if (exempt(sid)) return next(); // The bridge token ledger still records actual usage.
    const budget = budgets[sid];
    const policy = settings();
    if (!FLASH_MODELS.includes(options.model)) return blockedStream(sid, '模型没有已确认的 Flash 单价');
    if (!budget) return blockedStream(sid, '没有当前回合的预算基线，请在新回合重试');
    let tokens;
    try { tokens = inputTokenUpperBound(options); }
    catch (error) { return blockedStream(sid, error.message); }
    const output = Number(options.maxTokens);
    if (!Number.isSafeInteger(output) || output <= 0) return blockedStream(sid, '输出 token 上限未知');
    const rates = ratesAt('deepseek-flash', Date.now(), policy.table);
    const inputRate = rates.cacheHit * policy.cacheHitRatio + rates.cacheMiss * (1 - policy.cacheHitRatio);
    const reserved = (tokens * inputRate + output * rates.output) / rates.unit;
    // 按用户设定的估算目标判断，不另扣隐藏缓冲；并发请求先同步占款再开始。
    if (budget.spent + reserved > policy.maxCny) {
      return blockedStream(sid, `已计入/预留 ¥${budget.spent.toFixed(4)}，本次按${policy.cacheHitRatio * 100}%命中预留 ¥${reserved.toFixed(4)}，目标 ¥${policy.maxCny.toFixed(2)}`);
    }
    budget.spent += reserved;
    budget.calls++;
    persist(); // 落盘失败不得发出请求；重载时也不能丢掉未结算预留。
    return (async function* () {
      let usage;
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = chunk.usage;
          yield chunk;
        }
      } finally {
        if (!disposed && usage && Number.isFinite(usage.inputTokens) && Number.isFinite(usage.outputTokens)) {
          const actual = costOfBuckets(normalizeUsage(usage), rates).total;
          if (Number.isFinite(actual) && actual >= 0) budget.spent += actual - reserved;
          persist();
        }
      }
    })();
  }, { prepend: true });
  atomicJson(path.join(root, 'state/cost-guard-status.json'), {
    revision: 'message-budget-v1', budgetUnit: 'qq-message', pid: process.pid, appliedAt: Date.now(), ...settings(), outputMaxTokens: 2048,
    reservation: 'assumed-cache-hit/utf8-upper-bound', hardLimit: false, currency: 'CNY'
  });
}
