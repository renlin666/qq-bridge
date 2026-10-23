#!/usr/bin/env node
// DSH 桌面端每次启动都用 `--port 0`（OS 随机端口），所以 qq-bridge config.json 里写死的
// dsh.baseUrl 会在 DSH 重启后失效（Cookie 铸造绑定 host:port，端口一变就 401）。
//
// 本脚本在启动桥接**之前**跑一次：从本机监听表里找出真正的 DSH Web 端口，写回
// config.json 的 dsh.baseUrl，再让 bridge 启动。只读探测，不改 DSH 任何配置。
//
// 用法：
//   node tools/dsh-origin.mjs            # 探测 + 写回 config.json
//   node tools/dsh-origin.mjs --print    # 只打印，不写
//   node tools/dsh-origin.mjs --wait 60  # DSH 还没起来时最多等 60 秒
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(REPO, 'config.json');
// DSH 的 Web 服务对未鉴权请求的固定应答（比“任意 401”更精确，避免误认别的本机服务）。
const FINGERPRINT = /dsh web authentication required/i;

const argv = process.argv.slice(2);
const PRINT_ONLY = argv.includes('--print');
const waitIdx = argv.indexOf('--wait');
const WAIT_SEC = waitIdx >= 0 ? Number(argv[waitIdx + 1] ?? 60) : 0;

function listeningPorts() {
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  } catch {
    return [];
  }
  const ports = new Set();
  for (const line of out.split(/\r?\n/)) {
    //  TCP    127.0.0.1:64786        0.0.0.0:0              LISTENING       12345
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const host = m[1];
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])$/.test(host)) continue;
    const port = Number(m[2]);
    if (port > 0) ports.add(port);
  }
  return [...ports];
}

async function probe(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 900);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { port, status: res.status, dsh: FINGERPRINT.test(text) };
  } catch {
    return { port, status: 0, dsh: false };
  } finally {
    clearTimeout(timer);
  }
}

async function discover() {
  const ports = listeningPorts();
  const results = await Promise.all(ports.map(probe));
  const hits = results.filter((r) => r.dsh);
  if (hits.length) return hits.map((h) => h.port);
  // 启动中的 DSH 尚未监听时，桥接控制台/其他服务也会返回 401。
  // 必须等待 DSH 指纹，不能把这些端口写成 DSH 地址。
  return [];
}

function writeBaseUrl(port) {
  const raw = fs.readFileSync(CONFIG, 'utf8');
  const cfg = JSON.parse(raw);
  const next = `http://127.0.0.1:${port}`;
  if (cfg.dsh?.baseUrl === next) return { changed: false, baseUrl: next };
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: next };
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  return { changed: true, baseUrl: next };
}

const deadline = Date.now() + WAIT_SEC * 1000;
let found = [];
for (;;) {
  found = await discover();
  if (found.length || Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, 2000));
}

if (!found.length) {
  console.error('[dsh-origin] 没找到正在运行的 DSH Web 服务（127.0.0.1 上没有应答 DSH 鉴权指纹的端口）。');
  console.error('[dsh-origin] 请先启动 DeepSeek Harness 桌面端，或加 --wait 60 重试。');
  process.exit(1);
}

found.sort((a, b) => a - b);
const port = found[0];
if (PRINT_ONLY) {
  console.log(`http://127.0.0.1:${port}`);
} else {
  const { changed, baseUrl } = writeBaseUrl(port);
  console.log(`[dsh-origin] DSH = ${baseUrl}${changed ? '（已写回 config.json）' : '（config.json 已一致）'}`);
  if (found.length > 1) console.log(`[dsh-origin] 同时探测到 ${found.join(', ')}，已选用最小的 ${port}`);
}
