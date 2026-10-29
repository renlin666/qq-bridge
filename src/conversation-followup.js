// A recent reply creates a short opportunity for the same person to continue.
// Anchor the window to an actual bot message, never to incoming chatter/read marks.
export function isConversationFollowup({ history = [], userId, event, text, now = Date.now() }) {
  const peer = String(userId ?? '');
  if (!/^[1-9]\d*$/.test(peer) || !String(text ?? '').trim()) return false;
  const segments = Array.isArray(event?.message) ? event.message : [];
  // Explicitly addressing someone else starts a different conversation.
  if (segments.some(segment => segment?.type === 'reply' || segment?.type === 'at')) return false;
  if (segments.length && !segments.some(segment => segment?.type === 'text' && String(segment.data?.text ?? '').trim())) return false;
  let replyIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.isSelf) { replyIndex = i; break; }
  }
  if (replyIndex < 0) return false;
  const reply = history[replyIndex];
  const elapsed = now - Number(reply.time ?? reply.at);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 15 * 60000) return false;
  let previous;
  if (reply.atUserId && String(reply.atUserId) !== peer) return false;
  for (let i = replyIndex - 1; i >= 0; i--) {
    const message = history[i];
    if (message?.isSelf) continue;
    if (reply.replyToMessageId && String(message?.messageId ?? '') !== String(reply.replyToMessageId)) continue;
    if (reply.atUserId && String(message?.userId ?? '') !== peer) continue;
    previous = message; break;
  }
  if (String(previous?.userId ?? '') !== peer) return false;
  const replyDelay = Number(reply.time ?? reply.at) - Number(previous.time ?? previous.at);
  if (!Number.isFinite(replyDelay) || replyDelay < 0 || replyDelay > 15 * 60000) return false;
  // Another participant taking over (or an explicit reply to them) ends this link.
  return history.slice(replyIndex + 1).every(message => message?.isSelf
    || (String(message?.userId ?? '') === peer && (!message.replyToMessageId || message.quoteTargetIsSelf)));
}
