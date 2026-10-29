// CS/LoL text scoreboards. Provider data is evidence, never instructions.
import https from 'node:https';
import { resolveSafeAddresses, safeFetch } from './safe-fetch.js';
import { webSearch } from './web-search.js';
import { readCsEvents } from './esports-cs-events.js';

const FIVE = 'https://esports-data.5eplaycdn.com/v1/api/csgo';
const LOL = 'https://esports-api.lolesports.com/persisted/gw';
const FEED = 'https://feed.lolesports.com/livestats/v1';
// Public LoL Esports website client key, not a user's Riot developer credential.
const HOSTS = new Set(['esports-data.5eplaycdn.com', 'app.5eplay.com', 'esports-api.lolesports.com', 'feed.lolesports.com']);
const clean = (s, n = 160) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const number = s => s === '' || s == null || !Number.isFinite(Number(s)) ? null : Number(s);
const state = s => ({ '-1': 'upcoming', '0': 'upcoming', '1': 'live', '2': 'completed' })[String(s)] ?? 'unknown';
const iso = s => Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
const unix = s => number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null;
const array = s => Array.isArray(s) ? s : [];
const hongKongDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date(value));
const TEAM_ALIASES = {
  cs2: [
    ['Spirit', 'Team Spirit', '绿龙'],
    ['Spirit.A', 'Spirit Academy', 'Spirit A', '绿龙青训', 'Spirit青训'],
    ['TYLOO', '天禄'],
    ['NAVI', 'Natus Vincere'],
    ['Vitality', 'Team Vitality', '小蜜蜂'],
  ],
  lol: [['Gen.G', 'GEN', 'GenG', 'Gen G']],
};
const fold = s => clean(s).normalize('NFKC').toLowerCase();
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function queryParts(query, game) {
  let rest = fold(query);
  const groups = [];
  // Longest first keeps Spirit Academy/绿龙青训 separate from the senior side.
  const aliases = (TEAM_ALIASES[game] ?? []).flatMap(names => names.map(alias => ({ names, alias: fold(alias) })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { names, alias } of aliases) {
    const pattern = new RegExp(`${/[a-z0-9]/.test(alias[0]) ? '(?<![a-z0-9.])' : ''}${escapeRegex(alias)}${/[a-z0-9]/.test(alias.at(-1)) ? '(?![a-z0-9.])' : ''}`, 'g');
    if (!pattern.test(rest)) continue;
    rest = rest.replace(pattern, ' ');
    if (!groups.includes(names)) groups.push(names);
  }
  const terms = rest.split(/\s+|\bvs\.?\b|对阵|对战|和|对|打/i).filter(Boolean);
  return { groups, terms };
}

// Fixed provider hosts, pinned public DNS, no redirects, no cookies, bounded body
// and total deadline. Private API keys cannot be forwarded to another host.
export async function readEsportsJson(urlString, { headers = {}, signal } = {}) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new Error('电竞数据源地址不受支持');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 12000);
  try {
    const addresses = await Promise.race([resolveSafeAddresses(url.hostname), new Promise((_, reject) => {
      if (controller.signal.aborted) reject(new Error('电竞数据请求已取消'));
      else controller.signal.addEventListener('abort', () => reject(new Error('电竞数据请求超时或取消')), { once: true });
    })]);
    return await new Promise((resolve, reject) => {
      const req = https.get({ hostname: addresses[0], servername: url.hostname, path: url.pathname + url.search,
        signal: controller.signal, headers: { host: url.host, accept: 'application/json', 'user-agent': 'qq-bridge-esports/1.0', ...headers } }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(new Error('电竞数据响应过大')); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode === 204) { resolve(null); return; }
          if (res.statusCode !== 200) { reject(new Error(`电竞数据源 HTTP ${res.statusCode}`)); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('电竞数据源未返回有效 JSON')); }
        });
      });
      req.on('error', () => reject(new Error(controller.signal.aborted ? '电竞数据请求超时或取消' : '电竞数据源连接失败')));
    });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function csPlayers(rows) {
  return array(rows).slice(0, 10).map(p => ({ id: clean(p.id), name: clean(p.name), kills: number(p.kill), deaths: number(p.death),
    assists: number(p.assist), adr: number(p.adr), kast: clean(p.kast) || null, rating: number(p.rating) }));
}

