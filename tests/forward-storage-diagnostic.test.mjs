import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import handler,{diagnose,KEYS} from '../api/forward-storage-diagnostic.js';
import {createProducerStore,producerHash} from '../lib/forward-validation/producer-store.js';
import {createShadowStore,hashValue} from '../lib/forward-validation/store.js';
const RUN='manual-forward-worker-v1',secret='PRIVATE_TEST_SECRET_'.repeat(3);
const budget={maxBytes:8388608,maxCycles:10000,maxOperations:50000,maxEvents:10000,maxGenerations:10000,maxRetainedPayloadBytes:6291456,maxPayloadBytes:32768,maxIdempotencyReceipts:50000};
const worker=(n=1)=>JSON.stringify({schemaVersion:'forward-worker-state-v1',mappingVersion:'forward-worker-mapping-v1',fence:1,owner:'PRIVATE_OWNER',expiresAt:0,
 intents:Object.fromEntries(Array.from({length:n},(_,i)=>['PRIVATE_ID_'+i,JSON.stringify({id:'PRIVATE_ID_'+i,frozen:'{}',actions:{},done:{},status:'RUNNING'})]))});
async function fixtures(){
 const memory=new Map();const execute=async c=>{if(c[0]==='GET')return memory.get(c[1])??null;assert.equal(c[0],'EVAL');memory.set(c[3],c[6]);return 1;};
 const p=createProducerStore(execute);
 assert.equal((await p.createRun({runId:RUN,mode:'SHADOW',schemaVersion:1,coreCommit:'a'.repeat(40),officialActivationId:null,officialActivationAt:null,budget})).status,'OK');
 assert.equal((await p.allocateCycle(RUN,{requestId:'PRIVATE_REQUEST',expectedRevision:0,data:{allocationId:'PRIVATE_ALLOCATION',cycleStartedAt:'2026-10-25T00:00:00.000Z',sourceTimeLowerBound:'2026-10-25T00:00:00.000Z'}})).status,'OK');
 const s=createShadowStore(execute);
 assert.equal((await s.createRun({runId:RUN,mode:'SHADOW',schemaVersion:1,protocolVersion:'1.1',admissionVersion:'1.1',coreCommit:'a'.repeat(40),officialActivationId:null,officialActivationAt:null,
 ledgerRevision:0,captureWatermark:null,decisionWatermark:null,health:'HEALTHY',failureReason:null,storageBudget:{maxBytes:8388608,maxRecords:10000,maxEvents:50000,maxOperations:50000}})).status,'CREATED');
 return [worker(),memory.get(KEYS[1]),memory.get(KEYS[2])];
}
function producerBudget(raw,changes){const l=JSON.parse(raw);Object.assign(l.meta.budget,changes);const {integrityHash,...body}=l;return JSON.stringify({...body,integrityHash:producerHash(body)});}
async function invoke({method='GET',auth=`Bearer ${secret}`,raws,failAt=-1,unconfigured=false}={}){
 const saved={...process.env},original=global.fetch,calls=[];
 Object.assign(process.env,{SM1M_API_SECRET:secret,UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'PRIVATE_TOKEN'});
 if(unconfigured)delete process.env.SM1M_API_SECRET;
 const values=raws??await fixtures();
 global.fetch=async(url,options)=>{const index=calls.length;calls.push({url,options});if(index===failAt)throw Error('PRIVATE_TRANSPORT_ERROR');return {ok:true,json:async()=>({result:values[index]})};};
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
 try{await handler({method,headers:{authorization:auth},query:{key:'EVIL',store:'EVIL',command:'EVAL'},body:{command:'SET'}},res);return {res,calls};}
 finally{global.fetch=original;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);}
}
test('auth required and missing configuration fail closed before reads',async()=>{
 for(const options of [{auth:''},{auth:'Bearer wrong'},{unconfigured:true}]){const {res,calls}=await invoke(options);assert.ok([401,503].includes(res.code));assert.equal(calls.length,0);}
});
test('GET only',async()=>{for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']){const {res,calls}=await invoke({method});assert.equal(res.code,405);assert.equal(calls.length,0);}});
test('exactly three fixed GETs, zero writes/EVAL, caller selection ignored',async()=>{
 const {res,calls}=await invoke();assert.equal(res.code,200);assert.deepEqual(calls.map(c=>JSON.parse(c.options.body)),KEYS.map(k=>['GET',k]));
 assert.ok(calls.every(c=>c.options.redirect==='error'));assert.equal(res.headers['Cache-Control'],'private, no-store');
 assert.equal(res.body.atomicSnapshot,false);assert.deepEqual(res.body.reads.map(r=>r.order),[1,2,3]);
 for(const r of res.body.reads){assert.ok(Number.isFinite(Date.parse(r.startedAt)));assert.ok(r.completedAt>=r.startedAt);}
});
test('valid aggregate counts and exact raw byte lengths; no false blocker',async()=>{
 const raws=await fixtures();raws[0]+='\n';const d=await diagnose(raws);
 assert.equal(d.workerState.serializedBytes,Buffer.byteLength(raws[0]));assert.equal(d.workerState.intents,1);assert.equal(d.workerState.runningIntents,1);
 assert.deepEqual(d.workerState.statusCounts,{RUNNING:1,COMPLETE:0,BLOCKED_MAPPING:0});
 const p=JSON.parse(raws[1]);assert.equal(d.producerLedger.entries,1);assert.equal(d.producerLedger.revision,1);assert.equal(d.producerLedger.cycles,1);
 assert.equal(d.producerLedger.operations,0);assert.equal(d.producerLedger.generations,0);
 assert.ok(d.producerLedger.retainedPayloadBytes>0);assert.equal(d.producerLedger.maxRequestPayloadBytes,d.producerLedger.retainedPayloadBytes);
 assert.deepEqual(d.producerLedger.limits,p.meta.budget);assert.equal(d.shadowLedger.records,0);assert.equal(d.shadowLedger.ledgerRevision,0);
 assert.equal(d.blockingStore,'UNDETERMINED');assert.equal(d.nextStateAssessment,'NOT_REPRODUCED');
 for(const k of ['workerState','producerLedger','shadowLedger'])assert.ok(Object.values(d[k].budgetChecks).every(x=>x==='PASS'));
});
test('worker running limit: at boundary PASS, over boundary FAIL',async()=>{
 const raws=await fixtures();raws[0]=worker(100);assert.equal((await diagnose(raws)).workerState.budgetChecks.runningIntents,'PASS');
 raws[0]=worker(101);const d=await diagnose(raws);assert.equal(d.workerState.budgetChecks.runningIntents,'FAIL');assert.equal(d.blockingStore,'WORKER_STATE');
});
test('worker saved payload limit independently detected without raw action exposure',async()=>{
 const raws=await fixtures(),s=JSON.parse(raws[0]),i=JSON.parse(Object.values(s.intents)[0]);i.actions={private:'X'.repeat(33000)};s.intents[i.id]=JSON.stringify(i);raws[0]=JSON.stringify(s);
 const d=await diagnose(raws);assert.equal(d.workerState.payloadsOverLimit,1);assert.equal(d.workerState.budgetChecks.intentPayloadBytes,'FAIL');assert.equal(d.blockingStore,'WORKER_STATE');assert.ok(!JSON.stringify(d).includes('XXXXX'));
});
test('worker intents count and exact raw total byte budgets',async()=>{
 const raws=await fixtures();const s=JSON.parse(worker(10001));for(const key of Object.keys(s.intents)){const i=JSON.parse(s.intents[key]);i.status='COMPLETE';s.intents[key]=JSON.stringify(i);}raws[0]=JSON.stringify(s);
 assert.equal((await diagnose(raws)).workerState.budgetChecks.intents,'FAIL');raws[0]=worker()+' '.repeat(4194304);
 assert.equal((await diagnose(raws)).workerState.budgetChecks.serializedBytes,'FAIL');
});
for(const [limit,field] of [['maxBytes','serializedBytes'],['maxRetainedPayloadBytes','retainedPayloadBytes'],['maxPayloadBytes','requestPayloadBytes']])test(`producer uses stored ${limit}, not constants`,async()=>{
 const raws=await fixtures();raws[1]=producerBudget(raws[1],{[limit]:1});const d=await diagnose(raws);
 assert.equal(d.producerLedger.limits[limit],1);assert.equal(d.producerLedger.budgetChecks[field],'FAIL');assert.equal(d.blockingStore,'PRODUCER_LEDGER');
 assert.equal(d.producerLedger.validation,'STORED_BUDGET_CONFLICT');assert.equal(d.producerLedger.cycles,null);assert.equal(d.producerLedger.budgetChecks.cycles,'UNKNOWN');
});
test('shadow uses stored byte budget and reports only proved current violation',async()=>{
 const raws=await fixtures(),s=JSON.parse(raws[2]);s.meta.storageBudget.maxBytes=1;const {integrityHash,...body}=s;raws[2]=JSON.stringify({...body,integrityHash:hashValue(body)});const d=await diagnose(raws);
 assert.equal(d.shadowLedger.limits.maxBytes,1);assert.equal(d.shadowLedger.budgetChecks.serializedBytes,'FAIL');assert.equal(d.blockingStore,'SHADOW_LEDGER');
});
test('multiple current violations distinguished from next-state or historical cause',async()=>{
 const raws=await fixtures();raws[0]=worker(101);raws[1]=producerBudget(raws[1],{maxBytes:1});const d=await diagnose(raws);
 assert.equal(d.blockingStore,'MULTIPLE');assert.equal(d.blockingStoreScope,'CURRENT_STATE_ONLY');assert.equal(d.nextStateAssessment,'NOT_REPRODUCED');
});
test('malformed or unknown schemas never claim PASS or leak schema/error',async()=>{
 for(const value of ['{','{}','[]',JSON.stringify({schemaVersion:'PRIVATE_SCHEMA'})]){
 const d=await diagnose([value,value,value]);assert.equal(d.blockingStore,'UNDETERMINED');
 for(const k of ['workerState','producerLedger','shadowLedger']){assert.equal(d[k].status,'INVALID');assert.ok(Object.values(d[k].budgetChecks).every(v=>v==='UNKNOWN'));}
 assert.ok(!JSON.stringify(d).includes('PRIVATE_SCHEMA'));
 }
});
test('integrity corruption is not mislabeled as budget overflow',async()=>{
 const raws=await fixtures(),p=JSON.parse(raws[1]);p.integrityHash='bad';p.meta.budget.maxBytes=1;raws[1]=JSON.stringify(p);
 const d=await diagnose(raws);assert.equal(d.producerLedger.status,'INVALID');assert.equal(d.producerLedger.budgetChecks.serializedBytes,'UNKNOWN');assert.equal(d.blockingStore,'UNDETERMINED');
});
test('absent stores are NOT_FOUND with UNKNOWN checks',async()=>{const d=await diagnose([null,null,null]);for(const k of ['workerState','producerLedger','shadowLedger'])assert.equal(d[k].status,'NOT_FOUND');assert.equal(d.blockingStore,'UNDETERMINED');});
test('read transport error isolated, at most three reads, no retry or raw error',async()=>{
 const {res,calls}=await invoke({failAt:1});assert.equal(calls.length,3);assert.equal(res.body.producerLedger.status,'UNVERIFIED');assert.equal(res.body.workerState.status,'VALID');assert.ok(!JSON.stringify(res).includes('PRIVATE_TRANSPORT_ERROR'));
});
test('raw ledger, identities, credentials, trade data absent from response',async()=>{
 const {res}=await invoke();const output=JSON.stringify(res);
 for(const value of [secret,'PRIVATE_TOKEN','redis.invalid','PRIVATE_ID','PRIVATE_OWNER','PRIVATE_REQUEST','PRIVATE_ALLOCATION','requestId','initialPlan','tradeId','symbol','direction'])assert.ok(!output.includes(value),value);
});
test('endpoint never imports/invokes worker/scanner/tick or executes mutation commands',async()=>{
 const source=await readFile(new URL('../api/forward-storage-diagnostic.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/runWorker|runLifecycle|forward-tick|market\.js|\.transact\(|\.commit\(|\.save\(|\.acquire\(/);
 assert.doesNotMatch(source,/\['(?:EVAL|SET|DEL|EXPIRE)'/);
});

test('shadow shared INCONSISTENT_LEDGER code does not misclassify corrupt state',async()=>{
 const raws=await fixtures(),s=JSON.parse(raws[2]);s.meta.storageBudget.maxBytes=1;raws[2]=JSON.stringify(s);
 let d=await diagnose(raws);assert.equal(d.shadowLedger.status,'INVALID');assert.equal(d.blockingStore,'UNDETERMINED');
 s.operations=[{operationId:'PRIVATE',requestHash:'a'.repeat(64),ledgerRevision:1}];
 const {integrityHash,...body}=s;raws[2]=JSON.stringify({...body,integrityHash:hashValue(body)});
 d=await diagnose(raws);assert.equal(d.shadowLedger.status,'INVALID');assert.equal(d.shadowLedger.budgetChecks.serializedBytes,'UNKNOWN');
});
test('shadow stored operations limit checked after full integrity validation',async()=>{
 const raws=await fixtures(),s=JSON.parse(raws[2]);s.meta.storageBudget.maxOperations=1;s.meta.ledgerRevision=2;
 s.operations=[1,2].map(n=>({operationId:'PRIVATE_'+n,requestHash:'a'.repeat(64),ledgerRevision:n}));
 const {integrityHash,...body}=s;raws[2]=JSON.stringify({...body,integrityHash:hashValue(body)});
 const d=await diagnose(raws);assert.equal(d.shadowLedger.operations,2);assert.equal(d.shadowLedger.budgetChecks.operations,'FAIL');assert.equal(d.blockingStore,'SHADOW_LEDGER');
});

import {canonicalJSON,universeDigest} from '../lib/forward-validation/source-contract.js';
import {buildObservationCycle,digest} from '../lib/forward-validation/observation-store.js';
import {MAPPING,DELAYED} from '../lib/forward-validation/delayed-ingestion.js';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const T='2026-10-25T00:00:00.000Z',W='2026-10-25T01:00:00.000Z';
function example(){
 const symbol='PRIVATE_SYMBOL',plan={createdAt:T,plannedAt:T,expiresAt:W,entryZone:{from:99,to:101},
  stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,exitStrategy:{version:'tp1-50-reanalyse-v1'}};
 const f={symbol,direction:'Long',instrumentType:'SWAP',setupKey:symbol+':Long',tradeId:symbol+':Long:'+T,
  origin:{detectedAt:T},initialPlan:plan,originalEligibility:{confirmedAPlus:true}};
 const envelope=buildObservationCycle({ok:true,mode:'global-ranking',status:'ready',version:'1.0',generatedAt:T,resultsFailed:0,globalRanking:[{
  symbol,direction:'Long',origin:f.origin,initialPlan:plan,analysisContext:{analysisAt:T},entryZone:plan.entryZone,stopLoss:90,
  takeProfit1:110,takeProfit2:120,takeProfit3:130,opportunityScore:90,confidence:90,action:'Strong Buy',tradeAllowed:true,
  tradeReadiness:{ready:true},riskReward:2,researchProjectionJSON:JSON.stringify({frozenCandidate:f})}]},()=>true);
 const id=envelope.sourceCycleId,raw=canonicalJSON(envelope),o=envelope.observations[0],pid=digest([MAPPING,id]),op=digest([MAPPING,id,o.observationId]),cid=RUN+':1';
 const frozen=canonicalJSON({mappingVersion:MAPPING,sourceEnvelopeHash:digest(envelope),sourceCycleId:id,processingIdentity:pid,
  orderKey:T+'|'+id,workerProcessingStartedAt:W,workerRecordedAt:W});
 const request=(key,data)=>({requestId:digest([pid,key]),expectedRevision:0,data});
 const all={
  'producer-init':{runId:RUN,mode:'SHADOW'},'shadow-init':{runId:RUN,mode:'SHADOW'},
  allocate:request('allocate',{allocationId:pid,cycleStartedAt:W,sourceTimeLowerBound:W}),
  manifest:request('manifest',{cycleId:cid,universeId:id,universeHash:universeDigest([symbol]),expectedSymbols:[symbol],batchCount:1,
   batches:[{batchId:cid+':0',batchIndex:0,expectedBatchSymbols:[symbol]}]}),
  [op+':ingest']:request(op+':ingest',{cycleId:cid,operationId:op,ingestion:{schemaVersion:DELAYED,mappingVersion:MAPPING,processingIdentity:op,
   sourceEnvelope:raw,sourceCycleId:id,sourceEnvelopeHash:digest(envelope),observationId:o.observationId,observationPayloadHash:o.payloadHash,
   sourceObservedAt:T,sourceAnalysisAt:T,workerProcessingStartedAt:W,workerRecordedAt:W,frozenCandidate:f}}),
  [op+':generation']:request(op+':generation',{frozenCandidate:f}),
  [op+':prepare']:request(op+':prepare',{transaction:{records:[]}}),
  [op+':capture']:{runId:RUN,captureOperationId:op+':capture'}
 };
 const sequence=Object.keys(all);
 const item=(a=0,d=0,status='RUNNING')=>({id,frozen,status,
  actions:Object.fromEntries(sequence.slice(0,a).map(k=>[k,canonicalJSON(all[k])])),
  done:Object.fromEntries(sequence.slice(0,d).map(k=>[k,canonicalJSON({status:'OK',reply:k==='allocate'?{cycleId:cid}:{}})]))});
 return {id,frozen,item,sequence,all};
}
function state(items,pretty=false){
 return JSON.stringify({schemaVersion:'forward-worker-state-v1',mappingVersion:MAPPING,fence:1,owner:'PRIVATE_OWNER',expiresAt:0,
  intents:Object.fromEntries(items.map(i=>[i.id,canonicalJSON(i)]))},null,pretty?2:undefined);
}
async function inspect(items,pretty=false){const raws=await fixtures();raws[0]=state(items,pretty);return diagnose(raws);}
const receipt=i=>({receiptVersion:'forward-worker-complete-v1',id:i.id,frozen:i.frozen,status:'COMPLETE',fullIntentSha256:hash(canonicalJSON(i))});
const size=x=>Buffer.byteLength(x);
test('capacity counts include compact receipts and reservation schema is not inferred',async()=>{
 const a=example(),complete=a.item(8,8,'COMPLETE'),compact=receipt(complete);
 // Distinct identity bindings require distinct source timestamps: retain the
 // single valid compact item and separate legacy-shaped counters for this test.
 const run={...a.item(),id:'other'},blocked={...a.item(),id:'blocked',status:'BLOCKED_MAPPING',reasons:['MISSING_PLAN']};
 const d=await inspect([compact,run,blocked]);const c=d.workerState.capacity;
 assert.equal(c.assessmentStatus,'VALID');assert.equal(c.totalIntents,3);assert.equal(c.compactCompleteCount,1);
 assert.equal(c.runningCount,1);assert.equal(c.blockedMappingCount,1);assert.equal(c.reservationSchemaStatus,'NOT_APPLICABLE');assert.equal(c.reservationsCount,0);
 assert.equal(d.workerState.status,'VALID');
});
test('valid COMPLETE projection uses full canonical hash and nested string contributions without mutating input',async()=>{
 const e=example(),i=e.item(8,8,'COMPLETE');
 // Unicode/quotes in a valid non-ingest request are retained in the audit hash.
 const k=e.sequence[6],p=JSON.parse(i.actions[k]);p.data.transaction.note='PRIVATE_雪\\\"';i.actions[k]=canonicalJSON(p);
 const raw=state([i],true)+'\n',raws=await fixtures();raws[0]=raw;const before=[...raws];
 const d=await diagnose(raws),l=d.workerState.legacyCompaction,s=JSON.parse(raw),projected=structuredClone(s),r=canonicalJSON(receipt(i));
 projected.intents[i.id]=r;
 assert.equal(l.assessmentStatus,'PROJECTED');assert.equal(l.legacyCompleteCount,1);
 assert.equal(l.normalizedStateBytesBeforeCompaction,size(canonicalJSON(s)));
 assert.equal(l.stateBytesAfterFullLegacyCompactionEstimate,size(canonicalJSON(projected)));
 assert.equal(l.legacyCompleteReclaimableBytes,size(canonicalJSON(s))-size(canonicalJSON(projected)));
 assert.equal(l.legacyCompleteSerializedContributionBytes,size(JSON.stringify(i.id)+':'+JSON.stringify(s.intents[i.id])));
 assert.equal(l.legacyCompleteProjectedCompactContributionBytes,size(JSON.stringify(i.id)+':'+JSON.stringify(r)));
 assert.equal(l.estimateOnly,true);assert.notEqual(d.workerState.capacity.currentRawBytes,l.normalizedStateBytesBeforeCompaction);
 assert.deepEqual(raws,before);assert.ok(!JSON.stringify(d).includes('PRIVATE_雪'));
});
test('RUNNING and BLOCKED_MAPPING never compact in projection',async()=>{
 for(const status of ['RUNNING','BLOCKED_MAPPING']){
  const i=example().item(8,8,status),d=await inspect([i]),l=d.workerState.legacyCompaction;
  assert.equal(l.legacyCompleteCount,0);assert.equal(l.legacyCompleteReclaimableBytes,0);
  assert.equal(l.normalizedStateBytesBeforeCompaction,l.stateBytesAfterFullLegacyCompactionEstimate);
 }
});
test('invalid or unresolved legacy COMPLETE is not treated as compactable',async()=>{
 const i=example().item(5,4,'COMPLETE'),d=await inspect([i]);
 assert.equal(d.workerState.legacyCompaction.assessmentStatus,'PARTIAL_UNVERIFIED');
 assert.equal(d.workerState.legacyCompaction.legacyCompleteReclaimableBytes,null);
 assert.equal(d.capacityProjection.legacyRunningAdoptionFeasible,'UNKNOWN');
});
test('validated ingest proves N and exact operation prefix despite canonical key sorting',async()=>{
 const d=await inspect([example().item(5,4)]),r=d.workerState.running[0];
 assert.equal(r.observationCount,1);assert.equal(r.observationCountSource,'VALIDATED_SOURCE_ENVELOPE');
 assert.equal(r.expectedTotalActionCount,8);assert.equal(r.currentActionType,'ingest');assert.equal(r.currentActionOrdinal,5);
 assert.equal(r.remainingActionsToPrepare,3);assert.equal(r.remainingResultsToPersist,4);assert.equal(r.actionPrefixValidation,'PASS');
});
test('consistent manifest proves N without pretending source envelope is available',async()=>{
 const d=await inspect([example().item(4,4)]),r=d.workerState.running[0];
 assert.equal(r.observationCount,1);assert.equal(r.observationCountSource,'CONSISTENT_MANIFEST');
 assert.ok(d.capacityProjection.missingStructuralInputs.includes('SOURCE_ENVELOPE_UNAVAILABLE'));
});
test('no evidence for N is null; action counts are not interpreted as observation counts',async()=>{
 for(const a of [0,1,2,3]){
  const r=(await inspect([example().item(a,a)])).workerState.running[0];
  assert.equal(r.observationCount,null);assert.equal(r.expectedTotalActionCount,null);assert.equal(r.remainingActionsToPrepare,null);
 }
});
for(const [a,d,stage]of [[0,0,'INITIAL'],[1,0,'PREPARED_ACTION'],[3,3,'ACTION_RESULT_SAVED'],[8,8,'READY_TO_FINALIZE']])
 test('persisted stage '+stage,async()=>assert.equal((await inspect([example().item(a,d)])).workerState.running[0].persistedStage,stage));
test('unsaved attempted action does not replace persisted stage',async()=>{
 const r=(await inspect([example().item(4,4)])).workerState.running[0];
 assert.equal(r.persistedStage,'ACTION_RESULT_SAVED');assert.equal(r.currentActionType,'manifest');
});
test('invalid prefixes, source hashes, manifest provenance and malformed results fail closed',async()=>{
 const e=example();
 for(const edit of [
  i=>{delete i.actions.allocate;},
  i=>{i.done.unexpected=canonicalJSON({status:'OK'});},
  i=>{const x=JSON.parse(i.actions[e.sequence[4]]);x.data.ingestion.sourceEnvelopeHash='0'.repeat(64);i.actions[e.sequence[4]]=canonicalJSON(x);},
  i=>{const x=JSON.parse(i.actions.manifest);x.data.universeHash='0'.repeat(64);i.actions.manifest=canonicalJSON(x);},
  i=>{i.done.allocate=canonicalJSON({status:'ARBITRARY_SECRET'});},
  i=>{const x=JSON.parse(i.actions.manifest);x.requestId='bad';i.actions.manifest=canonicalJSON(x);}
 ]){
  const i=e.item(5,4);edit(i);const d=await inspect([i]),r=d.workerState.running[0];
  assert.equal(r.actionPrefixValidation,'UNVERIFIED');assert.equal(r.persistedStage,'INVALID_OR_UNRESOLVED_PREFIX');
  assert.equal(r.observationCount,null);assert.ok(!JSON.stringify(d).includes('ARBITRARY_SECRET'));
 }
});
test('zero-action RUNNING does not prove N=0; empty completed intent has bounded receipt projection',async()=>{
 const e=example(),r=(await inspect([e.item()])).workerState.running[0];assert.equal(r.observationCount,null);
 const d=await inspect([e.item(0,0,'COMPLETE')]);assert.equal(d.workerState.legacyCompaction.assessmentStatus,'PROJECTED');
 assert.equal(d.workerState.legacyCompaction.legacyCompleteCount,1);
});
test('no guessed reservation, lease acquisition or atomic snapshot',async()=>{
 const d=await inspect([example().item(5,4)]),p=d.capacityProjection;
 assert.equal(p.reservationAssessment,'NOT_DERIVABLE');
 for(const k of ['projectedMaximumContributionBytes','reservationNeededBytes','boundedHeaderHeadroomBytes','stateAfterMakeRoomAndReservationBytes','headroomAfterReservationBytes','makeRoomAcquisition'])assert.equal(p[k],null,k);
 assert.equal(p.legacyRunningAdoptionFeasible,'UNKNOWN');assert.equal(p.acquisitionAssessmentStatus,'NOT_DERIVABLE');assert.equal(p.atomicSnapshot,false);
});
test('multiple RUNNING never collapse into a single feasibility verdict',async()=>{
 const e=example(),d=await inspect([e.item(),{...e.item(),id:'second'}]);
 assert.equal(d.workerState.capacity.runningCount,2);assert.equal(d.workerState.running.length,2);
 assert.ok(d.capacityProjection.missingStructuralInputs.includes('OTHER_RUNNING_RESERVATIONS_UNASSESSED'));
 assert.equal(d.capacityProjection.legacyRunningAdoptionFeasible,'UNKNOWN');
});
test('oversized raw state is detected before any acquisition guess',async()=>{
 const raw=state([example().item()])+' '.repeat(4194304),raws=await fixtures();raws[0]=raw;
 const d=await diagnose(raws);assert.equal(d.capacityProjection.makeRoomAcquisition,'BLOCKED_OVERSIZED_CURRENT_STATE');
 assert.equal(d.workerState.capacity.currentFreeBytes,0);assert.ok(d.workerState.capacity.currentOverflowBytes>0);
});
test('extension output uses exact allowlists and never exposes request/result/frozen values',async()=>{
 const d=await inspect([example().item(5,4)]);
 const fields={
 capacity:'assessmentStatus currentRawBytes maxBytes currentFreeBytes currentOverflowBytes totalIntents runningCount legacyCompleteCount compactCompleteCount blockedMappingCount reservationSchemaStatus reservationsCount',
 legacyCompaction:'assessmentStatus legacyCompleteCount legacyCompleteSerializedContributionBytes legacyCompleteProjectedCompactContributionBytes legacyCompleteReclaimableBytes normalizedStateBytesBeforeCompaction stateBytesAfterFullLegacyCompactionEstimate serializationModel estimateOnly',
 running:'sourceCycleHash canonicalIntentBytes serializedContributionBytes actionsCount doneCount frozenBytes observationCount observationCountSource expectedTotalActionCount persistedStage currentActionOrdinal currentActionType remainingActionsToPrepare remainingResultsToPersist actionPrefixValidation mappingVersion hasReservation',
 projection:'reservationAssessment missingStructuralInputs currentContributionBytes projectedMaximumContributionBytes reservationNeededBytes reclaimableBytes stateAfterMakeRoomBytes boundedHeaderHeadroomBytes stateAfterMakeRoomAndReservationBytes headroomAfterReservationBytes legacyRunningAdoptionFeasible makeRoomAcquisition acquisitionAssessmentStatus atomicSnapshot'
 };
 for(const [key,value]of Object.entries({capacity:d.workerState.capacity,legacyCompaction:d.workerState.legacyCompaction,running:d.workerState.running[0],projection:d.capacityProjection}))
  assert.deepEqual(Object.keys(value).sort(),fields[key].split(' ').sort());
 const output=JSON.stringify(d),e=example();
 for(const value of [e.id,e.frozen,'PRIVATE_SYMBOL',...KEYS,'sourceEnvelope','initialPlan','PRIVATE_OWNER'])assert.ok(!output.includes(value),value);
 assert.match(d.workerState.running[0].sourceCycleHash,/^[a-f0-9]{64}$/);
});

test('missing inputs do not invent future actions/results for READY_TO_FINALIZE',async()=>{
 const d=await inspect([example().item(8,8)]),m=d.capacityProjection.missingStructuralInputs;
 assert.ok(!m.includes('FUTURE_REQUEST_SIZE_BOUNDS_UNAVAILABLE'));assert.ok(!m.includes('SUCCESS_REPLAY_RESULT_SIZE_BOUNDS_UNAVAILABLE'));
 assert.ok(!m.includes('RETAINED_GENERATION_BINDING_UNVERIFIED'));assert.equal(d.capacityProjection.reservationAssessment,'NOT_DERIVABLE');
});
test('invalid compact receipt fails closed and never changes projection',async()=>{
 const r=receipt(example().item(8,8,'COMPLETE'));r.fullIntentSha256='PRIVATE_BAD_HASH';
 const d=await inspect([r]);assert.equal(d.workerState.status,'INVALID');assert.equal(d.workerState.capacity.assessmentStatus,'NOT_DERIVABLE');
 assert.equal(d.workerState.legacyCompaction.stateBytesAfterFullLegacyCompactionEstimate,null);assert.ok(!JSON.stringify(d).includes('PRIVATE_BAD_HASH'));
});
