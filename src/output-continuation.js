import { CONTINUE_TEXT, observeCutoffProgress, cutoffBlockReason } from '../plugins/qq-agent-presets/qq-platform-policy.mjs';

// Keep truncated text until the native DSH policy finishes the follow-up turn.
export function createOutputContinuation(config = {}) {
  const pending = new Map();
  const progress = new Map();
  const limit = Math.max(0, Math.min(12, Number(config.maxContinuations ?? 6)));
  return {
    has: id => pending.has(id),
    delete: id => { pending.delete(id); progress.delete(id); },
    clear: () => { pending.clear(); progress.clear(); },
    observe(id, event) {
      if (!progress.has(id)) progress.set(id, {});
      observeCutoffProgress(progress.get(id), event);
      const message = event.data?.message ?? event.data;
      if (event.type === 'user/message' && message?.source?.kind === 'user') {
        const text = message.content?.map(b => b.text || '').join('');
        if (text !== CONTINUE_TEXT) pending.delete(id);
      }
    },
    finish(id, ended) {
      if (!ended) return { ended, continuing: false };
      const prior = pending.get(id) || { count: 0, text: '' };
      if (config.enabled && ended.reason.kind === 'max-tokens' && prior.count < limit && !cutoffBlockReason(progress.get(id) || {})) {
        pending.set(id, { count: prior.count + 1, text: prior.text + ended.text });
        return { ended: null, continuing: true };
      }
      pending.delete(id);
      progress.delete(id);
      return { ended: { ...ended, text: prior.text + ended.text }, continuing: false };
    }
  };
}
