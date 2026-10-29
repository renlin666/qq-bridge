import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCsMemeService, csCommentaryActive, readCsMemeApi} from '../src/cs-memes.js';
import {createPluginHost} from '../src/plugin-host/index.js';
import {BUILTIN_IDS} from '../src/plugin-host/catalog.js';
import {toolCategory} from '../plugins/qq-agent-presets/qq-tool-discovery.mjs';
import {createIntegrations} from '../src/project-integrations.js';
const ROOT=fileURLToPath(new URL('..',import.meta.url)), NOW=Date.parse('2026-10-26T04:00:00Z');
let seq=0;
const human=(text,time=NOW)=>({text,time,messageId:String(++seq),userId:'123'});
const conversation=(...texts)=>({recentMessages:texts.map((text,i)=>human(text,NOW-1000*(texts.length-i-1)))});
const match={id:'csgo_mc_2399727',status:'completed',tournament:'PGL',teams:[{name:'Spirit',seriesScore:2,players:[{name:'donk'}]},
  {name:'TYLOO',seriesScore:0,players:[{name:'Jee'}]}],maps:[{name:'Anubis',status:'completed',scores:[13,3]}]};
const args={matchId:match.id,query:'donk',action:'search',limit:4};
function fixture(options={}) {
  let st=conversation('解说昨天绿龙打天禄的CS比赛'); const config={csMemesEnabled:true};
  const service=createCsMemeService({getConversation:()=>st,getConfig:()=>config,queryMatch:async()=>({ok:true,matches:[match]}),
    readApi:async()=>({list:Array.from({length:6},(_,i)=>({id:i+1,barrage:'donk梗'+i}))}),now:()=>NOW,...options});
  return {service,config,setConversation:value=>{st=value;}};
}

test('only recent admitted CS match commentary enables memes, with LOL/topic/stop isolation',()=>{
  for(const texts of [['CS比赛现在比分多少'],['绿龙打天禄，解说一下','这回合太抽象了'],['donk比赛空枪了']]) assert(csCommentaryActive(conversation(...texts),NOW));
  for(const texts of [['LOL世界赛T1比赛'],['CS的显卡怎么设置'],['今晚吃什么'],['CS比赛比分','现在聊LOL比赛'],
    ['CS比赛比分','晚上吃什么','来个梗'],['CS比赛比分','认真分析这回合'],['CS比赛比分','别玩梗']]) assert.equal(csCommentaryActive(conversation(...texts),NOW),false,texts.join('/'));
  assert.equal(csCommentaryActive({recentMessages:[human('CS比赛',NOW-11*60000)]},NOW),false);
  assert.equal(csCommentaryActive({recentMessages:[{...human('CS比赛'),isSelf:true}]},NOW),false);
});

test('service includes verified scoreboard while supplying concise humor candidates',async()=>{
  const {service,config}=fixture();const r=await service.query('group:123',args,config,()=>{});
  assert.equal(r.source,'sb6657_online');assert.equal(r.items.length,4);
  assert.deepEqual(r.scoreboard.teams.map(t=>t.seriesScore),[2,0]);assert.deepEqual(r.scoreboard.maps[0].scores,[13,3]);
  assert.match(r.style,/以娱乐聊天为主/);assert.match(r.style,/不必逐条复盘事实/);
});

test('a verified live CS match preserves image/acknowledgement commentary but not a new daily or LOL topic',()=>{
  const f=fixture();f.setConversation(conversation('[图片]'));assert.equal(f.service.active('group:123',f.config),false);
  f.service.noteMatch('group:123',{game:'cs2',ok:true,matches:[{status:'live'}]});
  assert.equal(f.service.active('group:123',f.config),true);assert.equal(f.service.active('group:456',f.config),false);
  assert.equal(csCommentaryActive({recentMessages:[human('晚上吃什么',NOW+1),human('[图片]',NOW+2)]},NOW+3,NOW),false);
  assert.equal(csCommentaryActive(conversation('LOL比赛'),NOW,NOW-1),false);
});

test('active live commentary continues through a quiet group, and final results stop its cadence',()=>{
  let clock=NOW;const f=fixture({now:()=>clock});
  assert.equal(f.service.liveCommentary('group:123'),false);
  f.service.noteMatch('group:123',{game:'cs2',ok:true,matches:[{status:'live'}]});
  clock+=9*60000;
  f.service.noteMatch('group:123',{game:'cs2',ok:true,matches:[{status:'live'}]});
  clock+=2*60000;
  assert(f.service.liveCommentary('group:123'),'fresh live reads sustain commentary without new human messages');
  f.service.noteMatch('group:123',{game:'cs2',ok:true,matches:[{status:'completed'}]});
  assert.equal(f.service.liveCommentary('group:123'),false);
  f.service.noteMatch('group:123',{game:'cs2',ok:true,matches:[{status:'live'}]});
  clock+=11*60000;assert.equal(f.service.liveCommentary('group:123'),false,'failed/stale polling cannot keep running forever');
});

