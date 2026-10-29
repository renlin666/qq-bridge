// 5E event-page protocol reference: ekmanss/sports-data-collectors (MIT).
// Independent bounded reader; only explicit round boundaries admit gameplay.
const list = value => Array.isArray(value) ? value : [];
const text = (value, max = 100) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const integer = value => /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const playerId = value => /^csgo_pl_\d+$/.test(String(value)) ? String(value) : /^\d+$/.test(String(value)) ? 'csgo_pl_' + value : null;
const mapName = value => text(value).toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, '');
const compare = (a, b) => BigInt(a.update_version) < BigInt(b.update_version) ? -1 : BigInt(a.update_version) > BigInt(b.update_version) ? 1 : 0;
const types = { '1': 'round_start', '2': 'round_end', '6': 'bomb_planted', '8': 'kill' };

export function normalizeCsEvents(rows, match, { mapNumber, round } = {}) {
  const maps = list(match.bouts_state), players = new Map();
  for (const [side, team] of ['t1', 't2'].map(side => [side, match.mc_info[side + '_info']])) {
    for (const p of list(match.global_state?.[side + '_player_stats'])) players.set(p.id, { id: p.id, name: text(p.name), teamId: text(team.id) });
    for (const m of maps) for (const p of list(m[side + '_pr_stats'])) players.set(p.id, { id: p.id, name: text(p.name), teamId: text(team.id) });
  }
  const seen = new Map(), accepted = [], gaps = new Set(); let excluded = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') { gaps.add('identity_or_schema_mismatch'); continue; }
    const map = maps.find(m => String(m.bout_num) === String(row.bout_num));
    if (row.match_id !== match.mc_info.id || row.bout_id !== `${match.mc_info.id}_${row.bout_num}`
        || !map || mapName(row.map_name) !== mapName(map.map_name)
        || (match.tt_info?.id && row.tt_id !== match.tt_info.id) || !/^\d{1,30}$/.test(String(row.update_version))) {
      gaps.add('identity_or_schema_mismatch'); continue;
    }
    if (!['1', '2'].includes(String(map.status))) { excluded++; continue; }
    if (mapNumber != null && Number(row.bout_num) !== mapNumber) continue;
    const key = row.bout_id + ':' + row.update_version;
    if (seen.has(key)) { if (seen.get(key) !== row.log_info) { seen.set(key, null); gaps.add('conflicting_event_version'); } continue; }
    seen.set(key, row.log_info); accepted.push(row);
  }
  accepted.sort(compare);
  const current = new Map(), rounds = [], eventIds = new Set(), roundIds = new Map();
  for (const row of accepted) {
    if (seen.get(row.bout_id + ':' + row.update_version) === null) continue;
    let info; try { info = JSON.parse(row.log_info); } catch { gaps.add('invalid_event_json'); continue; }
    const type = types[String(info?.type)];
    if (!type) continue; // Join/quit and undocumented codes are not gameplay.
    const detail = info[type] ?? {};
    const slot = String(row.bout_num);
    const base = { providerVersion: String(row.update_version), providerMapNumber: slot, map: text(row.map_name), type };
    if (type === 'round_start') {
      const number = integer(detail.round_num);
      const mapRound = integer(maps.find(m => String(m.bout_num) === slot)?.curr_round_num);
      if (!number || number > 200 || (mapRound && number > mapRound) || (detail.bout_num && String(detail.bout_num) !== slot) || (detail.map && mapName(detail.map) !== mapName(row.map_name))) {
        current.delete(slot); gaps.add('invalid_round_boundary'); continue;
      }
      const map = maps.find(m => String(m.bout_num) === slot);
      const group = { slot, round: number, events: [{ ...base, round: number }], victims: new Set(), kills: 0, invalid: false, ended: false,
        needsEnd: !(Number(map.start_time) > 0) };
      const roundId = slot + ':' + number;
      if (roundIds.has(roundId)) { roundIds.get(roundId).invalid = true; group.invalid = true; gaps.add('non_official_or_restarted_round'); }
      roundIds.set(roundId, group);
      current.set(slot, group); rounds.push(group); continue;
    }
    const group = current.get(slot);
    if (!group || group.ended) { excluded++; continue; }
    const event = { ...base, round: group.round };
    if (type === 'kill') {
      const killer = players.get(playerId(detail.killer_id)), victim = players.get(playerId(detail.victim_id));
      if (!killer || !victim || killer.id === victim.id) { group.invalid = true; gaps.add('unresolved_player_identity'); continue; }
      const id = text(detail.event_id);
      if (id && eventIds.has(slot + ':' + id)) continue;
      if (id) eventIds.add(slot + ':' + id);
      if (group.victims.has(victim.id) || ++group.kills > 10) { group.invalid = true; gaps.add('non_official_or_restarted_round'); }
      group.victims.add(victim.id);
      Object.assign(event, { killer, victim, weapon: text(detail.weapon) || null,
        headshot: typeof detail.head_shot === 'boolean' ? detail.head_shot : null,
        assister: id && String(info.assist?.kill_event_id) === id ? text(info.assist?.assister_nick) || null : null });
    } else if (type === 'round_end') {
      const ct = integer(detail.ct_score), t = integer(detail.t_score);
      if (ct === null || t === null || ct + t !== group.round) { group.invalid = true; gaps.add('round_score_mismatch'); }
      Object.assign(event, { winnerSide: ['CT', 'T'].includes(detail.winner) ? detail.winner : null,
        sideScores: { CT: ct, T: t }, reason: text(detail.win_type) || null });
      group.ended = true;
    } else {
      Object.assign(event, { player: text(detail.player_nick) || text(detail.player_name) || null,
        ...(type === 'bomb_planted' ? { site: text(detail.bomb_site) || null } : {}) });
    }
    group.events.push(event);
  }
  const verified = rounds.filter(g => !g.invalid && (!g.needsEnd || g.ended) && (round == null || g.round === round));
  const events = verified.flatMap(g => g.events);
  return { events, excluded, gaps: [...gaps], hasRoundStart: verified.length > 0,
    completedRoundsOnly: maps.some(m => ['1', '2'].includes(String(m.status)) && !(Number(m.start_time) > 0)),
    note: '仅输出已开地图中有明确回合开始记录且通过身份/计数检查的事件。地图开始时间缺失时，还须有比分与回合号一致的回合结束记录，仅返回已结束回合；当前未结算回合暂不输出。未绑定回合、未开图和可疑热身/重赛记录已排除，不保证数据源无漏报或修订。' };
}

