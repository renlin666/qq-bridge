import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQqMemoryPolicy } from '../src/qq-memory-policy.js';
import { apply, NATIVE_MEMORY_TOOL_NAMES } from '../plugins/qq-agent-presets/qq-tool-restrict.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ok = body => ({ ok: true, status: 200, json: async () => body });

test('final prompt assembly excludes unavailable own-layer local tools without stopping later middleware', async () => {
  let assemble;
  apply({ tools: { restrict() {}, guard() {} }, systemPrompt: { section() {} },
    on(event, handler) { if (event === 'system-prompt/assemble') assemble = handler; } });
  let forwarded = false;
  const result = await assemble({}, {}, async () => { forwarded = true; return { tools: [
    { name: 'working_directory' }, { name: 'memory_remember' }, { name: 'mcp__snowluma__qq_send_message' },
    { name: 'qq_load_tools' }, { name: 'qq_compress_context' },
  ] }; });
  assert.ok(forwarded);
  assert.deepEqual(result.tools.map(tool => tool.name), ['mcp__snowluma__qq_send_message', 'qq_load_tools', 'qq_compress_context']);
});

test('QQ preset hides all eight native memory tools, shadows their guide, and preserves scoped QQ memory', () => {
  const hidden = [], sections = []; let guard;
  apply({ tools: { restrict: ({ deny }) => hidden.push(...deny), guard: fn => { guard = fn; } },
    systemPrompt: { section: value => sections.push(value) } });
  assert.equal(NATIVE_MEMORY_TOOL_NAMES.length, 8);
  for (const name of NATIVE_MEMORY_TOOL_NAMES) { assert.ok(hidden.includes(name)); assert.equal(typeof guard({ name }), 'string'); }
  for (const name of ['mcp__snowluma__qq_memory_append', 'mcp__snowluma__qq_shared_memory_remember', 'mcp__snowluma__qq_search_images', 'todo_write']) {
    assert.equal(hidden.includes(name), false); assert.equal(guard({ name }), undefined);
  }
  assert.equal(sections[0].name, 'meow-memory:guide'); assert.match(sections[0].text, /桥接记忆/);
  assert.ok(sections[0].text.length < 200);
});

test('optional plugin absence cannot disable the execution guard or break the preset', () => {
  let guard;
  apply({ tools: { restrict: () => { throw new Error('unknown tool'); }, guard: fn => { guard = fn; } } });
  assert.equal(typeof guard({ name: 'memory_remember' }), 'string');
  assert.equal(guard({ name: 'mcp__snowluma__qq_memory_query' }), undefined);
});

test('per-session policy uses the supported three fields without touching other sessions and avoids repeated writes', async () => {
  const calls = [];
  const policy = createQqMemoryPolicy({ request: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, ...body }); return ok({ ok: true, field: body.field, value: true });
  } });
  assert.equal((await policy.sync('qq-session')).applied, true);
  await policy.sync('qq-session');
  assert.deepEqual(calls.map(c => c.field), ['dream', 'inject', 'write']);
  assert.ok(calls.every(c => c.sessionId === 'qq-session' && c.value === true && c.url === '/meow-memory/skip-dreams'));
});

test('concurrent policy syncs share one set of writes; the policy is rechecked after ten minutes', async () => {
  let clock = 0, writes = 0;
  const policy = createQqMemoryPolicy({ now: () => clock, request: async (_, init) => { writes++; return ok({ ok: true, ...JSON.parse(init.body) }); } });
  await Promise.all([policy.sync('one'), policy.sync('one')]); assert.equal(writes, 3);
  clock = 600001; await policy.sync('one'); assert.equal(writes, 6);
});

test('unconfirmed response is not success and can be retried', async () => {
  let valid = false;
  const policy = createQqMemoryPolicy({ request: async (_, init) => ok(valid ? { ok: true, ...JSON.parse(init.body) } : { ok: true }) });
  await assert.rejects(policy.sync('qq'), /未确认/);
  valid = true; assert.equal((await policy.sync('qq')).applied, true);
});