export function normalizeCsMatch(m, detailed = false) {
  if (!m?.mc_info?.id || !m.mc_info.t1_info || !m.mc_info.t2_info) throw new Error('CS 数据结构不兼容');
  const info = m.mc_info, s = detailed ? m.global_state : m.state;
  if (!s) throw new Error('CS 比赛状态缺失');
  const id = clean(info.id), status = state(s.status);
  const teams = [info.t1_info, info.t2_info].map((t, i) => ({ id: clean(t.id) || null, name: clean(t.disp_name) || 'TBD',
    seriesScore: status === 'upcoming' ? null : number(s[`t${i + 1}_score`]),
    ...(detailed ? { players: csPlayers(s[`t${i + 1}_player_stats`]) } : {}) }));
  const maps = array(detailed ? m.bouts_state : s.bout_states).slice(0, 9).map(b => ({ providerMapNumber: clean(b.bout_num),
    name: clean(b.map_name) || null, status: status === 'completed' && state(b.status) === 'upcoming' ? 'not_played' : state(b.status),
    // t1/t2 stay attached to provider team IDs; never interpret CT/T as team order.
    scores: [1, 2].map(i => state(b.status) === 'upcoming' ? null : number(detailed ? b[`t${i}_stats`]?.all_score : b[`t${i}_score`])),
    ...(detailed ? { players: [csPlayers(b.t1_pr_stats), csPlayers(b.t2_pr_stats)], event: clean(b.event_log?.text, 400) || null,
      currentRound: number(b.curr_round_num), phase: ({ fh: 'first_half', sh: 'second_half', ot: 'overtime' })[b.curr_bout_stage] ?? null,
      sides: [clean(b.t1_stats?.role) || null, clean(b.t2_stats?.role) || null] } : {}) }));
  return { id, game: 'cs2', status, scheduledAt: unix(info.plan_ts), bestOf: number(info.format),
    tournament: clean(m.tt_info?.disp_name), stage: clean(info.tt_stage_desc), teams, maps,
    ...(detailed ? { veto: array(s.bp_map_item).slice(0, 9).map((v, i) => ({ order: i + 1,
      action: ['ban', 'pick', 'left'].includes(v.bp_type) ? v.bp_type : 'unknown', map: clean(v.map_name) || null,
      teamId: clean(info[`${v.team_side}_info`]?.id) || null, team: clean(info[`${v.team_side}_info`]?.disp_name) || null })) } : {}),
    url: `https://event.5eplay.com/csgo/matches/${encodeURIComponent(id)}` };
}

export function normalizeLolMatch(e) {
  const id = e?.match?.id || e?.id;
  if (!id || !Array.isArray(e.match?.teams)) throw new Error('LOL 数据结构不兼容');
  // getEventDetails puts the match identity in event.id, and omits state/date.
  const games = array(e.match.games), wins = e.match.teams.map(t => number(t.result?.gameWins));
  const requiredWins = number(e.match.strategy?.count) > 0 ? Math.floor(Number(e.match.strategy.count) / 2) + 1 : Infinity;
  const inferred = games.some(g => g.state === 'inProgress') ? 'live' : wins.some(n => n >= requiredWins) ? 'completed'
    : games.length && games.every(g => g.state === 'unstarted') ? 'upcoming' : 'unknown';
  return { id: clean(id), game: 'lol', status: ({ inProgress: 'live', completed: 'completed', unstarted: 'upcoming' })[e.state] ?? inferred,
    scheduledAt: iso(e.startTime), tournament: clean(e.league?.name), stage: clean(e.blockName), bestOf: number(e.match.strategy?.count),
    teams: e.match.teams.slice(0, 2).map(t => ({ id: clean(t.id), name: clean(t.name), code: clean(t.code),
      seriesScore: e.state === 'unstarted' ? null : number(t.result?.gameWins), outcome: clean(t.result?.outcome) || null })),
    games: games.slice(0, 9).map(g => ({ id: clean(g.id), number: number(g.number), status: clean(g.state),
      sides: array(g.teams).map(t => ({ teamId: clean(t.id), side: clean(t.side) })) })),
    url: 'https://lolesports.com/en-US/schedule' };
}

