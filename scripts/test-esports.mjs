import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEsportsService, detectEsports, normalizeCsMatch, normalizeLolFrame, normalizeLolMatch, readEsportsJson } from '../src/esports.js';
import { createPluginHost } from '../src/plugin-host/index.js';
import { BUILTIN_IDS, catalogFromDisk, extensionEnabled } from '../src/plugin-host/catalog.js';
import { toolCategory } from '../plugins/qq-agent-presets/qq-tool-discovery.mjs';
import { normalizeCsEvents, readCsEvents } from '../src/esports-cs-events.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
process.env.LOLESPORTS_WEB_API_KEY = 'test-only-key';
const NOW = Date.parse('2026-10-26T01:00:00Z');
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/esports/spirit-tyloo-events.json', import.meta.url), 'utf8'));

test('real historical round 16 exposes exact kills, veto ownership and round outcome', () => {
  const { events, gaps } = normalizeCsEvents(captured.events, captured.match, { mapNumber: 2, round: 16 });
  assert.deepEqual(gaps, []);
  assert.deepEqual(events.filter(e => e.type === 'kill').map(e => [e.killer.name, e.victim.name]), [
    ['donk', 'Moseyuh'], ['Jee', 'sh1ro'], ['magixx', 'JamYoung'], ['donk', 'Jee'],
    ['tN1R', 'Mercury'], ['Zero', 'donk'], ['Zero', 'tN1R'], ['magixx', 'Zero']
  ]);
  assert.equal(events.find(e => e.killer?.name === 'Jee').weapon, 'awp');
  assert.deepEqual(events.at(-1).sideScores, { CT: 3, T: 13 });
  const detail = normalizeCsMatch(captured.match, true);
  assert.equal(detail.veto.length, 7);
  assert.deepEqual(detail.veto.filter(v => v.action === 'pick').map(v => [v.team, v.map]), [['TYLOO', 'Mirage'], ['Spirit', 'Anubis']]);
  assert.equal(detail.maps[1].currentRound, 16);
});

test('foreign match/map/tournament logs are isolated and never assigned to the target round', () => {
  const kill = captured.events.find(r => JSON.parse(r.log_info).type === '8');
  for (const change of [{ match_id: 'csgo_mc_1' }, { bout_id: 'wrong' }, { map_name: 'Nuke' }, { tt_id: 'wrong' }]) {
    const r = normalizeCsEvents([...captured.events, { ...kill, ...change }], captured.match);
    assert.ok(r.gaps.includes('identity_or_schema_mismatch'));
    assert.equal(r.events.filter(e => e.type === 'kill').length, 8);
  }
});

test('unopened maps and kills without explicit round boundaries cannot become official kills', () => {
  const raw = structuredClone(captured.match); raw.bouts_state[1].status = '-1';
  assert.equal(normalizeCsEvents(captured.events, raw).events.length, 0);
  const kills = captured.events.filter(r => JSON.parse(r.log_info).type === '8');
  assert.equal(normalizeCsEvents(kills, captured.match).events.length, 0);
});

test('live maps with missing start_time admit coherent completed rounds, withholding an unfinished round', () => {
  const raw = structuredClone(captured.match); raw.bouts_state[1].status = '1'; raw.bouts_state[1].start_time = '';
  const complete = normalizeCsEvents(captured.events, raw, { mapNumber: 2, round: 16 });
  assert.equal(complete.completedRoundsOnly, true); assert.equal(complete.events.filter(e => e.type === 'kill').length, 8);
  const unfinished = captured.events.filter(row => JSON.parse(row.log_info).type !== '2');
  assert.equal(normalizeCsEvents(unfinished, raw).events.length, 0);
  raw.bouts_state[1].status = '-1'; assert.equal(normalizeCsEvents(captured.events, raw).events.length, 0);
});

