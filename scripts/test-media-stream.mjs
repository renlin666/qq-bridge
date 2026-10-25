import assert from 'node:assert/strict';
import { test } from 'node:test';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('streaming media retains DNS pinning, byte limits, redirect checks and atomic files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-media-stream-'));
  const media = Buffer.alloc(256 * 1024, 7);
  media.write('ftyp', 4, 'ascii');
  const server = http.createServer((req, res) => {
    if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/secret' }); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    if (req.url === '/abort') { res.writeHead(200); res.write(media.subarray(0, 20)); setTimeout(() => res.destroy(), 20); return; }
    res.writeHead(200);
    res.end(req.url === '/invalid' ? Buffer.alloc(24) : media);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalRequest = http.request;
  const requests = [];
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
  t.mock.method(http, 'request', (options, callback) => {
    requests.push(options);
    return originalRequest({ ...options, hostname: '127.0.0.1', port: server.address().port }, callback);
  });
  const { safeFetchMediaToFile } = await import('../src/safe-fetch.js');
  const destination = path.join(root, 'video.m4s');
  try {
    await t.test('real streamed bytes survive a redirect and retain Host/Referer', async () => {
      const result = await safeFetchMediaToFile('http://media.example/redirect', media.length, 'https://www.bilibili.com/', destination);
      assert.equal(result.bytes, media.length);
      assert.deepEqual(await fs.readFile(destination), media);
      assert.equal(requests[0].hostname, '8.8.8.8');
      assert.equal(requests[0].headers.host, 'media.example');
      assert.equal(requests[1].headers.referer, 'https://www.bilibili.com/');
      assert.deepEqual(await fs.readdir(root), ['video.m4s']);
    });
    await t.test('oversize response does not retry or replace a complete cache entry', async () => {
      const before = requests.length;
      await assert.rejects(safeFetchMediaToFile('http://media.example/ok', 1024, '', destination), /大小限制/);
      assert.equal(requests.length - before, 1);
      assert.deepEqual(await fs.readFile(destination), media);
      assert.deepEqual(await fs.readdir(root), ['video.m4s']);
    });
    await t.test('private redirect and invalid media leave no partial cache files', async () => {
      await assert.rejects(safeFetchMediaToFile('http://media.example/private', media.length, '', destination), /内网|本机/);
      await assert.rejects(safeFetchMediaToFile('http://media.example/invalid', media.length, '', destination), /有效的 MP4/);
      assert.deepEqual(await fs.readdir(root), ['video.m4s']);
    });
    await t.test('interrupted transfers close writers before retry and clean up', async () => {
      await assert.rejects(safeFetchMediaToFile('http://media.example/abort', media.length, '', destination), /中断|aborted|reset/i);
      assert.deepEqual(await fs.readFile(destination), media);
      assert.deepEqual(await fs.readdir(root), ['video.m4s']);
    });
    await t.test('low-memory admission rejects before network access and releases busy state after failure', async () => {
      const { readBilibiliMedia } = await import('../src/bilibili-media.js');
      t.mock.method(process, 'constrainedMemory', () => 0);
      const memory = t.mock.method(process, 'availableMemory', () => 0);
      const options = { media: { lowMemory: true }, stateDir: root };
      await assert.rejects(readBilibiliMedia('BV1xx411c7mD', options), /内存不足/);
      memory.mock.restore();
      const belowReserve = t.mock.method(process, 'availableMemory', () => 127 * 1024 * 1024);
      await assert.rejects(readBilibiliMedia('BV1xx411c7mD', options), /可用 127 MiB，需 128 MiB/);
      belowReserve.mock.restore();
      // Realistic headroom in a service constrained by MemoryHigh=256M:
      // it must reach the network instead of permanently rejecting all videos.
      t.mock.method(process, 'availableMemory', () => 160 * 1024 * 1024);
      t.mock.method(https, 'request', (_options, callback) => {
        const request = new EventEmitter();
        request.end = () => setImmediate(() => {
          const response = new PassThrough();
          response.statusCode = 200; response.headers = {}; response.complete = true;
          callback(response);
          response.end(JSON.stringify({ code: -400, message: 'fixture media unavailable' }));
        });
        request.destroy = () => {};
        return request;
      });
      const first = assert.rejects(readBilibiliMedia('BV1xx411c7mD', options), /视频信息不可用/);
      await assert.rejects(readBilibiliMedia('BV1xx411c7mD', options), /正在处理/);
      await first;
      await assert.rejects(readBilibiliMedia('BV1xx411c7mD', options), /视频信息不可用/);
    });
  } finally {
    t.mock.restoreAll();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Linux video admission counts clean cgroup file cache while preserving host and service limits', async () => {
  const { videoMemoryHeadroom } = await import('../src/bilibili-media.js');
  const MiB = 1024 * 1024;
  const values = {
    '/proc/self/cgroup': '0::/system.slice/qq-stack-bridge.service\n',
    '/sys/fs/cgroup/system.slice/qq-stack-bridge.service/memory.stat':
      `anon ${100 * MiB}\nfile ${170 * MiB}\nshmem ${4 * MiB}\nfile_dirty ${3 * MiB}\nfile_writeback ${2 * MiB}\n`,
    '/proc/meminfo': 'MemAvailable: 600000 kB\n',
  };
  const options = { platform: 'linux', available: 33 * MiB, constrained: 256 * MiB,
    read: file => { if (!(file in values)) throw new Error('missing fixture'); return values[file]; } };
  assert.equal(videoMemoryHeadroom(options), 194 * MiB, 'A second video can use reclaimable clean cache');
  assert.equal(videoMemoryHeadroom({ ...options, available: 200 * MiB }), 256 * MiB, 'Service limit remains binding');
  values['/proc/meminfo'] = 'MemAvailable: 98304 kB\n';
  assert.equal(videoMemoryHeadroom(options), 96 * MiB, 'Actual host memory pressure still rejects videos');
  values['/sys/fs/cgroup/system.slice/qq-stack-bridge.service/memory.stat'] =
    `anon ${100 * MiB}\nfile ${9 * MiB}\nshmem ${4 * MiB}\nfile_dirty ${3 * MiB}\nfile_writeback ${2 * MiB}\n`;
  assert.equal(videoMemoryHeadroom(options), 33 * MiB, 'Anonymous and non-reclaimable pages add no headroom');
  assert.equal(videoMemoryHeadroom({ ...options, read: () => { throw new Error('unavailable'); } }), 33 * MiB);
  assert.equal(videoMemoryHeadroom({ ...options, platform: 'win32' }), 33 * MiB);
});
