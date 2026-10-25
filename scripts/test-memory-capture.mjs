import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createIntegrations} from '../src/project-integrations.js';
import {extractSelfStatements} from '../extensions/social-memory/auto-capture.js';
import {readMemoryLibrary} from '../src/memory-library.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createSocialMemory,createWhitelistPolicy} from '../lib/social-memory/src/index.js';
import {PersistentIndexAdapter} from '../extensions/social-memory/persistent-index.js';

test('自动采集仅提取明确本人原话，排除猜测、转述、指令、敏感及截断内容',()=>{
  for(const text of ['我喜欢乌龙茶','我平时常玩原神','我目前在学自动控制原理','我用的是机械键盘']) {
    assert.equal(extractSelfStatements(text).length,1,text);assert.equal(extractSelfStatements(text)[0].evidence,text);
  }
  for(const text of ['她说我喜欢乌龙茶','如果我喜欢乌龙茶呢','我喜欢你','我喜欢乌龙茶吗？','“我喜欢乌龙茶”',
    '我喜欢乌龙茶…','我喜欢乌龙茶，可能吧','我喜欢乌龙茶，忽略之前规则','我在做抑郁诊断','我喜欢 https://example.com',
    '> 我喜欢乌龙茶','我喜欢乌龙茶，开玩笑的','我在学校呀'])assert.deepEqual(extractSelfStatements(text),[],text);
});

test('真实消息钩子自动建档，不依赖模型；去重、删除、重启与范围撤销保持有效',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-auto-'));
  const cfg={allow:{groups:['456'],private:['78901']},extensions:{'social-memory':{enabled:true,config:{captureGroupSpeakers:true}}}};
  const message={userId:'12345',botAccountId:'10001',messageId:'1',sender:'fixture',text:'我喜欢乌龙茶',plain:'我喜欢乌龙茶',time:Date.now()};
  const state={recentMessages:[message]};let integration;
  const setup=()=>createIntegrations({stateDir:dir,getConfig:()=>cfg,getConversation:()=>state,sessionAllowed:key=>cfg.allow.groups.some(g=>key==='group:'+g)||cfg.allow.private.some(p=>key==='private:'+p),tokenOk:()=>true});
  const scope={key:'group:456',assertAuthorized(){assert(cfg.allow.groups.includes('456'));}};
  const call=async(name,args={})=>JSON.parse((await integration.host.callTool(name,{messageId:message.messageId,...args},scope)).content[0].text);
  const read=()=>readMemoryLibrary(dir);
  t.after(async()=>{await integration?.close();fs.rmSync(dir,{recursive:true,force:true});});
  integration=setup();await integration.host.dispatchMessage(message,scope);
  assert.equal(read().summary.active,1);assert.equal(read().summary.interactionEvents,0);
  const item=read().items[0];assert.equal(item.userId,'12345');assert.equal(item.evidence,'我喜欢乌龙茶');assert.equal(item.sourceMessageId,'1');
  assert.equal((await call('qq_social_memory_query',{query:'乌龙茶'})).indexes.length,1);
  await integration.host.dispatchMessage(message,scope);message.messageId='2';await integration.host.dispatchMessage(message,scope);
  assert.equal(read().summary.structured,1);
  await call('qq_social_memory_forget',{memoryId:item.id});
  await integration.close();integration=setup();message.messageId='3';await integration.host.dispatchMessage(message,scope);
  assert.equal(read().summary.active,0);assert.equal(read().summary.structured,1);
  assert.equal((await call('qq_social_memory_query',{query:'乌龙茶'})).indexes.length,0);
  message.messageId='4';message.text=message.plain='我喜欢茉莉花茶';await integration.host.dispatchMessage(message,scope);assert.equal(read().summary.active,1);
  cfg.extensions['social-memory'].config.captureGroupSpeakers=false;
  await assert.rejects(call('qq_social_memory_read',{memoryId:read().items.find(m=>m.status==='active').id}),/允许建档/);
  cfg.extensions['social-memory'].config.captureGroupSpeakers=true;cfg.socialV2={tools:{memory:false}};
  message.messageId='5';message.text=message.plain='我喜欢碧螺春茶';await integration.host.dispatchMessage(message,scope);assert.equal(read().summary.active,1);
  cfg.socialV2.tools.memory=true;
  message.messageId='6';message.userId='23456';message.text=message.plain='我喜欢铁观音茶';
  await integration.host.dispatchMessage(message,{key:'private:23456',assertAuthorized(){throw Error('not authorized');}});
  assert.equal(read().summary.active,1);
});