test('absent optional endpoint is cached briefly, while an unknown session is an error', async () => {
  let writes = 0;
  const policy = createQqMemoryPolicy({ request: async () => { writes++; return { ok: false, status: 404, json: async () => ({}) }; } });
  assert.equal((await policy.sync('qq')).unavailable, true); await policy.sync('qq'); assert.equal(writes, 1);
  const invalid = createQqMemoryPolicy({ request: async () => ({ ok: false, status: 404, json: async () => ({ error: 'unknown session (no workspace)' }) }) });
  await assert.rejects(invalid.sync('qq'), /未确认/);
});

test('405 is optional absence only after authenticated inventory confirms it; installation is detected again', async () => {
  let clock=0,installed=false,supported=false,inventoryReads=0,policyWrites=0;
  const policy=createQqMemoryPolicy({now:()=>clock,request:async(url,init)=>{
    const payload=JSON.parse(init.body);
    if(url==='/api/pluginManager/listPlugins'){
      inventoryReads++;return ok({type:'server-response',rpcId:payload.rpcId,result:{ok:true,value:installed?[{moduleName:'meow-memory',enabled:true}]:[{moduleName:'qq-agent-presets',enabled:true}]}});
    }
    policyWrites++;
    return supported?ok({ok:true,...payload}):{ok:false,status:405,json:async()=>({})};
  }});
  assert.deepEqual(await policy.sync('qq'),{applied:false,unavailable:true,reason:'plugin_absent'});
  await policy.sync('qq');assert.equal(policyWrites,1);assert.equal(inventoryReads,1);
  clock=60001;installed=true;await assert.rejects(policy.sync('qq'),/未确认.*405/);
  supported=true;assert.equal((await policy.sync('qq')).applied,true);assert.equal(inventoryReads,2);
});

test('405 with loaded plugins, invalid inventory, failed discovery or unknown sessions stays an error', async () => {
  for(const value of [[{moduleName:'/plugins/meow-memory/index.js',enabled:true}],{items:[]},[{}]]){
    const policy=createQqMemoryPolicy({request:async(url,init)=>url.includes('listPlugins')
      ?ok({type:'server-response',rpcId:JSON.parse(init.body).rpcId,result:{ok:true,value}})
      :{ok:false,status:405,json:async()=>({})}});
    await assert.rejects(policy.sync('qq'),/未确认.*405/);
  }
  for(const mode of ['unreachable','wrong-envelope','unknown-session']){
    const policy=createQqMemoryPolicy({request:async(url)=>{
      if(url.includes('listPlugins')){if(mode==='unreachable')throw Error('offline');return ok({result:{ok:true,value:[]}});}
      return {ok:false,status:405,json:async()=>mode==='unknown-session'?{error:'unknown session'}:{}};
    }});
    await assert.rejects(policy.sync('qq'),/未确认.*405/);
  }
});

test('real bridge applies memory policy to new and reused QQ sessions but not closed-agent sessions', async () => {
  const h = await bridgeHarness();
  try {
    const writes = [];
    h.api._doFetchWithAuth = async (url, init) => { const body = JSON.parse(init.body); writes.push({ url, ...body }); return ok({ ok: true, ...body }); };
    h.setMode('reserved2');
    const session = await h.ensureSession('private:123');
    assert.equal(writes.length, 3); assert.ok(writes.every(w => w.sessionId === session));
    assert.equal(await h.ensureSession('private:123'), session); assert.equal(writes.length, 3);
    h.setMode('closed-agent'); await h.ensureSession('private:123'); assert.equal(writes.length, 3);
  } finally { await h.close(); }
});

test('new QQ session receives its policy before the first prompt is submitted', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    let prepared = false;
    h.api._doFetchWithAuth = async (_, init) => { const body = JSON.parse(init.body); if (body.field === 'write') prepared = true; return ok({ ok: true, ...body }); };
    h.api.sessions.prompt = async params => { assert.equal(prepared, true); return { result: { ok: true, value: {} } }; };
    await h.deliverPrompt('private:123', 'fixture prompt');
    assert.equal(prepared, true);
  } finally { await h.close(); }
});