test('both search and hot tools are denied outside CS commentary before any network request',async()=>{
  const f=fixture({readApi:()=>{throw new Error('must not reach network');}});f.setConversation(conversation('LOL比赛'));
  for(const action of ['search','hot']) await assert.rejects(f.service.query('group:123',{...args,action},f.config,()=>{}),/仅在/);
  f.setConversation(conversation('CS比赛'));f.config.csMemesEnabled=false;
  await assert.rejects(f.service.query('group:123',args,f.config,()=>{}),/仅在/);
});

test('invalid scoreboard and private/raw queries never leave for the meme site',async()=>{
  const broken=fixture({queryMatch:async()=>({ok:false,matches:[]}),readApi:()=>{throw new Error('must not read');}});
  assert.equal((await broken.service.query('group:123',args,broken.config,()=>{})).status,'scoreboard_unavailable');
  const f=fixture();await assert.rejects(f.service.query('group:123',{...args,query:'我朋友的QQ号123456'},f.config,()=>{}),/仅接受/);
  await assert.rejects(f.service.query('group:123',{...args,matchId:'../secret'},f.config,()=>{}),/真实CS比赛/);
});

test('online and offline candidates do not repeat in one chat, and scopes remain independent',async()=>{
  const f=fixture();const a=await f.service.query('group:123',args,f.config,()=>{}),b=await f.service.query('group:123',args,f.config,()=>{});
  assert(a.items.every(x=>!b.items.some(y=>x.id===y.id)));assert.equal(b.items.length,2);
  assert.equal((await f.service.query('group:123',args,f.config,()=>{})).items.length,0);
  assert.equal((await f.service.query('group:456',args,f.config,()=>{})).items.length,4);
  const off=fixture({readApi:async()=>{throw new Error('offline');}});const used=new Set();
  for(let i=0;i<4;i++) {
    const r=await off.service.query('group:123',args,off.config,()=>{});assert.equal(r.source,'offline_seed');assert.match(r.evidenceRule,/不是当天热梗/);
    for(const item of r.items){assert(!used.has(item.id));used.add(item.id);}
  }
  assert(used.size>0);
});

test('recent real sends cool repeated meme families and identical text with different IDs, across restarts',async()=>{
  const rows=[{id:'book',barrage:'怀念四本书：《大学》已肄业，《论语》连载中'},
    {id:'drone',barrage:'未经报备的无人Jee不许进入禁飞区'},
    {id:'same1',barrage:'残局开成了五人相声专场'},
    {id:'same2',barrage:'残局开成了五人相声专场！'},
    {id:'fresh',barrage:'这个烟雾弹是给对手开了盲盒'}];
  for(let restart=0;restart<2;restart++){
    const f=fixture({readApi:async()=>({list:rows})});
    f.setConversation({recentMessages:[
      {...human('9z这张《大学》已肄业，下一回合《论语》连载',NOW-2000),isSelf:true},
      {...human('天禄守成禁飞区，无人Jee不让进',NOW-1000),isSelf:true},human('CS比赛这回合呢')
    ]});
    const result=await f.service.query('group:123',{...args,limit:8},f.config,()=>{});
    assert.deepEqual(result.items.map(i=>i.id),['same1','fresh']);
    assert.equal(result.diversity.filteredCandidates,2);assert.equal(result.diversity.coolingTopics.length,2);
    assert.equal(result.diversity.recentMessages.length,2);
    // The actual send history belongs to this conversation, never to another group.
    f.setConversation(conversation('CS比赛'));const other=await f.service.query('group:456',{...args,limit:8},f.config,()=>{});
    assert(other.items.some(i=>i.id==='book'));
    const sameGroup=await f.service.query('group:123',{...args,limit:8},f.config,()=>{});
    assert(!sameGroup.items.some(i=>i.id==='same2'),'punctuation/ID changes cannot bypass offered-text deduplication');
  }
});

test('topic changes and disabling the flag revoke a request already waiting on the API',async()=>{
  for(const change of ['topic','config']) {
    let finish;const f=fixture({readApi:()=>new Promise(resolve=>{finish=resolve;})});
    const pending=f.service.query('group:123',args,f.config,()=>{});await new Promise(resolve=>setImmediate(resolve));
    if(change==='topic')f.setConversation(conversation('晚上吃饭'));else f.config.csMemesEnabled=false;
    finish({list:[{id:'x',barrage:'candidate'}]});await assert.rejects(pending,/仅在/);
  }
});

