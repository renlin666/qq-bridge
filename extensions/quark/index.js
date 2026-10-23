import { normalizeMagnet } from '../../src/quark-drive.js';

export function activate(ctx) {
  let reading = false;
  const lastRead = new Map();
  ctx.tools.register('qq_quark_status', async (_args, call) => ({ ok: true, ...await call.service('drive.inspect', { action: 'status' }) }));
  ctx.tools.register('qq_inspect_magnet', async (args, call) => {
    const message = call.messages.get(args.messageId);
    if (!message) throw Object.assign(new Error('只能读取当前会话已收到的消息，请传真实 messageId 或 seq'), { statusCode: 404 });
    const text = `${(message.sharedLinks ?? []).join('\n')}\n${message.text ?? ''}\n${message.plain ?? ''}\n${message.tail ?? ''}`.replace(/&amp;/g, '&');
    const magnets = [...new Set(text.match(/magnet:\?[^\s<>"'\]]+/gi) ?? [])];
    const value = magnets[(args.index ?? 1) - 1];
    if (!value) throw new Error('这条消息没有对应的磁力链接');
    const magnet = normalizeMagnet(value);
    if (reading || Date.now() - (lastRead.get(call.key) ?? 0) < 5000) throw Object.assign(new Error('夸克正在解析另一条链接或读取过于频繁'), { statusCode: 429 });
    reading = true; lastRead.set(call.key, Date.now());
    if (lastRead.size > 2000) lastRead.delete(lastRead.keys().next().value);
    try { return { ok: true, key: call.key, result: await call.service('drive.inspect', { action: 'read', magnet }) }; }
    finally { reading = false; }
  });
  ctx.onDispose(() => lastRead.clear());
}
