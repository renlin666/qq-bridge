import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBilibiliMedia } from './bilibili-media.js';
import { inspectMagnet, quarkStatus } from './quark-drive.js';
import { safeFetch, safeFetchBuffer } from './safe-fetch.js';
import { createQzoneSocial } from './qzone-social.js';
import { createQzonePublisher } from './qzone-publisher.js';
import { createPluginHost } from './plugin-host/index.js';
import { extensionConfig, extensionEnabled } from './plugin-host/catalog.js';
import { biliReferences } from './bilibili.js';
import { videoPolicy, videoDurationReason, skippedVideo, videoApproval } from './video-watch-policy.js';
import { legacyMemoryEntries } from './legacy-memory-source.js';
import { parseSocialEvents } from './social-event-metadata.js';
import { createFriendApproval } from './friend-approval.js';
import { readMemoryLibrary } from './memory-library.js';
import { readRelationships } from './relationship-view.js';
import { createArkAssistant } from './ark-assistant.js';
import { arkPaused } from './ark-client.js';
import { embedLocal } from './local-embedding.js';
import { createEsportsService } from './esports.js';
import { createCsMemeService } from './cs-memes.js';
import { createComfyService } from './comfy-service.js';
import { createSts2Service } from './sts2-service.js';
import { createSingingService } from './singing-service.js';

export const INTEGRATION_PREFIX = '/api/socialV2/integrations/';
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

