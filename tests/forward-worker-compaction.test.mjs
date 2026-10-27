import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJSON} from '../lib/forward-validation/source-contract.js';
import {buildObservationCycle,digest,OBSERVATION_KEY} from '../lib/forward-validation/observation-store.js';
import {validateCycle} from '../lib/forward-validation/observation-reader.js';
import {CONTROL,WORKER_KEY,STATE_LIMITS,COMPLETE_RECEIPT,prepareComplete,createWorkerStore} from '../lib/forward-validation/worker-store.js';
import {runWorker} from '../lib/forward-validation/worker.js';
const T='2026-10-18T10:00:00.000Z',W='2026-10-18T11:00:00.000Z',size=s=>Buffer.byteLength(s),clone=structuredClone;
function cycle(n=1){
 const globalRanking=Array.from({length:n},(_,i)=>{
  const symbol='TEST'+i,initialPlan={createdAt:T,plannedAt:T,expiresAt:'2026-10-19T10:00:00.000Z',entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,exitStrategy:{version:'tp1-50-reanalyse-v1'}};
  const frozenCandidate={symbol,direction:'Long',instrumentType:'SWAP',setupKey:symbol+':Long',tradeId:symbol+':Long:'+T,origin:{detectedAt:T},initialPlan,originalEligibility:{confirmedAPlus:true}};
  return {symbol,direction:'Long',instrumentType:'SWAP',origin:frozenCandidate.origin,initialPlan,analysisContext:{analysisAt:T},entryZone:initialPlan.entryZone,stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,
   opportunityScore:90,confidence:90,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true},riskReward:3,researchProjectionJSON:JSON.stringify({frozenCandidate})};
 });
 const e=buildObservationCycle({ok:true,status:'ready',mode:'global-ranking',version:'1.0',generatedAt:T,resultsFailed:0,globalRanking},()=>true);
 return validateCycle(canonicalJSON(e),e.sourceCycleId);
}
const state=i=>({schemaVersion:'forward-worker-state-v1',mappingVersion:'forward-worker-mapping-v1',fence:1,owner:'test-owner',expiresAt:Date.now()+60000,intents:{[i.id]:canonicalJSON(i)}});
test('atomic COMPLETE compaction on isolated Unix Redis, no production credentials',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-compact-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 const redis=c=>new Promise((resolve,reject)=>{
  const child=spawn('redis-cli',['-s',socket,'--json','-x',...c.slice(0,-1).map(String)]);let out='';
  child.stdout.on('data',b=>out+=b);child.on('error',reject);child.stdin.on('error',()=>{});
  child.on('close',code=>{try{if(code||out.startsWith('error:'))throw Error('ISOLATED_REDIS_ERROR');resolve(c[0]==='INFO'?out:JSON.parse(out));}catch(e){reject(e);}});child.stdin.end(String(c.at(-1)));
 });
 const store=createWorkerStore(redis),sets=async()=>Number(/cmdstat_set:calls=(\d+)/.exec(await redis(['INFO','commandstats']))?.[1]||0);
 const seed=async s=>redis(['SET',WORKER_KEY,JSON.stringify(s)]);
 const unchanged=async fn=>{const before=await redis(['GET',WORKER_KEY]),writes=await sets(),r=await fn();
  assert.equal(await redis(['GET',WORKER_KEY]),before);assert.equal(await sets(),writes);return r;};
 const evalProof=(p,raw=canonicalJSON(p.receipt),script=CONTROL)=>redis(['EVAL',script,'1',WORKER_KEY,'FINALIZE_COMPLETE','test-owner','1',canonicalJSON(p),raw]);
 const fixtures=new Map();
 try{
  let ready=false;for(let n=0;n<100;n++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  // Obtain exact complete action evidence from the real worker, stopped BEFORE FINALIZE.
  for(const n of [0,1,2]){
   await redis(['FLUSHDB']);const c=cycle(n);await redis(['SET',OBSERVATION_KEY,JSON.stringify({schemaVersion:'forward-observation-ledger-v1',cycles:{[c.envelope.sourceCycleId]:c.raw},count:1,observations:n,payloadBytes:size(c.raw)})]);
   let proof;await runWorker({now:()=>Date.parse(W),execute:async command=>{
    if(command[0]==='EVAL'&&command[4]==='FINALIZE_COMPLETE'){proof=JSON.parse(command[7]);throw Error('TEST_BEFORE_FINALIZE');}return redis(command);
   }});
   assert.ok(proof,`real source N=${n} reaches FINALIZE`);const item=JSON.parse(proof.expectedPreimage);
   assert.equal((await store.read()).intents[item.id].status,'RUNNING');fixtures.set(n,{item,c,proof});
  }
  const {item,c,proof}=fixtures.get(2);
  for(const n of [0,1,2])await t.test(`N=${n} exact schema/hash, one SET, compact without full COMPLETE`,async()=>{
   const f=fixtures.get(n);await seed(state(f.item));const before=await redis(['GET',WORKER_KEY]),writes=await sets();
   const r=await store.finalize('test-owner',1,f.item,f.c);assert.equal(r.status,'OK');assert.equal(await sets(),writes+1);
   const raw=await redis(['GET',WORKER_KEY]),after=(await store.read()).intents[f.item.id];
   assert.deepEqual(Object.keys(after).sort(),['receiptVersion','id','frozen','status','fullIntentSha256'].sort());
   assert.equal(after.receiptVersion,COMPLETE_RECEIPT);assert.equal(after.status,'COMPLETE');assert.equal(after.frozen,f.item.frozen);
   const virtual=canonicalJSON({...f.item,status:'COMPLETE'});
   assert.equal(after.fullIntentSha256,createHash('sha256').update(virtual).digest('hex'));assert.match(after.fullIntentSha256,/^[a-f0-9]{64}$/);
   assert.equal(JSON.parse(raw).intents[f.item.id],canonicalJSON(after));assert.equal(after.actions,undefined);assert.equal(after.done,undefined);
   assert.equal(r.finalizeMetrics.previousSerializedBytes,size(before));assert.equal(r.finalizeMetrics.prospectiveSerializedBytes,size(raw));
   assert.equal(r.finalizeMetrics.serializedReductionBytes,size(before)-size(raw));assert.equal(r.finalizeMetrics.wholeStateLimitBytes,4194304);
   const replay=await unchanged(()=>store.finalize('test-owner',1,f.item,f.c));assert.equal(replay.status,'IDEMPOTENT');
   t.diagnostic(`N=${n}: FULL=${size(virtual)}, COMPACT=${size(canonicalJSON(after))}, WHOLE_REDUCTION=${size(before)-size(raw)}`);
  });
  await t.test('canonical hash independent of insertion order; any full result change changes hash',()=>{
   const reversed=Object.fromEntries(Object.entries(item).reverse());assert.equal(prepareComplete(reversed,c).expectedHash,proof.expectedHash);
   const changed=clone(item),key=Object.keys(changed.done)[0],result=JSON.parse(changed.done[key]);result.testMetadata='changed';changed.done[key]=canonicalJSON(result);
   assert.notEqual(prepareComplete(changed,c).expectedHash,proof.expectedHash);
   assert.notEqual(createHash('sha256').update(JSON.stringify({...reversed,status:'COMPLETE'})).digest('hex'),proof.expectedHash);
  });
  const first=proof.expectedKeys[0],op=proof.expectedKeys.find(k=>k.endsWith(':ingest')).slice(0,-7);
  for(const [name,edit]of [
   ['missing action',i=>delete i.actions[first]],['extra action',i=>i.actions.extra='{}'],['missing done',i=>delete i.done[first]],
   ['extra done',i=>i.done.extra='{"status":"OK"}'],['failed result',i=>i.done[first]='{"status":"BLOCKED_STORAGE"}'],
   ['wrong action key',i=>{i.actions.wrong=i.actions[first];delete i.actions[first];}],
   ['wrong action type',i=>i.actions[op+':ingest']=i.actions[op+':prepare']],
   ['swapped init action types',i=>{[i.actions['producer-init'],i.actions['shadow-init']]=[i.actions['shadow-init'],i.actions['producer-init']];}],
   ['nonempty as empty',i=>{i.actions={};i.done={};}],
   ['mapping mismatch',i=>{const f=JSON.parse(i.frozen);f.mappingVersion='other';i.frozen=canonicalJSON(f);}],
   ['source hash mismatch',i=>{const f=JSON.parse(i.frozen);f.sourceEnvelopeHash='0'.repeat(64);i.frozen=canonicalJSON(f);}],
   ['processing identity mismatch',i=>{const f=JSON.parse(i.frozen);f.processingIdentity='0'.repeat(64);i.frozen=canonicalJSON(f);}],
   ['id mismatch',i=>i.id='0'.repeat(64)],['unknown intent field',i=>i.extra=true]
  ])await t.test(`${name}: preflight fails closed, zero commands/writes`,async()=>{
   const bad=clone(item);edit(bad);await seed(state(bad));let calls=0;
   const rejecting=createWorkerStore(async command=>{calls++;return redis(command);});
   assert.equal((await unchanged(()=>rejecting.finalize('test-owner',1,bad,c))).status,'CONFLICT');assert.equal(calls,0);
  });
  await t.test('N0 cannot finalize using nonempty source or nonempty actions',async()=>{
   const empty=fixtures.get(0);await seed(state(empty.item));assert.equal((await unchanged(()=>store.finalize('test-owner',1,empty.item,c))).status,'CONFLICT');
   const bad=clone(empty.item);bad.actions[first]='{}';assert.throws(()=>prepareComplete(bad,empty.c));
  });
  for(const [name,modify]of [
   ['different persisted preimage',s=>{const i=JSON.parse(s.intents[item.id]);i.done[first]=canonicalJSON({status:'OK',changed:true});s.intents[item.id]=canonicalJSON(i);}],
   ['different persisted frozen',s=>{const i=JSON.parse(s.intents[item.id]);i.frozen+=' ';s.intents[item.id]=canonicalJSON(i);}],
   ['wrong schema',s=>s.schemaVersion='v2'],['wrong mapping',s=>s.mappingVersion='v2'],['missing intent',s=>s.intents={}]
  ])await t.test(`${name}: atomic rejection, zero SET`,async()=>{
   const s=state(item);modify(s);await seed(s);assert.equal((await unchanged(()=>store.finalize('test-owner',1,item,c))).status,'CONFLICT');
  });
  for(const [name,owner,fence,expire]of [['owner','other',1,false],['fence','test-owner',2,false],['lease','test-owner',1,true]])await t.test(`${name}: fenced before SET`,async()=>{
   const s=state(item);if(expire)s.expiresAt=0;await seed(s);assert.equal((await unchanged(()=>store.finalize(owner,fence,item,c))).status,'FENCED');
  });
  for(const [name,edit]of [
   ['receipt extra field',p=>p.receipt.extra=true],['receipt hash mismatch',p=>p.receipt.fullIntentSha256='0'.repeat(64)],
   ['receipt frozen mismatch',p=>p.receipt.frozen+=' '],['receipt id mismatch',p=>p.receipt.id='0'.repeat(64)],
   ['receipt version mismatch',p=>p.receipt.receiptVersion='other'],['receipt wrong status',p=>p.receipt.status='RUNNING'],
   ['preimage mismatch',p=>p.expectedPreimage+=' '],['missing expected key',p=>p.expectedKeys.pop()],['duplicate expected key',p=>p.expectedKeys.push(first)]
  ])await t.test(`${name}: exact Lua rejects before SET`,async()=>{
   await seed(state(item));const p=clone(proof);edit(p);assert.equal((await unchanged(()=>evalProof(p)))[0],'CONFLICT');
  });
  for(const [name,edit]of [['missing action',i=>delete i.actions[first]],['missing done',i=>delete i.done[first]],['failed result',i=>i.done[first]='{"status":"ERROR"}'],['extra action',i=>i.actions.extra='{}']])await t.test(`Lua ${name} despite exact preimage rejects`,async()=>{
   const bad=clone(item);edit(bad);await seed(state(bad));const p=clone(proof);p.expectedPreimage=canonicalJSON(bad);
   assert.equal((await unchanged(()=>evalProof(p)))[0],'CONFLICT');
  });
  await t.test('compact replay conflicts and ordinary SAVE cannot create or modify receipt',async()=>{
   await seed(state(item));assert.equal((await unchanged(()=>store.save('test-owner',1,proof.receipt))).status,'CONFLICT');
   assert.equal((await store.finalize('test-owner',1,item,c)).status,'OK');
   for(const field of ['fullIntentSha256','frozen','receiptVersion','status']){const p=clone(proof);p.receipt[field]+='x';assert.equal((await unchanged(()=>evalProof(p)))[0],'CONFLICT');}
   // Even a mismatched proof cannot claim success by supplying an unchanged ARGV[5].
   const p=clone(proof);p.receipt.frozen+=' ';assert.equal((await unchanged(()=>evalProof(p,canonicalJSON(proof.receipt))))[0],'CONFLICT');
   assert.equal((await unchanged(()=>store.save('test-owner',1,proof.receipt))).status,'CONFLICT');
  });
  await t.test('mixed FULL RUNNING/legacy COMPLETE/compact COMPLETE/BLOCKED_MAPPING',async()=>{
   const s=state(item),legacy={...item,id:'legacy',status:'COMPLETE'},blocked={...item,id:'blocked',status:'BLOCKED_MAPPING',reasons:['MISSING_FROZEN_PLAN']};
   s.intents.legacy=canonicalJSON(legacy);s.intents.blocked=canonicalJSON(blocked);s.intents.compact=canonicalJSON({...proof.receipt,id:'compact'});await seed(s);
   const read=await store.read();assert.deepEqual(read.intents.legacy,legacy);assert.deepEqual(read.intents.blocked,blocked);assert.equal(read.intents.compact.receiptVersion,COMPLETE_RECEIPT);
   assert.equal((await store.finalize('test-owner',1,item,c)).status,'OK');const after=JSON.parse(await redis(['GET',WORKER_KEY]));
   for(const id of ['legacy','blocked','compact'])assert.equal(after.intents[id],s.intents[id]);
  });
  await t.test('crash inside Lua before SET leaves exact RUNNING bytes',async()=>{
   await seed(state(item));const before=await redis(['GET',WORKER_KEY]),writes=await sets();
   const fault=CONTROL.replace("redis.call('SET',KEYS[1],encoded)","error('TEST_BEFORE_SET')");
   await assert.rejects(()=>evalProof(proof,canonicalJSON(proof.receipt),fault));assert.equal(await redis(['GET',WORKER_KEY]),before);assert.equal(await sets(),writes);
  });
  await t.test('real worker persistence never contains intermediate FULL COMPLETE',async()=>{
   await redis(['FLUSHDB']);await redis(['SET',OBSERVATION_KEY,JSON.stringify({schemaVersion:'forward-observation-ledger-v1',cycles:{[c.envelope.sourceCycleId]:c.raw},count:1,observations:2,payloadBytes:size(c.raw)})]);
   let finalizes=0,saves=0;
   const r=await runWorker({now:()=>Date.parse(W),execute:async cmd=>{
    if(cmd[0]==='EVAL'&&cmd[4]==='SAVE'){assert.equal(JSON.parse(cmd[7]).status,'RUNNING');saves++;}
    if(cmd[0]==='EVAL'&&cmd[4]==='FINALIZE_COMPLETE')finalizes++;
    const result=await redis(cmd);
    if(cmd[0]==='EVAL'&&cmd[3]===WORKER_KEY){const s=await store.read();for(const v of Object.values(s.intents))if(v.status==='COMPLETE')assert.equal(v.receiptVersion,COMPLETE_RECEIPT);}
    return result;
   }});
   assert.equal(r.status,'COMPLETE');assert.equal(finalizes,1);assert.equal(saves,25);
  });
  await t.test('lost FINALIZE response: natural retry skips cycle and performs no downstream command',async()=>{
   await redis(['SET',OBSERVATION_KEY,JSON.stringify({schemaVersion:'forward-observation-ledger-v1',cycles:{[c.envelope.sourceCycleId]:c.raw},count:1,observations:2,payloadBytes:size(c.raw)})]);
   await seed(state(item));let lost=false;const lostStore=createWorkerStore(async cmd=>{const r=await redis(cmd);if(cmd[4]==='FINALIZE_COMPLETE'){lost=true;throw Error('TEST_LOST_RESPONSE');}return r;});
   await assert.rejects(()=>lostStore.finalize('test-owner',1,item,c));assert.equal(lost,true);
   await store.release('test-owner',1);const commands=[];
   const r=await runWorker({now:()=>Date.parse(W),execute:async cmd=>{commands.push(cmd);return redis(cmd);}});
   assert.equal(r.status,'IDLE');assert.ok(commands.every(cmd=>cmd[0]==='GET'||['ACQUIRE','RELEASE'].includes(cmd[4])));
   assert.equal((await store.read()).intents[item.id].receiptVersion,COMPLETE_RECEIPT);
  });
  await t.test('current >4MiB fails before SET',async()=>{
   const s=state(item);s.padding='x'.repeat(4194304);await seed(s);
   const r=await unchanged(()=>store.finalize('test-owner',1,item,c));assert.equal(r.status,'BLOCKED_STORAGE');assert.equal(r.finalizeMetrics.reasonCode,'CURRENT_STATE_LIMIT');
  });
  await t.test('prospective exact 4MiB permitted; +1 rejected before SET',async()=>{
   const empty=fixtures.get(0),s=state(empty.item);s.padding='x';await seed(s);
   const base=(await store.finalize('test-owner',1,empty.item,empty.c)).finalizeMetrics.prospectiveSerializedBytes;
   s.padding='x'.repeat(1+4194304-base);await seed(s);
   const exact=await store.finalize('test-owner',1,empty.item,empty.c);assert.equal(exact.status,'OK');assert.equal(exact.finalizeMetrics.prospectiveSerializedBytes,4194304);
   s.padding+='x';await seed(s);assert.ok(size(await redis(['GET',WORKER_KEY]))<=4194304);
   const overflow=await unchanged(()=>store.finalize('test-owner',1,empty.item,empty.c));assert.equal(overflow.status,'BLOCKED_STORAGE');assert.equal(overflow.finalizeMetrics.reasonCode,'WHOLE_STATE_LIMIT');assert.equal(overflow.finalizeMetrics.prospectiveSerializedBytes,4194305);
  });
  assert.equal(STATE_LIMITS.maxPayloadBytes,1048576);assert.equal(STATE_LIMITS.maxBytes,4194304);assert.equal(STATE_LIMITS.maxCycleReceipts,10000);
 }finally{try{await redis(['SHUTDOWN','NOSAVE']);}catch{}server.kill();await rm(dir,{recursive:true,force:true});}
});
