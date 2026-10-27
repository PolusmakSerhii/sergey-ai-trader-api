import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildObservationCycle,digest,OBSERVATION_KEY} from '../lib/forward-validation/observation-store.js';
import {canonicalJSON} from '../lib/forward-validation/source-contract.js';
import {validateCycle,readObservations} from '../lib/forward-validation/observation-reader.js';
import {mapObservation,validateDelayed,MAPPING,DELAYED} from '../lib/forward-validation/delayed-ingestion.js';
import {runWorker,RUN_ID} from '../lib/forward-validation/worker.js';
import {createWorkerStore,WORKER_KEY,fencedExecutor} from '../lib/forward-validation/worker-store.js';
import {createProducerStore,producerKey} from '../lib/forward-validation/producer-store.js';
import {shadowKey} from '../lib/forward-validation/store.js';
import handler from '../api/forward-worker.js';
const exec=promisify(execFile),T='2026-10-18T10:00:00.000Z',W='2026-10-18T11:00:00.000Z';
function cycle(n=1,at=T,complete=true){
 const globalRanking=Array.from({length:n},(_,i)=>{
  const symbol='S'+i,initialPlan={createdAt:at,plannedAt:at,expiresAt:'2026-10-19T10:00:00.000Z',entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,exitStrategy:{version:'tp1-50-reanalyse-v1'}};
  const f={symbol,direction:'Long',instrumentType:'SWAP',setupKey:symbol+':Long',tradeId:symbol+':Long:'+at,origin:{detectedAt:at},initialPlan,originalEligibility:{confirmedAPlus:true}};
  return {symbol,direction:'Long',instrumentType:'SWAP',origin:{detectedAt:at},initialPlan,analysisContext:{analysisAt:at},
   entryZone:initialPlan.entryZone,stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,opportunityScore:90,confidence:90,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true},riskReward:3,
   researchProjectionJSON:complete?JSON.stringify({frozenCandidate:f}):null};
 });
 const e=buildObservationCycle({ok:true,status:'ready',mode:'global-ranking',version:'1.0',generatedAt:at,resultsFailed:0,globalRanking},()=>true);
 return validateCycle(canonicalJSON(e),e.sourceCycleId);
}
const mutate=(c,fn)=>{const e=structuredClone(c.envelope);fn(e);for(const o of e.observations)o.payloadHash=digest(o.payload);return validateCycle(canonicalJSON(e),e.sourceCycleId);};
function delayed(c=cycle()){const o=c.envelope.observations[0];return {schemaVersion:DELAYED,mappingVersion:MAPPING,processingIdentity:digest([MAPPING,c.envelope.sourceCycleId,o.observationId]),
 sourceEnvelope:c.raw,sourceCycleId:c.envelope.sourceCycleId,sourceEnvelopeHash:c.hash,observationId:o.observationId,observationPayloadHash:o.payloadHash,
 sourceObservedAt:c.envelope.observedAt,sourceAnalysisAt:o.payload.analysisAt,workerProcessingStartedAt:W,workerRecordedAt:W,frozenCandidate:mapObservation(c,o).frozenCandidate};}
