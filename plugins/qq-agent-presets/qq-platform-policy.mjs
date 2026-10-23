import { randomUUID } from 'node:crypto';

export const name = 'qq-platform-policy';
export const inject = ['agents'];
export const FLASH_MODELS = Object.freeze([
  'deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash'
]);
export const CONTINUE_TEXT = '继续完成上一轮被输出 token 上限截断的任务。从断点接着写，不重复已经给出的内容，不重复已经成功执行的工具动作；已发送的 QQ 消息或说说不要再发送。完成原任务即可，不必说明自动续写过程。';

// A context overflow can be clamped by pi-ai to max_tokens=1. Continuing that
// request only grows the same overflowing history; it is not output to resume.
export function observeCutoffProgress(state, event) {
  if (event.type === 'turn/start') {
    state.compactionError = false;
    state.sawAssistant = false;
    state.progress = false;
  } else if (event.type === 'compaction/end') {
    state.compactionError = Boolean(event.data.error);
  } else if (event.type === 'assistant/message') {
    state.sawAssistant = true;
    const message = event.data.message ?? event.data;
    state.progress ||= (event.data.usage?.outputTokens ?? 0) > 1
      || message.content?.some(b => b.type === 'tool-call' || b.type === 'text' && b.text?.trim());
  }
}

export function cutoffBlockReason(state) {
  if (state.compactionError) return 'context compaction failed';
  if (state.sawAssistant && !state.progress) return 'no output progress (one-token cutoff)';
  return '';
}

export function apply(ctx, config = {}) {
  const provider = config.provider || 'qq-qianwen';
  const models = (config.models || FLASH_MODELS).filter(m => FLASH_MODELS.includes(m));
  if (!models.length) throw new Error('QQ platform policy needs an allowed DeepSeek Flash model');
  const maxTokens = Math.max(1, Math.min(32768, Number(config.maxTokens) || 32768));
  const maxContinuations = Math.max(0, Math.min(12, Number(config.maxContinuations ?? 6)));
  const states = new WeakMap();
  const stateFor = agent => {
    if (!states.has(agent)) states.set(agent, { count: 0, index: 0, step: '', autoId: '', queuedTurn: null });
    return states.get(agent);
  };
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const request = await next();
    if (request.provider !== provider) return request;
    const state = stateFor(agent);
    state.signal = signal;
    const key = `${turn}:${step}`;
    if (state.step !== key) { state.step = key; state.index = 0; }
    const { reasoningEffort: _effort, ...rest } = request;
    return { ...rest, provider, model: models[state.index], maxTokens };
  }, { prepend: true });
  ctx.on('agent/request-error', async (payload, next) => {
    const action = await next();
    const { agent, signal } = payload;
    const state = states.get(agent);
    if (!state || signal.aborted || payload.provider !== provider || action?.kind === 'retry') return action;
    if (state.index + 1 >= models.length) return action;
    state.index++;
    ctx.logger.info(`QQ model request failed; retrying on ${provider}/${models[state.index]}`);
    return { kind: 'retry' };
  }, { prepend: true });
  ctx.on('session/event', (session, event) => {
    const route = session.requestHeader()?.config;
    if (route?.provider !== provider || !models.includes(route.model)) return;
    const agent = ctx.agents.get(session.id);
    if (!agent) return;
    const state = stateFor(agent);
    observeCutoffProgress(state, event);
    if (event.type === 'user/message') {
      const message = event.data.message ?? event.data;
      if (message?.source?.kind === 'user' && message.id !== state.autoId) {
        state.count = 0;
        state.queuedTurn = null;
      }
      return;
    }
    if (event.type !== 'turn/end') return;
    if (event.data.reason?.kind !== 'max-tokens') { state.count = 0; return; }
    const blocked = cutoffBlockReason(state);
    if (blocked) {
      ctx.logger.info(`QQ auto-continuation stopped: ${blocked}; repair/compact this session before retrying`);
      return;
    }
    if (state.queuedTurn === event.data.turn || state.count >= maxContinuations) return;
    // Respect a stop or newly queued human instruction; never fight the user.
    if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return;
    const message = Object.freeze({
      id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'user' }),
      content: Object.freeze([Object.freeze({ type: 'text', text: CONTINUE_TEXT })])
    });
    state.queuedTurn = event.data.turn;
    state.autoId = message.id;
    // Session append observers cannot reenter session.append (followup logs an
    // inbox splice). A timer also lets the current driver become idle first.
    const turn = event.data.turn;
    setTimeout(() => {
      if (ctx.agents.get(session.id) !== agent || state.signal?.aborted || state.queuedTurn !== turn) return;
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return;
      state.count++;
      agent.followup(message);
      ctx.logger.info(`QQ output limit: automatically continuing (${state.count}/${maxContinuations})`);
    }, 0);
  });
}