test('duplicate versions deduplicate, while repeated victims suppress a suspicious round', () => {
  assert.equal(normalizeCsEvents([...captured.events, ...captured.events], captured.match).events.filter(e => e.type === 'kill').length, 8);
  const kill = structuredClone(captured.events.find(r => JSON.parse(r.log_info).type === '8'));
  kill.update_version = String(BigInt(kill.update_version) + 1n);
  const info = JSON.parse(kill.log_info); info.kill.event_id = 'other'; kill.log_info = JSON.stringify(info);
  const r = normalizeCsEvents([...captured.events, kill], captured.match);
  assert.ok(r.gaps.includes('non_official_or_restarted_round')); assert.equal(r.events.length, 0);
});

test('round score mismatch and unresolved player IDs cannot manufacture a valid round', () => {
  for (const mutate of [info => { if (info.type === '2') info.round_end.ct_score = '1'; },
    info => { if (info.type === '8') info.kill.killer_id = '999999999'; }]) {
    const rows = captured.events.map(r => { const info = JSON.parse(r.log_info); mutate(info); return { ...r, log_info: JSON.stringify(info) }; });
    const result = normalizeCsEvents(rows, captured.match); assert.equal(result.events.length, 0); assert.ok(result.gaps.length);
  }
});

test('a repeated round-start suppresses both incarnations until the provider resolves a restart', () => {
  const first = captured.events.find(r => JSON.parse(r.log_info).type === '1');
  const duplicate = { ...first, update_version: String(BigInt(first.update_version) + 1n) };
  const result = normalizeCsEvents([...captured.events, duplicate], captured.match);
  assert.equal(result.events.length, 0); assert.ok(result.gaps.includes('non_official_or_restarted_round'));
});

test('events query uses the real match ID, discloses bounds, and keeps latency unmeasured', async () => {
  const urls = [];
  const service = createEsportsService({ readJson: async url => { urls.push(url); return url.includes('/event/log?')
    ? { success: true, data: { list: captured.events } } : { success: true, data: { match: captured.match } }; } });
  const r = await service.query({ game: 'cs2', mode: 'events', matchId: captured.match.mc_info.id, mapNumber: 2, round: 16 });
  assert.equal(r.matches[0].eventLog.events.filter(e => e.type === 'kill').length, 8);
  assert.equal(r.matches[0].eventLog.completeHistory, false);
  assert.equal(r.capabilities.measuredLiveLatencySeconds, null); assert.equal(r.capabilities.continuousSubscription, false);
  assert.match(urls[1], /\/event\/log\?update_version=0&limit=100$/);
  assert.match(r.evidenceRule, /缓存不是直播延迟/);
});

test('event page failures preserve the scoreboard and explicitly mark unavailable logs', async () => {
  const service = createEsportsService({ readJson: async url => {
    if (url.includes('/event/log?')) throw new Error('503');
    return { success: true, data: { match: captured.match } };
  } });
  const r = await service.query({ game: 'cs2', mode: 'events', matchId: captured.match.mc_info.id });
  assert.equal(r.status, 'available'); assert.equal(r.matches[0].eventLog.status, 'unavailable');
  assert.deepEqual(r.matches[0].teams.map(t => t.seriesScore), [2, 0]);
});

test('event pagination ignores unreliable not_more and deduplicates overlapping pages', async () => {
  const newest = captured.events.at(-1);
  const filler = Array.from({ length: 100 }, (_, i) => ({ ...newest, update_version: String(BigInt(newest.update_version) + BigInt(i + 1)), log_info: '{"type":"4"}' })).reverse();
  const cursors = [];
  const r = await readCsEvents(captured.match, { mapNumber: 2, round: 16 }, async cursor => {
    cursors.push(cursor); return { success: true, data: { not_more: '1', list: cursor === '0' ? filler : captured.events } };
  });
  assert.equal(cursors.length, 2); assert.equal(r.events.filter(e => e.type === 'kill').length, 8);
});

