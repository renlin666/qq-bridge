import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSocialMemory,createWhitelistPolicy} from '../lib/social-memory/src/index.js';
import {createIntegrations} from '../src/project-integrations.js';
import {readMemoryLibrary} from '../src/memory-library.js';
import {readRelationships} from '../src/relationship-view.js';
import {bridgeHarness} from './audit-bridge-harness.mjs';

const context={platform:'qq',botAccountId:'10001',actor:{userId:'78901',displayName:'测试人物'},conversation:{kind:'group',id:'group:456',groupId:'456'}};
const policy=()=>createWhitelistPolicy({bots:{10001:{people:['78901'],groups:['456']}}});
const review=(action,extra={})=>({action,expectedVersion:1,requestId:'request_'+action+'_1234567890',reviewer:'test-admin',...extra});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phone-memory-')),dbPath=path.join(dir,'memory.db');
 const service=createSocialMemory({dbPath,policy:policy()});const db=new DatabaseSync(dbPath);
 const propose=(source,content='历史说喜欢乌龙茶')=>service.remember(context,{content,kind:'preference',confirmed:false,sourceMessageId:source,origin:'legacy-import',quote:'历史印象，待核实'}).memory;
 t.after(()=>{db.close();service.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,service,db,propose};
}
test('管理员确认、纠正和驳回原子保存审计；重试幂等且不调节关系',async t=>{
 const {service,db,propose}=fixture(t);
 const before=JSON.stringify(db.prepare('SELECT * FROM relationships').all());
 for(const action of ['confirm','correct','reject']){
  const m=propose(action),input=review(action,{...(action==='correct'?{content:'实际喜欢茉莉花茶',note:'经本人核实'}:{})});
  const result=service.reviewMemory(context,m.memoryId,input);assert.equal(result.memory.version,2);
  assert.equal(result.memory.status,action==='reject'?'forgotten':'active');
  assert.equal(service.reviewMemory(context,m.memoryId,input).duplicate,true);
  assert.throws(()=>service.reviewMemory(context,m.memoryId,{...input,note:'改变请求内容'}),/编号/);
  assert.throws(()=>service.reviewMemory(context,m.memoryId,{...input,requestId:'different_request_123456'}),/更新/);
  const audit=db.prepare('SELECT * FROM memory_reviews WHERE memory_id=?').get(m.memoryId);assert.equal(audit.action,action);
  assert.equal(JSON.parse(audit.before_json).content,'历史说喜欢乌龙茶');assert.equal(audit.to_version,2);
  if(action==='correct')assert.equal(service.getMemory(context,m.memoryId).content,'实际喜欢茉莉花茶');
  if(action==='reject')assert.throws(()=>service.getMemory(context,m.memoryId),/不可读/);
  else assert.equal(service.getMemory(context,m.memoryId).verification.method,'administrator_review');
 }
 await service.syncOutbox();assert.equal(db.prepare('SELECT count(*) n FROM memory_reviews').get().n,3);
 assert.equal(db.prepare('SELECT count(*) n FROM memory_revisions').get().n,3);
 assert.equal(JSON.stringify(db.prepare('SELECT * FROM relationships').all()),before);
 assert.equal(db.prepare('SELECT count(*) n FROM relationship_ledger').get().n,0);
});
test('审计写入失败回滚正文、版本、修订和索引队列',t=>{
 const {service,db,propose}=fixture(t),m=propose('rollback');
 const pending=JSON.stringify(service.outboxState());
 db.exec("CREATE TRIGGER fail_review BEFORE INSERT ON memory_reviews BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 assert.throws(()=>service.reviewMemory(context,m.memoryId,review('correct',{content:'应回滚的正文'})),/audit unavailable/);
 assert.equal(service.getMemory(context,m.memoryId).version,1);assert.equal(service.getMemory(context,m.memoryId).content,m.content);
 assert.equal(db.prepare('SELECT count(*) n FROM memory_revisions').get().n,0);assert.equal(JSON.stringify(service.outboxState()),pending);
});
test('核实拒绝过期版本、已确认条目、过期记忆、越权会话和人物',t=>{
 const {service,db,propose}=fixture(t),m=propose('guards');
 assert.throws(()=>service.reviewMemory(context,m.memoryId,review('confirm',{expectedVersion:99})),/更新/);
 db.prepare('UPDATE memories SET valid_to=1 WHERE id=?').run(m.memoryId);
 assert.throws(()=>service.reviewMemory(context,m.memoryId,review('confirm')),/无效/);
 db.prepare('UPDATE memories SET valid_to=NULL WHERE id=?').run(m.memoryId);
 assert.throws(()=>service.reviewMemory({...context,actor:{userId:'other'}},m.memoryId,review('confirm')));
 assert.throws(()=>service.reviewMemory({...context,conversation:{kind:'group',id:'group:999',groupId:'999'}},m.memoryId,review('confirm')));
 service.confirmMemory(context,m.memoryId);assert.throws(()=>service.reviewMemory(context,m.memoryId,review('confirm',{expectedVersion:2})),/待核实/);
});
test('手机管理员核实立即同步机器人索引；只读关系快照不维护和加分',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phone-plugin-'));fs.mkdirSync(path.join(dir,'state'));
 const cfg={ownerQQ:'12345',allow:{groups:['456'],private:['78901']},extensions:{'social-memory':{enabled:true,config:{minimumTiers:{78901:'亲近'}}}}};
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(cfg));const state=path.join(dir,'state');
 const message={userId:'78901',messageId:'source',botAccountId:'10001',plain:'谢谢你的帮助',sender:'测试人物'};
 const integration=createIntegrations({stateDir:state,getConfig:()=>cfg,getConversation:()=>({recentMessages:[message]}),sessionAllowed:key=>cfg.allow.groups.includes(key.slice(6)),tokenOk:()=>true});
 const scope={key:'group:456',assertAuthorized(){}};await integration.host.catalog();
 const dbPath=path.join(state,'extensions/social-memory/memory.db'),service=createSocialMemory({dbPath,policy:policy()}),db=new DatabaseSync(dbPath);
 t.after(async()=>{db.close();service.close();await integration.close();fs.rmSync(dir,{recursive:true,force:true});});
 await integration.host.dispatchMessage(message,scope);
 await integration.host.callTool('qq_social_relationship_event',{messageId:'source',kind:'positive_chat',evidence:'谢谢'},scope);
 const snapshot=()=>JSON.stringify(['relationships','relationship_ledger','relationship_stage_state','interaction_events'].map(name=>db.prepare('SELECT * FROM '+name).all()));
 const m=service.remember(context,{content:'历史喜欢乌龙茶',kind:'preference',confirmed:false,sourceMessageId:'legacy-note:review-fixture',origin:'legacy-import'}).memory;
 const before=snapshot();
 assert(readMemoryLibrary(state).items.find(x=>x.id===m.memoryId).canReview);
 const args={memoryId:m.memoryId,...review('correct',{content:'实际喜欢茉莉花茶'})};delete args.reviewer;
 const result=await integration.host.invokeAdmin('social-memory','review',args,()=>{});assert.equal(result.version,2);assert.equal(result.syncPending,0);
 assert.equal((await integration.host.invokeAdmin('social-memory','review',args,()=>{})).duplicate,true);
 const item=readMemoryLibrary(state).items.find(x=>x.id===m.memoryId);assert.equal(item.canReview,false);assert.equal(item.reviewHistory[0].beforeContent,'历史喜欢乌龙茶');
 const relations=readRelationships(state);assert.equal(relations.readonly,true);assert.equal(relations.items[0].stage,'亲近');assert.equal(relations.items[0].evidence.positive,1);
 assert.equal(snapshot(),before);
 const timestamp=Date.now();t.mock.method(Date,'now',()=>timestamp+3*86400000);readRelationships(state);assert.equal(snapshot(),before);t.mock.restoreAll();
 const parsed=JSON.parse((await integration.host.callTool('qq_social_memory_query',{messageId:'source',query:'茉莉花茶'},scope)).content[0].text);
 assert.equal(parsed.indexes[0].memoryId,m.memoryId);assert(!(await integration.host.catalog()).some(x=>/review/i.test(x.name)));
 const second=service.remember(context,{content:'另条待核实',kind:'preference',confirmed:false,sourceMessageId:'legacy-note:second',origin:'legacy-import'}).memory;
 cfg.allow.groups=[];await assert.rejects(integration.host.invokeAdmin('social-memory','review',{...args,memoryId:second.memoryId,requestId:'request_revoked_123456'},key=>{if(key&&!cfg.allow.groups.includes(key.slice(6)))throw Error('revoked');}),/revoked/);
});
test('真实 HTTP 管理核实认证、agent 隔离以及关系只读',async t=>{
 const h=await bridgeHarness({config:{extensions:{'social-memory':{enabled:true}}}});h.setMode('reserved2');h.setSelfIdentity('fixture','10001');
 const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));await h.close();});
 const origin='http://127.0.0.1:'+server.address().port,headers={'x-console-token':'fixture-console-token','content-type':'application/json'};
 const post=(url,body,extra={})=>fetch(origin+url,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 assert.equal((await fetch(origin+'/api/relationships')).status,401);
 assert.equal((await post('/api/memory-library/review',{}, {'x-console-token':''})).status,401);
 assert.equal((await post('/api/memory-library/review',{}, {'x-agent-call':'1'})).status,403);
 assert.equal((await fetch(origin+'/api/relationships',{headers:{...headers,'x-agent-call':'1'}})).status,403);
 assert.equal((await post('/api/relationships',{closeness:100})).status,405);
 assert.equal((await post('/api/memory-library/review',{closeness:100})).status,400);
 assert.equal((await fetch(origin+'/api/relationships',{headers})).status,200);
});
