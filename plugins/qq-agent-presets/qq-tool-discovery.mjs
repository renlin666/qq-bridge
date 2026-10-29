// Each agent owns its masks. Loading a category only lifts these masks; the
// permanent security restrictions and execution guard remain authoritative.
export const TOOL_CATEGORIES = Object.freeze({
  memory: '人物记忆、关系与获准共享摘要',
  media: '图片、表情包、日语语音与多语言唱歌、头像与合并转发',
  video: 'B站和视频内容读取',
  images: '搜图、生图与照片合成',
  qzone: '空间读取、发布、评论、点赞及好友审批',
  contacts: '授权联系人、跨会话发送、交接和管理员聊天检索',
  web: '联网搜索、网页正文及CS2/LOL电竞战报',
  details: '补充消息详情、成员、黑话、反馈及其他QQ动作',
});
const CORE = new Set(['qq_get_prompt', 'qq_get_unread_messages', 'qq_get_recent_messages',
  'qq_send_message', 'qq_reply', 'qq_wait_for_messages', 'qq_mark_read', 'qq_set_wake_config',
  'qq_social_state', 'qq_social_memory_profile']);

export function toolCategory(name) {
  if (name.startsWith('mcp__web-search-safe__')) return 'web';
  if (!/^mcp__snowluma(?:-host)?__/.test(name)) return null;
  const tool = name.replace(/^mcp__snowluma(?:-host)?__/, '');
  if (CORE.has(tool)) return null;
  if (tool === 'qq_esports' || /^qq_cs_meme_/.test(tool)) return 'web';
  if (/qzone|friend_approval/.test(tool)) return 'qzone';
  if (/bilibili|video/.test(tool)) return 'video';
  if (/search_images|generate_image|compose_photo/.test(tool)) return 'images';
  if (/contact|linked_|handoff/.test(tool)) return 'contacts';
  if (/memory|relationship/.test(tool)) return 'memory';
  if (/image|sticker|voice|speech|singing|avatar|forward/.test(tool)) return 'media';
  return 'details';
}

export function installToolDiscovery(ctx) {
  const masks = new Map();
  function scan() {
    for (const schema of ctx.tools.schemas()) {
      const category = toolCategory(schema.name);
      if (!category || loaded.has(category) || masks.has(schema.name)) continue;
      // restrict() only accepts inherited globals. Scoped tools stay visible.
      try {
        const dispose = ctx.tools.restrict({ deny: [schema.name] });
        if (typeof dispose === 'function') masks.set(schema.name, { category, dispose });
      } catch { /* a scope-local registration cannot be masked */ }
    }
  }
  const loaded = new Set();
  scan();
  // Late MCP discovery is accounted for before the next model request.
  ctx.on?.('agent/pre-step', (_options, next) => { scan(); return next(); });
  // Some DSH MCP clients register on the agent's OWN layer, which restrict()
  // deliberately cannot mask. The public assembly seam covers both inherited
  // and own-layer declarations. Pair it with an execution guard so a model
  // cannot call a hidden group by guessing a historically known tool name.
  ctx.on?.('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    return { ...assembly, tools: assembly.tools.filter(tool => {
      const category = toolCategory(tool.name);
      return !category || loaded.has(category);
    }) };
  });
  ctx.tools.guard?.(exec => {
    const category = toolCategory(exec.name || '');
    if (category && !loaded.has(category)) return `先用qq_load_tools加载${category}工具组`;
  });
  ctx.tools.register({
    name: 'qq_load_tools',
    description: '按需加载工具组。memory记忆关系，media图像表情语音转发，video视频，images搜图生图，qzone空间好友，contacts跨会话联系人，web联网，details其他QQ动作。未列出的能力先加载对应组；只影响当前会话，不授予权限。',
    parameters: { type: 'object', properties: { category: { type: 'string', enum: Object.keys(TOOL_CATEGORIES) } }, required: ['category'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute({ category }, exec) {
      if (!Object.hasOwn(TOOL_CATEGORIES, category)) throw new Error('未知工具组');
      loaded.add(category);
      const names = [];
      for (const [name, mask] of masks) {
        if (mask.category !== category) continue;
        mask.dispose(); masks.delete(name); names.push(name);
      }
      ctx.emit?.('system-prompt/change');
      return { category, available: ctx.tools.schemas(exec?.agent).filter(tool => toolCategory(tool.name) === category).map(tool => tool.name),
        newlyLoaded: names.length, note: '后续调用仍受当前会话、工具开关与权限检查；未加载不表示能力关闭。' };
    },
  });
  ctx.systemPrompt?.section({ name: 'qq:tool-discovery', order: 131,
    text: '常用聊天工具已加载。其他能力先用qq_load_tools(category)加载对应组再调用；名单里暂时没有不代表能力关闭。memory记忆关系，media图像表情语音，video视频，images搜图生图，qzone空间好友，contacts联系人与其他聊天，web联网及CS2/LOL电竞战报。电竞比分先加载web并用qq_esports查准；CS娱乐解说按专项提示查6657梗库轻松聊，不必默认严肃复盘。LOL或用户明确认真分析、查真实过程时用analysis搜战报或events查事件，不能把笑话当赛讯。details其他动作。加载仅当前会话生效，权限仍由服务校验。' });
}
