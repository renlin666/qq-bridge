import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import dns from 'node:dns';
import { spawnSync } from 'node:child_process';

test('oversize GIF becomes a labelled static image, preserving download and decode limits', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-gif-preview-test-'));
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const input = path.join(root, 'fixture.gif');
  const made = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=blue:s=64x64:d=1', '-frames:v', '1', '-threads', '1', input], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.error?.message || made.stderr);
  const gif = Buffer.concat([await fs.readFile(input), Buffer.alloc(8 * 1024 * 1024 + 1)]);
  const badDimensions = Buffer.from(gif.subarray(0, 32)); badDimensions.writeUInt16LE(5000, 6); badDimensions.writeUInt16LE(5000, 8);
  const server = http.createServer((req, res) => {
    if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/secret' }); res.end(); return; }
    const body = req.url === '/oversize' ? Buffer.alloc(20 * 1024 * 1024 + 1)
      : req.url === '/bomb' ? badDimensions : req.url === '/invalid' ? Buffer.from('<html>not an image</html>') : gif;
    res.writeHead(200, { 'content-length': body.length }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = http.request;
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(http, 'request', (options, callback) => request({ ...options, hostname: '127.0.0.1', port: server.address().port }, callback));
  const { safeFetchBuffer } = await import('../src/safe-fetch.js');
  const { readGifPreview } = await import('../src/image-preview.js');
  const options = { stateDir: root, ffmpegPath: ffmpeg };
  try {
    await assert.rejects(safeFetchBuffer('http://image.example/gif'), /超过大小限制/);
    const preview = await readGifPreview('http://image.example/gif', options);
    assert.equal(preview.mimeType, 'image/jpeg');
    assert(preview.buffer.length < 100_000);
    assert.equal(preview.preview.sourceBytes, gif.length);
    assert.equal(preview.preview.sourceWidth, 64);
    assert.match(preview.preview.note, /静态首帧.*未读取后续动画/);
    for (const [route, error] of [['oversize', /超过大小限制/], ['private', /内网|本机/],
      ['invalid', /有效的图片/], ['bomb', /像素超限/]]) {
      await assert.rejects(readGifPreview('http://image.example/' + route, options), error);
      assert.deepEqual(await fs.readdir(root), ['fixture.gif'], 'temporary source and preview files must be removed');
    }
    // A failure must release the single-task admission flag.
    assert((await readGifPreview('http://image.example/gif', options)).buffer.length > 0);
    const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
    const h = await bridgeHarness({ config: { integrations: { bilibili: { ffmpegPath: ffmpeg } } } });
    try {
      const media = { kind: 'image', subType: '1', file: 'fixture.gif', url: 'http://image.example/gif' };
      const images = await h.fetchMediaData([media]);
      assert.equal(images[0].mimeType, 'image/jpeg');
      assert.equal(images[0].preview.kind, 'animation-first-frame');
      assert.match(images[0].text, /静态首帧.*未读取后续动画/, 'already running MCP adapters also receive the disclosure');
      assert.equal(h.calls.images.length, 0, 'successful preview should precede gateway fallback');
      const inline = await h.resolveMediaList([media]);
      assert(inline.some(block => block.type === 'image' && block.mediaType === 'image/jpeg'));
      assert(inline.some(block => block.type === 'text' && /静态首帧/.test(block.text)));
      // Collection and sending still use the original path, without the viewing adapter.
      const original = await h.fetchOneBotImage(media);
      assert.equal(original.mimeType, 'image/png');
      assert.equal(original.preview, undefined);
    } finally { await h.close(); }
  } finally {
    t.mock.restoreAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
