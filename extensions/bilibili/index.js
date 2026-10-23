import { biliReferences } from '../../src/bilibili.js';
import { videoToolResult } from '../../src/bilibili-media.js';

export function activate(ctx) {
  let reading = false;
  const lastRead = new Map();
  const cache = new Map();
  ctx.tools.register('qq_read_bilibili', async (args, call) => {
    const message = call.messages.get(args.messageId);
    if (!message) throw Object.assign(new Error('只能读取当前会话已收到的消息，请传真实 messageId 或 seq'), { statusCode: 404 });
    const text = `${(message.sharedLinks ?? []).join('\n')}\n${message.text ?? ''}\n${message.plain ?? ''}\n${message.tail ?? ''}`;
    const reference = biliReferences(text)[(args.index ?? 1) - 1];
    if (!reference) throw new Error('这条消息没有对应的 B站视频链接');
    const cacheKey = JSON.stringify([reference, args.page ?? 1, args.startSeconds ?? 0, args.endSeconds ?? null, args.frameCount ?? 16]);
    const old = cache.get(cacheKey);
    let video;
    if (old && Date.now() - old.at < 600000) video = old.value;
    else {
      if (reading || Date.now() - (lastRead.get(call.key) ?? 0) < 5000) throw Object.assign(new Error('正在读取视频或读取过于频繁，请稍后重试'), { statusCode: 429 });
      reading = true; lastRead.set(call.key, Date.now());
      if (lastRead.size > 2000) lastRead.delete(lastRead.keys().next().value);
      try {
        video = await call.service('media.bilibili', { reference, ...args });
        cache.set(cacheKey, { at: Date.now(), value: video });
        if (cache.size > 12) cache.delete(cache.keys().next().value);
      } finally { reading = false; }
    }
    call.assertAuthorized();
    if (ctx.config.enabled === false) throw Object.assign(new Error('B站解析已关闭'), { statusCode: 403 });
    return { ok: true, key: call.key, video };
  }, { toMcp: videoToolResult });
  ctx.onDispose(() => { cache.clear(); lastRead.clear(); });
}