export function normalizeLolFrame(data, now = Date.now()) {
  const frames = array(data?.frames).filter(f => iso(f.rfc460Timestamp)).sort((a, b) => Date.parse(a.rfc460Timestamp) - Date.parse(b.rfc460Timestamp));
  const f = frames.at(-1);
  if (!f) return { available: false, note: '没有可用的比赛数据帧；部分赛区不提供实时数据。' };
  const sourceAt = iso(f.rfc460Timestamp), ageSeconds = Math.max(0, Math.round((now - Date.parse(sourceAt)) / 1000));
  const metadata = data.gameMetadata ?? {};
  return { available: true, sourceAt, ageSeconds, stale: ageSeconds > 120, gameState: clean(f.gameState),
    teams: ['blue', 'red'].map(side => {
      const t = f[`${side}Team`] ?? {}, md = metadata[`${side}TeamMetadata`] ?? {};
      return { side, teamId: clean(md.esportsTeamId) || null, kills: number(t.totalKills), gold: number(t.totalGold),
        towers: number(t.towers), barons: number(t.barons), inhibitors: number(t.inhibitors), dragons: array(t.dragons).map(x => clean(x, 40)),
        players: array(t.participants).slice(0, 5).map(p => { const pm = array(md.participantMetadata).find(m => m.participantId === p.participantId) ?? {};
          return { participantId: number(p.participantId), name: clean(pm.summonerName), champion: clean(pm.championId), role: clean(pm.role),
            kills: number(p.kills), deaths: number(p.deaths), assists: number(p.assists), gold: number(p.totalGold), cs: number(p.creepScore), level: number(p.level) };
        }) };
    }), note: '数据源可能晚于直播；蓝红方按 teamId 对齐，不能按赛程左右顺序推断。' };
}

export function detectEsports(text) {
  const t = clean(text, 2000);
  if (/\b(?:CS2?|CSGO|HLTV|IEM|BLAST|NAVI|FaZe|Vitality|MOUZ|G2|Spirit|TYLOO|Falcons|ZywOo|donk|m0NESY)\b|反恐精英|载物|绿龙|天禄|小蜜蜂|蒙古队/i.test(t)) return 'cs2';
  if (/\b(?:LOL|LPL|LCK|LEC|LCS|MSI|T1|GEN|GenG|BLG|TES|WBG|JDG|Faker|Chovy)\b|英雄联盟|世界赛|全球总决赛/i.test(t)) return 'lol';
  return null;
}

function matchesQuery(match, query) {
  const { groups, terms } = queryParts(query, match.game);
  const haystack = fold(`${match.tournament} ${match.teams.map(t => `${t.name} ${t.code ?? ''}`).join(' ')}`);
  return groups.every(names => match.teams.some(t => names.some(n => fold(n) === fold(t.name) || fold(n) === fold(t.code))))
    && terms.every(t => haystack.includes(t));
}

function pageText(body) {
  return clean(String(body).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' '), 6500);
}

