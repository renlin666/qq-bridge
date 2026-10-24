export function activate(ctx) {
  for (const [name, action] of [
    ['qq_publish_qzone', 'qzone-publish'], ['qq_list_qzone', 'qzone-list'],
    ['qq_get_qzone_comments', 'qzone-comments'], ['qq_react_qzone', 'qzone-react'],
    ['qq_get_qzone_feed', 'qzone-feed'], ['qq_like_qzone', 'qzone-like'],
    ['qq_like_qzone_comment', 'qzone-like-comment'],
  ]) ctx.tools.register(name, (args, call) => call.service('qzone.social', { action, ...args }));
  const interval = Math.max(60000, Number(ctx.config.pollIntervalMs) || 120000);
  ctx.scheduler.every(interval, () => ctx.background('qzone.social', { action: 'poll' }));
}