test('reader validates identity/hash/count/status and deterministic source',()=>{
 const c=cycle();assert.equal(validateCycle(c.raw,c.envelope.sourceCycleId).hash,c.hash);
 for(const change of [e=>e.observations[0].payload.confidence=99,e=>e.expectedObservationCount=2,e=>e.observationPersistenceStatus='UNRESOLVED',e=>e.sourceCycleId='x',e=>e.observations[0].observationId='x']){
  const e=structuredClone(c.envelope);change(e);assert.throws(()=>validateCycle(canonicalJSON(e),c.envelope.sourceCycleId));
 }
});
for(const [name,fn,reason]of [
 ['detectedAt',p=>p.detectedAt=null,'MISSING_DETECTED_AT'],['createdAt',p=>p.createdAt=null,'MISSING_CREATED_AT'],
 ['plan',p=>p.originalResearchProjectionJSON=null,'MISSING_FROZEN_PLAN'],['expiry',p=>{let x=JSON.parse(p.originalResearchProjectionJSON);delete x.frozenCandidate.initialPlan.expiresAt;p.originalResearchProjectionJSON=JSON.stringify(x);},'MISSING_PLAN_BOUNDARIES'],
 ['policy',p=>{let x=JSON.parse(p.originalResearchProjectionJSON);delete x.frozenCandidate.initialPlan.exitStrategy;p.originalResearchProjectionJSON=JSON.stringify(x);},'MISSING_EXIT_POLICY']])test(`missing ${name} blocks without time substitution`,()=>{
 const c=mutate(cycle(),e=>fn(e.observations[0].payload));const before=canonicalJSON(c);assert.ok(mapObservation(c,c.envelope.observations[0]).reasonCodes.includes(reason));assert.equal(canonicalJSON(c),before);
});
test('invalid directional geometry and empty policy block mapping',()=>{
 for(const type of ['geometry','policy']){
  const c=mutate(cycle(),e=>{const p=e.observations[0].payload,f=JSON.parse(p.originalResearchProjectionJSON).frozenCandidate;
   if(type==='geometry'){f.initialPlan.stopLoss=105;p.sourceGeometry.stopLoss=105;}else f.initialPlan.exitStrategy.version='';
   p.originalResearchProjectionJSON=JSON.stringify({frozenCandidate:f});
  });assert.equal(mapObservation(c,c.envelope.observations[0]).status,'BLOCKED_MAPPING');
 }
});
test('non SWAP mapping blocked',()=>{const c=cycle(),o=structuredClone(c.envelope.observations[0]);o.payload.instrumentType='SPOT';assert.ok(mapObservation(c,o).reasonCodes.includes('NON_SWAP'));});
for(const [name,edit,pass]of [['earlier',()=>{},true],['equal',d=>{d.workerProcessingStartedAt=T;d.workerRecordedAt=T;},true],
 ['future',d=>d.workerProcessingStartedAt='2026-10-18T09:00:00.000Z',false],['recorded before',d=>d.workerRecordedAt=T,false],
 ['source hash',d=>d.sourceEnvelopeHash='bad',false],['observation hash',d=>d.observationPayloadHash='bad',false],['version',d=>d.mappingVersion='v2',false]])test(`delayed provenance ${name}`,()=>{const d=delayed();edit(d);if(pass)assert.ok(validateDelayed(d));else assert.throws(()=>validateDelayed(d));});
