import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {planTimelineTimes,videoToolResult} from '../src/bilibili-media.js';
import {transcribeSocket} from '../src/speech-socket.js';
const bv='BV1xx411c7mD';
test('视频独立唤醒：零概率、潜水、无需@、峰时均不能拦截；引用旧视频不触发',async()=>{
 const h=await bridgeHarness({config:{socialV2:{peakEconomy:{enabled:true,mode:'peak',probability:0,minIntervalMs:900000}}}});
 try{
  h.setMode('reserved2');h.setSelfIdentity('fixture','10001');const st=h.getSocialV2State('group:456');st.bootstrapSent=true;
  st.wakeConfig={mode:'diving',infinite:true,triggers:{probability:0},batchWindowMs:8000};
  const incoming=message=>h.handleIncoming('group',456,{self_id:10001,user_id:123,group_id:456,message_id:'share',sender:{nickname:'fixture'},message},h.cfg);
  await incoming([{type:'text',data:{text:'https://www.bilibili.com/video/'+bv}}]);
  assert(st.pendingWakeTimer,'B站分享必须计划唤醒');
  clearTimeout(st.pendingWakeTimer);st.pendingWakeTimer=null;
  await h.sendWakePromptV2('group:456','video');assert.equal(h.calls.prompts.length,1,'峰时仍投递视频唤醒');
  const prompt=h.calls.prompts[0].content.map(p=>p.text||'').join('\n');
  assert.match(prompt,/视频分享必唤醒/);assert.match(prompt,/180秒/);assert.doesNotMatch(prompt,/≤5分钟/);
  assert.match(prompt,/没看视频，只看标题/);assert.match(prompt,/全时间线/);assert.match(prompt,/画面采样/);
 }finally{await h.close();}
 for(const [label,message,wake]of [
  ['native',[{type:'video',data:{file:'fixture.mp4'}}],true],
  ['card',[{type:'json',data:{data:JSON.stringify({meta:{detail_1:{title:'fixture',qqdocurl:'https://b23.tv/fixture'}}})}}],true],
  ['ordinary',[{type:'text',data:{text:'普通聊天'}}],false],
  ['quoted',[{type:'reply',data:{id:'old-video'}},{type:'text',data:{text:'之前那个'}}],false]
 ]){
  const h=await bridgeHarness();try{h.setMode('reserved2');const st=h.getSocialV2State('group:456');st.bootstrapSent=true;st.wakeConfig={mode:'diving',infinite:true,triggers:{probability:0},batchWindowMs:8000};
   await h.handleIncoming('group',456,{self_id:10001,user_id:123,group_id:456,message_id:label,sender:{nickname:'fixture'},message},h.cfg);
   assert.equal(!!st.pendingWakeTimer,wake,label);
  }finally{await h.close();}
 }
});
test('整个时间线覆盖开头、两秒间隔和最后画面；联系表将准确时间点送入模型',()=>{
 for(const duration of [.1,1,2,16,88,180]){const t=planTimelineTimes(duration);assert.equal(t[0],0);assert(t.at(-1)>=duration-1);assert(t.every(x=>x>=0&&x<duration));assert(t.every((x,i)=>i===0||x-t[i-1]<=2));}
 for(const duration of [0,-1,NaN,Infinity])assert.throws(()=>planTimelineTimes(duration));
 assert(planTimelineTimes(3600).length<=92,'授权长视频也不能无界返回图片');
 const r=videoToolResult({video:{frames:[{seconds:0,timestamps:[0,2,4],mimeType:'image/jpeg',data:'sample'}]}});
 assert.deepEqual(JSON.parse(r.content[0].text).video.frameTimestamps,[0,2,4]);assert.match(r.content[1].text,/从左到右、从上到下/);assert.equal(r.content[2].type,'image');
});
test('音轨客户端仅连接本机套接字，发送实际WAV并传播错误、响应大小限制和超时',async t=>{
 if(process.platform==='win32'){t.skip('Unix socket transport is checked on Linux');return;}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-speech-test-')),socket=path.join(dir,'asr.sock');let mode='ok';
 const server=http.createServer(async(req,res)=>{const body=[];for await(const b of req)body.push(b);assert.equal(Buffer.concat(body).length,100);assert.equal(req.url,'/transcribe');
  if(mode==='timeout')return;if(mode==='oversize'){res.end('x'.repeat(129*1024));return;}res.writeHead(mode==='error'?503:200,{'content-type':'application/json'});res.end(JSON.stringify(mode==='error'?{error:'fixture error'}:{text:'真实音轨',audioSeconds:1}));});
 await new Promise(r=>server.listen(socket,r));
 try{assert.equal((await transcribeSocket(Buffer.alloc(100),socket)).text,'真实音轨');mode='error';await assert.rejects(transcribeSocket(Buffer.alloc(100),socket),/fixture error/);
  mode='oversize';await assert.rejects(transcribeSocket(Buffer.alloc(100),socket),/过大/);mode='timeout';await assert.rejects(transcribeSocket(Buffer.alloc(100),socket,{timeoutMs:20}),/超时/);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