test('events arguments reject unsupported games, invented map slots and unbounded cursors', async () => {
  const service = createEsportsService({ readJson: async () => ({ success: true, data: { match: captured.match } }) });
  for (const args of [{ game: 'lol', mode: 'events', matchId: '123456789' }, { game: 'cs2', mode: 'events' },
    { game: 'cs2', mode: 'events', matchId: captured.match.mc_info.id, round: 1 },
    { game: 'cs2', mode: 'events', matchId: captured.match.mc_info.id, eventCursor: '../local' }]) await assert.rejects(service.query(args));
  const result = await service.query({ game: 'cs2', mode: 'events', matchId: captured.match.mc_info.id, mapNumber: 9 });
  assert.equal(result.status, 'unavailable');
});
const cs = (status = '1') => ({ mc_info: { id: 'csgo_mc_1234567', format: '3', plan_ts: String((NOW - 3600000) / 1000),
  t1_info: { id: 'team1', disp_name: 'NAVI' }, t2_info: { id: 'team2', disp_name: 'G2' } }, tt_info: { disp_name: 'Test Cup' },
  state: { status, t1_score: '1', t2_score: '0', bout_states: [{ bout_num: '1', map_name: 'Nuke', status: '2', t1_score: '13', t2_score: '9' }] } });
const event = (state = 'inProgress') => ({ startTime: '2026-10-25T20:00:00Z', state, type: 'match', league: { name: 'Worlds' },
  match: { id: '123456789123456789', strategy: { count: 3 }, teams: [{ id: '111', name: 'T1', code: 'T1', result: { gameWins: 1 } },
    { id: '222', name: 'Gen.G', code: 'GEN', result: { gameWins: 0 } }],
  games: [{ id: '223456789123456789', number: 2, state: 'inProgress', teams: [{ id: '222', side: 'blue' }, { id: '111', side: 'red' }] }] } });

function spiritHistory() {
  const row = (index, left, right) => {
    const m = cs('2'); m.mc_info.id = `csgo_mc_${2399700 + index}`;
    m.mc_info.plan_ts = String(Date.parse('2026-10-25T08:00:00Z') / 1000);
    m.mc_info.t1_info.disp_name = left; m.mc_info.t2_info.disp_name = right;
    return m;
  };
  const first = Array.from({ length: 20 }, (_, i) => row(i, 'Other' + i, 'Opponent' + i));
  first[0] = row(0, 'Spirit.A', 'CCT opponent');
  const second = Array.from({ length: 20 }, (_, i) => row(i + 100, 'Team' + i, 'Rival' + i));
  second[8] = row(27, 'Spirit', 'TYLOO'); second[8].state.t1_score = '2';
  second[8].state.bout_states = [{ bout_num: '1', map_name: 'Mirage', status: '2', t1_score: '13', t2_score: '5' },
    { bout_num: '2', map_name: 'Anubis', status: '2', t1_score: '13', t2_score: '3' }];
  return { first, second };
}

test('regression: Spirit vs TYLOO yesterday is automatically found at page 2 row 9', async () => {
  const { first, second } = spiritHistory(), pages = [];
  const service = createEsportsService({ now: () => NOW, readJson: async url => {
    const page = Number(new URL(url).searchParams.get('page')); pages.push(page);
    return { success: true, data: { matches: page === 1 ? first : page === 2 ? second : [] } };
  } });
  const result = await service.query({ game: 'cs2', mode: 'results', query: 'Spirit vs TYLOO', date: '2026-10-25' });
  assert.equal(result.status, 'available'); assert.equal(result.matches[0].id, 'csgo_mc_2399727');
  assert.deepEqual(result.matches[0].maps.map(m => m.scores), [[13, 5], [13, 3]]);
  assert.deepEqual(pages, [1, 2]); assert.deepEqual(result.pagesScanned, [1, 2]);
});

test('explicit CS list pages expose every row; row 9 cannot disappear between pages', async () => {
  const { second } = spiritHistory();
  const service = createEsportsService({ readJson: async () => ({ success: true, data: { matches: second } }) });
  const result = await service.query({ game: 'cs2', mode: 'results', page: 2 });
  assert.equal(result.matches.length, 20); assert.ok(result.matches.some(m => m.id === 'csgo_mc_2399727'));
  assert.equal(result.truncated, false);
});

