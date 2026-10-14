import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createShadowStore, shadowKey, hashValue, immutableOriginHash, canonicalJSON } from '../lib/forward-validation/store.js';
const exec = promisify(execFile);
const T='2026-10-14T10:00:00.000Z';
const meta=(runId,budget={maxBytes:1000000,maxRecords:100,maxEvents:100,maxOperations:200})=>({
  schemaVersion:1,mode:'SHADOW',protocolVersion:'1.1',admissionVersion:'1.1',runId,
  officialActivationId:null,officialActivationAt:null,coreCommit:'b7cb03c35a350f64f3a0ae8ecf33ca4973f2e9ac',
  ledgerRevision:0,captureWatermark:null,decisionWatermark:null,health:'HEALTHY',failureReason:null,storageBudget:budget
});
function record(id='a'){
  const r={identityOrigin:'SHADOW_ONLY',coreTradeId:null,shadowCandidateId:id,setupKey:`${id}:Long`,symbol:id,
    instrumentType:'SWAP',direction:'Long',origin:{detectedAt:T},analysisAt:T,initialPlan:{entryPrice:100},
    originalEligibility:{confirmedAPlus:true},state:'WAITING_ENTRY',priorDisposition:null,capacityOccupied:false,
    verificationCursor:null,verifiedThrough:null,unresolvedReason:null,eligibleEntryCandle:null,admissionDecision:null,
    skipReason:null,lifecycleEvidenceRefs:[],terminal:null,recordedAt:T,updatedAt:T,revision:0};
  r.immutableOriginHash=immutableOriginHash(r);return r;
}
const decision=(value='ADMITTED')=>({eventTime:T,decidedAt:T,comparatorKey:[T,T,'a'],capacityBefore:[],decision:value,reason:null,evidenceRefs:['evidence-a']});
const event=(id='e',identity='a',source=id)=>({eventId:id,sourceOperationId:source,sourceRevision:0,identity,type:'OBSERVED',eventTime:T,observedAt:T,payload:{value:1},evidenceHash:hashValue({value:1})});
const tx=(operationId,expectedLedgerRevision,records=[],events=[],metadata)=>({operationId,expectedLedgerRevision,records,events,...(metadata?{metadata}:{})});
const create=(r)=>({expectedRevision:null,record:r});
const update=(r)=>({expectedRevision:r.revision,record:{...structuredClone(r),revision:r.revision+1}});