// Core adapters retain the existing transport, scoped reads and publication ledgers.
// Feature selection, schemas and tool registration belong to the project extensions.
export function createIntegrations({ stateDir, getConfig, onebot, getConversation, sessionAllowed, tokenOk, socialHub,
  getConversations = () => [], getSelfId = () => '',
  readMessageImages, readSelfImage, validateImage, sendVideo, notifyQzone = async () => {}, fetchImage = safeFetchBuffer,
  readVideo = readBilibiliMedia, readMagnet = inspectMagnet, driveStatus = quarkStatus, queryEsports,
  projectRoot = ROOT, localRoot, backgroundAllowed = () => true, sanitizeExternalText = String, log = () => {},
  onGameControl, onGameObservation, gameSessionReady }) {
  const effectiveConfig = () => {
    const cfg = getConfig();
    const integrations = { ...cfg.integrations };
    for (const id of ['bilibili', 'quark', 'qzone']) integrations[id] = { ...extensionConfig(id, cfg), enabled: extensionEnabled(id, cfg) };
    return { ...cfg, integrations };
  };
  const qzone = createQzoneSocial({ stateDir, getConfig: effectiveConfig, onebot, sessionAllowed, notify: notifyQzone });
  const friendApproval = createFriendApproval({ stateDir, getConfig: effectiveConfig, getConversation, sessionAllowed, onebot, log,
    notify: (key, messages, requestId, authorize) => socialHub?.sendLocal(key, messages, requestId, authorize)
      ?? fail('管理员私聊通知服务未就绪', 503) });
  const publish = createQzonePublisher({ stateDir, getConfig: effectiveConfig, onebot, readMessageImages, readSelfImage, validateImage, fetchImage,
    readSearchImage: (key, imageId) => {
      if (!extensionEnabled('image-search', getConfig())) fail('图片搜索插件未启用', 403);
      if (!socialHub?.imageForSend) fail('搜图配图读取未就绪', 503);
      return socialHub.imageForSend(key, imageId).buffer;
    } });
  function checkScope(body, req) {
    const key = String(body.key ?? '').trim();
    if (!/^(group|private):[1-9]\d*$/.test(key)) fail('key 格式无效');
    const token = req.headers['x-agent-token'];
    if ((token || req.headers['x-agent-call'] !== undefined) && (!token || !tokenOk(key, token))) fail('agent token 无效', 403);
    if (!sessionAllowed(key)) fail('会话不在当前允许范围内', 403);
    return key;
  }
  const scope = (body, req) => ({ key: checkScope(body, req), assertAuthorized: () => checkScope(body, req) });
  function readMessage(key, messageId) {
      const st = getConversation(key);
      const ref = String(messageId ?? '');
      return [...(st?.recentMessages ?? []), ...(st?.unread ?? [])]
        .find(message => String(message.seq) === ref || String(message.messageId) === ref) ?? null;
  }
  const comfy = createComfyService({ stateDir, getConfig, readMessage, readMessageImages, validateImage, sendVideo, onebot,
    sanitizeText: sanitizeExternalText, storeImage: (key, buffer, title) => socialHub.storeGeneratedImage(key, buffer, title) });
  const ark = createArkAssistant({ stateDir, projectRoot, getConfig, readMessage, onebot,
    embed: embedLocal,
    localGenerate: comfy.generateImage,
    readMessageImages, validateImage, sanitizeText: sanitizeExternalText,
    readSearchImage: (key, id) => socialHub.imageForSend(key, id).buffer,
    storeImage: (key, buffer, title) => socialHub.storeGeneratedImage(key, buffer, title) });
  const esports = queryEsports ? { query: queryEsports } : createEsportsService({ root: projectRoot });
  const csMemes = createCsMemeService({ getConversation,
    getConfig: () => extensionConfig('esports', getConfig()),
    queryMatch: (args, config, authorize, signal) => esports.query(args, config, authorize, signal) });
  const sts2 = createSts2Service({ stateDir, getConfig, readMessage, onControlChange: onGameControl,
    onObservation: onGameObservation, sessionReady: gameSessionReady });
  const singing = createSingingService({ stateDir, projectRoot, getConfig, readMessage });
  const host = createPluginHost({ root: projectRoot, localRoot, stateDir, getConfig, log, services: {
    readMessage,
    'singing.generate': (key, args, authorize, signal) => singing.handle(key, args, authorize, signal),
    'games.sts2': (key, args, authorize, signal) => sts2.handle(key, args, authorize, signal),
    'comfy.generate': (key, args, authorize, signal) => comfy.handle(key, args, authorize, signal),
    'cs-memes.context'(key, _args, authorize) { authorize(); return { active: csMemes.active(key, extensionConfig('esports', getConfig())) }; },
    'cs-memes.query'(key, args, authorize, signal) {
      authorize(); return csMemes.query(key, args, extensionConfig('esports', getConfig()), authorize, signal);
    },
    async 'esports.query'(key, args, authorize, signal) {
      authorize();
      if (!extensionEnabled('esports', getConfig())) fail('电竞插件已关闭', 403);
      const result = await esports.query(args, extensionConfig('esports', getConfig()), authorize, signal);
      authorize(); csMemes.noteMatch(key, result);
      if (csMemes.liveCommentary(key)) result.commentary = {
        refreshAfterMs: 20000,
        diversity: csMemes.diversity(key),
        instruction: '当前CS比赛解说要主动跟进：qq_wait_for_messages用timeoutMs=20000、minNewMessages=1、quietMs=3000；无人聊天也刷新该场比分和附带回合。每句话都带梗，包括报比分和回群友；可以为了串而串，CS解说期间可以完全不管人设。每条解说优先带一处可辨认的6657原梗或融梗，用qq_cs_meme_search/qq_cs_meme_hot取得候选，不能查完只发普通数据播报；余下可放开吐槽、抽象比喻和自创段子，比分/地图分/胜负仍说准，不拿段子冒充真实击杀。遵守diversity：最近10条中用过的梗、母题、句式先冷却，换人名/比分套原句仍算重复；四本书/大学/论语系列已用过就停，换题材和回合现编，候选陈旧就换公开主题或24h/7d窗口补新梗。已有新素材够用不必每句查库。出现新比分、关键击杀/残局或可串的角度就主动发言，不用等被问；数据没变化不重复刷屏，记住已讲过的事件id。比赛结束、用户停止或换话题即结束主动循环并恢复原人设；普通睡前5分钟观察只在决定收尾时使用。'
      };
      const live = result.matches?.filter(m => m.status === 'live');
      if (args.game === 'cs2' && (args.mode == null || args.mode === 'live') && live?.length === 1
          && csMemes.active(key, extensionConfig('esports', getConfig()))) {
        const detail = await esports.query({ game: 'cs2', mode: 'events', matchId: live[0].id, eventLimit: 30, maxEventPages: 1 },
          extensionConfig('esports', getConfig()), authorize, signal);
        authorize();
        if (!csMemes.active(key, extensionConfig('esports', getConfig()))) return result;
        const enriched = detail.matches?.find(m => m.id === live[0].id);
        if (enriched) {
          result.matches = result.matches.map(m => m.id === enriched.id ? enriched : m);
          result.commentaryEvents = { attempted: true, status: enriched.eventLog?.status,
            note: '查比分顺带读取最近已核对回合，给娱乐解说找素材，不要求逐条播报；缺失或未结算不编造。自动附带最多1页，更多历史可显式events查询。' };
        } else result.commentaryEvents = { attempted: true, status: 'unavailable', note: '回合读取失败，比分仍可用。' };
      }
      return result;
    },
    'ark.assist': (key, args, authorize, signal) => ark.handle(key, args, authorize, signal),
    'ark.embed': (key, args, authorize, signal) => {
      const scopeKey = key || args.scopeKey;
      const recheck = () => {
        authorize();
        if (!scopeKey || !sessionAllowed(scopeKey) || getConfig().socialV2?.tools?.memory === false
          || !backgroundAllowed() || String(args.botAccountId) !== String(getSelfId())) fail('向量记忆范围已撤销', 403);
      };
      recheck();
      return ark.embedding(args.text, recheck, signal, key ? 2000 : 10000);
    },
    'ark.rank': (key, args, authorize, signal) => getConfig().extensions?.ark?.enabled === true
      ? ark.rank(key, args, authorize, signal) : { candidates: args.candidates, provider: 'unchanged' },
    'memory.legacy'(key, _args, authorize) {
      authorize();
      const read = scope => getConfig().socialV2?.tools?.memory === false ? []
        : legacyMemoryEntries(getConversation(scope), socialHub?.query(scope) ?? []);
      if (key) return read(key);
      return { botAccountId: String(getSelfId() || ''), scopes: [...getConversations()]
        .filter(([scope]) => sessionAllowed(scope)).map(([scope]) => ({ key: scope, entries: read(scope) })) };
    },
    'memory.policy'(_key, _args, authorize) {
      authorize();
      const cfg = getConfig();
      const extra = extensionConfig('social-memory', cfg);
      return { botAccountId:String(getSelfId()||''),ownerQQ:String(cfg.ownerQQ||''),enabled:cfg.socialV2?.tools?.memory!==false,people: cfg.socialV2?.tools?.memory === false ? [] : [...new Set([...(cfg.allow?.private ?? []), ...(extra.people ?? []), cfg.ownerQQ].filter(Boolean).map(String))],
        embeddingEnabled: cfg.extensions?.ark?.enabled === true && cfg.extensions.ark.config?.embeddingEnabled !== false,
        groups: (cfg.allow?.groups ?? []).map(String), minimumTiers: extra.minimumTiers ?? {} };
    },
    sendMessage(key, messages, requestId, authorize) {
      if (!socialHub) fail('发送服务未就绪', 503);
      return socialHub.sendLocal(key, messages, requestId, authorize);
    },
    async 'network.read'(_key, args, authorize) {
      authorize();
      const result = await safeFetch(args.url, Math.max(1, Math.min(1024 * 1024, Number(args.maxBytes) || 128 * 1024)));
      authorize(); return { statusCode: result.statusCode, body: result.body, url: result.url };
    },
    async 'media.bilibili'(key, { reference, ...options }, authorize) {
      authorize();
      if (!extensionEnabled('bilibili', getConfig())) fail('B站解析已关闭', 403);
      const media = extensionConfig('bilibili', getConfig());
      if (getConfig().extensions?.ark?.enabled === true && !arkPaused(getConfig().extensions.ark.config)) media.ark = extensionConfig('ark', getConfig());
      const message = readMessage(key, options.messageId);
      if (!message) fail('视频消息不属于当前会话', 404);
      const refs = biliReferences(`${(message.sharedLinks ?? []).join('\n')}\n${message.text ?? ''}\n${message.plain ?? ''}\n${message.tail ?? ''}`);
      if (!refs.includes(reference)) fail('视频链接不属于当前消息', 403);
      const result = await readVideo(reference, { ...options, media, stateDir, watchApproved: false });
      authorize();
      const current = videoPolicy(extensionConfig('bilibili', getConfig()));
      const blocked = result.watchStatus === 'skipped' ? result.reason : videoDurationReason(result, current);
      return blocked ? skippedVideo(blocked, current, result.totalDuration ?? result.duration, result)
        : { ...result, watchAuthorization: !current.durationGateEnabled ? 'duration-gate-disabled' : 'duration-limit' };
    },
    'drive.inspect'(_key, { action, magnet }, authorize) {
      authorize();
      const options = extensionConfig('quark', getConfig());
      if (!extensionEnabled('quark', getConfig())) fail('夸克磁力解析未启用', 403);
      return action === 'status' ? driveStatus(options) : readMagnet(magnet, options);
    },
    'images.search'(key, args, authorize) { return socialHub?.handle('image-search', key, args, authorize) ?? fail('搜图服务未就绪', 503); },
    'images.send'(key, args, authorize) { return socialHub?.handle('image-send', key, args, authorize) ?? fail('发送服务未就绪', 503); },
    async 'qzone.social'(key, { action, ...args }, authorize) {
      if (action === 'friend-poll') { if (backgroundAllowed()) { authorize(); friendApproval.poll(); } return null; }
      if (action === 'friend-message') return friendApproval.incoming(key, args.message, authorize);
      if (action === 'friend-propose') return friendApproval.propose(key, args, authorize);
      if (action === 'friend-status') { authorize(); return friendApproval.status(key, args); }
      if (action === 'poll') {
        if (backgroundAllowed()) { authorize(); await qzone.poll(); }
        return null;
      }
      authorize();
      return action === 'qzone-publish' ? publish(key, args, authorize) : qzone.handle(action, key, args, authorize);
    },
  } });
  async function handle({ req, url, readBody, sendJson }) {
    if (url.pathname === '/api/memory-library/hybrid-status') {
      if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) fail('向量索引状态仅管理员可用', 403);
      if (req.method !== 'GET') { sendJson({ ok: false, error: '仅支持GET' }, 405); return true; }
      sendJson(await host.invokeAdmin('social-memory', 'hybrid-status', {}, key => {
        if (!extensionEnabled('social-memory', getConfig()) || getConfig().socialV2?.tools?.memory === false) fail('记忆已关闭', 403);
        if (key && !sessionAllowed(key)) fail('会话已撤销', 403);
      }));
      return true;
    }
    if (url.pathname === '/api/memory-library/review') {
      const authorize=key=>{
        if(req.headers['x-agent-token']||req.headers['x-agent-call']!==undefined)fail('记忆核实仅管理员可用',403);
        if(!extensionEnabled('social-memory',getConfig())||getConfig().socialV2?.tools?.memory===false)fail('记忆功能已关闭',403);
        if(key&&!sessionAllowed(key))fail('记忆会话不在当前白名单',403);
      };
      authorize();
      if(req.method!=='POST'){sendJson({ok:false,error:'核实操作需要 POST'},405);return true;}
      const body=await readBody();
      try{sendJson(await host.invokeAdmin('social-memory','review',body,authorize));}
      catch(error){error.statusCode??=({CONFLICT:409,FORBIDDEN:403,PERSON_DISABLED:403,NOT_FOUND:404,INVALID_INPUT:400,INVALID_CONTEXT:400}[error.code]||400);throw error;}
      return true;
    }
    if(url.pathname==='/api/relationships'){
      if(req.headers['x-agent-token']||req.headers['x-agent-call']!==undefined)fail('关系管理视图仅控制台可用',403);
      if(req.method!=='GET'){sendJson({ok:false,error:'关系数据只读'},405);return true;}
      sendJson(readRelationships(stateDir,url.searchParams));return true;
    }
    if (url.pathname === '/api/memory-library') {
      if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) fail('记忆库管理视图仅控制台可用',403);
      if (req.method !== 'GET') { sendJson({ok:false,error:'只支持只读查看'},405); return true; }
      sendJson(readMemoryLibrary(stateDir,url.searchParams)); return true;
    }
    if (url.pathname === '/api/extensions/catalog' && req.method === 'GET') {
      sendJson({ tools: await host.catalog() }); return true;
    }
    const call = url.pathname === '/api/socialV2/extensions/call';
    if (!call && !url.pathname.startsWith(INTEGRATION_PREFIX)) return false;
    if (req.method !== 'POST') { sendJson({ ok: false, error: '请使用 POST' }, 405); return true; }
    const body = await readBody();
    const current = scope(body, req);
    if (call) {
      sendJson(await host.callTool(body.name, body.arguments, current)); return true;
    }
    const action = url.pathname.slice(INTEGRATION_PREFIX.length);
    const result = await host.invokeAction(action, body, current);
    if (result != null) { current.assertAuthorized(); sendJson({ ok: true, key: current.key, ...result }); return true; }
    // These aliases are owned by plugins even when disabled; never fall back around a disabled plugin.
    if (['bilibili', 'magnet', 'quark-status', 'qzone-publish', 'qzone-list', 'qzone-feed', 'qzone-comments', 'qzone-react', 'qzone-like', 'qzone-like-comment', 'image-search', 'image-send'].includes(action)) fail('插件未启用或功能已关闭', 403);
    const socialResult = await socialHub?.handle(action, current.key, body, current.assertAuthorized);
    if (socialResult != null) { current.assertAuthorized(); sendJson({ ok: true, key: current.key, ...socialResult }); return true; }
    sendJson({ ok: false, error: '未知扩展功能' }, 404); return true;
  }
  handle.host = host;
  handle.csCommentaryFor = key => extensionEnabled('esports', getConfig()) && csMemes.liveCommentary(key);
  handle.parseSocialEvents = parseSocialEvents;
  handle.recordSocialEvents = async (key, events, assertAuthorized) => {
    const receipts = [];
    for (const event of events) {
      try {
        assertAuthorized();
        const result = await host.callTool('qq_social_relationship_event', event, { key, assertAuthorized });
        const data = JSON.parse(result.content[0].text);
        receipts.push({ messageId: event.messageId, kind: event.kind,
          status: data.duplicate ? 'duplicate' : data.applied ? 'applied' : 'ignored',
          ...(data.reason ? { reason: data.reason } : {}) });
      } catch (error) {
        receipts.push({ messageId: event.messageId, kind: event.kind, status: 'rejected', reason: String(error.message).slice(0, 180) });
      }
    }
    return receipts;
  };
  handle.contextFor = async key => {
    const st = getConversation(key);
    const recent = st?.unread?.length ? st.unread.slice(-12) : (st?.recentMessages ?? []).slice(-6);
    const seen = new Set(), chunks = [];
    for (const message of [...recent].reverse()) {
      if (message.isSelf || !message.userId || !message.botAccountId || seen.has(String(message.userId))) continue;
      seen.add(String(message.userId));
      const chunk = await host.collectContext({ ...message, attitudeOnly: seen.size > 1,
        query: String(message.plain ?? message.text ?? '').slice(0, 200) }, {
        key, assertAuthorized() { if (!sessionAllowed(key)) fail('记忆会话权限已撤销', 403); }
      });
      if (chunks.join('\n').length + (chunks.length ? 1 : 0) + chunk.length > 1500) break;
      if (chunk) chunks.push(chunk);
      if (seen.size >= 3) break;
    }
    return chunks.join('\n');
  };
  handle.ready = host.ready;
  handle.pollQzone = () => backgroundAllowed() ? qzone.poll() : Promise.resolve();
  handle.close = () => host.close();
  return handle;
}
