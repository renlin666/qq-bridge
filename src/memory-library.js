import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SENSITIVE_RE } from './sensitive.js';
import { legacyMemoryId } from '../extensions/social-memory/legacy-store.js';

const safe = value => SENSITIVE_RE.test(String(value ?? '')) ? '[敏感内容已隐藏]' : String(value ?? '');
const load = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
function database(file, work, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return work(db); } finally { db.close(); }
}

// Administrator-only view. Review writes use a separate authenticated endpoint.
export function readMemoryLibrary(stateDir, params = new URLSearchParams()) {
  const directory = path.join(stateDir, 'extensions/social-memory');
  const structured = database(path.join(directory, 'memory.db'), db => {
    const names = new Map(db.prepare('SELECT person_id,alias FROM person_aliases ORDER BY last_seen_at').all().map(r => [r.person_id, r.alias]));
    const people = db.prepare(`SELECT p.id,p.user_id,p.bot_account_id,r.tier,s.stage,r.updated_at
      FROM people p LEFT JOIN relationships r ON r.person_id=p.id
      LEFT JOIN relationship_stage_state s ON s.person_id=p.id`).all()
      .map(p => ({ id:p.id, userId:p.user_id, botAccountId:p.bot_account_id, name:safe(names.get(p.id)||p.user_id), stage:p.stage||p.tier, updatedAt:p.updated_at }));
    const person = new Map(people.map(p => [p.id,p]));
    const sources = new Map();
    const reviews=new Map();
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_reviews'").get())for(const r of db.prepare('SELECT * FROM memory_reviews ORDER BY at DESC').all()){
      const history=reviews.get(r.memory_id)||[];
      if(history.length<8)history.push({id:r.id,action:r.action,reviewer:'管理员',at:r.at,fromVersion:r.from_version,toVersion:r.to_version,
        beforeContent:safe(JSON.parse(r.before_json).content),afterContent:safe(JSON.parse(r.after_json).content),note:safe(r.note)});
      reviews.set(r.memory_id,history);
    }
    for (const s of db.prepare('SELECT memory_id,source_message_id,author_person_id,quote FROM memory_sources ORDER BY captured_at').all()) {
      if (!sources.has(s.memory_id)) sources.set(s.memory_id, s);
    }
    const items = db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all().map(m => {
      const source=sources.get(m.id), who=person.get(m.subject_person_id||source?.author_person_id);
      return { id:m.id,type:'structured',botAccountId:m.bot_account_id,scope:m.scope_id,
        userId:who?.userId||'',name:who?.name||'未绑定人物',kind:m.kind,status:m.status==='active'&&m.valid_to&&m.valid_to<=Date.now()?'expired':m.status,confirmed:!!m.confirmed,
        origin:m.origin,content:safe(m.content),version:m.version,reviewHistory:reviews.get(m.id)||[],sourceMessageId:m.source_message_id,evidence:safe(source?.quote||''),
        occurredAt:m.occurred_at,createdAt:m.created_at,updatedAt:m.updated_at,validTo:m.valid_to,
        keywords:JSON.parse(m.keywords_json||'[]'),identityBound:!!who };
    });
    return { people,items,outbox:db.prepare('SELECT status,count(*) AS count FROM sync_outbox GROUP BY status').all(),
      interactionEvents:db.prepare('SELECT count(*) AS n FROM interaction_events').get().n };
  }, {people:[],items:[],outbox:[],interactionEvents:0});
  const legacy = database(path.join(directory,'legacy-memory.db'),db => db.prepare('SELECT * FROM legacy_memory WHERE active=1').all()
    .map(r=>({id:r.id,type:'legacy',botAccountId:r.bot,scope:r.scope,userId:'',name:'旧会话资料',kind:r.origin,status:'legacy',confirmed:false,
      origin:r.origin,content:safe(r.content),sourceMessageId:null,evidence:'旧摘要/印象记录，缺少逐条原消息证据，未自动确认人物事实。',
      keywords:JSON.parse(r.keywords||'[]'),identityBound:false})),[]);
  const capture = database(path.join(directory,'capture.db'),db=>({
    totals:db.prepare('SELECT status,count(*) AS count FROM capture_decisions GROUP BY status').all(),
    recent:db.prepare('SELECT scope,user AS userId,source_id AS sourceMessageId,at,status,reason,memory_ids AS memoryIds FROM capture_decisions ORDER BY at DESC LIMIT 16').all()
      .map(r=>({...r,memoryIds:JSON.parse(r.memoryIds)}))
  }),{totals:[],recent:[]});
  const transfers = new Map(structured.items.filter(m=>m.sourceMessageId?.startsWith('legacy-note:'))
    .map(m=>[legacyMemoryId(m.botAccountId,m.scope,'legacy-shared',m.sourceMessageId.slice(12)),m]));
  for(const item of legacy) {
    const target=transfers.get(item.id);
    if(target) { item.migratedTo=target.id;item.evidence+=` 已整理到结构化记录 ${target.id}（${target.status==='forgotten'?'已驳回或遗忘':target.confirmed?'已确认':'待核实'}），原文继续保留。`; }
  }
  const q=String(params.get('q')||'').slice(0,200).toLocaleLowerCase(),scope=String(params.get('scope')||''),user=String(params.get('user')||''),type=params.get('type')||'all';
  const status=params.get('status')||'all';
  const all=[...structured.items,...legacy];
  const filtered=all.filter(m=>(type==='legacy'||!m.migratedTo)&&(type==='all'||m.type===type)&&(status==='all'||m.status===status)&&(!scope||m.scope===scope)&&(!user||m.userId===user)
    &&(!q||[m.content,m.name,m.userId,m.scope,m.sourceMessageId,...m.keywords].join(' ').toLocaleLowerCase().includes(q)));
  const page=Math.max(0,Math.min(10000,Math.trunc(Number(params.get('page'))||0))),size=30;
  const config=load(path.join(stateDir,'../config.json'));
  for(const item of structured.items){
    const scopeAllowed=item.scope.startsWith('group:')?(config.allow?.groups||[]).map(String).includes(item.scope.slice(6))
      :item.scope==='private:'+item.userId&&(config.allow?.private||[]).map(String).includes(item.userId);
    item.canReview=item.status==='proposed'&&!!item.identityBound&&scopeAllowed&&(!item.validTo||item.validTo>Date.now())
      &&config.extensions?.['social-memory']?.enabled===true&&config.socialV2?.tools?.memory!==false;
  }
  return { sampledAt:new Date().toISOString(),summary:{structured:structured.items.length,
    active:structured.items.filter(m=>m.status==='active').length,proposed:structured.items.filter(m=>m.status==='proposed').length,
    legacy:legacy.length,linkedLegacy:transfers.size,people:structured.people.length,interactionEvents:structured.interactionEvents,outbox:structured.outbox},
    capture:{...capture,enabled:config.extensions?.['social-memory']?.enabled!==false && config.extensions?.['social-memory']?.config?.autoCapture!==false && config.socialV2?.tools?.memory!==false,
      migration:load(path.join(directory,'backfill-report.json'))},
    people:structured.people,scopes:[...new Set(all.map(m=>m.scope))].sort(),items:filtered.slice(page*size,(page+1)*size),
    total:filtered.length,page,pageSize:size,hasMore:(page+1)*size<filtered.length };
}
