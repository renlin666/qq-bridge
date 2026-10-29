import { detectEsports } from '../../src/esports.js';

export function activate(ctx) {
  const topics = new Map();
  function remember(message, call) {
    if (message.isSelf) return null;
    const text = String(message.plain ?? message.text ?? message.query ?? '');
    const game = detectEsports(text);
    if (game) {
      topics.set(call.key, { game, at: Date.now() });
      if (topics.size > 256) topics.delete(topics.keys().next().value);
      return game;
    }
    const previous = topics.get(call.key);
    return previous && Date.now() - previous.at < 10 * 60 * 1000 && /比赛|这把|这局|赢|输|比分|战报|团战|大龙|经济|击杀|选图|禁图|回合|谁杀|决赛|打得|翻盘|第[一二三四五12345][局图]|残局|rating|adr/i.test(text) ? previous.game : null;
  }
  ctx.events.on('message', remember);
  ctx.context.register(async (message, call) => {
    const game = remember(message, call);
    if (ctx.config.csMemesEnabled === true && (await call.service('cs-memes.context', {})).active) {
      return '【CS娱乐解说】每句话都带梗，包括报比分和回群友，可以为了串而串；CS解说期间可以完全不管人设，不受原角色语气、克制程度和称呼习惯限制，比分/图分/胜负要查准，不必逐回合严肃复盘。先qq_load_tools(category=web)，qq_esports取得真实matchId和比分（会顺带返回最近回合eventLog），挑有意思的击杀/残局当素材，再qq_cs_meme_search搜该场选手/队伍或残局、空枪等主题；需要时qq_cs_meme_hot看24h/7d热榜。进行中的CS解说要主动聊，qq_wait_for_messages(timeoutMs=20000,minNewMessages=1,quietMs=3000)，没人接话也继续刷新该场数据；新比分、关键击杀/残局和贴切好梗可主动说，不等被问，没变化不重复刷屏，记住已讲事件id。比赛结束、用户停止或换话题即退出短等循环，决定收尾才按普通睡前观察规则。每条CS解说优先落地至少一处可辨认的6657原梗或融梗，先消化工具返回的items，不能查完只发普通数据播报。可短引原梗、综合仿写、抽象比喻和自创段子，一句多梗也可以；最近10条用过的梗、母题和句式先冷却，换人名/比分套原句仍算重复；四本书/大学/论语、无人Jee等已用系列先停，换题材、回合现编和不同表情包。遵守比分/梗工具返回的diversity；旧候选用完换公开主题或24h/7d窗口。已有新素材够用不必每句查库。梗里的仿新闻不是事实公告。顺带读取回合不等于严肃复盘或逐条播报；明确追问真实过程再用events翻更多回合，需要认真分析再用analysis长篇战报。无新候选可换公开主题或查热榜，也可自创梗式表达；接口失败的离线种子不叫当天热梗。LOL、日常聊天、认真分析或用户说别玩梗时停止6657梗库和脱离人设的CS风格，恢复原人设；日常按操作者偏好尽量句句带梗或表情包。只能说取得文字比分，不能假装看过直播；这是当前活跃解说循环，不是后台订阅，不能承诺离线自动跟进。';
    }
    if (!game) return '';
    return `【电竞查证 ${game}】准备参与这场比赛的讨论时，先qq_load_tools(category=web)，再用qq_esports查询。正在打/比分用mode=live；赛后、输赢原因、选手发挥用mode=analysis，该模式会自动联网搜索并读取战报。昨天/今天按香港时间算出YYYY-MM-DD并传date；query可用绿龙/Spirit、天禄/TYLOO等公开队名，勿发送群友原话或个人资料。指定队名/日期不传page会自动检索最多5页；不要只翻无筛选列表就断言没有比赛。Spirit是一队，Spirit.A/Spirit Academy是青训，不能混用。先取真实matchId再读详情；CS选图禁图读veto，谁杀了谁/回合经过先用mode=events+matchId，不凭旧记忆说拿不到；可按详情providerMapNumber传mapNumber和round，nextCursor查更早日志。日志可能不全，排除未开图/无回合边界/可疑热身；不能用总击杀推顺序。15秒缓存不是直播延迟，未测延迟不得说十几秒到一分钟；没有后台订阅不得承诺晚上自动跟进。LOL可用返回的gameId查小局。不要只附和群友或凭旧知识分析。模糊对阵/日期先看上下文，仍不明确再确认。仅取得文字数据，不能声称观看直播；核对日期和系列赛/地图比分；未找到只说明已查范围，不能据此否定用户的比赛记忆。缺失KDA/Rating不编造。拿到资料后按人设自然聊具体内容，无需机械播报整张表。`;
  });
  ctx.tools.register('qq_esports', async (args, call) => {
    const result = await call.service('esports.query', args);
    if (result.status === 'available') topics.set(call.key, { game: args.game, at: Date.now() });
    return result;
  });
  ctx.tools.register('qq_cs_meme_search', (args, call) => call.service('cs-memes.query', { ...args, action: 'search' }));
  ctx.tools.register('qq_cs_meme_hot', (args, call) => call.service('cs-memes.query', { ...args, action: 'hot' }));
  ctx.onDispose(() => topics.clear());
}
