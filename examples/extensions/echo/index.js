import crypto from 'node:crypto';

export function activate(ctx) {
  const storeKey = key => 'count_' + key.replace(':', '_');
  ctx.events.on('message', (message, call) => {
    call.assertAuthorized();
    const key = storeKey(message.key);
    ctx.storage.set(key, ctx.storage.get(key, 0) + 1);
  });
  ctx.tools.register('qq_ext_echo_echo', (args, call) => ({
    text: (ctx.config.prefix ?? '收到：') + args.text,
    key: call.key, observedMessages: ctx.storage.get(storeKey(call.key), 0),
  }));
  // /echo:ping is owner-only by default. A real message id keeps replay idempotent.
  ctx.commands.register('ping', async (args, call) => {
    if (!call.messageId) throw new Error('缺少真实消息编号，未发送');
    const requestId = 'echo_' + crypto.createHash('sha256').update(call.key + ':' + call.messageId).digest('hex');
    return call.messages.send([(ctx.config.prefix ?? '收到：') + (args || 'pong')], requestId);
  });
}
