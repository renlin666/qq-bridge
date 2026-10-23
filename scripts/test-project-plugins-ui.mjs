// Optional real-browser QA against an isolated HTTP fixture, never production config.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const saved = [];
const errors = [];
const plugins = ['bilibili', 'image-search', 'quark', 'qzone'].map(id => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions', id, 'plugin.json'), 'utf8'));
  return { id, version: manifest.version, status: 'active', enabled: true, configSchema: manifest.configSchema,
    config: id === 'bilibili' ? { ffmpegPath: '', transcribe: true } : id === 'qzone' ? { visibility: 4, allowedKeys: ['group:456'], maxPerDay: 3 } : {}, tools: manifest.tools.map(tool => tool.name) };
});
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/extensions')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(root, 'public/extensions.html'))); return; }
  if (req.url === '/api/extensions' && req.headers['x-console-token'] === 'fixture-token') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ plugins })); return; }
  if (req.url === '/api/extensions/config' && req.headers['x-console-token'] === 'fixture-token') {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { saved.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: '配置已保存；停用立即生效，启用需要重启。' })); }); return;
  }
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find(file => fs.existsSync(file));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/extensions?token=fixture-token'); await page.locator('article').nth(3).waitFor();
  assert.equal(await page.locator('article').count(), 4);
  assert.equal(page.url(), origin + '/extensions');
  const bilibili = page.locator('article').filter({ has: page.getByRole('heading', { name: 'bilibili', exact: true }) });
  await bilibili.getByLabel('ffmpegPath', { exact: true }).fill('ffmpeg');
  await bilibili.getByLabel('启用插件', { exact: true }).uncheck();
  await bilibili.getByRole('button', { name: '保存配置' }).click();
  await bilibili.getByText('配置已保存；停用立即生效，启用需要重启。', { exact: true }).waitFor();
  assert.equal(saved[0].id, 'bilibili'); assert.equal(saved[0].enabled, false); assert.equal(saved[0].config.ffmpegPath, 'ffmpeg');
  await page.screenshot({ path: path.join(root, 'state/plugin-host-ui-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(root, 'state/plugin-host-ui-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS plugin manager: metadata forms, authenticated save, no external requests, desktop/mobile layout, no page errors');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
