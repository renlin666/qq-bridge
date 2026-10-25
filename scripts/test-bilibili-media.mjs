import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFrameTimes, videoToolResult, selectVideoTrack } from '../src/bilibili-media.js';
import { registerIntegrationTools } from '../src/mcp-qq-integrations.js';

test('low-memory AVC selection admits portrait 480p and keeps the same pixel budget', () => {
  const portrait = { width: 480, height: 852, codecs: 'avc1.64001F', bandwidth: 840339 };
  const lower = { width: 360, height: 640, codecs: 'avc1.64001E', bandwidth: 600796 };
  const oversized = { width: 720, height: 1280, codecs: 'avc1.64001F' };
  assert.equal(selectVideoTrack([lower, oversized, { ...portrait, codecs: 'hvc1' }, portrait], true), portrait);
  const landscape = { width: 854, height: 480, codecs: 'avc1', bandwidth: 500000 };
  assert.equal(selectVideoTrack([landscape], true), landscape);
  for (const track of [oversized, { ...portrait, width: undefined }, { ...portrait, height: 900 }, { ...portrait, codecs: 'av01' }]) {
    assert.equal(selectVideoTrack([track], true), undefined);
  }
});

test('overview covers the video and focused reads stay inside the requested segment', () => {
  const overview = planFrameTimes(1203);
  assert.equal(overview.length, 16);
  assert.equal(overview[0], 0);
  assert.equal(overview.at(-1), 1202);
  const focused = planFrameTimes(1203, { startSeconds: 1100, endSeconds: 1190, frameCount: 10 });
  assert.ok(focused.every(t => t >= 1100 && t < 1190));
  assert.equal(new Set(focused).size, 10);
  for (const options of [{ startSeconds: -1 }, { startSeconds: 1203 }, { endSeconds: 0 }, { frameCount: 17 }, { frameCount: 1.5 }]) {
    assert.throws(() => planFrameTimes(1203, options), /无效/);
  }
});

test('video frames reach MCP as image blocks with timestamps, never base64 text', async () => {
  const tools = new Map();
  let call;
  const video = { title: 'fixture', visualStatus: 'available', transcriptStatus: 'available', transcript: 'actual speech',
    frames: [{ seconds: 8.25, mimeType: 'image/jpeg', data: 'fixture-base64' }] };
  registerIntegrationTools({ tool: (name, _description, _schema, handler) => tools.set(name, handler) }, async (url, init) => {
    call = { url, ...init }; return videoToolResult({ ok: true, video });
  }, { integrations: { bilibili: { enabled: true } } });
  const result = await tools.get('qq_read_bilibili')({ key: 'group:456', token: 'fixture-token', messageId: 99,
    startSeconds: 8, endSeconds: 10, frameCount: 2 });
  assert.equal(call.timeoutMs, 605000);
  assert.equal(call.url, '/api/socialV2/extensions/call');
  assert.equal(JSON.parse(call.body).arguments.startSeconds, 8);
  assert.ok(!call.body.includes('fixture-token'));
  assert.deepEqual(result.content.map(b => b.type), ['text', 'text', 'image']);
  assert.equal(result.content[2].data, 'fixture-base64');
  assert.match(result.content[1].text, /8\.250/);
  assert.doesNotMatch(result.content[0].text, /fixture-base64/);
  assert.match(result.content[0].text, /actual speech/);
  assert.equal(videoToolResult({ ok: true, video: { frames: [], visualStatus: 'unavailable' } }).content.length, 1);
});


import { readBilibili } from '../src/bilibili.js';
const bvid='BV1xx411c7mD';
function fixture(pages, calls, {status=412, code=0}={}) {
 return async url=>{
  calls.push(url);
  if(url.includes('/view?'))return {statusCode:status,body:'blocked'};
  if(url.includes('/pagelist?'))return {statusCode:200,body:JSON.stringify({code,data:pages})};
  assert.match(url,/\/player\/v2\?/);
  return {statusCode:200,body:JSON.stringify({code:0,data:{}})};
 };
}
test('detail HTTP 412 falls back to real public page metadata and preserves duration gates',async()=>{
 const calls=[];
 const result=await readBilibili(bvid,{maxVideoSeconds:180,fetcher:fixture([{cid:123,duration:112,part:'part'}],calls)});
 assert.equal(result.cid,123);assert.equal(result.duration,112);assert.equal(result.totalDuration,112);
 assert.equal(result.metadataSource,'pagelist');assert.equal(result.metadataStatus,'partial');
 assert.equal(result.title,'');assert.equal(result.description,'');assert.equal(result.subtitleStatus,'unavailable');
 assert.equal(calls.length,3);
 const longCalls=[];
 const blocked=await readBilibili(bvid,{maxVideoSeconds:180,fetcher:fixture([{cid:123,duration:112},{cid:124,duration:100}],longCalls)});
 assert.equal(blocked.totalDuration,212);assert.equal(blocked.watchBlockReason,'duration_exceeded');
 assert.equal(longCalls.length,2,'No subtitles or media before full-duration gate');
});
test('page-list fallback fails closed for missing durations, invalid CIDs and unavailable data',async()=>{
 for(const pages of [[],[{cid:123}],[{cid:123,duration:0}],[{cid:'123',duration:112}],[{cid:123,duration:112},{cid:124}]]){
  await assert.rejects(readBilibili(bvid,{maxVideoSeconds:180,fetcher:fixture(pages,[])}));
 }
 await assert.rejects(readBilibili(bvid,{fetcher:fixture([{cid:123,duration:112}],[],{code:-404})}),/HTTP 412/);
 const calls=[];
 await assert.rejects(readBilibili(bvid,{fetcher:fixture([],calls,{status:404})}),/HTTP 404/);
 assert.equal(calls.length,1,'Unrelated errors never trigger fallback');
});