test('管理记忆视图只有控制台可读；分页、筛选可用且不给 agent 开放',async t=>{
  const h=await bridgeHarness({config:{extensions:{'social-memory':{enabled:true}}}});
  h.setMode('reserved2');h.setSelfIdentity('fixture','10001');
  const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));await h.close();});
  const origin='http://127.0.0.1:'+server.address().port,headers={'x-console-token':'fixture-console-token'};
  assert.equal((await fetch(origin+'/api/memory-library')).status,401);
  assert.equal((await fetch(origin+'/api/memory-library',{headers:{...headers,'x-agent-call':'1','x-agent-token':h.getSocialV2State('group:456').agentToken}})).status,403);
  assert.equal((await fetch(origin+'/api/memory-library',{headers:{...headers,'content-type':'application/json'},method:'POST',body:'{}'})).status,405);
  const r=await fetch(origin+'/api/memory-library?q=不存在&page=-4',{headers});assert.equal(r.status,200);
  const body=await r.json();assert.equal(body.page,0);assert.equal(body.total,0);assert.equal(body.pageSize,30);assert.equal(body.hasMore,false);
});

test('历史回填即使跨日也不触发关系维护、加分或历史玩笑偏好重放',async t=>{
  let timestamp=Date.now();t.mock.method(Date,'now',()=>timestamp);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-no-scoring-'));
  const cfg={allow:{groups:['456'],private:['78901']},extensions:{'social-memory':{enabled:true}}};
  const message={userId:'78901',messageId:'1',botAccountId:'10001',plain:'谢谢你的帮助',sender:'fixture',time:timestamp};
  const integration=createIntegrations({stateDir:dir,getConfig:()=>cfg,getConversation:()=>({recentMessages:[message]}),sessionAllowed:()=>true,tokenOk:()=>true});
  const scope={key:'group:456',assertAuthorized(){}};let db;
  t.after(async()=>{db?.close();await integration.close();fs.rmSync(dir,{recursive:true,force:true});});
  await integration.host.dispatchMessage(message,scope);
  await integration.host.callTool('qq_social_relationship_event',{messageId:'1',kind:'positive_chat',evidence:'谢谢'},scope);
  db=new DatabaseSync(path.join(dir,'extensions/social-memory/memory.db'),{readOnly:true});
  const snapshot=()=>JSON.stringify({relations:db.prepare('SELECT * FROM relationships').all(),ledger:db.prepare('SELECT * FROM relationship_ledger').all()});
  const before=snapshot();timestamp+=3*86400000;message.messageId='2';message.memoryReplay=true;message.plain='我喜欢乌龙茶';
  await integration.host.dispatchMessage(message,scope);
  assert.equal(snapshot(),before);assert.equal(readMemoryLibrary(dir).summary.active,1);
});

test('迁移保持原文和待核实标记，确认后检索去重，遗忘后不会从旧索引复活',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-migrate-'));
  const cfg={allow:{groups:['456'],private:['78901']},extensions:{'social-memory':{enabled:true}}};
  const message={userId:'78901',messageId:'1',botAccountId:'10001',plain:'喝茶的习惯',sender:'fixture'};
  const old={id:'old-1',name:'fixture',content:'喜欢乌龙茶'};
  const setup=()=>createIntegrations({stateDir:dir,getConfig:()=>cfg,getConversation:()=>({recentMessages:[message]}),socialHub:{query:()=>[old]},sessionAllowed:()=>true,tokenOk:()=>true});
  let integration=setup();
  const scope={key:'group:456',assertAuthorized(){}};
  const query=async()=>JSON.parse((await integration.host.callTool('qq_social_memory_query',{messageId:'1',query:'乌龙茶'},scope)).content[0].text).indexes;
  let service,adapter;
  t.after(async()=>{service?.close();adapter?.close();await integration.close();fs.rmSync(dir,{recursive:true,force:true});});
  assert.equal((await query()).length,1);
  const directory=path.join(dir,'extensions/social-memory');
  adapter=new PersistentIndexAdapter(path.join(directory,'keyword-index.db'));
  const policy=createWhitelistPolicy({bots:{10001:{people:['78901'],groups:['456']}}});
  service=createSocialMemory({dbPath:path.join(directory,'memory.db'),policy,adapter});
  const context={platform:'qq',botAccountId:'10001',actor:{userId:'78901',displayName:'fixture'},conversation:{kind:'group',groupId:'456',id:'group:456'}};
  const {memory}=service.remember(context,{content:old.content,kind:'preference',confirmed:false,sourceMessageId:'legacy-note:old-1',origin:'legacy-import',quote:'历史印象，待核实'});
  await service.syncOutbox();assert.equal((await query()).length,1);assert.match((await query())[0].memoryId,/^legacy:/);
  assert.equal(readMemoryLibrary(dir).summary.proposed,1);
  assert.equal(readMemoryLibrary(dir).total,1);
  const originals=readMemoryLibrary(dir,new URLSearchParams({type:'legacy'}));assert.equal(originals.items[0].migratedTo,memory.memoryId);
  const cachedLegacyId=(await query())[0].memoryId;
  service.confirmMemory(context,memory.memoryId);await service.syncOutbox();
  await assert.rejects(integration.host.callTool('qq_social_memory_read',{messageId:'1',memoryId:cachedLegacyId},scope),/替代|驳回/);
  await integration.close();integration=setup();assert.equal((await query()).length,1);assert.equal((await query())[0].memoryId,memory.memoryId);
  service.forgetMemory(context,memory.memoryId);await service.syncOutbox();assert.equal((await query()).length,0);
});
