import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFrameTimes, videoToolResult } from '../src/bilibili-media.js';
import { registerIntegrationTools } from '../src/mcp-qq-integrations.js';

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