function relevantReport(hit, selected, query, game) {
  let url = clean(hit.url, 1500);
  try { url = decodeURIComponent(url); } catch {}
  const text = `${hit.title || ''} ${hit.snippet || ''} ${url}`.normalize('NFKC').toLowerCase();
  const parts = queryParts(query, game);
  const groups = selected ? selected.teams.map(t => (TEAM_ALIASES[game] ?? []).find(names => names.some(n => fold(n) === fold(t.name) || fold(n) === fold(t.code))) || [t.name, t.code].filter(Boolean))
    : [...parts.groups, ...parts.terms.map(t => [t])];
  return groups.length > 0 && groups.every(names => names.some(name => {
    const term = name.normalize('NFKC').toLowerCase();
    if (/^[a-z0-9. -]+$/.test(term)) {
      const academyGuard = game === 'cs2' && names[0] === 'Spirit' ? '(?![\\s._-]*(?:academy|青训)|\\.a\\b)' : '';
      return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(term)}${academyGuard}(?:$|[^a-z0-9])`, 'i').test(text);
    }
    return game === 'cs2' && names[0] === 'Spirit' ? new RegExp(`${escapeRegex(term)}(?!青训)`).test(text) : text.includes(term);
  }));
}

export function createEsportsService({ root = process.cwd(), readJson = readEsportsJson, search = webSearch, fetchPage = safeFetch, now = Date.now } = {}) {
  const cache = new Map();
  async function json(url, options, authorize) {
    authorize();
    const cached = cache.get(url);
    if (cached && now() - cached.at < 15000) return structuredClone(cached.data);
    const data = await readJson(url, options);
    authorize();
    if (options?.signal?.aborted) throw new Error('电竞查询已取消');
    cache.set(url, { at: now(), data });
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return data;
  }
  async function cs(args, options, authorize) {
    if (args.matchId) {
      if (!/^csgo_mc_\d{1,12}$/.test(args.matchId)) throw new Error('CS matchId 应为查询返回的 csgo_mc_数字');
      const raw = await json(`${FIVE}/matches/${args.matchId}/data`, options, authorize);
      if (raw?.success !== true || raw.data?.match?.mc_info?.id !== args.matchId) throw new Error('CS 单场数据不可用或身份不匹配');
      const match = normalizeCsMatch(raw.data.match, true);
      if (args.mode === 'events') {
        if (args.mapNumber != null && !match.maps.some(m => Number(m.providerMapNumber) === args.mapNumber)) throw new Error('mapNumber不属于该场比赛');
        match.eventLog = await readCsEvents(raw.data.match, args, cursor =>
          json(`${FIVE}/match/${args.matchId}/event/log?update_version=${cursor}&limit=100`, options, authorize));
      }
      return { matches: [match], scope: args.mode === 'events' ? '指定比赛有界回合事件快照' : '指定比赛详情' };
    }
    const history = ['results', 'analysis'].includes(args.mode);
    const pagesScanned = [], matches = [], seen = new Set();
    const lastPage = args.autoPages ? 5 : args.page;
    let mayHaveNextPage = false;
    for (let page = args.page; page <= lastPage; page++) {
      const url = `https://app.5eplay.com/api/tournament/session_list?game_status=${history ? 2 : 1}&game_type=1&grades=&page=${page}&limit=20`;
      const raw = await json(url, options, authorize);
      if (raw?.success !== true || !Array.isArray(raw.data?.matches)) throw new Error('CS 比赛列表不可用');
      const all = raw.data.matches.map(m => normalizeCsMatch(m));
      pagesScanned.push(page); mayHaveNextPage = all.length === 20;
      for (const match of all) {
        if (seen.has(match.id) || !matchesQuery(match, args.query) || (args.mode === 'live' && match.status !== 'live')
          || (history && match.status !== 'completed') || (args.date && (!match.scheduledAt || hongKongDate(match.scheduledAt) !== args.date))) continue;
        seen.add(match.id); matches.push(match);
      }
      // A targeted matchup stops once found. A date-only listing covers the
      // bounded window until the provider page is wholly older than that day.
      if (!mayHaveNextPage || (args.query && matches.length) || (args.date && all.length && all.every(m => m.scheduledAt && hongKongDate(m.scheduledAt) < args.date))) break;
    }
    return { matches, pagesScanned, scope: `5E列表第${pagesScanned.join('、')}页，每页最多20场；不是所有历史比赛`, mayHaveNextPage,
      note: '队名和日期查询未指定page时自动检索最多5页；一队与青训按独立队名匹配。空结果仅表示此范围未找到，不能断言比赛不存在。' };
  }
  async function lol(args, options, authorize) {
    // Keys only go to the fixed Riot gateway, never to feed URLs or redirects.
    const apiKey = process.env[options.lolApiKeyEnv || 'LOLESPORTS_WEB_API_KEY'];
    if (!apiKey) throw new Error('LOL 赛事查询需要配置 API 密钥环境变量');
    const headers = { 'x-api-key': apiKey };
    if (args.matchId && !/^\d{6,24}$/.test(args.matchId)) throw new Error('LOL matchId 应为查询返回的数字ID');
    const endpoint = args.matchId ? `getEventDetails?hl=en-US&id=${args.matchId}` : `${args.mode === 'live' ? 'getLive' : 'getSchedule'}?hl=en-US`;
    // Credential changes must not reuse a result fetched under an older key.
    const raw = await readJson(`${LOL}/${endpoint}`, { headers, signal: options.signal }); authorize();
    let event = raw?.data?.event;
    if (args.matchId && String(event?.id || event?.match?.id) !== args.matchId) throw new Error('LOL 单场数据身份不匹配');
    if (args.matchId) {
      // Only enrich with a schedule row with the same ID; details remain usable
      // when an older match has fallen outside the current schedule window.
      try {
        const schedule = await json(`${LOL}/getSchedule?hl=en-US`, { headers, signal: options.signal }, authorize);
        const row = array(schedule?.data?.schedule?.events).find(e => String(e.match?.id) === args.matchId);
        if (row) event = { ...row, ...event, match: { ...row.match, ...event.match, id: args.matchId } };
      } catch { authorize(); }
    }
    const events = args.matchId ? [event] : raw?.data?.schedule?.events;
    if (!Array.isArray(events)) throw new Error('LOL 比赛列表不可用');
    const matches = events.filter(e => e.type !== 'show' && e.match).map(normalizeLolMatch).filter(m => matchesQuery(m, args.query)
      && (args.mode !== 'live' || m.status === 'live') && (args.mode !== 'schedule' || m.status !== 'completed')
      && (!['results', 'analysis'].includes(args.mode) || m.status === 'completed'));
    if (['results', 'analysis'].includes(args.mode)) matches.sort((a, b) => (Date.parse(b.scheduledAt) || 0) - (Date.parse(a.scheduledAt) || 0));
    if (args.matchId && matches[0]) {
      const live = matches[0].games.find(g => g.status === 'inProgress');
      const selected = args.gameId || live?.id;
      if (args.gameId && !matches[0].games.some(g => g.id === args.gameId)) throw new Error('gameId 不属于该场 LOL 比赛');
      if (selected) {
        try {
          const data = await json(`${FEED}/window/${selected}`, { signal: options.signal }, authorize);
          matches[0].liveStats = normalizeLolFrame(data, now());
        } catch { authorize(); matches[0].liveStats = { available: false, note: '该小局数据帧不可用，不等于没有比赛。' }; }
      }
    }
    return { matches, scope: args.matchId ? '指定比赛详情' : 'LoL Esports当前赛程窗口，可能未覆盖所有赛区或历史比赛',
      note: '列表大比分是系列赛胜场数；实时击杀、经济、推塔需用matchId读取详情。没有数据帧时不能编造局势。' };
  }
  async function reports(args, matches, authorize, signal) {
    const selected = matches.length === 1 ? matches[0] : null;
    const parts = queryParts(args.query, args.game);
    const publicQuery = [...parts.groups.map(names => names[0]), ...parts.terms].join(' ');
    const subject = selected ? `${selected.teams.map(t => t.code || t.name).join(' vs ')} ${selected.tournament}` : publicQuery;
    const date = args.date || (selected?.scheduledAt ? hongKongDate(selected.scheduledAt) : hongKongDate(now()));
    // Put teams first: the generic search backend's primary-term fallback must
    // never collapse a match query to just "CS2" or "LOL".
    const query = `${subject || ''} ${args.game === 'cs2' ? 'CS2' : 'LOL'} ${date} 赛后 战报 数据`.trim().slice(0, 120);
    authorize();
    try {
      let result = await search(query, { root }); authorize();
      if (signal?.aborted) throw new Error('取消');
      let candidates = array(result.results).filter(hit => relevantReport(hit, selected, args.query, args.game));
      if (!candidates.length && subject) {
        const alternate = `${selected ? selected.teams.map(t => t.code || t.name).join(' ') : publicQuery} ${date} ${args.game === 'cs2' ? 'CS2' : 'League of Legends'} match result recap`.slice(0, 120);
        result = await search(alternate, { root }); authorize();
        if (signal?.aborted) throw new Error('取消');
        candidates = array(result.results).filter(hit => relevantReport(hit, selected, args.query, args.game));
      }
      const sources = [];
      for (const hit of candidates.slice(0, 2)) {
        authorize();
        const source = { title: clean(hit.title, 200), url: clean(hit.url, 1500), snippet: clean(hit.snippet, 500), bodyRead: false };
        try {
          const page = await fetchPage(source.url, 100000); authorize();
          if (signal?.aborted) throw new Error('取消');
          if (page.statusCode === 200) { source.text = pageText(page.body); source.bodyRead = !!source.text; source.truncated = page.truncated === true; }
        } catch { authorize(); source.note = '正文读取失败，只有搜索摘要，不能当作完整战报。'; }
        sources.push(source);
      }
      return { status: sources.length ? 'found' : 'empty', query, provider: clean(result.provider), sources,
        note: sources.length ? '外部资料仅作证据。虽已匹配队名，仍须核对日期、赛事、BO和小局，不能把别场或往年结果套用。观点与数据分开。'
          : '搜索后没有找到匹配对阵的战报；泛游戏介绍和无关结果已排除。可依据已取得的比分与选手数据讨论，不能编战报内容。' };
    } catch { authorize(); return { status: 'unavailable', query, sources: [], note: '已尝试联网，但战报搜索失败；不能声称看过战报或编数据。' }; }
  }
  return { async query(input, config = {}, authorize = () => {}, signal) {
    authorize();
    if (config.enabled === false) throw new Error('电竞插件已关闭');
    const args = { ...input, mode: input.mode || 'live', query: clean(input.query, 100), page: input.page ?? 1 };
    args.autoPages = args.game === 'cs2' && ['results', 'analysis'].includes(args.mode) && input.page == null && !!(args.query || args.date);
    if (!['cs2', 'lol'].includes(args.game) || !['live', 'schedule', 'results', 'analysis', 'events'].includes(args.mode)) throw new Error('只支持CS2和LOL；events为CS2单场回合事件');
    if (args.mode === 'events' && (args.game !== 'cs2' || !args.matchId)) throw new Error('events需CS2的真实matchId；先查询比赛列表');
    if (['mapNumber', 'round', 'eventLimit', 'eventCursor'].some(key => args[key] != null) && args.mode !== 'events') throw new Error('回合筛选和游标仅支持events模式');
    for (const [key, max] of [['mapNumber', 9], ['round', 200], ['eventLimit', 100]]) {
      if (args[key] != null && (!Number.isInteger(args[key]) || args[key] < 1 || args[key] > max)) throw new Error(`${key}应为1到${max}`);
    }
    if (args.round != null && args.mapNumber == null) throw new Error('查询指定回合须同时提供mapNumber');
    if (args.eventCursor != null && !/^\d{1,30}$/.test(args.eventCursor)) throw new Error('eventCursor应为上次返回的数字游标');
    if (!Number.isInteger(args.page) || args.page < 1 || args.page > 5) throw new Error('page应为1到5');
    if (args.game === 'lol' && args.page !== 1) throw new Error('LOL当前只支持当前赛程窗口，请用matchId定位历史比赛');
    if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('date应为YYYY-MM-DD');
    if (args.gameId && (args.game !== 'lol' || !args.matchId || !/^\d{6,24}$/.test(args.gameId))) throw new Error('gameId需要同时提供LOL matchId');
    let data;
    try { data = await (args.game === 'cs2' ? cs : lol)(args, { lolApiKeyEnv: config.lolApiKeyEnv, signal }, authorize); }
    catch (e) { authorize(); data = { matches: [], status: 'unavailable', note: clean(e.message, 180) }; }
    authorize();
    if (signal?.aborted) throw new Error('电竞查询已取消');
    if (args.date) data.matches = data.matches.filter(m => m.scheduledAt && hongKongDate(m.scheduledAt) === args.date);
    data.totalMatchedInPage = data.matches.length;
    const limit = args.game === 'cs2' ? 20 : 8;
    data.truncated = data.matches.length > limit;
    data.matches = data.matches.slice(0, limit);
    const report = args.mode === 'analysis' ? await reports(args, data.matches, authorize, signal) : undefined;
    authorize();
    if (signal?.aborted) throw new Error('电竞查询已取消');
    return { ...data, ok: data.status !== 'unavailable', game: args.game, mode: args.mode, fetchedAt: new Date(now()).toISOString(),
      status: data.status || (data.matches.length ? 'available' : 'no_matches_in_scope'), provider: args.game === 'cs2' ? '5eplay' : 'lolesports',
      cacheSeconds: 15, ...(report ? { report } : {}),
      capabilities: { csRoundEvents: args.game === 'cs2' ? 'events+matchId' : 'not_implemented', continuousSubscription: false,
        measuredLiveLatencySeconds: null },
      evidenceRule: '仅获取文字比分和数据，未观看直播。fetchedAt是查询时间，不是数据源更新时间；15秒缓存不是直播延迟。未实测连续直播延迟，不能宣称十几秒到一分钟或保证实时。CS选图读详情veto，谁杀了谁先用events+matchId并核对map/round；事件缺失不可从总击杀反推，不能把窗口当完整回放。未建订阅不能承诺晚上自动跟进。空列表只表示当前窗口未找到，数据不足要说明。' };
  } };
}