test('CS main team, academy and Chinese aliases resolve to separate identities', async () => {
  const { first, second } = spiritHistory();
  for (const query of ['Spirit', 'Team Spirit', '绿龙', '绿龙和天禄', 'Spirit vs 天禄', '天禄']) {
    const service = createEsportsService({ readJson: async url => ({ success: true, data: {
      matches: new URL(url).searchParams.get('page') === '1' ? first : second } }) });
    const result = await service.query({ game: 'cs2', mode: 'results', query, date: '2026-10-25' });
    assert.equal(result.matches[0]?.id, 'csgo_mc_2399727', query);
    assert.ok(!result.matches.some(m => m.teams.some(t => t.name === 'Spirit.A')));
  }
  const service = createEsportsService({ readJson: async () => ({ success: true, data: { matches: first } }) });
  const academy = await service.query({ game: 'cs2', mode: 'results', query: 'Spirit Academy' });
  assert.equal(academy.matches[0].teams[0].name, 'Spirit.A');
});

test('date filtering applies before targeted pagination can stop on a wrong-day match', async () => {
  const { first, second } = spiritHistory();
  first[0] = structuredClone(second[8]); first[0].mc_info.plan_ts = String(NOW / 1000);
  const service = createEsportsService({ readJson: async url => ({ success: true, data: { matches:
    new URL(url).searchParams.get('page') === '1' ? first : second } }) });
  const result = await service.query({ game: 'cs2', mode: 'results', query: 'Spirit TYLOO', date: '2026-10-25' });
  assert.equal(result.matches[0].scheduledAt, '2026-10-25T08:00:00.000Z');
});

test('a later source-page failure is unavailable, rather than proof of no historical match', async () => {
  const { first } = spiritHistory();
  const service = createEsportsService({ readJson: async url => {
    if (new URL(url).searchParams.get('page') === '2') throw new Error('电竞数据源 HTTP 503');
    return { success: true, data: { matches: first } };
  } });
  const result = await service.query({ game: 'cs2', mode: 'results', query: 'Spirit TYLOO', date: '2026-10-25' });
  assert.equal(result.status, 'unavailable');
});

test('senior Spirit report filtering excludes Spirit Academy and uses canonical public aliases', async () => {
  const { second } = spiritHistory(), searches = [];
  const service = createEsportsService({ now: () => NOW,
    readJson: async () => ({ success: true, data: { matches: second } }),
    search: async query => { searches.push(query); return { results: [{ title: 'Spirit Academy vs TYLOO', url: 'https://example.com/spirit-academy-tyloo' }] }; },
    fetchPage: async () => { throw new Error('academy report must not be read'); } });
  const result = await service.query({ game: 'cs2', mode: 'analysis', query: '绿龙和天禄', date: '2026-10-25' });
  assert.equal(result.matches[0].id, 'csgo_mc_2399727'); assert.equal(result.report.status, 'empty');
  assert.ok(searches.every(q => q.includes('Spirit') && q.includes('TYLOO') && !q.includes('绿龙')));
});

test('CS normalizes series/map scores, unavailable stats and unplayed decider without inventing zeros', () => {
  const raw = cs('2');
  raw.global_state = { ...raw.state, t1_player_stats: [{ id: 'p1', name: 'Player', kill: '23', death: '14', adr: '', rating: '1.3' }] };
  raw.bouts_state = [{ bout_num: '3', map_name: 'Ancient', status: '-1', t1_stats: {}, t2_stats: {} }];
  const match = normalizeCsMatch(raw, true);
  assert.deepEqual(match.teams.map(t => t.seriesScore), [1, 0]);
  assert.equal(match.teams[0].players[0].kills, 23); assert.equal(match.teams[0].players[0].adr, null);
  assert.equal(match.maps[0].status, 'not_played'); assert.deepEqual(match.maps[0].scores, [null, null]);
  assert.equal(normalizeCsMatch(cs('0')).teams[0].seriesScore, null);
  assert.equal(normalizeCsMatch(cs('99')).status, 'unknown');
});

test('CS live excludes upcoming/finished rows and preserves limited-window semantics', async () => {
  let calls = 0, clock = NOW;
  const service = createEsportsService({ now: () => clock, readJson: async () => { calls++; return { success: true, data: { matches: [cs('1'), cs('0'), cs('2')] } }; } });
  const r = await service.query({ game: 'cs2', mode: 'live' });
  assert.equal(r.matches.length, 1); assert.equal(r.matches[0].status, 'live'); assert.match(r.scope, /第1页/);
  await service.query({ game: 'cs2', mode: 'live' }); assert.equal(calls, 1);
  clock += 16000; await service.query({ game: 'cs2', mode: 'live' }); assert.equal(calls, 2);
  const empty = await service.query({ game: 'cs2', query: 'Falcons' });
  assert.equal(empty.status, 'no_matches_in_scope'); assert.equal(empty.ok, true);
});

