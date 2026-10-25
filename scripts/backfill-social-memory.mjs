// Explicit operator backfill. Source input contains original messages and separately marked old notes.
import fs from 'node:fs';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createPluginHost} from '../src/plugin-host/index.js';
import {createSocialMemory,createWhitelistPolicy} from '../lib/social-memory/src/index.js';
import {PersistentIndexAdapter} from '../extensions/social-memory/persistent-index.js';
import {extractSelfStatements} from '../extensions/social-memory/auto-capture.js';
import {SENSITIVE_RE} from '../src/sensitive.js';
import {fileURLToPath} from 'node:url';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const inputPath=process.argv[2];if(!inputPath)throw Error('Usage: node scripts/backfill-social-memory.mjs evidence.json [--apply]');
const apply=process.argv.includes('--apply'),input=JSON.parse(fs.readFileSync(inputPath,'utf8')),cfg=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
const extra=cfg.extensions?.['social-memory']?.config||{};
if(cfg.extensions?.['social-memory']?.enabled!==true||cfg.socialV2?.tools?.memory===false)throw Error('Memory is disabled; backfill refused');
const allowed=new Set([...(cfg.allow?.groups||[]).map(x=>'group:'+x),...(cfg.allow?.private||[]).map(x=>'private:'+x)]);
const basePeople=[...new Set([...(cfg.allow?.private||[]),...(extra.people||[]),cfg.ownerQQ].filter(Boolean).map(String))];
const messages=input.messages.filter(x=>allowed.has(x.key)&&x.message.botAccountId===input.botAccountId&&!x.message.isSelf);
const observed=new Set(basePeople);
if(extra.captureGroupSpeakers)for(const x of messages)if(x.key.startsWith('group:'))observed.add(x.message.userId);
const currentScope=(key,user)=>allowed.has(key)&&(key==='private:'+user||(key.startsWith('group:')&&observed.has(user)));
const notes=input.legacy.filter(n=>currentScope(n.sourceKey,String(n.userId))&&/^[1-9]\d{4,11}$/.test(String(n.userId))&&n.origin==='impression'
 && n.content?.length>=6&&n.content.length<=500&&!SENSITIVE_RE.test(n.content)
 && !/规矩|要求|规定|必须|不许|不准|别跟|让我|让你|不能|不要|授权|API|令牌|配置|代写|自封|爷爷|你爹|dad|妈妈|[，、：:]$/.test(n.content)
 && !/[（(][^）)]*$/.test(n.content));
const candidates=messages.filter(x=>observed.has(x.message.userId)&&extractSelfStatements(x.message.text).length);
const report={at:new Date().toISOString(),originalMessages:messages.length,candidateMessages:candidates.length,eligibleLegacyNotes:notes.length,
 autoAdded:0,legacyAdded:0,skippedLegacy:input.legacy.length-notes.length,applied:apply};
if(!apply){console.log(JSON.stringify(report));process.exit(0);}
const stateDir=path.join(root,'state'),directory=path.join(stateDir,'extensions/social-memory');
const count=()=>{const db=new DatabaseSync(path.join(directory,'memory.db'),{readOnly:true});try{return db.prepare('SELECT count(*) AS n FROM memories').get().n;}finally{db.close();}};
const before=count();
const onlyMemory={...cfg,extensions:{...cfg.extensions,...Object.fromEntries(['bilibili','image-search','quark','qzone'].map(id=>[id,{enabled:false}]))}};
let current;
const host=createPluginHost({root,stateDir,getConfig:()=>onlyMemory,services:{readMessage:()=>current,
 'memory.policy':()=>({people:basePeople,groups:(cfg.allow?.groups||[]).map(String),minimumTiers:extra.minimumTiers||{},enabled:true}),
 'memory.legacy':key=>key?[]:{scopes:[]}},log:(...args)=>process.stderr.write(args.join(' ')+'\n')});
try{
 await host.ready;
 for(const item of messages){current=item.message;await host.dispatchMessage(current,{key:item.key,assertAuthorized(){if(!allowed.has(item.key))throw Error('scope revoked');}});}
}finally{await host.close();}
report.autoAdded=count()-before;
const policy=createWhitelistPolicy({bots:{[input.botAccountId]:{people:[...observed],groups:cfg.allow.groups.map(String)}}});
const adapter=new PersistentIndexAdapter(path.join(directory,'keyword-index.db'));
const service=createSocialMemory({dbPath:path.join(directory,'memory.db'),policy,adapter,relationshipStages:true,
 extractor:{name:'disabled-for-backfill',extract:()=>({memories:[],interactions:[]})}});
try{
 for(const n of notes){
  const group=n.sourceKey.startsWith('group:');
  const context={platform:'qq',botAccountId:input.botAccountId,actor:{userId:String(n.userId),displayName:n.name||String(n.userId)},conversation:{kind:group?'group':'private',id:n.sourceKey,...(group?{groupId:n.sourceKey.slice(6)}:{})}};
  const value=service.remember(context,{content:n.content,kind:'experience',confirmed:false,confidence:.4,origin:'legacy-import',
   subjectUserId:String(n.userId),sourceMessageId:'legacy-note:'+n.id,quote:'历史印象摘要（缺少逐条原消息证据，待核实）：'+n.content,occurredAt:n.at});
  if(!value.duplicate&&!value.suppressed)report.legacyAdded++;
 }
 await service.syncOutbox();
}finally{service.close();adapter.close();}
const reportPath=path.join(directory,'backfill-report.json');
let previous={};try{previous=JSON.parse(fs.readFileSync(reportPath,'utf8'));}catch{}
fs.writeFileSync(reportPath,JSON.stringify({...report,autoAdded:report.autoAdded+(previous.autoAdded||0),
 legacyAdded:report.legacyAdded+(previous.legacyAdded||0),runs:(previous.runs||0)+1,lastRun:report},null,2),{mode:0o600});
console.log(JSON.stringify(report));
