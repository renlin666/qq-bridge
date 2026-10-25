import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STAGES } from '../lib/social-memory/src/stages.js';
import { SENSITIVE_RE } from './sensitive.js';

const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {};}};
const safe=value=>SENSITIVE_RE.test(String(value??''))?'[敏感内容已隐藏]':String(value??'');
const rounded=value=>Math.round(Number(value)*10)/10;
function readDb(file,work,fallback){
  if(!fs.existsSync(file))return fallback;
  const db=new DatabaseSync(file,{readOnly:true});
  try{db.exec('PRAGMA query_only=ON; BEGIN');const out=work(db);db.exec('COMMIT');return out;}finally{db.close();}
}

// Snapshot only: do not call getRelationship(), which performs maintenance and writes a ledger.
export function readRelationships(stateDir,params=new URLSearchParams()){
  const directory=path.join(stateDir,'extensions/social-memory'),cfg=readJson(path.join(stateDir,'../config.json'));
  const allowed=new Set([...(cfg.allow?.groups||[]).map(x=>'group:'+x),...(cfg.allow?.private||[]).map(x=>'private:'+x)]);
  const floors=cfg.extensions?.['social-memory']?.config?.minimumTiers||{},now=Date.now();
  const policies=readDb(path.join(directory,'social-policy.db'),db=>{
    const records=db.prepare('SELECT * FROM social_policy_state').all();
    for(const b of db.prepare("SELECT bot,scope,user,count(*) AS n FROM social_policy_events WHERE kind='banter' GROUP BY bot,scope,user").all()){
      let row=records.find(r=>r.bot===b.bot&&r.scope===b.scope&&r.user===b.user);
      if(!row){row={bot:b.bot,scope:b.scope,user:b.user};records.push(row);}row.observedBanter=b.n;
    }
    return records.filter(r=>allowed.has(r.scope));
  },[]);
  const reactions=readJson(path.join(directory,'reactions.json'));
  const people=readDb(path.join(directory,'memory.db'),db=>{
    const names=new Map(db.prepare('SELECT person_id,alias FROM person_aliases ORDER BY last_seen_at').all().map(r=>[r.person_id,r.alias]));
    return db.prepare(`SELECT p.id,p.user_id,p.bot_account_id,p.status,r.*,s.stage AS stage_number
      FROM people p LEFT JOIN relationships r ON r.person_id=p.id LEFT JOIN relationship_stage_state s ON s.person_id=p.id
      ORDER BY r.updated_at DESC,p.user_id`).all().map(p=>{
      const recorded=p.person_id!==null;
      const dimensions=recorded?Object.fromEntries(['closeness','familiarity','trust','boundary'].map(k=>[k,rounded(p[k])])):null;
      const earned=recorded?STAGES[p.stage_number]||null:null,minimum=STAGES.includes(floors[p.user_id])?floors[p.user_id]:null;
      const stage=recorded?(minimum&&STAGES.indexOf(minimum)>STAGES.indexOf(earned)?minimum:earned):null;
      const stats=db.prepare(`SELECT e.kind,e.occurred_at FROM interaction_events e WHERE e.person_id=? AND e.status='applied'
        AND NOT EXISTS(SELECT 1 FROM relationship_ledger l WHERE l.event_id=e.id AND l.status='reverted')`).all(p.id);
      const positive=stats.filter(e=>['positive_chat','shared_activity','support','deep_talk'].includes(e.kind));
      const changes=db.prepare(`SELECT l.id,l.kind,l.deltas_json,l.reason,l.status,l.created_at,l.source_message_id,e.evidence
        FROM relationship_ledger l LEFT JOIN interaction_events e ON e.id=l.event_id WHERE l.person_id=? ORDER BY l.created_at DESC LIMIT 12`).all(p.id)
        .map(e=>({id:e.id,kind:e.kind,deltas:JSON.parse(e.deltas_json),reason:safe(e.reason),status:e.status,at:e.created_at,sourceMessageId:e.source_message_id,evidence:safe(e.evidence)}));
      const scopes=policies.filter(s=>s.bot===p.bot_account_id&&s.user===p.user_id).map(s=>({scope:s.scope,
        preference:s.preference||(s.observedBanter>=3?'light':'unknown'),preferenceConfirmed:!!s.preference,
        conflict:s.conflict==='resolved'?null:s.conflict||null,observedBanter:s.observedBanter||0}));
      const transient=[];
      for(const [key,value]of Object.entries(reactions))try{
        const [bot,scope,user]=JSON.parse(key),r=value.reaction;
        if(bot===p.bot_account_id&&user===p.user_id&&allowed.has(scope)&&r?.expiresAt>now)transient.push({scope,kind:r.kind,expiresAt:r.expiresAt});
      }catch{}
      return {id:p.id,userId:p.user_id,botAccountId:p.bot_account_id,name:safe(names.get(p.id)||p.user_id),personStatus:p.status,recorded,
        score:recorded?rounded(p.closeness*.4+p.familiarity*.3+p.trust*.3):null,dimensions,stage,earnedStage:earned,minimumTier:minimum,
        updatedAt:p.updated_at||null,maintenanceAt:p.maintenance_at||null,
        mood:recorded&&p.mood_expires_at>now?{label:safe(p.mood_label),intensity:p.mood_intensity,expiresAt:p.mood_expires_at}:null,
        evidence:{events:stats.length,positive:positive.length,days:new Set(positive.map(e=>Math.floor(e.occurred_at/86400000))).size,kinds:new Set(positive.map(e=>e.kind)).size},
        scopes,transient,changes};
    });
  },[]);
  const query=String(params.get('q')||'').slice(0,200).toLowerCase(),filtered=people.filter(p=>!query||[p.name,p.userId,p.botAccountId].join(' ').toLowerCase().includes(query));
  const page=Math.max(0,Math.min(10000,Math.trunc(Number(params.get('page'))||0))),size=30;
  return {sampledAt:new Date(now).toISOString(),readonly:true,summary:{people:people.length,scored:people.filter(p=>p.recorded).length},
    formula:'综合分 = 亲近 × 0.4 + 熟悉 × 0.3 + 信任 × 0.3；关系阶段另结合互动证据与既有规则。',
    note:'只读快照。查看不会触发加分、衰减或阶段重算；记忆核实也不直接改变关系分数。',
    items:filtered.slice(page*size,(page+1)*size),total:filtered.length,page,pageSize:size,hasMore:(page+1)*size<filtered.length};
}
