// 离线浏览器回归：不访问生产QQ/DSH，不修改账本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startConsoleFixture } from './console-ui-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  (process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)') + '/Microsoft/Edge/Application/msedge.exe',
  (process.env.PROGRAMFILES || 'C:/Program Files') + '/Google/Chrome/Application/chrome.exe'
].find(file => fs.existsSync(file));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const fixture = await startConsoleFixture();
try {
  for (const [pageName, width] of [['console', 1440], ['billing', 1440], ['billing', 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('Storage denied', 'SecurityError'); }
    }));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, fixture.url);
      assert.equal(route.request().method(), 'GET');
      if (url.pathname === '/billing') return route.fulfill({ contentType: 'text/html',
        body: fs.readFileSync(new URL('../public/billing.html', import.meta.url), 'utf8') });
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.url + (pageName === 'billing' ? '/billing?token=fixture' : '/?token=fixture#usage'));
    const metric = pageName === 'billing' ? '#totalCost' : '#metricUsageCost';
    await page.waitForFunction(selector => document.querySelector(selector).textContent.includes('¥'), metric);
    assert.deepEqual(errors, [], 'blocked localStorage must not abort page initialization');
    if (pageName === 'billing') {
      await page.waitForSelector('#turns tbody tr');
      const before = await page.locator('#turnScope').innerText();
      await page.selectOption('#conversation', 'private:100001');
      await page.waitForFunction(() => document.querySelector('#turnScope').textContent.includes('private:100001'));
      assert.notEqual(await page.locator('#turnScope').innerText(), before);
      await page.selectOption('#hours', '168');
      await page.waitForSelector('#chart .bar');
      assert.ok(await page.locator('#chart .bar').count() > 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    console.log(`PASS ${pageName} ${width}px: blocked storage, real rendered billing, navigation/layout`);
    await context.close();
  }
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).pathname.startsWith('/api/')
    ? route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"expired"}' })
    : route.continue());
  const page = await context.newPage();
  let dialogs = 0;
  page.on('dialog', dialog => { dialogs++; return dialog.dismiss(); });
  await page.goto(fixture.url + '/?token=expired#usage');
  await page.waitForTimeout(3500);
  assert.equal(dialogs, 1, 'concurrent polling must not create an authentication dialog storm');
  console.log('PASS expired authentication: only one prompt across concurrent API requests and polling');
  await context.close();
} finally {
  await browser.close();
  await fixture.close();
}
