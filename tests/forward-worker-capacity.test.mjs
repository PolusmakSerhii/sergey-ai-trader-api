import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJSON} from '../lib/forward-validation/source-contract.js';
import {CONTROL,WORKER_KEY,STATE_LIMITS,createWorkerStore} from '../lib/forward-validation/worker-store.js';
const exec=promisify(execFile);
const item=(size,id='test-intent')=>{const i={id,frozen:'{}',actions:{padding:''},done:{},status:'RUNNING'};
 i.actions.padding='x'.repeat(size-Buffer.byteLength(canonicalJSON(i)));assert.equal(Buffer.byteLength(canonicalJSON(i)),size);return i;};
const state=intents=>({schemaVersion:'forward-worker-state-v1',mappingVersion:'forward-worker-mapping-v1',fence:1,owner:'test-owner',expiresAt:Date.now()+60000,intents});
test('exact worker CONTROL capacity and invariants on isolated Unix Redis',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-capacity-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 // Last argument travels over stdin, avoiding OS argv limits for MiB fixtures.
 const redis=c=>new Promise((resolve,reject)=>{const child=spawn('redis-cli',['-s',socket,'--json','-x',...c.slice(0,-1).map(String)]);
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);
  child.stdin.on('error',()=>{});child.on('close',code=>{try{if(code||out.startsWith('error:'))throw Error('LOCAL_REDIS_FAILED '+err);resolve(c[0]==='INFO'?out:JSON.parse(out));}catch(e){reject(e);}});child.stdin.end(String(c.at(-1)));});
 const store=createWorkerStore(redis),seed=async s=>redis(['SET',WORKER_KEY,JSON.stringify(s)]);
 const saves=async()=>{const info=await redis(['INFO','commandstats']);return Number(/cmdstat_set:calls=(\d+)/.exec(info)?.[1]||0);};
 const save=i=>store.save('test-owner',1,i);
 const unchanged=async(fn,status)=>{const raw=await redis(['GET',WORKER_KEY]),count=await saves(),r=await fn();assert.equal(r.status,status);
  assert.equal(await redis(['GET',WORKER_KEY]),raw);assert.equal(await saves(),count);return r;};
 try{
  let ready=false;for(let n=0;n<100;n++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  for(const size of [33692,1048576])await t.test(`${size} exact canonical bytes accepted with actual encoded metrics`,async()=>{
   await seed(state({}));const before=await redis(['GET',WORKER_KEY]);const r=await save(item(size));assert.equal(r.status,'OK');
   const after=await redis(['GET',WORKER_KEY]);assert.equal(r.saveMetrics.canonicalIntentBytes,size);
   assert.equal(r.saveMetrics.configuredLimitBytes,1048576);assert.equal(r.saveMetrics.previousSerializedBytes,Buffer.byteLength(before));
   assert.equal(r.saveMetrics.prospectiveSerializedBytes,Buffer.byteLength(after));assert.ok(Buffer.byteLength(after)<=4194304);
   assert.equal(r.saveMetrics.serializedGrowthBytes,Buffer.byteLength(after)-Buffer.byteLength(before));assert.equal(r.saveMetrics.crossedLegacyLimit,true);
  });
  await t.test('1048577 rejects early with null prospective and zero SET',async()=>{await seed(state({}));
   const r=await unchanged(()=>save(item(1048577)),'BLOCKED_STORAGE');assert.equal(r.saveMetrics.reasonCode,'INTENT_LIMIT');assert.equal(r.saveMetrics.prospectiveSerializedBytes,null);});
  await t.test('actual prospective overflow rejects before SET',async()=>{const s=state({});s.padding='x'.repeat(3500000);await seed(s);
   const r=await unchanged(()=>save(item(1048576)),'BLOCKED_STORAGE');assert.equal(r.saveMetrics.reasonCode,'WHOLE_STATE_LIMIT');assert.ok(r.saveMetrics.prospectiveSerializedBytes>4194304);});
  await t.test('actual prospective exact 4 MiB accepted then +1 rejected',async()=>{const i=item(33692),s=state({});s.padding='x';await seed(s);
   const first=await save(i),base=first.saveMetrics.prospectiveSerializedBytes;s.padding='x'.repeat(1+4194304-base);await seed(s);
   const exact=await save(i);assert.equal(exact.status,'OK');assert.equal(exact.saveMetrics.prospectiveSerializedBytes,4194304);
   s.padding+='x';await seed(s);const r=await unchanged(()=>save(i),'BLOCKED_STORAGE');assert.equal(r.saveMetrics.prospectiveSerializedBytes,4194305);
  });
  await t.test('current raw overflow blocks SAVE and ACQUIRE without SET',async()=>{const s=state({});s.padding='x'.repeat(4194304);await seed(s);
   const r=await unchanged(()=>save(item(200)),'BLOCKED_STORAGE');assert.equal(r.saveMetrics.reasonCode,'CURRENT_STATE_LIMIT');assert.equal(r.saveMetrics.prospectiveSerializedBytes,null);
   await unchanged(()=>store.acquire('test-owner'),'BLOCKED_STORAGE');});
  await t.test('fencing and expired lease unchanged',async()=>{await seed(state({}));await unchanged(()=>store.save('other',1,item(200)),'FENCED');
   await unchanged(()=>store.save('test-owner',2,item(200)),'FENCED');const s=state({});s.expiresAt=0;await seed(s);await unchanged(()=>save(item(200)),'FENCED');});
  await t.test('frozen actions done immutable; COMPLETE remains full and terminal',async()=>{
   const i=item(33692);i.done.first='{"status":"OK"}';await seed(state({[i.id]:canonicalJSON(i)}));
   for(const field of ['frozen','actions','done']){const changed=structuredClone(i);if(field==='frozen')changed.frozen='{"changed":true}';else changed[field]={};await unchanged(()=>save(changed),'CONFLICT');}
   const complete={...i,status:'COMPLETE'};assert.equal((await save(complete)).status,'OK');assert.deepEqual((await store.read()).intents[i.id],complete);
   assert.equal((await save(complete)).status,'OK');await unchanged(()=>save({...complete,status:'RUNNING'}),'CONFLICT');
  });
  await t.test('BLOCKED_MAPPING remains terminal',async()=>{const i={...item(200),status:'BLOCKED_MAPPING',reasons:['MISSING_FROZEN_PLAN']};await seed(state({}));
   assert.equal((await save(i)).status,'OK');await unchanged(()=>save({...i,status:'RUNNING'}),'CONFLICT');});
  await t.test('count and pending limits unchanged, two RUNNING still allowed',async()=>{
   const i=item(200);await seed(state({one:canonicalJSON({...i,id:'one'})}));assert.equal((await save(i)).status,'OK');
   for(const [count,status]of [[100,'RUNNING'],[10000,'COMPLETE']]){const intents=Object.fromEntries(Array.from({length:count},(_,n)=>['id'+n,canonicalJSON({id:'id'+n,frozen:'{}',actions:{},done:{},status})]));await seed(state(intents));
    const r=await unchanged(()=>save(i),'BLOCKED_STORAGE');assert.equal(r.saveMetrics.reasonCode,'COUNT_LIMIT');}
  });
  await t.test('crossing logged only on durable first crossing, not replay or later save',async()=>{await seed(state({}));const i=item(33692);
   assert.equal((await save(i)).saveMetrics.crossedLegacyLimit,true);assert.equal((await save(i)).saveMetrics.crossedLegacyLimit,false);
   i.done.next='{"status":"OK"}';assert.equal((await save(i)).saveMetrics.crossedLegacyLimit,false);});
  await t.test('old ceiling reads/acquires/checks but cannot SAVE larger legacy RUNNING',async()=>{
   const {stdout:old}=await exec('git',['show','a29eccf78f6129742ef0fc446429622e48d2f531:lib/forward-validation/worker-store.js']);const script=old.match(/export const CONTROL=`([\s\S]*?)`;/)[1];
   const i=item(33692);await seed({...state({[i.id]:canonicalJSON(i)}),expiresAt:0});
   const r=await redis(['EVAL',script,'1',WORKER_KEY,'ACQUIRE','test-owner','0','']);assert.equal(r[0],'OK');
   const fence=r[1];assert.equal((await redis(['EVAL',script,'1',WORKER_KEY,'CHECK','test-owner',fence,'']))[0],'OK');
   assert.deepEqual((await store.read()).intents[i.id],i);const before=await redis(['GET',WORKER_KEY]),count=await saves();
   assert.equal((await redis(['EVAL',script,'1',WORKER_KEY,'SAVE','test-owner',fence,canonicalJSON(i)]))[0],'BLOCKED_STORAGE');
   assert.equal(await redis(['GET',WORKER_KEY]),before);assert.equal(await saves(),count);
   assert.match(old,/Object\.entries\(s.intents\).*JSON\.parse\(v\)/);
  });
  assert.equal(STATE_LIMITS.maxBytes,4194304);assert.equal(STATE_LIMITS.maxPayloadBytes,1048576);
  assert.ok(CONTROL.indexOf('if #encoded>4194304')<CONTROL.indexOf("redis.call('SET'"));
 }finally{try{await redis(['SHUTDOWN','NOSAVE']);}catch{}server.kill();await rm(dir,{recursive:true,force:true});}
});
