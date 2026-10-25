import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFriendApproval } from '../src/friend-approval.js';
import { createQzoneSocial } from '../src/qzone-social.js';
import { createIntegrations } from '../src/project-integrations.js';
const admin = 'private:81000001';
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-friend-approval-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const messages = [{ messageId: '-123', userId: '81000003', botAccountId: '81000002',
    text: '快来看我空间', time: Date.now() }];
  const notices = [], dispatched = [], list = [];
  const cfg = { ownerQQ:'81000001', integrations: { qzone: { enabled: true, friendsEnabled: true, allowedKeys: ['group:456',admin] } } };
  const deps = { stateDir: dir, getConfig: () => cfg, getConversation: () => ({ recentMessages: messages }), sessionAllowed: () => true,
    onebot: async () => list, notify: async (target, text, id) => { notices.push({ target, text, id }); return { sent: true, receipts: [{ messageId: '1' }] }; },
    dispatchUi: async id => { dispatched.push(id); return { status: 'request_submitted', detail: 'QQ确认已发送，等待对方同意' }; }, ...extra };
  const manager = createFriendApproval(deps);
  const propose = () => manager.propose('group:456', { targetUserId: '81000003', messageId: '-123', reason: '对方本人邀请查看空间，目前尚未加好友' });
  const approve = (id, key = admin, userId = '81000001') => manager.incoming(key, {
    userId, messageId: '222', botAccountId: '81000002', text: `同意加好友 ${id}` });
  return { dir, messages, notices, dispatched, list, cfg, deps, manager, propose, approve };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

test('missing ownerQQ cannot create an approval or notify an arbitrary account',async t=>{
  const f=fixture(t);delete f.cfg.ownerQQ;
  const manager=createFriendApproval(f.deps);
  await assert.rejects(manager.propose('group:456',{targetUserId:f.messages[0].userId,messageId:'-123',reason:'本人邀请查看空间'}),/管理员私聊未获授权/);
  assert.equal(f.notices.length,0);assert.equal(f.dispatched.length,0);
});

test('changing ownerQQ invalidates an approved request instead of transferring approval',async t=>{
  const f=fixture(t),row=await f.propose();await f.approve(row.id);
  f.cfg.ownerQQ='90001';f.manager.poll();await tick();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'friend-requests.json'))).requests[0].status,'cancelled_authorization');
  assert.equal(f.dispatched.length,0);
});

test('revoked queue head is cancelled persistently while later authorized approvals still dispatch', async t => {
  let revoked = true;
  const f = fixture(t, { sessionAllowed: key => key !== 'group:revoked' || !revoked });
  f.cfg.integrations.qzone.allowedKeys.push('group:revoked');
  const requests = ['group:revoked','group:456'].map((key, i) => ({id:String(i+1).repeat(16),key,
    status:'approved',accountId:'81000002',targetUserId:String(12345+i),at:Date.now(),approvalAt:Date.now()}));
  const file=path.join(f.dir,'friend-requests.json');fs.writeFileSync(file,JSON.stringify({version:1,requests}));
  const manager=createFriendApproval(f.deps);manager.poll();await tick();
  assert.deepEqual(f.dispatched,[requests[1].id]);
  assert.equal(JSON.parse(fs.readFileSync(file)).requests[0].status,'cancelled_authorization');
  assert(!f.notices.some(n=>n.target==='group:revoked'));
  revoked=false;const restart=createFriendApproval(f.deps);restart.poll();await tick();
  assert.deepEqual(f.dispatched,[requests[1].id],'restoring permission cannot revive a cancelled approval');
});