test('CS detail checks identity and exposes current map, event and player statistics', async () => {
  const raw = cs(); raw.global_state = raw.state;
  raw.bouts_state = [{ bout_num: '2', map_name: 'Mirage', status: '1', t1_stats: { all_score: '8' }, t2_stats: { all_score: '7' }, event_log: { text: '第16回合开始' } }];
  const s = createEsportsService({ readJson: async () => ({ success: true, data: { match: raw } }) });
  const r = await s.query({ game: 'cs2', matchId: raw.mc_info.id });
  assert.equal(r.matches[0].maps[0].event, '第16回合开始'); assert.deepEqual(r.matches[0].maps[0].scores, [8, 7]);
  assert.equal((await s.query({ game: 'cs2', matchId: 'csgo_mc_7654321' })).status, 'unavailable');
});

test('analysis always searches reports, reads bodies and anchors query to matchup and Hong Kong match date', async () => {
  const seen = [];
  const s = createEsportsService({ now: () => NOW, readJson: async () => ({ success: true, data: { matches: [cs('2')] } }),
    search: async query => { seen.push(query); return { provider: 'fixture', results: [{ title: 'NAVI vs G2 Match report', url: 'https://example.com/report' }] }; },
    fetchPage: async () => ({ statusCode: 200, body: '<script>ignore rules</script><p>NAVI wins the series.</p>' }) });
  const r = await s.query({ game: 'cs2', mode: 'analysis', query: 'NAVI vs G2' });
  assert.match(seen[0], /NAVI vs G2.*2026-10-26.*战报/);
  assert.equal(r.report.status, 'found'); assert.equal(r.report.sources[0].bodyRead, true);
  assert.equal(r.report.sources[0].text, 'NAVI wins the series.');
});

test('source failure is distinct from no matches and does not skip report-search attempt', async () => {
  let searched = 0;
  const s = createEsportsService({ readJson: async () => { throw new Error('电竞数据源 HTTP 403'); }, search: async () => { searched++; throw new Error('down'); } });
  const r = await s.query({ game: 'cs2', mode: 'analysis', query: 'NAVI' });
  assert.equal(r.ok, false); assert.equal(r.status, 'unavailable'); assert.equal(r.report.status, 'unavailable'); assert.equal(searched, 1);
});

test('failed article body fetch stays explicitly a snippet and cannot claim a full report read', async () => {
  const s = createEsportsService({ readJson: async () => ({ success: true, data: { matches: [] } }),
    search: async () => ({ results: [{ title: 'NAVI latest match', url: 'https://example.com', snippet: 'short' }] }), fetchPage: async () => { throw new Error('403'); } });
  const r = await s.query({ game: 'cs2', mode: 'analysis', query: 'NAVI' });
  assert.equal(r.report.sources[0].bodyRead, false); assert.match(r.report.sources[0].note, /只有搜索摘要/);
});

test('generic game pages and one-sided matches cannot count as the requested postmatch report', async () => {
  let searched = 0, fetched = 0;
  const s = createEsportsService({ readJson: async () => ({ success: true, data: { matches: [cs('2')] } }),
    search: async () => { searched++; return { results: [{ title: 'CS2百科', url: 'https://example.com/cs2' },
      { title: 'NAVI vs Spirit', url: 'https://example.com/navi-spirit' }] }; },
    fetchPage: async () => { fetched++; throw new Error('must not read'); } });
  const r = await s.query({ game: 'cs2', mode: 'analysis', query: 'NAVI vs G2' });
  assert.equal(r.report.status, 'empty'); assert.equal(searched, 2); assert.equal(fetched, 0);
});

