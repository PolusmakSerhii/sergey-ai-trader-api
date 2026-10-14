import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,execFile } from 'node:child_process';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProducerStore,producerKey,producerHash } from '../lib/forward-validation/producer-store.js';
import { universeDigest } from '../lib/forward-validation/source-contract.js';
const exec=promisify(execFile),T='2026-10-15T10:00:00.000Z',U='2026-10-15T10:01:00.000Z',V='2026-10-15T10:02:00.000Z';
const clone=structuredClone;
const budget=()=>({maxBytes:5000000,maxCycles:100,maxOperations:100,maxEvents:500,maxGenerations:100,
  maxRetainedPayloadBytes:4000000,maxPayloadBytes:1000000,maxIdempotencyReceipts:500});
const meta=(runId,changes={})=>({runId,mode:'SHADOW',schemaVersion:1,coreCommit:'37dfece6b6eabc836a2ce318018c014e77629d8b',
  officialActivationId:null,officialActivationAt:null,budget:{...budget(),...changes}});
const allocation=(allocationId='allocation-1',at=T)=>({allocationId,cycleStartedAt:at,sourceTimeLowerBound:at});
const frozen=(cycleId,symbols=['AAA'])=>({cycleId,universeId:'okx-test',universeHash:universeDigest(symbols),expectedSymbols:symbols,
  batchCount:1,batches:[{batchId:`${cycleId}:batch:0`,batchIndex:0,expectedBatchSymbols:symbols}]});
const intent=(cycleId,symbol='AAA',at=T)=>({operationId:`${cycleId}:0:SWAP:${symbol}`,cycleId,batchId:`${cycleId}:batch:0`,batchIndex:0,
  symbol,instrumentType:'SWAP',sourceTimeLowerBound:at,registeredAt:at,processingStartedAt:at});
function candidate(symbol='AAA',at=T) {const setupKey=`${symbol}:Long`,id=`${setupKey}:${at}`;
  return {tradeId:id,setupKey,symbol,direction:'Long',instrumentType:'SWAP',origin:{detectedAt:at},
    initialPlan:{createdAt:at,entryZone:{from:99,to:101},stopLoss:95,takeProfit1:110,exitStrategy:{version:'tp1-50-reanalyse-v1'}},
    originalEligibility:{confirmedAPlus:true}};}
function sourceResult(i,plus=true,at=T,extra={}) {
  const c=candidate(i.symbol,at),status=plus?'ANALYZED_A_PLUS_CAPTURE_PENDING':'ANALYZED_NO_A_PLUS';
  const payload={symbol:i.symbol,instrumentType:i.instrumentType,analysisAt:at,capturedAt:at,status,
    identityRefs:plus?[c.tradeId]:[],...(plus?{frozenCandidate:c}:{}),...extra};
  return {operationId:i.operationId,analysisAt:at,capturedAt:at,completedAt:at,status,identityRefs:payload.identityRefs,payload,payloadHash:producerHash(payload)};
}
function generation(r) {const f=r.payload.frozenCandidate;return {setupKey:f.setupKey,shadowCandidateId:f.tradeId,identityOrigin:'SHADOW_ONLY',
  originalSourceOperationId:r.operationId,originalCapturedAt:r.capturedAt,frozenCandidate:f,frozenFactsHash:producerHash(f)};}
function closure(g) {const evidence={status:'Closed',checkedAt:U,confirmed:true,shadowCandidateId:g.shadowCandidateId,frozenFactsHash:g.frozenFactsHash};
  return {shadowCandidateId:g.shadowCandidateId,proof:{shadowCandidateId:g.shadowCandidateId,frozenFactsHash:g.frozenFactsHash,
    verified:true,noGaps:true,noAmbiguity:true,evidenceRef:'closed-candle',evidence,evidenceHash:producerHash(evidence),
    closedAt:U,verifiedThrough:U,status:'Closed'}};}
function capture(r,g=generation(r)) {const id=`cap:${r.operationId}`,transaction={operationId:id,expectedLedgerRevision:0,
  records:[],events:[{identity:g.shadowCandidateId,sourceOperationId:r.operationId}]};
  return {captureOperationId:id,sourceOperationId:r.operationId,shadowCandidateId:g.shadowCandidateId,payloadHash:r.payloadHash,
    expectedShadowRevision:0,transaction,transactionHash:producerHash(transaction)};}
