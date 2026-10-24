export function videoPolicy(config = {}) {
  const bounded = (key, fallback, max) => {
    const n = Number(config[key]);
    return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.floor(n)) : fallback;
  };
  return { maxVideoSeconds: bounded('maxVideoSeconds', 300, 3600),
    defaultFrameCount: bounded('defaultFrameCount', 8, 16), maxTextChars: bounded('maxTextChars', 6000, 24000) };
}

export function directlyMentionsBot(event, fallbackId = '') {
  const id = String(event?.self_id || fallbackId || '');
  return !!id && Array.isArray(event?.message)
    && event.message.some(segment => segment?.type === 'at' && String(segment.data?.qq) === id);
}

export function videoDurationReason(video, policy, approved = false) {
  const duration = Number(video?.duration);
  const total = Number(video?.totalDuration ?? video?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(total) || total <= 0) return 'duration_unknown';
  return !approved && Math.max(duration, total) > policy.maxVideoSeconds ? 'duration_exceeded' : null;
}

// Only original, admitted messages can grant permission. Never accept an actor
// ID, boolean or quoted approval text supplied by the model as authorization.
export function videoApproval(message, messages, config, approvalMessageId) {
  const approver = String(config.approvalUserId ?? '');
  if (!approver) return null;
  return messages.find(candidate => {
    if (candidate.isSelf || String(candidate.userId ?? '') !== approver) return false;
    if (approvalMessageId != null && ![candidate.seq, candidate.messageId].some(id => id != null && String(id) === String(approvalMessageId))) return false;
    const match = /^允许观看视频(?:\s+(-?\d+))?[。！!]?\s*$/.exec(String(candidate.approvalText ?? candidate.plain ?? candidate.text ?? '').trim());
    if (!match) return false;
    if (match[1]) return [message.seq, message.messageId].some(id => id != null && String(id) === match[1]);
    return message.messageId != null && String(candidate.replyToMessageId ?? '') === String(message.messageId);
  }) ?? null;
}

export function skippedVideo(reason, policy, duration) {
  return { watchStatus: 'skipped', reason, retryable: false, maxVideoSeconds: policy.maxVideoSeconds,
    ...(Number.isFinite(Number(duration)) && Number(duration) > 0 ? { duration: Number(duration) } : {}),
    frames: [], visualStatus: 'not-read', transcriptStatus: 'not-read',
    limit: reason === 'duration_exceeded' ? `整段视频超过${policy.maxVideoSeconds}秒，尚无指定账号对该条视频的许可；不观看，不通过截取片段绕过。`
      : '无法取得有效视频时长，暂不能抽帧观看；不得声称已观看。' };
}
