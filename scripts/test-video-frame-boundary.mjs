import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planTimelineTimes, probeVideoDuration, timelineSheets, videoToolResult } from '../src/bilibili-media.js';

test('real FFmpeg: rounded page duration cannot discard all pictures at end of track', async () => {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-video-boundary-'));
  try {
    const file = path.join(root, '64 second track.mp4');
    const made = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=2:d=64', '-threads', '1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(made.status, 0, made.error?.message || made.stderr);
    const duration = await probeVideoDuration(file, ffmpeg);
    assert.equal(duration, 64);

    const stale = path.join(root, 'rounded');
    await fs.mkdir(stale);
    // FFmpeg versions either return success without a JPEG or report an empty
    // encoder at EOF; both must reproduce the original boundary failure.
    await assert.rejects(timelineSheets(file, stale, planTimelineTimes(65), ffmpeg), /64 秒未生成有效画面|本地媒体处理失败/);

    const fresh = path.join(root, 'actual');
    await fs.mkdir(fresh);
    const times = planTimelineTimes(Math.min(65, duration));
    const frames = await timelineSheets(file, fresh, times, ffmpeg);
    assert.equal(frames.length, 3, '33 actual samples include a final partial sheet');
    assert.deepEqual(frames.flatMap(frame => frame.timestamps), times);
    assert.equal(times.at(-1), 63);
    assert.deepEqual(frames.at(-1).timestamps, [63]);
    for (const frame of frames) {
      const bytes = Buffer.from(frame.data, 'base64');
      assert.equal(bytes[0], 255);
      assert.equal(bytes[1], 216);
    }
    const result = videoToolResult({ video: { visualStatus: 'available', frames } });
    assert.equal(result.content.filter(block => block.type === 'image').length, 3);
    assert.deepEqual(JSON.parse(result.content[0].text).video.frameTimestamps, times);

    // Cached reads and exact full sheets retain the same timestamps and count.
    assert.deepEqual(await timelineSheets(file, fresh, times, ffmpeg), frames);
    const exact = path.join(root, 'exact');
    await fs.mkdir(exact);
    assert.equal((await timelineSheets(file, exact, times.slice(0, 16), ffmpeg)).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