const receipt=c=>({captureOperationId:c.captureOperationId,receipt:{operationId:c.captureOperationId,sourceOperationId:c.sourceOperationId,
  identityRef:c.shadowCandidateId,payloadHash:c.payloadHash,transactionHash:c.transactionHash,ledgerRevision:1}});
function reconciliation(r,g=generation(r)) {const f=g.frozenCandidate,facts={setupKey:g.setupKey,symbol:f.symbol,direction:f.direction,
  instrumentType:f.instrumentType,initialPlan:f.initialPlan,origin:f.origin,originalEligibility:f.originalEligibility};
  const equivalenceProof={coreTradeId:f.tradeId,coreEvidenceRef:'core-read-proof',shadowFacts:facts,coreFacts:clone(facts)};
  return {reconciliationId:'link-1',shadowCandidateId:g.shadowCandidateId,linkedCoreTradeId:f.tradeId,
    sourceOperationId:r.operationId,equivalenceProof,proofHash:producerHash(equivalenceProof)};}

test('isolated producer store: local Unix-socket Redis only',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm1m-producer-')),socket=join(dir,'redis.sock');
  const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
  let serverError;server.on('error',e=>{serverError=e;});const commands=[];
  const redis=async cmd=>{commands.push(clone(cmd));const {stdout}=await exec('redis-cli',['-s',socket,'--json',...cmd.map(String)],{maxBuffer:12*1024*1024});
    if(stdout.startsWith('error:'))throw new Error(stdout);return JSON.parse(stdout);};
  const store=createProducerStore(redis);let run=0,request=0;
  const fresh=async changes=>{const id=`run-${++run}`;assert.equal((await store.createRun(meta(id,changes))).status,'OK');return id;};
  const read=async id=>{const r=await store.read(id);assert.equal(r.status,'OK',r.reason);return r;};
  const send=async(id,type,data,requestId=`request-${++request}`)=>{const r=await read(id);return store[type](id,{requestId,expectedRevision:r.revision,data});};
  const ok=async(...args)=>{const r=await send(...args);assert.equal(r.status,'OK',r.reason);return r;};
  const cycle=async(id,seq='alloc',symbols=['AAA'],at=T)=>{const a=await ok(id,'allocateCycle',allocation(seq,at));await ok(id,'freezeManifest',frozen(a.reply.cycleId,symbols));return a.reply.cycleId;};
  const seeded=async(changes={},plus=true)=>{const id=await fresh(changes),cid=await cycle(id),i=intent(cid);await ok(id,'registerOperation',i);
    const r=sourceResult(i,plus);await ok(id,'persistResult',r);return {id,cid,i,r};};
  const generated=async(changes={})=>{const x=await seeded(changes);x.g=generation(x.r);await ok(x.id,'getOrCreateGeneration',x.g);return x;};
  const prepared=async()=>{const x=await generated();x.c=capture(x.r);await ok(x.id,'prepareCapture',x.c);return x;};
  const raw=id=>redis(['GET',producerKey(id)]);
  try {
    let ready=false;
    for(let n=0;n<100;n++){if(serverError)throw serverError;try{if(await redis(['PING'])==='PONG'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,20));}
    assert.equal(ready,true,'local Redis unavailable');
    await t.test('explicit budget creates SHADOW run',async()=>{const id=await fresh();assert.equal((await read(id)).state.producerSequence,0);});
    await t.test('missing budget rejected',async()=>{const m=meta('missing');delete m.budget;assert.equal((await store.createRun(m)).status,'BLOCKED_INTEGRITY');});
    await t.test('null budget rejected',async()=>{const m=meta('null');m.budget=null;assert.equal((await store.createRun(m)).status,'BLOCKED_INTEGRITY');});
    await t.test('invalid budget rejected',async()=>assert.equal((await store.createRun(meta('invalid',{maxCycles:0}))).status,'BLOCKED_INTEGRITY'));
    await t.test('official mode rejected',async()=>{const m=meta('official');m.mode='FORWARD';assert.equal((await store.createRun(m)).status,'BLOCKED_INTEGRITY');});
    await t.test('activation marker rejected',async()=>{const m=meta('activated');m.officialActivationAt=T;assert.equal((await store.createRun(m)).status,'BLOCKED_INTEGRITY');});
    await t.test('namespace rejects unsafe run id',async()=>assert.equal((await store.read('../core')).status,'BLOCKED_INTEGRITY'));
    await t.test('exact run retry',async()=>{const id=await fresh();assert.equal((await store.createRun(meta(id))).status,'IDEMPOTENT');});
    await t.test('run budget immutable',async()=>{const id=await fresh();assert.equal((await store.createRun(meta(id,{maxCycles:12}))).status,'BLOCKED_INTEGRITY');});
    await t.test('atomic deterministic cycle allocation',async()=>{const id=await fresh(),r=await ok(id,'allocateCycle',allocation());assert.equal(r.reply.cycleId,`${id}:1`);assert.equal((await read(id)).state.cycles.length,1);});
    await t.test('allocation exact request retry same cycle bytes',async()=>{const id=await fresh(),q={requestId:'alloc',expectedRevision:0,data:allocation()};const a=await store.allocateCycle(id,q),before=await raw(id);const b=await store.allocateCycle(id,q);assert.equal(b.status,'IDEMPOTENT');assert.deepEqual(b.reply,a.reply);assert.equal(await raw(id),before);});
    await t.test('allocation logical retry new request id does not increment sequence',async()=>{const id=await fresh();await ok(id,'allocateCycle',allocation());await ok(id,'allocateCycle',allocation());assert.equal((await read(id)).state.producerSequence,1);});
    await t.test('genuine allocation gets next sequence',async()=>{const id=await fresh();await ok(id,'allocateCycle',allocation());const r=await ok(id,'allocateCycle',allocation('new'));assert.equal(r.reply.producerSequence,2);});
    await t.test('allocation conflicting key rejected',async()=>{const id=await fresh();await ok(id,'allocateCycle',allocation());assert.equal((await send(id,'allocateCycle',allocation('allocation-1',U))).status,'BLOCKED_INTEGRITY');});
    await t.test('restart discovers all unfinished cycles',async()=>{const id=await fresh();await ok(id,'allocateCycle',allocation());await ok(id,'allocateCycle',allocation('next'));const r=await createProducerStore(redis).readRecoveryState(id);assert.equal(r.unfinishedCycles.length,2);assert.equal(r.activeCycle,`${id}:2`);});
    await t.test('frozen universe and exact retry',async()=>{const id=await fresh(),cid=await cycle(id);await ok(id,'freezeManifest',frozen(cid));assert.deepEqual((await store.readCycle(id,cid)).manifest.expectedSymbols,['AAA']);});
    await t.test('universe replacement rejected',async()=>{const id=await fresh(),cid=await cycle(id);assert.equal((await send(id,'freezeManifest',frozen(cid,['BBB']))).status,'BLOCKED_INTEGRITY');});
    await t.test('batch membership replacement rejected',async()=>{const id=await fresh(),cid=await cycle(id);const d=frozen(cid);d.batches[0].batchId='changed';assert.equal((await send(id,'freezeManifest',d)).status,'BLOCKED_INTEGRITY');});
    await t.test('source lower bound cannot be rewritten via manifest',async()=>{const id=await fresh(),cid=await cycle(id);assert.equal((await send(id,'freezeManifest',{...frozen(cid),sourceTimeLowerBound:U})).status,'BLOCKED_INTEGRITY');});
    await t.test('intent before result and exact operation retry',async()=>{const id=await fresh(),cid=await cycle(id),i=intent(cid);await ok(id,'registerOperation',i);await ok(id,'registerOperation',i);assert.equal((await read(id)).state.operations.length,1);});
    await t.test('operation immutable facts conflict',async()=>{const x=await seeded();assert.equal((await send(x.id,'registerOperation',{...x.i,registeredAt:U})).status,'BLOCKED_INTEGRITY');});
    await t.test('result without intent rejected',async()=>{const id=await fresh(),cid=await cycle(id);assert.equal((await send(id,'persistResult',sourceResult(intent(cid)))).status,'BLOCKED_INTEGRITY');});
    await t.test('original payload survives restart',async()=>{const x=await seeded();const r=await createProducerStore(redis).read(x.id);assert.deepEqual(r.state.operations[0].result,x.r);});
    await t.test('result hash mismatch rejected',async()=>{const id=await fresh(),cid=await cycle(id),i=intent(cid);await ok(id,'registerOperation',i);const r=sourceResult(i);r.payloadHash='a'.repeat(64);assert.equal((await send(id,'persistResult',r)).status,'BLOCKED_INTEGRITY');});
    await t.test('exact result retry idempotent fact',async()=>{const x=await seeded();await ok(x.id,'persistResult',x.r);assert.equal((await read(x.id)).state.operations.length,1);});
    await t.test('conflicting later result rejected',async()=>{const x=await seeded();assert.equal((await send(x.id,'persistResult',sourceResult(x.i,true,U))).status,'BLOCKED_INTEGRITY');});
    await t.test('missing payload unresolved never NO_A_PLUS',async()=>{const id=await fresh(),cid=await cycle(id),i=intent(cid);await ok(id,'registerOperation',i);const r=await store.readRecoveryState(id);assert.deepEqual(r.unresolvedOperations,[i.operationId]);assert.equal((await store.readCycle(id,cid)).manifest.results[0].status,'PENDING');});
    await t.test('metadata cannot mislabel durable payload',async()=>{const id=await fresh(),cid=await cycle(id),i=intent(cid);await ok(id,'registerOperation',i);const r=sourceResult(i,false);r.payload.status='ANALYZED_A_PLUS_CAPTURE_PENDING';r.payloadHash=producerHash(r.payload);assert.equal((await send(id,'persistResult',r)).status,'BLOCKED_INTEGRITY');});
    await t.test('first generation persisted',async()=>{const x=await generated();assert.equal((await read(x.id)).state.generations[0].generationSequence,1);});
    await t.test('same setup generation reused',async()=>{const x=await generated();await ok(x.id,'getOrCreateGeneration',x.g);assert.equal((await read(x.id)).state.generations.length,1);});
    await t.test('later changed observation reuses frozen generation',async()=>{const x=await generated(),cid=await cycle(x.id,'later',['AAA'],V),i=intent(cid,'AAA',V),r=sourceResult(i,true,V);r.payload.frozenCandidate.initialPlan.stopLoss=94;r.payloadHash=producerHash(r.payload);await ok(x.id,'registerOperation',i);await ok(x.id,'persistResult',r);const reused=await ok(x.id,'getOrCreateGeneration',generation(r));assert.equal(reused.reply.shadowCandidateId,x.g.shadowCandidateId);const s=(await read(x.id)).state;assert.equal(s.generations.length,1);assert.equal(s.generations[0].original.frozenCandidate.initialPlan.stopLoss,95);assert.equal(s.generationLinks.length,1);});
    await t.test('original frozen fact rewrite rejected',async()=>{const x=await generated(),g=clone(x.g);g.frozenCandidate.initialPlan.stopLoss=94;g.frozenFactsHash=producerHash(g.frozenCandidate);assert.equal((await send(x.id,'getOrCreateGeneration',g)).status,'BLOCKED_INTEGRITY');});
    await t.test('SKIPPED_CAPACITY does not release generation',async()=>{const x=await generated(),p=closure(x.g);p.proof.status='SKIPPED_CAPACITY';assert.equal((await send(x.id,'recordGenerationClosure',p)).status,'BLOCKED_INTEGRITY');assert.equal((await read(x.id)).state.generations[0].logicalLifecycleState,'OPEN');});
    await t.test('unresolved generation blocks next generation',async()=>{const x=await generated();await ok(x.id,'markGenerationUnresolved',{shadowCandidateId:x.g.shadowCandidateId,reason:'gap',evidenceRef:'missing'});const cid=await cycle(x.id,'later',['AAA'],V),i=intent(cid,'AAA',V),r=sourceResult(i,true,V);await ok(x.id,'registerOperation',i);await ok(x.id,'persistResult',r);const got=await ok(x.id,'getOrCreateGeneration',generation(r));assert.equal(got.reply.shadowCandidateId,x.g.shadowCandidateId);assert.equal((await read(x.id)).state.generations.length,1);});
    await t.test('verified terminal permits subsequent generation',async()=>{const x=await generated();await ok(x.id,'recordGenerationClosure',closure(x.g));const cid=await cycle(x.id,'later',['AAA'],V),i=intent(cid,'AAA',V),r=sourceResult(i,true,V);await ok(x.id,'registerOperation',i);await ok(x.id,'persistResult',r);assert.equal((await ok(x.id,'getOrCreateGeneration',generation(r))).reply.generationSequence,2);});
    await t.test('wall clock alone not closure',async()=>{const x=await generated();assert.equal((await send(x.id,'recordGenerationClosure',{shadowCandidateId:x.g.shadowCandidateId,proof:{closedAt:V}})).status,'BLOCKED_INTEGRITY');});
    await t.test('closure proof cannot refer to different identity',async()=>{const x=await generated(),p=closure(x.g);p.proof.evidence.shadowCandidateId='other';p.proof.evidenceHash=producerHash(p.proof.evidence);assert.equal((await send(x.id,'recordGenerationClosure',p)).status,'BLOCKED_INTEGRITY');});
    await t.test('restart preserves generation',async()=>{const x=await generated();assert.equal((await createProducerStore(redis).readRecoveryState(x.id)).currentGenerations[0].shadowCandidateId,x.g.shadowCandidateId);});
    await t.test('pending exact capture transaction persisted',async()=>{const x=await prepared(),s=(await read(x.id)).state;assert.deepEqual(s.captures[0].intent.transaction,x.c.transaction);assert.equal(s.captures[0].state,'PENDING');});
    await t.test('capture intent retry reuses transaction',async()=>{const x=await prepared();await ok(x.id,'prepareCapture',x.c);assert.equal((await read(x.id)).state.captures.length,1);});
    await t.test('changed transaction under same id rejected',async()=>{const x=await prepared(),c=clone(x.c);c.transaction.expectedLedgerRevision=2;c.expectedShadowRevision=2;c.transactionHash=producerHash(c.transaction);assert.equal((await send(x.id,'prepareCapture',c)).status,'BLOCKED_INTEGRITY');});
    await t.test('matching receipt then finalization closes capture gap',async()=>{const x=await prepared();await ok(x.id,'receiveCaptureReceipt',receipt(x.c));let r=await store.readRecoveryState(x.id);assert.equal(r.receiptsAwaitingFinalization.length,1);await ok(x.id,'acknowledgeCapture',{captureOperationId:x.c.captureOperationId});r=await store.readRecoveryState(x.id);assert.equal(r.pendingCaptures.length,0);assert.equal((await store.readCycle(x.id,x.cid)).proof.canSeal,true);});
    await t.test('conflicting ack rejected',async()=>{const x=await prepared(),r=receipt(x.c);r.receipt.payloadHash='b'.repeat(64);assert.equal((await send(x.id,'receiveCaptureReceipt',r)).status,'BLOCKED_INTEGRITY');});
    await t.test('receipt exact retry after restart',async()=>{const x=await prepared();await ok(x.id,'receiveCaptureReceipt',receipt(x.c));await ok(x.id,'receiveCaptureReceipt',receipt(x.c));assert.equal((await createProducerStore(redis).readRecoveryState(x.id)).receiptsAwaitingFinalization.length,1);});
    await t.test('ack without receipt rejected',async()=>{const x=await prepared();assert.equal((await send(x.id,'acknowledgeCapture',{captureOperationId:x.c.captureOperationId})).status,'BLOCKED_INTEGRITY');});
    await t.test('uncertain capture retains exact payload',async()=>{const x=await prepared();await ok(x.id,'markCaptureUnresolved',{captureOperationId:x.c.captureOperationId,reason:'response lost'});assert.deepEqual((await read(x.id)).state.captures[0].intent.transaction,x.c.transaction);});
    await t.test('reconciliation exact proof and duplicate',async()=>{const x=await generated(),p=reconciliation(x.r);assert.equal((await ok(x.id,'recordReconciliation',p)).reply.status,'MATCHED');await ok(x.id,'recordReconciliation',p);assert.equal((await read(x.id)).state.reconciliations.length,1);});
    await t.test('reconciliation mismatch unresolved no identity mutation',async()=>{const x=await generated(),p=reconciliation(x.r);p.equivalenceProof.coreFacts.initialPlan.createdAt=U;p.proofHash=producerHash(p.equivalenceProof);assert.equal((await ok(x.id,'recordReconciliation',p)).reply.status,'UNRESOLVED');const s=(await read(x.id)).state;assert.equal(s.generations.length,1);assert.deepEqual(s.generations[0].original,x.g);});
    await t.test('conflicting proof ID rejected',async()=>{const x=await generated(),p=reconciliation(x.r);await ok(x.id,'recordReconciliation',p);p.linkedCoreTradeId='other';assert.equal((await send(x.id,'recordReconciliation',p)).status,'BLOCKED_INTEGRITY');});
    await t.test('failing seal proof persisted as blocker not seal',async()=>{const id=await fresh(),cid=await cycle(id),proof=(await store.readCycle(id,cid)).proof;const r=await ok(id,'recordSealEvidence',{cycleId:cid,observedAt:T,proof});assert.equal(r.reply.sealed,false);assert.ok((await store.readRecoveryState(id)).healthHistory[0].blockers.length);});
    await t.test('forged successful seal rejected',async()=>{const id=await fresh(),cid=await cycle(id);assert.equal((await send(id,'recordSealEvidence',{cycleId:cid,observedAt:T,proof:{canSeal:true,blockers:[]}})).status,'BLOCKED_INTEGRITY');});
    await t.test('valid computed seal persisted',async()=>{const x=await seeded({},false),proof=(await store.readCycle(x.id,x.cid)).proof;assert.equal(proof.canSeal,true);await ok(x.id,'recordSealEvidence',{cycleId:x.cid,observedAt:T,proof});assert.equal((await store.readCycle(x.id,x.cid)).cycle.sealed,true);});
    await t.test('forceSeal/reset unavailable',async()=>{const id=await fresh();assert.equal(store.reset,undefined);assert.equal(store.forceSeal,undefined);assert.equal((await store.transact(id,{requestId:'force',expectedRevision:0,type:'forceSeal',data:{}})).status,'BLOCKED_INTEGRITY');});
    await t.test('health history preserved after source recovery',async()=>{const id=await fresh(),cid=await cycle(id);await ok(id,'recordSealEvidence',{cycleId:cid,observedAt:T,proof:(await store.readCycle(id,cid)).proof});const i=intent(cid);await ok(id,'registerOperation',i);await ok(id,'persistResult',sourceResult(i,false));await ok(id,'recordSealEvidence',{cycleId:cid,observedAt:U,proof:(await store.readCycle(id,cid)).proof});const h=(await store.readRecoveryState(id)).healthHistory;assert.equal(h.length,2);assert.equal(h[0].health,'BLOCKED_SOURCE');assert.equal(h[1].health,'HEALTHY');});
    await t.test('recovery lists uncaptured source result',async()=>{const x=await seeded();assert.deepEqual((await store.readRecoveryState(x.id)).resultsAwaitingCapture,[x.i.operationId]);});
    await t.test('stale writer rejected',async()=>{const id=await fresh();await ok(id,'allocateCycle',allocation());assert.equal((await store.allocateCycle(id,{requestId:'stale',expectedRevision:0,data:allocation('other')})).status,'STALE');});
    await t.test('conflicting idempotency key rejected',async()=>{const id=await fresh(),q={requestId:'same',expectedRevision:0,data:allocation()};await store.allocateCycle(id,q);q.data.allocationId='different';assert.equal((await store.allocateCycle(id,q)).status,'BLOCKED_INTEGRITY');});
    await t.test('lost allocation response retry increments once',async()=>{const id=await fresh();let lost=true;const flaky=createProducerStore(async c=>{const value=await redis(c);if(c[0]==='EVAL'&&lost){lost=false;throw new Error('lost');}return value;});const q={requestId:'lost',expectedRevision:0,data:allocation()};assert.equal((await flaky.allocateCycle(id,q)).status,'UNRESOLVED');assert.equal((await flaky.allocateCycle(id,q)).status,'IDEMPOTENT');assert.equal((await read(id)).state.producerSequence,1);});
    await t.test('lost result response recoverable without re-analysis',async()=>{const id=await fresh(),cid=await cycle(id),i=intent(cid);await ok(id,'registerOperation',i);let lost=true;const flaky=createProducerStore(async c=>{const value=await redis(c);if(c[0]==='EVAL'&&lost){lost=false;throw new Error('lost');}return value;});const q={requestId:'lost-result',expectedRevision:(await read(id)).revision,data:sourceResult(i)};assert.equal((await flaky.persistResult(id,q)).status,'UNRESOLVED');assert.equal((await flaky.persistResult(id,q)).status,'IDEMPOTENT');assert.deepEqual((await read(id)).state.operations[0].result,q.data);});
    await t.test('max ledger bytes blocks initialization',async()=>assert.equal((await store.createRun(meta('tiny',{maxBytes:1}))).status,'BLOCKED_STORAGE'));
    await t.test('max cycles overflow preserves bytes',async()=>{const id=await fresh({maxCycles:1});await ok(id,'allocateCycle',allocation());const before=await raw(id);assert.equal((await send(id,'allocateCycle',allocation('second'))).status,'BLOCKED_STORAGE');assert.equal(await raw(id),before);});
    await t.test('max operations overflow',async()=>{const id=await fresh({maxOperations:1}),cid=await cycle(id,'a',['AAA','BBB']);await ok(id,'registerOperation',intent(cid));const before=await raw(id);assert.equal((await send(id,'registerOperation',intent(cid,'BBB'))).status,'BLOCKED_STORAGE');assert.equal(await raw(id),before);});
    await t.test('max generations overflow',async()=>{const x=await generated({maxGenerations:1});await ok(x.id,'recordGenerationClosure',closure(x.g));const cid=await cycle(x.id,'later',['AAA'],V),i=intent(cid,'AAA',V),r=sourceResult(i,true,V);await ok(x.id,'registerOperation',i);await ok(x.id,'persistResult',r);assert.equal((await send(x.id,'getOrCreateGeneration',generation(r))).status,'BLOCKED_STORAGE');});
    await t.test('per-payload UTF8 size overflow no trimming',async()=>{const id=await fresh({maxPayloadBytes:1800}),cid=await cycle(id),i=intent(cid);await ok(id,'registerOperation',i);const before=await raw(id),r=sourceResult(i,false,T,{large:'я'.repeat(2000)});assert.equal((await send(id,'persistResult',r)).status,'BLOCKED_STORAGE');assert.equal(await raw(id),before);});
    await t.test('retained payload budget overflow',async()=>{const id=await fresh({maxRetainedPayloadBytes:200});await ok(id,'allocateCycle',allocation());assert.equal((await send(id,'freezeManifest',frozen(`${id}:1`))).status,'BLOCKED_STORAGE');});
    await t.test('max events overflow',async()=>{const id=await fresh({maxEvents:1});await ok(id,'allocateCycle',allocation());assert.equal((await send(id,'freezeManifest',frozen(`${id}:1`))).status,'BLOCKED_STORAGE');});
    await t.test('max idempotency receipts overflow',async()=>{const id=await fresh({maxIdempotencyReceipts:1});await ok(id,'allocateCycle',allocation());assert.equal((await send(id,'allocateCycle',allocation('second'))).status,'BLOCKED_STORAGE');});
    await t.test('overflow cannot advance seal',async()=>{const x=await seeded({maxEvents:4},false);const before=await raw(x.id);assert.equal((await send(x.id,'recordSealEvidence',{cycleId:x.cid,observedAt:T,proof:(await store.readCycle(x.id,x.cid)).proof})).status,'BLOCKED_STORAGE');assert.equal(await raw(x.id),before);assert.equal((await store.readCycle(x.id,x.cid)).cycle.sealed,false);});
    await t.test('ledger byte overflow after successful initialization',async()=>{const id=await fresh({maxBytes:1800});await ok(id,'allocateCycle',allocation());const before=await raw(id);const r=await send(id,'freezeManifest',frozen(`${id}:1`,Array.from({length:30},(_,i)=>`SYMBOL${i}`)));assert.equal(r.status,'BLOCKED_STORAGE');assert.equal(await raw(id),before);});
    await t.test('lost receipt response recovered then finalized once',async()=>{const x=await prepared();let lost=true;const flaky=createProducerStore(async c=>{const value=await redis(c);if(c[0]==='EVAL'&&lost){lost=false;throw new Error('lost');}return value;});const q={requestId:'lost-ack',expectedRevision:(await read(x.id)).revision,data:receipt(x.c)};assert.equal((await flaky.receiveCaptureReceipt(x.id,q)).status,'UNRESOLVED');assert.equal((await flaky.receiveCaptureReceipt(x.id,q)).status,'IDEMPOTENT');await ok(x.id,'acknowledgeCapture',{captureOperationId:x.c.captureOperationId});assert.equal((await store.readRecoveryState(x.id)).pendingCaptures.length,0);});
    await t.test('old reused observation cannot create a generation after closure',async()=>{const x=await generated(),cid=await cycle(x.id,'later',['AAA'],U),i=intent(cid,'AAA',U),r=sourceResult(i,true,U);await ok(x.id,'registerOperation',i);await ok(x.id,'persistResult',r);const g=generation(r);await ok(x.id,'getOrCreateGeneration',g);await ok(x.id,'recordGenerationClosure',closure(x.g));const retry=await ok(x.id,'getOrCreateGeneration',g);assert.equal(retry.reply.shadowCandidateId,x.g.shadowCandidateId);assert.equal((await read(x.id)).state.generations.length,1);});
    await t.test('malformed ledger rejected',async()=>{const id=await fresh();await redis(['SET',producerKey(id),'{']);assert.equal((await store.read(id)).status,'BLOCKED_INTEGRITY');});
    await t.test('partial ledger with recomputed hash rejected',async()=>{const id=await fresh();await ok(id,'allocateCycle',allocation());const l=JSON.parse(await raw(id));l.entries=[];delete l.integrityHash;l.integrityHash=producerHash(l);await redis(['SET',producerKey(id),JSON.stringify(l)]);assert.equal((await store.read(id)).status,'BLOCKED_INTEGRITY');});
    await t.test('CAS racing allocation only one wins',async()=>{const id=await fresh();let count=0,release;const barrier=new Promise(r=>release=r);const racing=createProducerStore(async c=>{const value=await redis(c);if(c[0]==='GET'&&c[1]===producerKey(id)){count++;if(count===2)release();await barrier;}return value;});const results=await Promise.all(['a','b'].map(n=>racing.allocateCycle(id,{requestId:n,expectedRevision:0,data:allocation(n)})));assert.deepEqual(results.map(r=>r.status).sort(),['OK','STALE']);assert.equal((await read(id)).state.producerSequence,1);});
    await t.test('transport failure does not create outcome',async()=>{const s=createProducerStore(async()=>{throw new Error('offline');});assert.equal((await s.read('offline')).status,'UNRESOLVED');});
    await t.test('inputs are not mutated',async()=>{const id=await fresh(),d=allocation(),before=clone(d);await ok(id,'allocateCycle',d);assert.deepEqual(d,before);});
    await t.test('only isolated producer keys accessed',async()=>{for(const c of commands){if(c[0]==='GET'||c[0]==='SET')assert.match(c[1],/^sergey-ai:forward-shadow:v1:[A-Za-z0-9_-]+:producer-ledger$/);if(c[0]==='EVAL')assert.match(c[3],/^sergey-ai:forward-shadow:v1:[A-Za-z0-9_-]+:producer-ledger$/);}assert.ok((await redis(['KEYS','*'])).every(k=>k.endsWith(':producer-ledger')));});
    await t.test('no clock/random/transport/Core/strategy implementation',async()=>{const s=await readFile(new URL('../lib/forward-validation/producer-store.js',import.meta.url),'utf8');assert.doesNotMatch(s,/Date\.now|randomUUID|Math\.random|fetch\(|node:fs|process\.|api\/market|OPEN_TRADES|registerOpenTrade|createShadowStore|calculate.*Score/);});
  } finally {
    if(server.exitCode===null){const exited=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;}
    await rm(dir,{recursive:true,force:true});
  }
});
