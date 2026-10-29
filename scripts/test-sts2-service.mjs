import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSts2Service } from '../src/sts2-service.js';

test('群聊和其他私聊不能读取游戏；管理员真实授权后才能行动，未知结果不能重放', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sts2-'));
  const token = path.join(dir, 'token'); fs.writeFileSync(token, 'a'.repeat(64));
  let clock = Date.now(), calls = [], offline = false;
  const cfg = { ownerQQ: '100001', extensions: { sts2: { enabled: true, config: { tokenFile: token } } } };
  const message = { userId: '100001', messageId: 'auth', plain: '帮我玩杀戮尖塔2', time: clock };
  const service = createSts2Service({ stateDir: dir, getConfig: () => cfg, readMessage: () => message, now: () => clock,
    fetcher: async (url, options) => { if (offline) throw new Error('unknown transport'); calls.push({ url, options }); return new Response(JSON.stringify({ ok: true })); } });
  const key = 'private:100001', allow = () => {};
  try {
    for (const bad of ['group:100005', 'private:123']) await assert.rejects(service.handle(bad, { operation: 'read', view: 'state' }, allow), /仅管理员/);
    const read = await service.handle(key, { operation: 'read', view: 'health' }, allow);
    assert.match(read.instructions, /qq_get_prompt/);
    assert.match(read.instructions, /qq_send_message/);
    assert.match(read.instructions, /新事件/);
    assert.match(read.instructions, /同一事件不要反复播报/);
    const action = { operation: 'action', kind: 'end_turn', arguments: {}, requestId: 'request_0001' };
    await assert.rejects(service.handle(key, action, allow), /尚未取得/);
    await service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'auth' }, allow);
    await service.handle(key, action, allow);
    assert.equal((await service.handle(key, action, allow)).duplicate, true);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
    await assert.rejects(service.handle(key, { ...action, arguments: { confirm: true } }, allow), /相同编号/);
    offline = true;
    await assert.rejects(service.handle(key, { ...action, requestId: 'request_0002' }, allow), /结果未知/);
    offline = false;
    await assert.rejects(service.handle(key, { ...action, requestId: 'request_0002' }, allow), /结果未知/);
    await assert.rejects(service.handle(key, { ...action, requestId: 'request_0003', kind: 'start' }, allow), /未开放/);
    clock += 3 * 3600000;
    await assert.rejects(service.handle(key, { ...action, requestId: 'request_0004' }, allow), /过期/);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('动作返回时不能覆盖处理中收到的停止指令，非法授权时间不能放行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sts2-stop-'));
  const token = path.join(dir, 'token'); fs.writeFileSync(token, 'b'.repeat(64));
  const now = Date.now(), key = 'private:100001', allow = () => {};
  let finish, invalidTime = false;
  const service = createSts2Service({ stateDir: dir, now: () => now,
    getConfig: () => ({ ownerQQ: '100001', extensions: { sts2: { enabled: true, config: { tokenFile: token } } } }),
    readMessage: () => ({ userId: '100001', messageId: 'auth', plain: '玩杀戮尖塔2', time: invalidTime ? undefined : now }),
    fetcher: async () => new Promise(resolve => { finish = () => resolve(new Response('{"ok":true}')); }) });
  try {
    invalidTime = true;
    await assert.rejects(service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'auth' }, allow), /过期/);
    invalidTime = false;
    await service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'auth' }, allow);
    const action = { operation: 'action', kind: 'end_turn', arguments: {}, requestId: 'request_stop_001' };
    const pending = service.handle(key, action, allow);
    await service.handle(key, { operation: 'control', enabled: false, requestMessageId: 'auth' }, allow);
    finish(); await pending;
    await assert.rejects(service.handle(key, { ...action, requestId: 'request_stop_002' }, allow), /尚未取得/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('实际游戏插件清单能在启用配置下注册三个工具', async () => {
  const { discoverExtensions } = await import('../src/plugin-host/catalog.js');
  const root = new URL('..', import.meta.url).pathname;
  const { fileURLToPath } = await import('node:url');
  const rows = discoverExtensions(fileURLToPath(new URL('..', import.meta.url)), { extensions: { sts2: { enabled: true, config: { tokenFile: '/private/token' } } } });
  const row = rows.find(row => row.id === 'sts2');
  assert.equal(row.status, 'discovered', row.error);
  assert.deepEqual(row.manifest.tools.map(t => t.name), ['qq_sts2_read', 'qq_sts2_control', 'qq_sts2_action']);
  const action = row.manifest.tools.find(t => t.name === 'qq_sts2_action');
  assert.ok(action.inputSchema.properties.kind.enum.includes('proceed'));
});

test('proceed 需要授权，使用空参数POST并对相同编号去重', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sts2-proceed-'));
  const token = path.join(dir, 'token'); fs.writeFileSync(token, 'c'.repeat(64));
  const clock = Date.now(), calls = [];
  const service = createSts2Service({ stateDir: dir, now: () => clock,
    getConfig: () => ({ ownerQQ: '100001', extensions: { sts2: { enabled: true, config: { tokenFile: token } } } }),
    readMessage: () => ({ userId: '100001', messageId: 'auth', plain: '玩杀戮尖塔2', time: clock }),
    fetcher: async (url, options) => { calls.push({ url, options }); return new Response('{"ok":false,"error":"no button"}'); } });
  const key = 'private:100001', allow = () => {};
  const action = { operation: 'action', kind: 'proceed', arguments: {}, requestId: 'proceed_test_001' };
  try {
    await assert.rejects(service.handle(key, action, allow), /尚未取得/);
    assert.equal(calls.length, 0);
    await service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'auth' }, allow);
    for (const arguments_ of [{ confirm: true }, ['proceed'], 'bad'])
      await assert.rejects(service.handle(key, { ...action, arguments: arguments_ }, allow), /空对象/);
    assert.equal((await service.handle(key, action, allow)).ok, false);
    assert.equal(calls[0].url, 'http://127.0.0.1:23928/proceed');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.body, '{}');
    assert.equal((await service.handle(key, action, allow)).duplicate, true);
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('暂停后旧消息不能续授权，只有暂停后的真实游玩请求可以恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sts2-pause-'));
  let clock = Date.now();
  const message = { userId: '100001', messageId: 'old', plain: '玩杀戮尖塔2', time: clock };
  const service = createSts2Service({ stateDir: dir, now: () => clock,
    getConfig: () => ({ ownerQQ: '100001', extensions: { sts2: { enabled: true, config: {} } } }),
    readMessage: () => message });
  const key = 'private:100001', allow = () => {};
  try {
    await service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'old' }, allow);
    clock += 100;
    await service.handle(key, { operation: 'control', enabled: false, requestMessageId: 'old' }, allow);
    await assert.rejects(service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'old' }, allow), /不能复用旧授权/);
    clock += 100; message.time = clock; message.messageId = 'new';
    assert.equal((await service.handle(key, { operation: 'control', enabled: true, requestMessageId: 'new' }, allow)).enabled, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('遗漏 respond id 时读取当前请求并核对选项，不重复领取', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sts2-reward-'));
  const token = path.join(dir, 'token'); fs.writeFileSync(token, 'd'.repeat(64));
  const clock = Date.now(), calls = [];
  const service = createSts2Service({stateDir:dir, now:()=>clock,
    getConfig:()=>({ownerQQ:'100001', extensions:{sts2:{enabled:true, config:{tokenFile:token}}}}),
    readMessage:()=>({userId:'100001',messageId:'auth',plain:'玩杀戮尖塔2',time:clock}),
    fetcher:async (url, options)=>{calls.push({url,options});return new Response(JSON.stringify(url.endsWith('/request')
      ? {pending:{id:11,min:0,max:2,candidates:[{key:'19金币#1'},{key:'卡牌奖励#1'}]}}
      : {ok:true,applied:'19金币#1'}));}});
  const key='private:100001', allow=()=>{};
  const action={operation:'action',kind:'respond',arguments:{picks:['19金币#1']},requestId:'reward_0001'};
  try {
    await service.handle(key,{operation:'control',enabled:true,requestMessageId:'auth'},allow);
    await assert.rejects(service.handle(key,{...action,requestId:'reward_invalid',arguments:{picks:['不存在#1']}},allow), /不属于当前请求/);
    assert.equal(calls.filter(x=>x.url.endsWith('/respond')).length,0);
    const result=await service.handle(key,action,allow);
    assert.equal(result.ok,true);
    assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/respond')).options.body),{id:11,picks:['19金币#1']});
    const before=calls.length;
    assert.equal((await service.handle(key,action,allow)).duplicate,true);
    assert.equal(calls.length,before);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('读取当前请求期间暂停，不能继续提交奖励', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-sts2-reward-pause-'));
  const token=path.join(dir,'token');fs.writeFileSync(token,'e'.repeat(64));
  const clock=Date.now();let release;let calls=0;
  const service=createSts2Service({stateDir:dir,now:()=>clock,
    getConfig:()=>({ownerQQ:'100001',extensions:{sts2:{enabled:true,config:{tokenFile:token}}}}),
    readMessage:()=>({userId:'100001',messageId:'auth',plain:'玩杀戮尖塔2',time:clock}),
    fetcher:async ()=>{calls++;return await new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({pending:{id:11,min:0,max:1,candidates:[{key:'19金币#1'}]}})));});}});
  const key='private:100001',allow=()=>{};
  try {
    await service.handle(key,{operation:'control',enabled:true,requestMessageId:'auth'},allow);
    const pending=service.handle(key,{operation:'action',kind:'respond',requestId:'reward_pause_01',arguments:{picks:['19金币#1']}},allow);
    await service.handle(key,{operation:'control',enabled:false,requestMessageId:'auth'},allow);
    release();
    await assert.rejects(pending,/控制已停止/);
    assert.equal(calls,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
