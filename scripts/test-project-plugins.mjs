// Project plugin contract tests. Temporary state/fake transports only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPluginHost } from '../src/plugin-host/index.js';
import { createExtensionStorage } from '../src/plugin-host/storage.js';
import { catalogFromDisk, discoverExtensions } from '../src/plugin-host/catalog.js';
import { createIntegrations } from '../src/qq-integrations.js';
import { registerProjectExtensionTools } from '../src/mcp-project-extensions.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const builtinsOff = Object.fromEntries(['bilibili', 'image-search', 'quark', 'qzone'].map(id => [id, { enabled: false }]));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-project-plugins-'));
  const stateDir = path.join(root, 'state');
  const localRoot = path.join(root, 'extensions-local');
  fs.mkdirSync(localRoot); fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const cfg = { extensions: structuredClone(builtinsOff) };
  const hosts = [];
  t.after(async () => { for (const host of hosts) await host.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-project-plugins-'))); fs.rmSync(root, { recursive: true, force: true }); });
  function add(id, code, { capabilities = [], tools, ...extra } = {}) {
    const directory = path.join(localRoot, id); fs.mkdirSync(directory, { recursive: true });
    const manifest = { id, version: '1.0.0', apiVersion: 1, entry: './index.js', capabilities,
      tools: tools ?? [{ name: `qq_ext_${id.replaceAll('-', '_')}_value`, description: 'fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], ...extra };
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify(manifest)); fs.writeFileSync(path.join(directory, 'index.js'), code);
    cfg.extensions[id] = { enabled: true, capabilities, config: {} };
    return manifest;
  }
  function host(options = {}) { const value = createPluginHost({ root, stateDir, localRoot, getConfig: () => cfg, ...options }); hosts.push(value); return value; }
  return { root, stateDir, localRoot, cfg, add, host };
}
const scope = (key = 'group:456') => ({ key, assertAuthorized() {} });

test('a new directory plus explicit config registers tools without changing bridge/MCP code', async t => {
  const f = fixture(t);
  f.add('new-feature', "export function activate(ctx){ctx.tools.register('qq_ext_new_feature_value',(_,call)=>({key:call.key,answer:42}));}");
  const host = f.host();
  assert.deepEqual((await host.catalog()).map(tool => tool.name), ['qq_ext_new_feature_value']);
  const result = await host.callTool('qq_ext_new_feature_value', {}, scope());
  assert.deepEqual(JSON.parse(result.content[0].text), { key: 'group:456', answer: 42 });
  const registered = new Map();
  let forwarded;
  registerProjectExtensionTools({ tool: (name, _description, _schema, fn) => registered.set(name, fn) }, async (url, init) => {
    forwarded = { url, init }; return result;
  }, f.cfg, f.root, await host.catalog());
  assert.deepEqual(await registered.get('qq_ext_new_feature_value')({ key: 'group:456', token: 'fixture' }), result);
  assert.equal(forwarded.url, '/api/socialV2/extensions/call');
  assert.deepEqual(JSON.parse(forwarded.init.body), { key: 'group:456', name: 'qq_ext_new_feature_value', arguments: {} });
  assert.equal(forwarded.init.headers['x-agent-token'], 'fixture');
});

test('disabled or merely discovered plugins never execute; disk catalog only reads metadata', async t => {
  const f = fixture(t);
  const marker = path.join(f.stateDir, 'imported');
  f.add('dormant', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'bad');export function activate(){}`);
  assert.equal(catalogFromDisk(f.root, f.cfg).length, 1); assert.equal(fs.existsSync(marker), false);
  f.cfg.extensions.dormant.enabled = false;
  const host = f.host(); await host.ready;
  assert.equal(fs.existsSync(marker), false); assert.equal((await host.catalog()).length, 0);
});

test('invalid API, missing grants and core-name collisions fail closed without breaking healthy plugins', async t => {
  const f = fixture(t);
  f.add('broken', 'throw new Error("must not import")', { apiVersion: 999 });
  f.add('ungranted', 'throw new Error("must not import")', { capabilities: ['messages.read'] });
  f.cfg.extensions.ungranted.capabilities = [];
  f.add('stringgrants', 'throw new Error("must not import")', { capabilities: ['messages.read'] });
  f.cfg.extensions.stringgrants.capabilities = 'not-messages.read';
  f.add('collision', 'throw new Error("must not import")', { tools: [{ name: 'qq_send_message', description: 'bad', inputSchema: { type: 'object' } }] });
  f.add('healthy', "export function activate(ctx){ctx.tools.register('qq_ext_healthy_value',()=>7);}");
  const host = f.host();
  assert.equal((await host.catalog()).length, 1);
  assert.equal((await host.status()).filter(row => row.status === 'failed').length, 4);
  assert.match((await host.callTool('qq_ext_healthy_value', {}, scope())).content[0].text, /7/);
});

test('entrypoint traversal and directory junction escape are refused before import', async t => {
  const f = fixture(t);
  f.add('escape', 'throw new Error("must not import")', { entry: '../../package.json' });
  assert.match(discoverExtensions(f.root, f.cfg).find(row => row.id === 'escape').error, /越界/);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.localRoot, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  f.cfg.extensions.junction = { enabled: true, capabilities: [] };
  assert.match(discoverExtensions(f.root, f.cfg).find(row => row.id === 'junction').error, /越界/);
});

test('failed activation rolls back timers, tools and disposal callbacks', async t => {
  const f = fixture(t); const intervals = new Set();
  t.mock.method(globalThis, 'setInterval', () => { const timer = { unref() {} }; intervals.add(timer); return timer; });
  t.mock.method(globalThis, 'clearInterval', timer => intervals.delete(timer));
  f.add('rollback', "export function activate(ctx){ctx.scheduler.every(1000,()=>{});ctx.onDispose(()=>ctx.storage.set('disposed',true));ctx.tools.register('qq_ext_rollback_value',()=>1);throw new Error('activation failure');}", { capabilities: ['scheduler'] });
  const host = f.host(); await host.ready;
  assert.equal((await host.catalog()).length, 0); assert.equal(intervals.size, 0);
  assert.equal(createExtensionStorage(f.stateDir, 'rollback').get('disposed'), true);
});

test('activation timeout cannot register late tools', async t => {
  const f = fixture(t);
  f.add('slow', "export async function activate(ctx){await new Promise(r=>setTimeout(r,60));ctx.tools.register('qq_ext_slow_value',()=>1);}");
  const host = f.host({ activationTimeoutMs: 15 }); await host.ready;
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal((await host.catalog()).length, 0);
  assert.equal((await host.status()).find(row => row.id === 'slow').status, 'failed');
});

test('tool schemas reject unknown arguments and cannot smuggle another conversation key', async t => {
  const f = fixture(t);
  f.add('strict', "export function activate(ctx){ctx.tools.register('qq_ext_strict_value',()=>1);}");
  const host = f.host();
  await assert.rejects(host.callTool('qq_ext_strict_value', { key: 'group:789' }, scope()), /参数无效/);
  await assert.rejects(host.callTool('qq_ext_strict_value', {}, { key: 'group:456' }), /已认证会话/);
});

test('tool capability grants and current authorization are checked again after async work', async t => {
  const f = fixture(t); let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let authorized = true;
  f.add('revoke', "export function activate(ctx){ctx.tools.register('qq_ext_revoke_value',(_,call)=>call.service('fixture.wait',{}));}", { capabilities: ['fixture.wait'] });
  const host = f.host({ services: { 'fixture.wait': async () => { entered(); await gate; return { private: 'must not escape' }; } } });
  const pending = host.callTool('qq_ext_revoke_value', {}, { key: 'group:456', assertAuthorized() { if (!authorized) throw new Error('revoked'); } });
  await started; authorized = false; release(); await assert.rejects(pending, /revoked/);
});

test('disabled plugins abort in-flight calls, remove their tools and run async cleanup', async t => {
  const f = fixture(t); let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.add('stopper', "export function activate(ctx){ctx.onDispose(async()=>{await Promise.resolve();ctx.storage.set('disposed',true)});ctx.tools.register('qq_ext_stopper_value',(_,call)=>call.service('fixture.wait',{}));}", { capabilities: ['fixture.wait'] });
  const host = f.host({ services: { 'fixture.wait': () => { entered(); return new Promise(() => {}); } } });
  const pending = host.callTool('qq_ext_stopper_value', {}, scope());
  const rejected = assert.rejects(pending, /取消或超时/);
  await started; await host.stop('stopper'); await rejected;
  assert.equal((await host.catalog()).length, 0); assert.equal(createExtensionStorage(f.stateDir, 'stopper').get('disposed'), true);
});

test('a timed-out invocation cannot send later through the SDK', async t => {
  const f = fixture(t); let sends = 0;
  f.add('late', "export function activate(ctx){ctx.tools.register('qq_ext_late_value',async(_,call)=>{await new Promise(r=>setTimeout(r,50));return call.messages.send(['late'],'fixture_request');});}", {
    capabilities: ['messages.send'], tools: [{ name: 'qq_ext_late_value', description: 'fixture', timeoutMs: 10, inputSchema: { type: 'object', properties: {} } }],
  });
  const host = f.host({ services: { sendMessage: () => { sends++; } } });
  await assert.rejects(host.callTool('qq_ext_late_value', {}, scope()), /取消或超时/);
  await new Promise(resolve => setTimeout(resolve, 75)); assert.equal(sends, 0);
});

test('timed-out scheduled work never overlaps and disable clears the interval', async t => {
  const f = fixture(t); let tick; let intervalCleared = false; let runs = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'setInterval', fn => { tick = fn; return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => { intervalCleared = true; });
  f.add('scheduled', "export function activate(ctx){ctx.scheduler.every(1000,()=>ctx.background('fixture.work'));ctx.tools.register('qq_ext_scheduled_value',()=>1);}", { capabilities: ['scheduler', 'fixture.work'] });
  const host = f.host({ hookTimeoutMs: 10, services: { 'fixture.work': async () => { runs++; await gate; } } });
  await host.ready; await tick(); await tick(); assert.equal(runs, 1);
  release(); await Promise.resolve(); await host.stop('scheduled'); assert.equal(intervalCleared, true);
});

test('message hooks are scoped and isolated; commands are namespaced and owner-only by default', async t => {
  const f = fixture(t);
  f.add('hooks', "export function activate(ctx){ctx.events.on('message',()=>{throw new Error('hook failure')});ctx.commands.register('ping',(_,call)=>ctx.storage.set('owner',call.isOwner));ctx.tools.register('qq_ext_hooks_value',()=>1);}", { capabilities: ['messages.read'] });
  const host = f.host(); await host.dispatchMessage({ text: 'hello' }, scope());
  assert.equal(await host.dispatchCommand('/reset', scope()), false);
  await assert.rejects(host.dispatchCommand('/hooks:ping', scope()), /管理员/);
  assert.equal(await host.dispatchCommand('/hooks:ping', { ...scope(), isOwner: true }), true);
  assert.equal(createExtensionStorage(f.stateDir, 'hooks').get('owner'), true);
});

test('storage is namespaced and corrupt state cannot be silently overwritten', t => {
  const f = fixture(t); const first = createExtensionStorage(f.stateDir, 'first'); const second = createExtensionStorage(f.stateDir, 'second');
  first.set('value', { n: 1 }); second.set('value', { n: 2 });
  assert.deepEqual(first.get('value'), { n: 1 }); assert.deepEqual(second.get('value'), { n: 2 });
  assert.throws(() => first.set('../escape', 1), /名称无效/);
  const file = path.join(f.stateDir, 'extensions', 'first', 'value.json'); fs.writeFileSync(file, '{broken');
  assert.throws(() => first.get('value'), /损坏/); assert.throws(() => first.set('value', {})); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('configuration schemas apply before activation and metadata contains no configured secrets', async t => {
  const f = fixture(t);
  f.add('configurable', "export function activate(ctx){ctx.tools.register('qq_ext_configurable_value',()=>ctx.config.value);}", {
    configSchema: { type: 'object', properties: { value: { type: 'integer', minimum: 0 } }, additionalProperties: false },
  });
  f.cfg.extensions.configurable.config = { value: 4 };
  const host = f.host(); assert.ok(!JSON.stringify(await host.catalog()).includes('configured-secret'));
  await assert.rejects(host.validateConfig('configurable', { value: -1 }), /配置无效/);
  assert.equal(JSON.parse((await host.callTool('qq_ext_configurable_value', {}, scope())).content[0].text), 4);
});

test('built-in B站/image tools format actual multimodal content in the bridge host', async t => {
  const f = fixture(t);
  const bridge = createIntegrations({ stateDir: f.stateDir, getConfig: () => ({}), onebot: async () => ({}),
    sessionAllowed: () => true, tokenOk: () => true,
    getConversation: () => ({ recentMessages: [{ messageId: 99, directAtSelf: true, sharedLinks: ['https://www.bilibili.com/video/BV1xx411c7mD'] }] }),
    readVideo: async () => ({ title: 'fixture', duration: 20, transcript: 'actual speech', frames: [{ seconds: 8.25, mimeType: 'image/jpeg', data: 'fixture-base64' }] }),
    socialHub: { handle: async () => ({ images: [{ imageId: 'image-1' }], previews: [{ mimeType: 'image/png', data: 'preview-bytes' }] }) },
  });
  t.after(() => bridge.close());
  const video = await bridge.host.callTool('qq_read_bilibili', { messageId: 99 }, scope());
  assert.deepEqual(video.content.map(block => block.type), ['text', 'text', 'image']); assert.match(video.content[1].text, /8\.250/);
  assert.doesNotMatch(video.content[0].text, /fixture-base64/);
  const images = await bridge.host.callTool('qq_search_images', { query: 'fixture' }, scope());
  assert.equal(images.content[1].type, 'image'); assert.equal(images.content[1].data, 'preview-bytes'); assert.doesNotMatch(images.content[0].text, /previews/);
});

test('real HTTP/MCP path loads an external plugin; admin config and scoped calls remain isolated', async t => {
  const files = { 'package.json': '{"type":"module"}' };
  for (const name of ['index.js', 'plugin.json']) files['extensions-local/echo/' + name] = fs.readFileSync(path.join(ROOT, 'examples/extensions/echo', name), 'utf8');
  const h = await bridgeHarness({ files, config: { extensions: { ...builtinsOff, echo: { enabled: true, capabilities: ['messages.read', 'messages.send'], config: { prefix: 'test:' } } } } });
  h.setMode('reserved2'); h.setSelfIdentity('fixture', '99999');
  const token = h.getSocialV2State('group:456').agentToken;
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, { body, agent = true, sessionToken = token } = {}) => {
    const response = await fetch(origin + route, { method: body ? 'POST' : 'GET',
      headers: { 'x-console-token': 'fixture-console-token', ...(agent ? { 'x-agent-call': '1' } : {}), ...(sessionToken ? { 'x-agent-token': sessionToken } : {}), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const catalog = await request('/api/extensions/catalog', { sessionToken: '' }); assert.equal(catalog.status, 200); assert.equal(catalog.data.tools[0].name, 'qq_ext_echo_echo');
  assert.equal((await request('/api/extensions', { sessionToken: '' })).status, 403);
  const payload = { key: 'group:456', name: 'qq_ext_echo_echo', arguments: { text: 'hello' } };
  const called = await request('/api/socialV2/extensions/call', { body: payload }); assert.equal(called.status, 200); assert.equal(JSON.parse(called.data.content[0].text).text, 'test:hello');
  assert.equal((await request('/api/socialV2/extensions/call', { body: { ...payload, key: 'group:789' } })).status, 403);
  assert.equal((await request('/api/socialV2/extensions/call', { body: payload, sessionToken: '' })).status, 403);
  const invalid = await request('/api/extensions/config', { agent: false, sessionToken: '', body: { id: 'echo', enabled: true, config: { prefix: 123 } } }); assert.equal(invalid.status, 400);
  const disabled = await request('/api/extensions/config', { agent: false, sessionToken: '', body: { id: 'echo', enabled: false, config: { prefix: 'test:' } } }); assert.equal(disabled.status, 200);
  assert.equal((await request('/api/socialV2/extensions/call', { body: payload })).status, 403);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).extensions.echo.enabled, false);
});

test('real message commands use the existing send queue/receipts and never require cross-chat sharing', async t => {
  const files = { 'package.json': '{"type":"module"}' };
  for (const name of ['index.js', 'plugin.json']) files['extensions-local/echo/' + name] = fs.readFileSync(path.join(ROOT, 'examples/extensions/echo', name), 'utf8');
  const h = await bridgeHarness({ files, config: { extensions: { ...builtinsOff, echo: { enabled: true, capabilities: ['messages.read', 'messages.send'], config: {} } } } });
  h.setMode('chat'); h.setSelfIdentity('fixture', '99999');
  const server = h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await h.close(); });
  const event = { self_id: 99999, user_id: 123, message_id: 55, message: [{ type: 'text', data: { text: '/echo:ping hello' } }] };
  await h.handleIncoming('group', 456, event, h.cfg); await h.handleIncoming('group', 456, event, h.cfg);
  assert.equal(h.calls.http.filter(call => call.url.endsWith('/send_group_msg')).length, 1);
  assert.ok(h.getSocialV2State('group:456').recentMessages.some(message => message.messageId));
});