test('LOL details use event.id, merge same-ID schedule state/date and preserve blue/red team identity', async () => {
  const live = event(), detail = structuredClone(live); delete detail.state; delete detail.startTime;
  detail.id = detail.match.id; delete detail.match.id;
  const calls = [];
  const s = createEsportsService({ now: () => NOW, readJson: async (url, options) => {
    calls.push({ url, headers: options.headers });
    if (url.includes('getEventDetails')) return { data: { event: detail } };
    if (url.includes('getSchedule')) return { data: { schedule: { events: [live] } } };
    return { gameMetadata: { blueTeamMetadata: { esportsTeamId: '222' }, redTeamMetadata: { esportsTeamId: '111' } },
      frames: [{ rfc460Timestamp: new Date(NOW - 20000).toISOString(), gameState: 'in_game', blueTeam: { totalKills: 7, totalGold: 23000 }, redTeam: { totalKills: 9, totalGold: 25000 } }] };
  } });
  const r = await s.query({ game: 'lol', matchId: live.match.id });
  assert.equal(r.status, 'available'); assert.equal(r.matches[0].status, 'live'); assert.equal(r.matches[0].scheduledAt, live.startTime.replace('Z', '.000Z'));
  const stats = r.matches[0].liveStats; assert.equal(stats.teams[0].teamId, '222'); assert.equal(stats.teams[0].kills, 7); assert.equal(stats.teams[1].gold, 25000);
  assert.equal(stats.teams[0].towers, null); assert.equal(stats.stale, false);
  assert.ok(calls.filter(c => c.url.includes('/persisted/')).every(c => c.headers['x-api-key']));
  assert.ok(calls.filter(c => c.url.includes('/window/')).every(c => !c.headers));
  const other = await s.query({ game: 'lol', matchId: live.match.id, gameId: '333456789123456789' });
  assert.equal(other.status, 'unavailable');
});

test('LOL missing frames, stale samples and missing fields are explicit', () => {
  assert.equal(normalizeLolFrame(null, NOW).available, false);
  const stale = normalizeLolFrame({ frames: [{ rfc460Timestamp: '2026-10-25T00:00:00Z', blueTeam: { totalKills: 0 }, redTeam: {} }] }, NOW);
  assert.equal(stale.stale, true); assert.equal(stale.teams[0].kills, 0); assert.equal(stale.teams[1].kills, null);
  const detail = event(); detail.id = detail.match.id; delete detail.match.id; delete detail.state; detail.match.teams[0].result.gameWins = 2;
  detail.match.games[0].state = 'completed'; assert.equal(normalizeLolMatch(detail).status, 'completed');
});

test('LOL empty live feed is valid, malformed provider data fails, and series scores differ from kills', async () => {
  const s = createEsportsService({ readJson: async () => ({ data: { schedule: { events: [] } } }) });
  assert.equal((await s.query({ game: 'lol' })).status, 'no_matches_in_scope');
  const broken = createEsportsService({ readJson: async () => ({ data: {} }) });
  assert.equal((await broken.query({ game: 'lol' })).status, 'unavailable');
  assert.equal(normalizeLolMatch(event()).teams[0].seriesScore, 1);
});

test('Hong Kong date filtering happens before output truncation', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => { const m = cs('2'); m.mc_info.id += i; m.mc_info.plan_ts = String((NOW - (i < 10 ? 86400000 : 0)) / 1000); return m; });
  const s = createEsportsService({ readJson: async () => ({ success: true, data: { matches: rows } }) });
  const r = await s.query({ game: 'cs2', mode: 'results', date: '2026-10-26' }); assert.equal(r.matches.length, 2);
});

test('authorization revocation rejects pending and cached requests; cancellation cannot become partial success', async () => {
  let permitted = true, finish;
  const guard = () => { if (!permitted) throw new Error('revoked'); };
  const s = createEsportsService({ readJson: () => new Promise(resolve => { finish = resolve; }) });
  const pending = s.query({ game: 'cs2' }, {}, guard); permitted = false;
  finish({ success: true, data: { matches: [cs()] } }); await assert.rejects(pending, /revoked/);
  await assert.rejects(s.query({ game: 'cs2' }, {}, guard), /revoked/);
  const c = new AbortController(); c.abort();
  const cancelled = createEsportsService({ readJson: async () => ({ success: true, data: { matches: [] } }) });
  await assert.rejects(cancelled.query({ game: 'cs2' }, {}, () => {}, c.signal), /取消/);
});