test('hot windows map to fixed read-only routes and cancellation cannot turn into offline success',async()=>{
  const seen=[];const f=fixture({readApi:async(route)=>{seen.push(route);return route.endsWith('getRandOne')?{id:'x',barrage:'random'}:[{id:route,barrage:'hot'}];}});
  for(const window of ['24h','7d','random'])await f.service.query('group:123',{...args,action:'hot',window},f.config,()=>{});
  assert.deepEqual(seen,['/machine/hotBarrageOf24H','/machine/hotBarrageOf7Day','/machine/getRandOne']);
  const abort=new AbortController();abort.abort();await assert.rejects(f.service.query('group:123',args,f.config,()=>{},abort.signal),/取消/);
  await assert.rejects(readCsMemeApi('/machine/vote',{}),/不受支持/);
});

test('real extension host routes both meme tools, injects CS style, and drops it for LOL',async t=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-cs-memes-'));
  const f=fixture(), cfg={extensions:Object.fromEntries(BUILTIN_IDS.map(id=>[id,{enabled:id==='esports',config:id==='esports'?f.config:{}}]))};
  const host=createPluginHost({root:ROOT,stateDir,getConfig:()=>cfg,services:{
    'cs-memes.context':key=>({active:f.service.active(key,f.config)}),
    'cs-memes.query':(key,args,authorize,signal)=>f.service.query(key,args,f.config,authorize,signal),
    'esports.query':async()=>({status:'available',matches:[match]})}});
  t.after(async()=>{await host.close();fs.rmSync(stateDir,{recursive:true,force:true});});
  const scope={key:'group:123',assertAuthorized(){}};
  const hint=await host.collectContext({plain:'解说CS比赛'},scope);assert.match(hint,/CS娱乐解说/);assert.match(hint,/不必逐回合严肃复盘/);assert.match(hint,/顺带返回最近回合eventLog/);
  const r=await host.callTool('qq_cs_meme_search',{matchId:match.id,query:'donk'},scope);assert.equal(JSON.parse(r.content[0].text).items.length,4);
  assert.equal(toolCategory('mcp__snowluma__qq_cs_meme_hot'),'web');
  f.setConversation(conversation('LOL比赛'));
  assert.doesNotMatch(await host.collectContext({plain:'LOL比赛'},scope),/CS娱乐解说/);
  await assert.rejects(host.callTool('qq_cs_meme_hot',{matchId:match.id},scope),/仅在/);
});

test('CS commentary score queries automatically include one bounded event page; ordinary chat does not',async t=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-cs-rounds-'));
  const cfg={extensions:Object.fromEntries(BUILTIN_IDS.map(id=>[id,{enabled:id==='esports',config:id==='esports'?{csMemesEnabled:true}:{}}]))};
  let st={recentMessages:[human('CS比赛现在天禄比分多少',Date.now())]},calls=[],failEvents=false;
  const live={...match,status:'live'};
  const integration=createIntegrations({stateDir,getConfig:()=>cfg,getConversation:()=>st,sessionAllowed:()=>true,tokenOk:()=>true,
    queryEsports:async args=>{calls.push(args);return args.mode==='events'?(failEvents?{ok:false,matches:[]}:{ok:true,matches:[{...live,eventLog:{status:'available',events:[{type:'kill'}]}}]}):{game:'cs2',ok:true,matches:[live]};}});
  t.after(async()=>{await integration.close();fs.rmSync(stateDir,{recursive:true,force:true});});
  const scope={key:'group:123',assertAuthorized(){}};
  const read=async()=>JSON.parse((await integration.host.callTool('qq_esports',{game:'cs2',mode:'live',query:'TYLOO'},scope)).content[0].text);
  const result=await read();assert.equal(calls.length,2);assert.equal(calls[1].maxEventPages,1);
  assert.equal(result.commentaryEvents.attempted,true);assert.equal(result.matches[0].eventLog.events[0].type,'kill');
  assert.equal(result.commentary.refreshAfterMs,20000);assert(integration.csCommentaryFor(scope.key));
  calls=[];st={recentMessages:[human('晚饭吃什么',Date.now())]};await read();assert.equal(calls.length,1);
  assert.equal(integration.csCommentaryFor(scope.key),false);
  calls=[];st={recentMessages:[human('CS比赛',Date.now())]};failEvents=true;
  const fallback=await read();assert.equal(fallback.matches[0].teams[0].seriesScore,2);assert.equal(fallback.commentaryEvents.status,'unavailable');
});
