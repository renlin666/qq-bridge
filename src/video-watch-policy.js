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

export function videoDurationReason(video, policy) {
  const duration = Number(video?.duration);
  const total = Number(video?.totalDuration ?? video?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(total) || total <= 0) return 'duration_unknown';
  return Math.max(duration, total) > policy.maxVideoSeconds ? 'duration_exceeded' : null;
}

export function skippedVideo(reason, policy, duration) {
  return { watchStatus: 'skipped', reason, retryable: false, maxVideoSeconds: policy.maxVideoSeconds,
    ...(Number.isFinite(Number(duration)) && Number(duration) > 0 ? { duration: Number(duration) } : {}),
    frames: [], visualStatus: 'not-read', transcriptStatus: 'not-read',
    limit: reason === 'mention_required' ? '原视频消息未直接@机器人，不观看，不要重试。'
      : reason === 'duration_exceeded' ? `整段视频超过${policy.maxVideoSeconds}秒，不观看，也不通过截取片段绕过。`
      : '无法确认视频时长，不观看。' };
}
