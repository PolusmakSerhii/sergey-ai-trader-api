import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSourceEpoch,deriveEpochProof,VERSION} from '../lib/forward-validation/source-epoch.js';
import {createSourceRegistry,VERSION as RV,RUN_ID,REGISTRY_KEY} from '../lib/forward-validation/source-registry.js';
import {prepareObservationCycle,persistObservationCycle} from '../lib/forward-validation/observation-store.js';
import {deriveBoundaryProof} from '../lib/forward-validation/source-contract.js';
const exec=promisify(execFile);
test('epoch transitions on isolated Unix Redis only',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-epoch-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 const start=Math.ceil(Date.now()/60000)*60000+60000,at=i=>new Date(start+i*60000).toISOString();
 const redis=async cmd=>{if(cmd[0]==='TIME')return [String(Math.floor((start+100*60000)/1000)),'0'];const {stdout}=await exec('redis-cli',['-s',socket,'--json',...cmd.map(String)],{maxBuffer:12*1024*1024});if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);};
 const store=createSourceEpoch(redis),old=createSourceRegistry(redis);
 const activation={epochVersion:VERSION,runId:RUN_ID,epochId:'epoch-test',activatedAt:at(0),sourceLowerBound:at(0),protocolVersion:'1.1',registryVersion:RV,status:'ACTIVE'};
 const fresh=async()=>{await redis(['FLUSHDB']);assert.equal((await old.activate({registryVersion:RV,runId:RUN_ID,activatedAt:at(0),activationSourceBoundary:at(0),protocolVersion:'1.1'})).status,'ACTIVATED');assert.equal((await store.activate(activation)).status,'ACTIVATED');};
 const fixture=async(i=1,n=1)=>{
  const reg=await store.register('lease-'+i,at(i),at(i));
  const snapshot={ok:true,status:'ready',mode:'global-ranking',version:'1.0',generatedAt:at(i),resultsFailed:0,globalRanking:Array.from({length:n},(_,k)=>({symbol:'S'+k,direction:'Long',analysisContext:{analysisAt:at(i)},entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,opportunityScore:90,confidence:90,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true},riskReward:3}))};
  const prepared=prepareObservationCycle(snapshot,()=>true),binding=await store.bind(reg,snapshot,prepared);return {reg,snapshot,prepared,binding};
 };
 const observe=async x=>store.observe(x.binding,x.prepared,await persistObservationCycle(x.prepared,redis));
 try{
  let ready=false;for(let i=0;i<100;i++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  await t.test('disabled, explicit activation, replay, conflicting activation',async()=>{
   assert.equal((await store.register('x',at(1),at(1))).status,'NOT_STARTED');await fresh();assert.equal((await store.activate(activation)).status,'IDEMPOTENT');assert.equal((await store.activate({...activation,epochId:'other'})).status,'CONFLICT');
  });
  await t.test('preactivation and in-flight excluded, historical interval unproven',async()=>{
   await fresh();assert.equal((await store.register('old',at(-1),at(1))).status,'REJECTED');assert.equal((await store.register('equal',at(0),at(1))).status,'REJECTED');assert.equal(deriveEpochProof(await store.read(),at(-1)).status,'UNRESOLVED');
  });
  await t.test('immutable lower bound and registration replay',async()=>{
   await fresh();const a=await store.register('a',at(1),at(1));assert.equal(a.status,'EXPECTED');assert.equal((await store.register('a',at(1),at(1))).status,'IDEMPOTENT');assert.equal((await store.register('a',at(2),at(2))).status,'CONFLICT');
  });
  for(const n of [0,1])await t.test(`${n} A+: bind/observe replay and compatible source proof`,async()=>{
   await fresh();const x=await fixture(1,n);assert.equal(x.binding.status,'BOUND');assert.equal((await store.bind(x.reg,x.snapshot,x.prepared)).status,'IDEMPOTENT');assert.equal((await observe(x)).status,'OBSERVED');assert.equal((await observe(x)).status,'IDEMPOTENT');
   assert.equal((await store.seal(at(2))).status,'SEALED');assert.equal((await store.seal(at(2))).status,'IDEMPOTENT');const state=await store.read(),proof=deriveEpochProof(state,at(2));assert.equal(proof.sourceFence.closed,true,JSON.stringify(proof));assert.equal(proof.registryProof.futureSourceTimeLowerBound,new Date(Date.parse(at(2))+1).toISOString());
   assert.equal(state.coverageBarrier,'UNRESOLVED_RESERVATION_GAP');
   assert.equal(deriveBoundaryProof({minute:at(2),sourceFence:proof.sourceFence,candidateCompleteness:{minute:at(2),complete:true,unresolvedEarlier:false,evidenceRef:'synthetic-candidates'},lifecycleCompleteness:{minute:at(2),complete:true,unresolvedEarlier:false,evidenceRef:'synthetic-lifecycle'}}).sealed,true);
  });
  await t.test('unresolved registered member blocks sealing and cannot disappear',async()=>{
   await fresh();const x=await fixture();assert.equal((await store.seal(at(2))).status,'UNRESOLVED');assert.equal((await store.observe(x.binding,x.prepared,{status:'UNRESOLVED'})).status,'UNRESOLVED');assert.equal((await store.seal(at(2))).status,'UNRESOLVED');assert.equal((await store.read()).reservations[x.reg.reservationId].status,'EXPECTED');
  });
  await t.test('snapshot construction failure leaves durable member',async()=>{await fresh();const r=await store.register('no-snapshot',at(1),at(1));assert.equal((await store.read()).reservations[r.reservationId].status,'EXPECTED');assert.equal((await store.seal(at(2))).status,'UNRESOLVED');});
  await t.test('conflicting binding or older source evidence blocks seal',async()=>{
   for(const kind of ['hash','older']){await fresh();const x=await fixture();const changed=structuredClone(x.snapshot);if(kind==='hash')changed.extra='changed';else changed.globalRanking[0].analysisContext.analysisAt=at(-1);assert.equal((await store.bind(x.reg,changed,prepareObservationCycle(changed,()=>true))).status,'CONFLICT');assert.equal((await store.seal(at(2))).status,'UNRESOLVED');}
  });
  await t.test('conflict persistence overflow is reported, prior evidence preserved',async()=>{
   await fresh();const x=await fixture();const state=await store.read();state.receipts=50000;await redis(['SET',REGISTRY_KEY,JSON.stringify(state)]);
   const before=await redis(['GET',REGISTRY_KEY]);const changed={...x.snapshot,extra:'conflicting'};
   assert.equal((await store.bind(x.reg,changed,x.prepared)).status,'BLOCKED_STORAGE');
   assert.equal(await redis(['GET',REGISTRY_KEY]),before);
   assert.equal((await store.seal(at(2))).status,'UNRESOLVED');
  });
  await t.test('monotonic seal and atomic gate reject <= T, accept > T',async()=>{
   await fresh();assert.equal((await store.seal(at(2))).status,'SEALED');assert.equal((await store.seal(at(1))).status,'CONFLICT');assert.equal((await store.register('old',at(2),at(3))).status,'REJECTED');assert.equal((await store.register('new',at(3),at(3))).status,'EXPECTED');
  });
  await t.test('unregistered snapshot cannot bind or retroactively join',async()=>{
   await fresh();await store.seal(at(2));const x=await fixture(1);assert.equal(x.reg.status,'REJECTED');assert.equal(x.binding.status,'REJECTED');assert.equal(Object.keys((await store.read()).reservations).length,0);
  });
  await t.test('timeout before commit: nonmember; lost reply after commit: exact recovery only',async()=>{
   await fresh();const absent=createSourceEpoch(async c=>{if(c[0]==='EVAL')throw Error('timeout');return redis(c);});assert.equal((await absent.register('absent',at(1),at(1))).status,'UNRESOLVED');assert.equal((await store.recover('absent',at(1),at(1))).status,'UNRESOLVED');
   const lost=createSourceEpoch(async c=>{const v=await redis(c);if(c[0]==='EVAL')throw Error('lost reply');return v;});assert.equal((await lost.register('lost',at(1),at(1))).status,'UNRESOLVED');assert.equal((await store.recover('lost',at(1),at(1))).status,'IDEMPOTENT');assert.equal((await store.seal(at(2))).status,'UNRESOLVED');
  });
  await t.test('atomic race registration versus sealing cannot both commit',async()=>{
   await fresh();const results=await Promise.all([store.register('race',at(1),at(1)),store.seal(at(2))]);assert.ok(!(results[0].status==='EXPECTED'&&results[1].status==='SEALED'));const s=await store.read();if(s.epoch.sealedThrough)assert.equal(Object.keys(s.reservations).length,0);
  });
  await t.test('crash after sealing resumes exact durable frontier',async()=>{
   await fresh();const lost=createSourceEpoch(async c=>{const v=await redis(c);if(c[0]==='EVAL')throw Error('lost');return v;});assert.equal((await lost.seal(at(2))).status,'UNRESOLVED');assert.equal((await store.seal(at(2))).status,'IDEMPOTENT');assert.equal(deriveEpochProof(await store.read(),at(2)).sourceFence.closed,true);
  });
  await t.test('budget overflow preserves prior registry bytes',async()=>{
   await fresh();const s=await store.read();s.receipts=50000;await redis(['SET',REGISTRY_KEY,JSON.stringify(s)]);const before=await redis(['GET',REGISTRY_KEY]);assert.equal((await store.register('overflow',at(1),at(1))).status,'BLOCKED_STORAGE');assert.equal(await redis(['GET',REGISTRY_KEY]),before);
  });
 }finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