test('isolated Forward store against private Unix-socket Redis only',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm1m-forward-store-')),socket=join(dir,'redis.sock');
  const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
  let serverError;server.on('error',e=>{serverError=e;});
  const commands=[];
  const redis=async command=>{
    commands.push(structuredClone(command));
    const {stdout}=await exec('redis-cli',['-s',socket,'--json',...command.map(String)],{maxBuffer:4*1024*1024});
    if(stdout.startsWith('error:'))throw new Error(stdout);
    return JSON.parse(stdout);
  };
  const store=createShadowStore(redis);
  let sequence=0;
  const fresh=async(budget)=>{const id=`run-${++sequence}`;assert.equal((await store.createRun(meta(id,budget))).status,'CREATED');return id;};
  const seeded=async()=>{const id=await fresh();assert.equal((await store.commit(id,tx('create',0,[create(record())]))).status,'OK');return id;};
  const ledger=async id=>{const r=await store.read(id);assert.equal(r.status,'OK');return r.ledger;};
  const save=async(id,r,op='update')=>{const l=await ledger(id);return store.commit(id,tx(op,l.meta.ledgerRevision,[update(r)]));};
  const toState=async(id,state)=>{
    let r=(await ledger(id)).records[0];r.state=state;r.capacityOccupied=state==='ADMITTED';
    r.admissionDecision=['ADMITTED','SKIPPED_CAPACITY'].includes(state)?decision(state):null;
    r.skipReason=state.startsWith('SKIPPED')?'reason':null;
    assert.equal((await save(id,r)).status,'OK');return (await ledger(id)).records[0];
  };
  try{
    let ready=false;
    for(let i=0;i<100;i++){if(serverError)throw serverError;try{ready=await redis(['PING'])==='PONG';}catch{}if(ready)break;await new Promise(r=>setTimeout(r,20));}
    assert.ok(ready,'Local Redis unavailable; no production fallback permitted');
    await t.test('create SHADOW with mandatory null official fields',async()=>{const id=await fresh();const l=await ledger(id);assert.equal(l.meta.mode,'SHADOW');assert.equal(l.meta.officialActivationAt,null);});
    await t.test('official mode rejected before writing',async()=>assert.equal((await store.createRun({...meta('official'),mode:'OFFICIAL'})).status,'INVALID_SHADOW_MODE'));
    for(const key of ['officialActivationId','officialActivationAt'])await t.test('non-null '+key+' rejected',async()=>assert.equal((await store.createRun({...meta('marker'),[key]:T})).status,'INVALID_SHADOW_MODE'));
    await t.test('budget must be explicitly configured',async()=>assert.equal((await store.createRun(meta('unset',null))).status,'BUDGET_UNSET'));
    await t.test('exact create-run retry is idempotent',async()=>{const id=await fresh();assert.equal((await store.createRun(meta(id))).status,'IDEMPOTENT');});
    await t.test('different run metadata conflicts',async()=>{const id=await fresh();assert.equal((await store.createRun({...meta(id),coreCommit:'a'.repeat(40)})).status,'RUN_CONFLICT');});
    await t.test('create record, exact lost-response retry, no duplicate',async()=>{
      const id=await fresh(),request=tx('op',0,[create(record())]);
      assert.equal((await store.commit(id,request)).status,'OK');
      const before=await redis(['GET',shadowKey(id)]);
      assert.equal((await store.commit(id,request)).status,'IDEMPOTENT');
      assert.equal(await redis(['GET',shadowKey(id)]),before);assert.equal((await ledger(id)).records.length,1);
    });
    await t.test('exact record creation with fresh operation id is idempotent',async()=>{
      const id=await seeded();assert.equal((await store.commit(id,tx('retry',1,[create(record())]))).status,'IDEMPOTENT');assert.equal((await ledger(id)).records.length,1);
    });
    await t.test('immutable origin conflict even with recalculated hash',async()=>{
      const id=await seeded(),r=record();r.initialPlan.entryPrice=999;r.immutableOriginHash=immutableOriginHash(r);
      assert.equal((await store.commit(id,tx('bad',1,[create(r)]))).status,'IMMUTABLE_CONFLICT');
    });
    await t.test('append event and retry exactly once',async()=>{
      const id=await seeded(),request=tx('event',1,[],[event()]);
      assert.equal((await store.commit(id,request)).status,'OK');assert.equal((await store.commit(id,request)).status,'IDEMPOTENT');assert.equal((await ledger(id)).events.length,1);
    });
    await t.test('same event ID conflicting payload/hash rejected',async()=>{
      const id=await seeded();await store.commit(id,tx('e1',1,[],[event()]));
      const e=event();e.payload.value=2;e.evidenceHash=hashValue(e.payload);
      assert.equal((await store.commit(id,tx('e2',2,[],[e]))).status,'EVENT_CONFLICT');
    });
    await t.test('wrong evidence hash rejected',async()=>{const id=await seeded();assert.equal((await store.commit(id,tx('bad',1,[],[{...event(),evidenceHash:'a'.repeat(64)}]))).status,'EVENT_HASH_CONFLICT');});
    await t.test('source operation/revision cannot map to different event',async()=>{
      const id=await seeded();await store.commit(id,tx('e1',1,[],[event('one','a','source')]));
      assert.equal((await store.commit(id,tx('e2',2,[],[event('two','a','source')]))).status,'EVENT_CONFLICT');
      assert.equal((await store.commit(id,tx('e3',2,[],[event('one','a','source')]))).status,'IDEMPOTENT');
    });
    await t.test('no-op operation ID cannot later change content',async()=>{
      const id=await seeded();await store.commit(id,tx('noop',1));
      assert.equal((await store.commit(id,tx('noop',1,[],[event()]))).status,'OPERATION_CONFLICT');
    });
    await t.test('valid CAS updates record and ledger revisions',async()=>{
      const id=await seeded(),r=record();r.verifiedThrough=T;
      assert.equal((await save(id,r)).status,'OK');const l=await ledger(id);assert.equal(l.records[0].revision,1);assert.equal(l.meta.ledgerRevision,2);
    });
    await t.test('stale ledger rejected',async()=>{const id=await seeded();assert.equal((await store.commit(id,tx('stale',0))).status,'STALE');});
    await t.test('stale record revision rejected',async()=>{
      const id=await seeded();await save(id,record());assert.equal((await store.commit(id,tx('stale',2,[update(record())]))).status,'STALE');
    });
    for(const state of ['ADMITTED','SKIPPED_CAPACITY'])await t.test(state+' decision immutable',async()=>{
      const id=await seeded(),r=await toState(id,state);r.admissionDecision.reason='rewritten';
      assert.equal((await save(id,r,'bad')).status,'FINAL_DECISION_CONFLICT');
    });
    await t.test('SKIPPED_MISSED_ENTRY cannot regress',async()=>{
      const id=await seeded(),r=await toState(id,'SKIPPED_MISSED_ENTRY');r.state='WAITING_ENTRY';r.skipReason=null;
      assert.equal((await save(id,r,'bad')).status,'FINAL_STATE_CONFLICT');
    });
    const completed=async()=>{
      const id=await seeded();let r=await toState(id,'ADMITTED');r.state='COMPLETED';
      r.terminal={status:'Closed',checkedAt:T,resultR:null,evidenceRef:'terminal-1'};
      assert.equal((await save(id,r,'complete')).status,'OK');return id;
    };
    await t.test('COMPLETED cannot regress or rewrite model R',async()=>{
      const id=await completed();let r=(await ledger(id)).records[0];r.state='ADMITTED';r.terminal=null;
      assert.equal((await save(id,r,'bad')).status,'FINAL_STATE_CONFLICT');
      r=(await ledger(id)).records[0];r.terminal.resultR=1;assert.equal((await save(id,r,'bad2')).status,'FINAL_STATE_CONFLICT');
    });
    await t.test('COMPLETED can release slot once without editing terminal facts',async()=>{
      const id=await completed();let r=(await ledger(id)).records[0];r.capacityOccupied=false;
      assert.equal((await save(id,r,'release')).status,'OK');r=(await ledger(id)).records[0];r.capacityOccupied=true;
      assert.equal((await save(id,r,'reoccupy')).status,'FINAL_STATE_CONFLICT');
    });
    await t.test('unresolved waiting recovers and retains prior disposition',async()=>{
      const id=await seeded();let r=record();r.state='UNRESOLVED_VERIFICATION';r.priorDisposition='WAITING_ENTRY';r.unresolvedReason='GAP';
      assert.equal((await save(id,r)).status,'OK');r=(await ledger(id)).records[0];assert.equal(r.priorDisposition,'WAITING_ENTRY');
      r.state='WAITING_ENTRY';r.priorDisposition=null;r.unresolvedReason=null;assert.equal((await save(id,r,'recover')).status,'OK');
    });
    await t.test('admitted unresolved retains occupied capacity and decision',async()=>{
      const id=await seeded();let r=await toState(id,'ADMITTED');r.state='UNRESOLVED_VERIFICATION';r.priorDisposition='ADMITTED';r.unresolvedReason='GAP';
      assert.equal((await save(id,r,'gap')).status,'OK');r=(await ledger(id)).records[0];assert.equal(r.capacityOccupied,true);
      r.capacityOccupied=false;assert.equal((await save(id,r,'bad')).status,'INVALID_OCCUPANCY');
    });
    await t.test('unresolved priorDisposition cannot be rewritten',async()=>{
      const id=await seeded();const r=record();r.state='UNRESOLVED_VERIFICATION';r.priorDisposition='DETECTED';r.unresolvedReason='GAP';
      assert.equal((await save(id,r)).status,'STATE_REGRESSION');
    });
    await t.test('reserved data failure state rejected',async()=>{
      const id=await seeded();const r=record();r.state='SKIPPED_DATA_FAILURE';assert.equal((await save(id,r)).status,'INVALID_OR_RESERVED_STATE');
    });
    await t.test('malformed stored JSON fails closed without write',async()=>{
      const id=await fresh();await redis(['SET',shadowKey(id),'{broken']);
      assert.equal((await store.read(id)).status,'MALFORMED_STORED_JSON');assert.equal((await store.commit(id,tx('x',0))).status,'MALFORMED_STORED_JSON');
      assert.equal(await redis(['GET',shadowKey(id)]),'{broken');
    });
    await t.test('inconsistent checksum fails closed',async()=>{
      const id=await seeded();const l=await ledger(id);l.records[0].capacityOccupied=true;await redis(['SET',shadowKey(id),JSON.stringify(l)]);
      assert.equal((await store.read(id)).status,'INCONSISTENT_LEDGER');
    });
    await t.test('partial ledger fails closed even with matching checksum',async()=>{
      const id=await seeded();const l=await ledger(id);delete l.records;delete l.integrityHash;l.integrityHash=hashValue(l);
      await redis(['SET',shadowKey(id),JSON.stringify(l)]);assert.equal((await store.read(id)).status,'INCONSISTENT_LEDGER');
    });
    await t.test('tiny byte budget blocks initial creation',async()=>{
      const m=meta('tiny',{maxBytes:1,maxRecords:1,maxEvents:1,maxOperations:1});
      assert.equal((await store.createRun(m)).status,'BLOCKED_STORAGE');assert.equal(await redis(['GET',shadowKey('tiny')]),null);
    });
    await t.test('budget overflow preserves records/events/watermark byte-for-byte',async()=>{
      const id=await fresh({maxBytes:8000,maxRecords:1,maxEvents:1,maxOperations:10});
      assert.equal((await store.commit(id,tx('init',0,[create(record())],[event()]))).status,'OK');
      const before=await redis(['GET',shadowKey(id)]);
      const r=await store.commit(id,tx('overflow',1,[create(record('b'))],[],{captureWatermark:T,decisionWatermark:T}));
      assert.equal(r.status,'BLOCKED_STORAGE');assert.equal(r.persisted,false);assert.equal(await redis(['GET',shadowKey(id)]),before);
      assert.equal((await store.commit(id,tx('event-overflow',1,[],[event('two')]))).status,'BLOCKED_STORAGE');
      assert.equal(await redis(['GET',shadowKey(id)]),before);
    });
    await t.test('UTF-8 byte budget includes payload and receipt bytes',async()=>{
      const id=await fresh({maxBytes:6000,maxRecords:2,maxEvents:5,maxOperations:5});
      await store.commit(id,tx('create',0,[create(record())]));const e=event();e.payload={text:'я'.repeat(5000)};e.evidenceHash=hashValue(e.payload);
      assert.equal((await store.commit(id,tx('large',1,[],[e]))).status,'BLOCKED_STORAGE');
    });
    await t.test('watermark cannot regress or exceed capture frontier',async()=>{
      const id=await fresh();assert.equal((await store.commit(id,tx('advance',0,[],[],{captureWatermark:T,decisionWatermark:T}))).status,'OK');
      assert.equal((await store.commit(id,tx('back',1,[],[],{captureWatermark:null}))).status,'WATERMARK_REGRESSION');
      assert.equal((await store.commit(id,tx('ahead',1,[],[],{decisionWatermark:'2026-10-14T10:01:00.000Z'}))).status,'INVALID_WATERMARK');
    });
    await t.test('restart uses persisted idempotency receipt',async()=>{
      const id=await seeded(),request=tx('event',1,[],[event()]);await store.commit(id,request);
      assert.equal((await createShadowStore(redis).commit(id,request)).status,'IDEMPOTENT');
    });
    await t.test('lost response after successful CAS is retry-safe',async()=>{
      const id=await seeded();let lost=true;const flaky=createShadowStore(async command=>{const result=await redis(command);if(command[0]==='EVAL'&&lost){lost=false;throw new Error('lost response');}return result;});
      const request=tx('lost',1,[],[event()]);assert.equal((await flaky.commit(id,request)).status,'STORAGE_ERROR');
      assert.equal((await flaky.commit(id,request)).status,'IDEMPOTENT');assert.equal((await ledger(id)).events.length,1);
    });
    await t.test('write transport failure is infrastructure failure, no disposition',async()=>{
      const id=await seeded();const before=await redis(['GET',shadowKey(id)]);
      const failing=createShadowStore(command=>command[0]==='EVAL'?Promise.reject(new Error('failure')):redis(command));
      const r=await failing.commit(id,tx('bad',1,[],[event()]));assert.equal(r.status,'STORAGE_ERROR');assert.equal(r.state,undefined);
      assert.equal(await redis(['GET',shadowKey(id)]),before);
    });
    await t.test('two writers reading same revision: exactly one CAS wins',async()=>{
      const id=await seeded();let reads=0,open;const barrier=new Promise(resolve=>{open=resolve;});
      const concurrent=createShadowStore(async command=>{const result=await redis(command);if(command[0]==='GET'){reads++;if(reads===2)open();await barrier;}return result;});
      const rs=await Promise.all([concurrent.commit(id,tx('one',1,[],[event('one')])),concurrent.commit(id,tx('two',1,[],[event('two')]))]);
      assert.deepEqual(rs.map(r=>r.status).sort(),['OK','STALE']);const l=await ledger(id);assert.equal(l.meta.ledgerRevision,2);assert.equal(l.events.length,1);
    });
    await t.test('event order independent of submitted order',async()=>{
      const id=await seeded();await store.commit(id,tx('events',1,[],[event('z'),event('b')]));
      assert.deepEqual((await ledger(id)).events.map(e=>e.eventId),['b','z']);
    });
    await t.test('invalid namespace cannot reach Core key',async()=>{
      for(const id of ['', '../core','x:stats','x{tag}'])assert.throws(()=>shadowKey(id));
      assert.match(shadowKey('test'),/^sergey-ai:forward-shadow:v1:test:ledger$/);
    });
    await t.test('store touches only SHADOW keys; no Core/statistics/archive writes',async()=>{
      for(const c of commands){if(c[0]==='GET'||c[0]==='SET')assert.match(c[1],/^sergey-ai:forward-shadow:v1:/);if(c[0]==='EVAL'){assert.equal(c[2],'1');assert.match(c[3],/^sergey-ai:forward-shadow:v1:/);}}
      const all=await redis(['KEYS','*']);assert.ok(all.every(k=>k.startsWith('sergey-ai:forward-shadow:v1:')));
    });
    await t.test('store has no engine imports, comparator, capacity thresholds or transport',async()=>{
      const src=await readFile(new URL('../lib/forward-validation/store.js',import.meta.url),'utf8');
      assert.doesNotMatch(src,/compareCandidates|checkCapacity|reduceMinute|MAX_TOTAL|MAX_SAME_DIRECTION|localeCompare|fetch\(|Date\.now\(|process\.env|api\/market|from ['"]\.\/engine/);
    });
    await t.test('inputs unchanged and canonical JSON rejects non-finite values',async()=>{
      const id=await fresh(),request=tx('one',0,[create(record())]);const before=structuredClone(request);
      await store.commit(id,request);assert.deepEqual(request,before);assert.throws(()=>canonicalJSON({n:NaN}));
    });
  }finally{
    if(server.exitCode===null&&server.signalCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;}
    await rm(dir,{recursive:true,force:true});
  }
});