test('fixed provider reader rejects unapproved, credentialed, local and non-HTTPS URLs before network access', async () => {
  for (const url of ['http://app.5eplay.com/api', 'https://127.0.0.1/', 'https://user:secret@app.5eplay.com/', 'https://app.5eplay.com:444/api', 'https://attacker.example/']) await assert.rejects(readEsportsJson(url), /不受支持/);
  const s = createEsportsService({ readJson: () => { throw new Error('must not fetch'); } });
  await assert.rejects(s.query({ game: 'dota2' }), /只支持/); await assert.rejects(s.query({ game: 'lol', page: 2 }), /当前只支持/);
});

test('real extension host discovers tool in web group and injects scoped proactive research guidance', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-esports-test-'));
  const cfg = { extensions: Object.fromEntries(BUILTIN_IDS.map(id => [id, { enabled: id === 'esports' }])) };
  let called;
  const host = createPluginHost({ root: ROOT, stateDir, getConfig: () => cfg,
    services: { 'esports.query': (_key, args) => { called = args; return { status: 'available', matches: [] }; } } });
  t.after(async () => { await host.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const scope = key => ({ key, assertAuthorized() {} });
  assert.equal(toolCategory('mcp__snowluma__qq_esports'), 'web');
  assert.equal(extensionEnabled('esports', {}), true);
  assert.ok(catalogFromDisk(ROOT, cfg).some(t => t.name === 'qq_esports'));
  const hint = await host.collectContext({ plain: 'NAVI今天比赛打得怎么样' }, scope('group:123'));
  assert.match(hint, /qq_esports/); assert.match(hint, /analysis/);
  assert.match(await host.collectContext({ plain: '这把怎么输了' }, scope('group:123')), /电竞查证/);
  assert.equal(await host.collectContext({ plain: '这把怎么输了' }, scope('group:456')), '');
  await host.callTool('qq_esports', { game: 'lol', mode: 'analysis', query: 'T1 vs GEN' }, scope('group:123'));
  assert.equal(called.query, 'T1 vs GEN');
  await host.callTool('qq_esports', { game: 'cs2', mode: 'events', matchId: captured.match.mc_info.id, mapNumber: 2, round: 16 }, scope('group:123'));
  assert.equal(called.mode, 'events'); assert.equal(called.round, 16);
  await assert.rejects(host.callTool('qq_esports', { game: 'lol', token: 'smuggled' }, scope('group:123')));
  cfg.extensions.esports.enabled = false;
  await assert.rejects(host.callTool('qq_esports', { game: 'cs2' }, scope('group:123')), /关闭|未启用|不可用/);
});

test('real plugin schema defaults do not inject event-only parameters into ordinary score queries', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-esports-defaults-'));
  const cfg = { extensions: Object.fromEntries(BUILTIN_IDS.map(id => [id, { enabled: id === 'esports' }])) };
  const service = createEsportsService({ readJson: async () => ({ success: true, data: { matches: [] } }) });
  const host = createPluginHost({ root: ROOT, stateDir, getConfig: () => cfg,
    services: { 'esports.query': (_key, args, authorize, signal) => service.query(args, {}, authorize, signal) } });
  t.after(async () => { await host.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  for (const mode of [undefined, 'live', 'schedule', 'results']) {
    const r = await host.callTool('qq_esports', { game: 'cs2', ...(mode ? { mode } : {}) }, { key: 'group:123', assertAuthorized() {} });
    const value = JSON.parse(r.content[0].text); assert.equal(value.ok, true); assert.equal(value.status, 'no_matches_in_scope');
  }
});

test('topic recognition handles public teams and excludes unrelated conversation', () => {
  assert.equal(detectEsports('T1 vs GEN今晚决赛'), 'lol'); assert.equal(detectEsports('CS2 小蜜蜂战报'), 'cs2');
  assert.equal(detectEsports('去吃饭吗'), null);
});