test('private manual endpoint requires auth and POST; no network on rejection',async()=>{
 const old=process.env.SM1M_API_SECRET;process.env.SM1M_API_SECRET='x'.repeat(40);
 try{for(const [headers,method,code]of [[{},'POST',401],[{authorization:'Bearer '+'x'.repeat(40)},'GET',405]]){
  const res={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;return this;}};await handler({headers,method},res);assert.equal(res.code,code);
 }}finally{if(old===undefined)delete process.env.SM1M_API_SECRET;else process.env.SM1M_API_SECRET=old;}
});
test('local Unix-socket worker integration and crash recovery',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-worker-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 const redis=async cmd=>{const {stdout}=await exec('redis-cli',['-s',socket,'--json',...cmd.map(String)],{maxBuffer:16*1024*1024});if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);};
 const seed=async rows=>{const l={schemaVersion:'forward-observation-ledger-v1',cycles:Object.fromEntries(rows.map(c=>[c.envelope.sourceCycleId,c.raw])),count:rows.length,observations:rows.reduce((n,c)=>n+c.envelope.observations.length,0),payloadBytes:rows.reduce((n,c)=>n+Buffer.byteLength(c.raw),0)};await redis(['SET',OBSERVATION_KEY,JSON.stringify(l)]);};
 const fresh=async rows=>{await redis(['FLUSHDB']);await seed(rows);};
 const read=async key=>{const raw=await redis(['GET',key]);return raw?JSON.parse(raw):null;};
 const expire=async()=>{const s=await read(WORKER_KEY);s.expiresAt=0;await redis(['SET',WORKER_KEY,JSON.stringify(s)]);};
 const run=(execute=redis)=>runWorker({execute,now:()=>Date.parse(W)});
 try{
  let ready=false;for(let i=0;i<100;i++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  await t.test('zero cycle complete, one cycle/invocation, deterministic pending selection',async()=>{
   const a=cycle(0),b=cycle(0,'2026-10-18T10:01:00.000Z');await fresh([b,a]);assert.equal((await run()).status,'COMPLETE');
   let s=await createWorkerStore(redis).read();assert.deepEqual(Object.keys(s.intents),[a.envelope.sourceCycleId]);assert.equal(await read(producerKey(RUN_ID)),null);
   assert.equal((await run()).status,'COMPLETE');assert.equal((await run()).status,'IDLE');
  });
  await t.test('valid initial generation, repeated open link, no second generation or Shadow record',async()=>{
   await fresh([cycle()]);const r=await run();assert.equal(r.status,'COMPLETE',JSON.stringify(r));
   const p=createProducerStore(redis);let state=await p.read(RUN_ID);assert.equal(state.state.generations.length,1);assert.equal(state.state.captures[0].state,'ACKNOWLEDGED');assert.deepEqual(state.recovery.resultsAwaitingCapture,[]);
   const shadow=await read(shadowKey(RUN_ID));assert.equal(shadow.records.length,1);assert.equal(shadow.records[0].state,'DETECTED');
   await seed([cycle(),cycle(1,'2026-10-18T10:01:00.000Z')]);assert.equal((await run()).status,'COMPLETE');state=await p.read(RUN_ID);
   assert.equal(state.state.generations.length,1);assert.equal(state.state.generations[0].logicalLifecycleState,'OPEN');assert.equal(state.state.generationLinks.length,1);assert.deepEqual(state.recovery.resultsAwaitingCapture,[]);
   assert.equal((await read(shadowKey(RUN_ID))).records.length,1);assert.equal((await run()).status,'IDLE');
  });
  await t.test('delayed receipt exact replay and changed immutable facts fail closed',async()=>{
   await fresh([cycle()]);assert.equal((await run()).status,'COMPLETE');
   const p=createProducerStore(redis),ledger=await read(producerKey(RUN_ID));
   const request=ledger.entries.find(e=>e.request.type==='ingestDelayedObservation').request;
   assert.equal((await p.ingestDelayedObservation(RUN_ID,request)).status,'IDEMPOTENT');
   const before=await redis(['GET',producerKey(RUN_ID)]);
   for(const [key,value]of [['sourceEnvelopeHash','bad'],['observationPayloadHash','bad'],['workerRecordedAt','2026-10-18T11:01:00.000Z'],['workerProcessingStartedAt','2026-10-18T10:59:00.000Z']]){
    const changed=structuredClone(request);changed.requestId='conflict-'+key;changed.expectedRevision=ledger.revision;changed.data.ingestion[key]=value;
    const r=await p.ingestDelayedObservation(RUN_ID,changed);assert.equal(r.status,'BLOCKED_INTEGRITY',key);assert.equal(await redis(['GET',producerKey(RUN_ID)]),before);
   }
  });
  await t.test('delayed ingestion charged to producer budget, no partial write',async()=>{
   await fresh([cycle()]);await run();const l=await read(producerKey(RUN_ID)),ingest=l.entries.find(e=>e.request.type==='ingestDelayedObservation').request;
   await redis(['DEL',producerKey(RUN_ID)]);const p=createProducerStore(redis);
   const meta=structuredClone(l.meta);meta.budget.maxPayloadBytes=1000;assert.equal((await p.createRun(meta)).status,'OK');
   for(const e of l.entries){if(e.request.type==='ingestDelayedObservation')break;assert.equal((await p.transact(RUN_ID,e.request)).status,'OK');}
   const before=await redis(['GET',producerKey(RUN_ID)]);assert.equal((await p.ingestDelayedObservation(RUN_ID,ingest)).status,'BLOCKED_STORAGE');assert.equal(await redis(['GET',producerKey(RUN_ID)]),before);
  });
  await t.test('worker mapping is frozen; final receipt cannot change; old owner cannot finalize',async()=>{
   await fresh([cycle(0)]);await run();const store=createWorkerStore(redis),lease=await store.acquire('new');const s=await store.read(),item=Object.values(s.intents)[0];
   const changed=structuredClone(item);changed.status='BLOCKED_MAPPING';assert.equal((await store.save('new',lease.fence,changed)).status,'CONFLICT');
   await expire();await store.acquire('takeover');assert.equal((await store.save('new',lease.fence,item)).status,'FENCED');
   const raw=await read(WORKER_KEY);raw.mappingVersion='v2';await redis(['SET',WORKER_KEY,JSON.stringify(raw)]);assert.equal((await run()).status,'CONFLICT');
  });
  await t.test('50 observations accepted for mapping; 51 blocked',async()=>{
   // Small immutable incomplete evidence fits F2 envelope; mapping remains blocked.
   const small=n=>{const e=cycle(0).envelope;e.observations=Array.from({length:n},(_,i)=>{const payload={symbol:'S'+i,instrumentType:'SWAP',direction:'Long',canonicalEvidence:{gate:'isConfirmedAPlusTrade',confirmed:true}};
    return {observationId:digest([e.schemaVersion,e.sourceCycleId,'SWAP',payload.symbol,'Long']),payload,payloadHash:digest(payload)};}).sort((a,b)=>a.observationId<b.observationId?-1:1);e.expectedObservationCount=n;e.persistedObservationCount=n;return validateCycle(canonicalJSON(e),e.sourceCycleId);};
   await fresh([small(50)]);let r=await run();assert.equal(r.blockedObservations,50);assert.ok(!r.reasonCodes.includes('OBSERVATION_LIMIT_EXCEEDED'));
   await fresh([small(51)]);r=await run();assert.deepEqual(r.reasonCodes,['OBSERVATION_LIMIT_EXCEEDED']);assert.equal(await read(producerKey(RUN_ID)),null);
  });
  await t.test('late earlier cycle blocks; conflicting source hash fails closed',async()=>{
   const a=cycle(0),b=cycle(0,'2026-10-18T10:01:00.000Z');await fresh([b]);await run();await seed([a,b]);assert.equal((await run()).status,'BLOCKED_MAPPING');
   await fresh([cycle(1,T,false)]);await run();const changed=mutate(cycle(1,T,false),e=>e.observations[0].payload.confidence=91);await seed([changed]);assert.equal((await run()).reasonCode,'SOURCE_HASH_CONFLICT');
  });
  await t.test('lease conflict, 60000ms TTL, expiry takeover, old owner fenced',async()=>{
   await fresh([]);const store=createWorkerStore(redis),a=await store.acquire('a');assert.equal(a.status,'OK');const s=await read(WORKER_KEY);assert.ok(s.expiresAt-Date.now()>58000&&s.expiresAt-Date.now()<=60000);
   assert.equal((await store.acquire('b')).status,'BUSY');await expire();const b=await store.acquire('b');assert.ok(b.fence>a.fence);
   assert.equal((await store.check('a',a.fence)).status,'FENCED');await assert.rejects(()=>fencedExecutor(redis,'a',a.fence,()=>{})(['GET',OBSERVATION_KEY]));
  });
  await t.test('45s budget stops before another 5s command; no retry',async()=>{
   await fresh([cycle()]);let time=Date.parse(W),calls=0;const r=await runWorker({now:()=>time,execute:async c=>{calls++;const x=await redis(c);time+=10000;return x;}});
   assert.equal(r.status,'UNRESOLVED');assert.equal(r.reasonCode,'DEADLINE');assert.ok(calls<=4);
  });
  await t.test('legacy 32KiB threshold is no longer worker rejection',async()=>{
   await fresh([]);const s=createWorkerStore(redis),lease=await s.acquire('x'),before=await redis(['GET',WORKER_KEY]);
   assert.equal((await s.save('x',lease.fence,{id:'a',frozen:'x'.repeat(32769),actions:{},done:{},status:'RUNNING'})).status,'OK');assert.notEqual(await redis(['GET',WORKER_KEY]),before);
  });
  await t.test('resume real N2 action prefix before next cycle, preserving done and side effects',async()=>{
   const c=cycle(2),later=cycle(0,'2026-10-18T10:02:00.000Z');await fresh([c,later]);let cut=false;
   await run(async command=>{if(cut)throw Error('crash');const r=await redis(command);
    if(command[0]==='EVAL'&&command[4]==='SAVE'){const i=JSON.parse(command[7]);
     if(Object.keys(i.actions).length===10&&Object.keys(i.done).length===10){cut=true;throw Error('crash after action 10');}}
    return r;});
   assert.equal(cut,true);const before=(await createWorkerStore(redis).read()).intents[c.envelope.sourceCycleId];
   assert.equal(before.status,'RUNNING');await expire();const result=await run();assert.equal(result.status,'COMPLETE');
   const state=await createWorkerStore(redis).read(),after=state.intents[c.envelope.sourceCycleId];
   assert.equal(Object.keys(state.intents).length,1);assert.equal(after.status,'COMPLETE');assert.equal(after.frozen,before.frozen);
   for(const [key,value]of Object.entries(before.actions))assert.equal(after.actions[key],value);
   for(const [key,value]of Object.entries(before.done))assert.equal(after.done[key],value);
   assert.equal(Object.keys(after.actions).length,12);assert.equal(Object.keys(after.done).length,12);assert.equal(after.receiptVersion,undefined);
   const p=await createProducerStore(redis).read(RUN_ID);assert.equal(p.state.generations.length,2);assert.equal(p.state.captures.length,2);
   assert.equal((await read(shadowKey(RUN_ID))).records.length,2);assert.equal((await run()).status,'COMPLETE');
  });
  await t.test('crash after each durable write resumes identical intent, single generation/capture',async()=>{
   await fresh([cycle()]);let writes=0;const spy=async c=>{const r=await redis(c);if(c[0]==='EVAL'&&String(c[1]).includes("redis.call('SET'"))writes++;return r;};assert.equal((await run(spy)).status,'COMPLETE');
   for(let cut=1;cut<=writes;cut++){
    await fresh([cycle()]);let seen=0,dead=false;const faulty=async c=>{if(dead)throw Error('crashed');const r=await redis(c);
     if(c[0]==='EVAL'&&String(c[1]).includes("redis.call('SET'")){seen++;if(seen===cut){dead=true;throw Error('crash after commit');}}return r;};
    await run(faulty);const before=await createWorkerStore(redis).read();await expire();const r=await run();assert.ok(['COMPLETE','IDLE'].includes(r.status),`boundary ${cut}: ${JSON.stringify(r)}`);
    const after=await createWorkerStore(redis).read();for(const [id,item]of Object.entries(before.intents))assert.equal(after.intents[id].frozen,item.frozen);
    const p=await createProducerStore(redis).read(RUN_ID);assert.equal(p.state.generations.length,1);assert.equal(p.state.captures.length,1);assert.equal((await read(shadowKey(RUN_ID))).records.length,1);
   }
  });
 }finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
test('no admission/closure/scheduler in worker code',async()=>{
 const s=await readFile(new URL('../lib/forward-validation/worker.js',import.meta.url),'utf8');assert.doesNotMatch(s,/recordGenerationClosure|reduceMinute|evaluateTradeLifecycle|QStash|setInterval/);
});