export async function readCsEvents(match, args, readPage) {
  const rows = []; let cursor = args.eventCursor || '0', nextCursor = null, sourceWindowExhausted = false, failure = null, pages = 0;
  const visited = new Set();
  const pageLimit = args.maxEventPages === 1 ? 1 : 3;
  while (pages < pageLimit && !visited.has(cursor)) {
    visited.add(cursor);
    let reply;
    try { reply = await readPage(cursor); }
    catch { failure = '事件数据源不可用，不能从选手总击杀反推击杀顺序。'; break; }
    if (reply?.success !== true || !Array.isArray(reply.data?.list)) { failure = '事件响应结构不可用。'; break; }
    pages++;
    const page = reply.data.list;
    if (page.length > 100) { failure = '事件页超过请求范围。'; break; }
    rows.push(...page);
    const tail = page.at(-1)?.update_version;
    nextCursor = /^\d{1,30}$/.test(String(tail)) ? String(tail) : null;
    if (page.length < 100) { sourceWindowExhausted = true; nextCursor = null; break; }
    if (!nextCursor || (cursor !== '0' && BigInt(nextCursor) >= BigInt(cursor))) { failure = '事件游标没有向更早记录前进。'; nextCursor = null; break; }
    // Recent mode needs enough context to bind its newest events to rounds.
    const parsed = normalizeCsEvents(rows, match, args);
    if (parsed.hasRoundStart && (args.round != null || (args.mapNumber == null && parsed.events.length >= (args.eventLimit ?? 60)))) break;
    cursor = nextCursor;
  }
  const normalized = normalizeCsEvents(rows, match, args);
  const limit = args.eventLimit ?? 60, events = normalized.events.slice(-limit);
  return { ...normalized, events, status: failure || normalized.gaps.length ? (events.length ? 'partial' : 'unavailable') : events.length ? 'available' : 'no_verified_events_in_window',
    pagesScanned: pages, rowsScanned: rows.length, sourceWindowExhausted, completeHistory: false,
    outputTruncated: normalized.events.length > limit, nextCursor, ...(failure ? { error: failure } : {}),
    sourceUpdatedAt: null, latencySeconds: null,
    coverage: `最近事件的有界快照，最多${pageLimit}页各100条；不是全场完整回放，不保证连续更新或固定直播延迟。eventCursor用于查询更早页；页间可能变化。` };
}
