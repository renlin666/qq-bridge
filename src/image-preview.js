import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { safeFetchImageToFile } from './safe-fetch.js';

let active = false;

// Oversize GIFs are streamed to disk; only a bounded JPEG enters model context.
// This is a viewing adapter, never a source for sticker collection or sending.
export async function readGifPreview(url, { stateDir, ffmpegPath = 'ffmpeg', maxBytes = 8 * 1024 * 1024,
  maxPixels = 4_000_000 } = {}) {
  if (active) throw new Error('动图预览正在处理，请稍后重试');
  active = true;
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(stateDir, 'image-preview-'));
    const input = path.join(dir, 'source.gif'), output = path.join(dir, 'preview.jpg');
    const { bytes } = await safeFetchImageToFile(url, 20 * 1024 * 1024, input);
    const handle = await fs.open(input, 'r');
    let width, height;
    try {
      const header = Buffer.alloc(12);
      await handle.read(header, 0, 12, 0);
      if (!['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))) throw new Error('大图预览仅支持 GIF 动图');
      width = header.readUInt16LE(6); height = header.readUInt16LE(8);
      if (!width || !height || width * height > Math.min(maxPixels, 4_000_000)) throw new Error('动图预览像素超限');
    } finally { await handle.close(); }
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-i', input,
        '-frames:v', '1', '-vf', "scale=w='min(1280,iw)':h=-2", '-q:v', '3', output],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '', expired = false;
      const timer = setTimeout(() => { expired = true; child.kill(); }, 15000);
      child.stderr.on('data', b => { stderr = (stderr + b).slice(-400); });
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', code => {
        clearTimeout(timer);
        if (expired) reject(new Error('动图预览处理超时'));
        else if (code !== 0) reject(new Error('动图预览处理失败：' + stderr));
        else resolve();
      });
    });
    const stat = await fs.stat(output);
    if (!stat.size || stat.size > maxBytes) throw new Error('动图预览大小超限');
    const buffer = await fs.readFile(output);
    if (buffer[0] !== 255 || buffer[1] !== 216) throw new Error('动图预览不是有效 JPEG');
    return { buffer, mimeType: 'image/jpeg', preview: { kind: 'animation-first-frame', sourceBytes: bytes,
      sourceWidth: width, sourceHeight: height, note: '动态图的静态首帧预览，未读取后续动画；不能据此描述动作过程。' } };
  } finally {
    try { if (dir) await fs.rm(dir, { recursive: true, force: true }); }
    finally { active = false; }
  }
}
