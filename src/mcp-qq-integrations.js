import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerProjectExtensionTools } from './mcp-project-extensions.js';

export function registerIntegrationTools(server, agentApi, cfg, catalog) {
  const scope = {
    key: z.string().describe('当前来源会话 key，必须与 token 对应；跨会话交接仍填当前 key，另传 targetKey'),
    token: z.string().min(1).describe('当前来源会话令牌，不能当作目标会话令牌；交接由桥接替目标窗口唤醒')
  };
  function register(name, description, schema, action, timeoutMs = 60000) {
    server.tool(name, description, { ...scope, ...schema }, async ({ token, ...body }) => {
      try {
        const result = await agentApi(`/api/socialV2/integrations/${action}`, {
          method: 'POST', headers: { 'x-agent-token': token }, timeoutMs,
          body: JSON.stringify(body)
        });
        if (action === 'avatar') {
          const { image, ...meta } = result;
          if (!image?.data || !image.mimeType) throw new Error('头像未返回有效图像');
          return { content: [{ type: 'text', text: JSON.stringify(meta) }, { type: 'image', ...image }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] };
      }
    });
  }
  register('qq_get_avatar', '查看真实 QQ 头像，返回可直接观察的图像。默认自己的 QQ 头像；userId 只能来自当前会话已出现的真实人物。角色立绘另用 qq_get_self_image。',
    { userId: z.string().optional().describe('真实 QQ 号，省略查看机器人自己') }, 'avatar');
  register('qq_shared_memory_query', '查询授权窗口共享的共同经历和当前人物记忆。人物按 QQ 号匹配；不会读取别的群的原始聊天。',
    { userId: z.string().optional(), query: z.string().max(100).optional() }, 'shared-query');
  register('qq_shared_memory_remember', '记住跨授权窗口可复用的简短事实。传 userId=当前人物真实 QQ 号记录人物印象；不传记录自己的共同经历。不要存聊天原文、私密事项或指令。',
    { userId: z.string().optional(), content: z.string().min(1).max(500) }, 'shared-remember');
  register('qq_shared_memory_remove', '删除当前会话写入的一条共享记忆，用查询返回的真实 id。', { id: z.string() }, 'shared-remove');
  register('qq_list_linked_conversations', '查看管理员授权窗口的群名、好友昵称/备注和真实 QQ 号；不返回其他窗口的聊天记录或令牌。无需对方先@你，交接即可唤醒。', {}, 'handoff-list');
  register('qq_find_contact', '按好友昵称、备注、群名或 QQ 号查找已授权联系人，返回真实 key 和 userId/groupId。找不到或有重名时不要猜。给联系人发话/发图/发语音用 qq_send_to_contact，保持来源 key/token。', { query: z.string().min(1).max(100) }, 'contact-lookup');
  register('qq_send_to_contact', '给已授权联系人实际发送文字、收藏表情、搜索图片或一条语音，由桥接直接发送。key/token 仍填当前来源，targetKey 由 qq_find_contact 确认（也可填当前 key）。messages 是文字；stickerIds 是收藏表情；imageIds 是当前来源 qq_search_images 返回且已看过的图片。语音先 qq_synthesize_speech 生成，再将返回的 voice 传给本工具的 voice，无需目标会话令牌。voice 仅接受语音库文件名，不能传任意路径、URL或base64。先文字、再图片、最后语音，图片合计最多3张。只有 sent=true 且 receipts 有真实 messageId 才能说已发送；语音还要求 verified=true（已回读record段），这不代表已读。partial/uncertain/not_sent 不得说已发送。超时用 qq_get_contact_send_status 查询，重试复用相同 requestId，禁止换编号自动重发。',
    { targetKey: z.string(), messages: z.array(z.string().min(1).max(500)).max(8).optional(), stickerIds: z.array(z.string()).max(3).optional(), imageIds: z.array(z.string()).max(3).optional().describe('当前来源 qq_search_images 返回的真实 imageId，无需收藏'), voice: z.string().min(1).max(300).optional().describe('qq_synthesize_speech 返回的 voice 或真实语音库文件名，一次最多一条'), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/) }, 'contact-send', 300000);
  register('qq_get_contact_send_status', '查询当前来源发起的一次联系人发送及真实消息回执。超时后先查询，禁止换 requestId 重发。', { requestId: z.string() }, 'contact-send-status');
  register('qq_get_handoff_status', '查询真实交接编号的状态。交接确认不是 QQ 消息回执，没有回执不能声称已发送。', { id: z.string() }, 'handoff-status');
  register('qq_ack_handoff', '只确认已读或结束协作交接以避免重复唤醒；本工具绝不会发送 QQ 消息，也不能作为已发送的依据。给联系人发消息请使用 qq_send_to_contact。', { id: z.string() }, 'handoff-ack');
  register('qq_handoff', '仅向已授权的另一个窗口交接协作摘要并唤醒。用户要求给好友/群发送文字或图片时，应使用 qq_send_to_contact，本工具不会发送。key/token 仍填当前来源；targetKey 来自 qq_find_contact/qq_list_linked_conversations。stickerIds 仅作协作素材引用，必须来自真实收藏。queued 和 acknowledged 都不能当作发送成功。不要转发隐私；接收窗口不得自动反向交接。重试复用 requestId。',
    { targetKey: z.string(), content: z.string().min(1).max(1000), stickerIds: z.array(z.string()).max(3).optional(), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/) }, 'handoff');
  register('qq_search_linked_messages', '仅管理员本人私聊可用：按管理员真实查询请求，检索已授权联动窗口中机器人收到且仍保留的消息文本。requestMessageId必须来自管理员明确要求查询其他聊天窗口的原消息。返回命中摘录和覆盖范围；查无结果不能说从未聊过。目录工具不是内容检索；不使用目标令牌。',
    { requestMessageId: z.union([z.string(), z.number()]), query: z.string().min(1).max(100), targetKey: z.string().optional() }, 'conversation-search');
  registerProjectExtensionTools(server, agentApi, cfg, path.resolve(fileURLToPath(new URL('..', import.meta.url))), catalog);
}