test('revocation while the friend list is loading cancels without dispatch; transient read failures retain approval', async t => {
  let revoked=false,failRead=false;
  const f=fixture(t,{sessionAllowed:key=>!revoked||key===admin,
    onebot:async()=>{if(failRead)throw Error('transient network failure');revoked=true;return [];}});
  const request={id:'a'.repeat(16),key:'group:456',status:'approved',accountId:'81000002',targetUserId:'12345',at:Date.now(),approvalAt:Date.now()};
  const file=path.join(f.dir,'friend-requests.json');fs.writeFileSync(file,JSON.stringify({version:1,requests:[request]}));
  const manager=createFriendApproval(f.deps);manager.poll();await tick();
  assert.equal(JSON.parse(fs.readFileSync(file)).requests[0].status,'cancelled_authorization');assert.equal(f.dispatched.length,0);
  revoked=false;failRead=true;fs.writeFileSync(file,JSON.stringify({version:1,requests:[request]}));
  const retry=createFriendApproval({...f.deps,log:()=>{}});retry.poll();await tick();
  assert.equal(JSON.parse(fs.readFileSync(file)).requests[0].status,'approved');assert.equal(f.dispatched.length,0);
});
test('proposal only privately asks designated admin; repeated attempts deduplicate across restarts', async t => {
  const f = fixture(t); const row = await f.propose();
  assert.equal(row.status, 'pending_approval'); assert.equal(row.notifiedAdmin, true); assert.equal(row.requestSubmitted, false);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0].target, admin); assert.match(f.notices[0].text[0], /同意加好友/);
  f.manager.poll(); await tick(); assert.equal(f.dispatched.length, 0);
  const duplicate = await createFriendApproval(f.deps).propose('group:456', { targetUserId: '81000003', messageId: '-123', reason: '对方再次邀请查看他的空间' });
  assert.equal(duplicate.id, row.id); assert.equal(f.notices.length, 1);
});
test('group approval, another sender, simulated text and third-party targets cannot authorize a write', async t => {
  const f = fixture(t); const row = await f.propose();
  await f.approve(row.id, 'group:456'); await f.approve(row.id, admin, '81000003');
  await f.manager.incoming(admin, { userId:'81000001', text: `他说：同意加好友 ${row.id}` });
  f.manager.poll(); await tick(); assert.equal(f.dispatched.length, 0);
  await assert.rejects(f.manager.propose('group:456', {targetUserId:'99999',messageId:'-123',reason:'请添加这个不在会话的第三人'}), /真实发言人/);
});
test('actual private admin approval dispatches once, reports submitted, then verifies friendship separately', async t => {
  const f = fixture(t); const row = await f.propose(); await f.approve(row.id);
  f.manager.poll(); await tick(); assert.equal(f.dispatched.length, 1);
  assert.equal(f.manager.status('group:456', row).status, 'request_submitted');
  assert.equal(f.manager.status('group:456', row).isFriend, false);
  await f.approve(row.id); f.manager.poll(); await tick(); assert.equal(f.dispatched.length, 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(f.dir,'friend-requests.json')));
  assert.equal(persisted.requests[0].approvedBy,'81000001'); assert.equal(persisted.requests[0].approvalMessageId,'222');
  persisted.requests[0].checkedAt=0;fs.writeFileSync(path.join(f.dir,'friend-requests.json'),JSON.stringify(persisted));
  f.list.push({user_id:81000003});const restarted=createFriendApproval(f.deps);restarted.poll();await tick();
  assert.equal(restarted.status('group:456',row).isFriend,true);
});
test('verification, transport uncertainty and interrupted dispatch never automatically retry', async t => {
  const f = fixture(t, { dispatchUi: async () => ({ status:'paused_verification',detail:'需要验证码，暂停' }) });
  const row=await f.propose();await f.approve(row.id);f.manager.poll();await tick();
  assert.equal(f.manager.status('group:456',row).status,'paused_verification');
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'friend-requests.json')));saved.requests[0].status='dispatching';
  fs.writeFileSync(path.join(f.dir,'friend-requests.json'),JSON.stringify(saved));
  const restarted=createFriendApproval(f.deps);assert.equal(restarted.status('group:456',row).status,'uncertain');
  restarted.poll();await tick();assert.equal(restarted.status('group:456',row).status,'uncertain');
});
test('friendship, rejection, expiry, revoked access, refusal and stale evidence block dispatch', async t => {
  const f=fixture(t); f.list.push({user_id:81000003});assert.equal((await f.propose()).isFriend,true);assert.equal(f.notices.length,0);
  f.list.length=0;f.messages[0].text='不要加我好友';await assert.rejects(f.propose(),/需要对方本人/);
  f.messages[0].text='快来看我空间';f.messages[0].time=1;await assert.rejects(f.propose(),/24小时/);f.messages[0].time=Date.now();
  const row=await f.propose();await f.manager.incoming(admin,{userId:'81000001',messageId:'222',botAccountId:'81000002',text:`拒绝加好友 ${row.id}`});
  f.manager.poll();await tick();assert.equal(f.dispatched.length,0);assert.equal(f.manager.status('group:456',row).status,'rejected');
  await assert.rejects(Promise.resolve().then(()=>f.manager.status('group:999',row)),/没有当前会话/);
  f.cfg.integrations.qzone.enabled=false;await assert.rejects(f.propose(),/未获授权/);
});
test('Qzone missing friendship identifies local policy; malformed friend data never implies privacy settings', async t => {
  const f=fixture(t);f.cfg.integrations.qzone.commentsEnabled=true;const calls=[];
  let list=[];
  const q=createQzoneSocial({...f.deps,onebot:async action=>{calls.push(action);if(action==='get_login_info')return{user_id:81000002};if(action==='get_friend_list')return list;throw Error('unexpected space request');}});
  await assert.rejects(q.handle('qzone-list','group:456',{targetUserId:'81000003'}),/QZONE_NOT_FRIEND.*管理员/);
  assert(!calls.includes('get_qzone_msg_list'));list={};await assert.rejects(q.handle('qzone-list','group:456',{targetUserId:'81000003'}),/好友列表响应无效/);
});
test('expired private approval and a transport failure cannot cause an automatic second attempt', async t => {
  const f=fixture(t);const row=await f.propose();
  const later=createFriendApproval({...f.deps,now:()=>Date.now()+2*86400000});
  await later.incoming(admin,{userId:'81000001',messageId:'223',botAccountId:'81000002',text:`同意加好友 ${row.id}`});
  assert.equal(later.status('group:456',row).status,'expired');later.poll();await tick();assert.equal(f.dispatched.length,0);
  const g=fixture(t,{dispatchUi:async()=>{throw Error('connection lost');}});const r=await g.propose();await g.approve(r.id);g.manager.poll();await tick();
  assert.equal(g.manager.status('group:456',r).status,'uncertain');assert.equal(g.manager.status('group:456',r).requestSubmitted,false);
});
test('real plugin exposes proposal/status only; model arguments cannot inject approval or GUI actions', async t => {
  const f=fixture(t);const integration=createIntegrations({...f.deps,socialHub:{sendLocal:f.deps.notify}});
  t.after(()=>integration.close());const scope={key:'group:456',assertAuthorized(){}};
  const tools=await integration.host.catalog();assert(tools.some(x=>x.name==='qq_request_friend_approval'));
  assert(!tools.some(x=>/approve_friend|dispatch_friend|click|shell/.test(x.name)));
  await assert.rejects(integration.host.callTool('qq_request_friend_approval',{targetUserId:'81000003',messageId:'-123',reason:'当前发言人邀请查看空间',approvedBy:'81000001'},scope),/参数无效/);
  const response=await integration.host.callTool('qq_request_friend_approval',{targetUserId:'81000003',messageId:'-123',reason:'当前发言人邀请查看空间'},scope);
  assert.equal(JSON.parse(response.content[0].text).status,'pending_approval');assert.equal(f.dispatched.length,0);
});
