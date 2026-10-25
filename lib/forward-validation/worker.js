import {createHash,randomUUID} from 'node:crypto';
import {canonicalJSON,universeDigest} from './source-contract.js';
import {digest} from './observation-store.js';
import {readObservations,assert,lexical} from './observation-reader.js';
import {mapObservation,MAPPING,DELAYED} from './delayed-ingestion.js';
import {createWorkerStore,fencedExecutor,WORKER_MS,COMMAND_MS} from './worker-store.js';
import {createProducerStore,producerHash} from './producer-store.js';
import {createShadowStore,immutableOriginHash} from './store.js';
import {createCaptureAdapter} from './capture-adapter.js';
export const RUN_ID='manual-forward-worker-v1';
export const CORE_COMMIT='6020fc2ada83ef5121a95dd8d4656850631f5f93';
export const PRODUCER_BUDGET=Object.freeze({maxBytes:8388608,maxCycles:10000,maxOperations:50000,maxEvents:10000,maxGenerations:10000,maxRetainedPayloadBytes:6291456,maxPayloadBytes:32768,maxIdempotencyReceipts:50000});
export const SHADOW_BUDGET=Object.freeze({maxBytes:8388608,maxRecords:10000,maxEvents:50000,maxOperations:50000});
// Diagnostic projection only. Never return diagnostics to the worker state machine.
const diagnosticStatuses=new Set(['OK','CREATED','IDEMPOTENT','BLOCKED_STORAGE','BLOCKED_INTEGRITY','UNRESOLVED','CONFLICT','FENCED','STALE','BUSY','NOT_FOUND','STORAGE_ERROR','RUN_CONFLICT','OPERATION_CONFLICT','MALFORMED_STORED_JSON','INCONSISTENT_LEDGER']);
const diagnosticReasons=new Set(['BUDGET_EXCEEDED','TRANSPORT_FAILURE','STORED_BUDGET_CONFLICT','INCONSISTENT_LEDGER','MALFORMED_STORED_JSON','LEDGER_HASH_CONFLICT','PARTIAL_LEDGER','INVALID_RECEIPT','REPLAY_INTEGRITY_CONFLICT','IDEMPOTENCY_CONFLICT','RUN_ID_CONFLICT']);
const diagnosticOperations={acquire:'ACQUIRE',read:'READ',check:'CHECK',save:'SAVE',release:'RELEASE',createRun:'CREATE_RUN',allocateCycle:'ALLOCATE_CYCLE',freezeManifest:'FREEZE_MANIFEST',ingestDelayedObservation:'INGEST_DELAYED_OBSERVATION',getOrCreateGeneration:'GET_OR_CREATE_GENERATION',prepareCapture:'PREPARE_CAPTURE',commit:'COMMIT',receiveCaptureReceipt:'RECEIVE_CAPTURE_RECEIPT',acknowledgeCapture:'ACKNOWLEDGE_CAPTURE'};
const diagnosticHash=value=>typeof value==='string'?createHash('sha256').update(value).digest('hex'):null;
const ok=r=>{assert(r&&['OK','CREATED','IDEMPOTENT'].includes(r.status),r?.status??'UNRESOLVED');return r;};
export async function runWorker({execute,now=Date.now,owner=randomUUID(),onStorage}={}){
 const start=now();
 // One request can consume 5000ms; reserve another 1000ms for bounded local
 // validation/serialization. Check before EVERY Redis command, not just phases.
 const guard=()=>assert(now()-start<=WORKER_MS-COMMAND_MS-1000,'DEADLINE');
 const bounded=async c=>{guard();return execute(c);};
 let lease,item,actionKey=null,savePhase=null,diagnosticEmitted=false;
 const report=(component,method,args,result)=>{
  // Cleanup must neither replace nor masquerade as a processing failure.
  if(method==='release'||diagnosticEmitted)return;
  try{
   diagnosticEmitted=true;
   const reason=result?.reasonCode??result?.reason;
   const event={component,operation:diagnosticOperations[method],savePhase:method==='save'?savePhase:null,
    originalStatus:diagnosticStatuses.has(result?.status)?result.status:'UNKNOWN',
    originalReasonCode:reason==null?'NOT_PROVIDED':diagnosticReasons.has(reason)?reason:'UNCLASSIFIED',
    sourceCycleHash:diagnosticHash(item?.id),actionHash:diagnosticHash(actionKey)};
   if(component==='WORKER_STATE'&&method==='save'){
    const prepared=args[2];event.preparedIntentBytes=Buffer.byteLength(canonicalJSON(prepared),'utf8');
    event.maxPayloadBytes=32768;event.preparedIntentOverLimit=event.preparedIntentBytes>32768;
    event.actionsCount=Object.keys(prepared.actions).length;event.doneCount=Object.keys(prepared.done).length;
   }
   if(component==='PRODUCER_LEDGER'&&args[1]?.data!==undefined)
    event.requestDataBytes=Buffer.byteLength(canonicalJSON(args[1].data),'utf8');
   if(component==='SHADOW_LEDGER'&&method==='commit'){
    if(Array.isArray(args[1]?.records))event.transactionRecordsCount=args[1].records.length;
    if(Array.isArray(args[1]?.events))event.transactionEventsCount=args[1].events.length;
   }
   console.info('[forward-worker-storage-failure]',JSON.stringify(event));
  }catch{}
 };
 const observe=(component,store)=>Object.fromEntries(Object.entries(store).map(([method,fn])=>[method,
  !Object.hasOwn(diagnosticOperations,method)?fn:async(...args)=>{
   let result;
   try{result=await fn(...args);}catch(error){report(component,method,args,null);throw error;}
   // Worker read returns a state, not a status receipt.
   if(!(component==='WORKER_STATE'&&method==='read')&&!['OK','CREATED','IDEMPOTENT'].includes(result?.status))report(component,method,args,result);
   return result;
  }]));
 const store=observe('WORKER_STATE',createWorkerStore(bounded));
 try{
  const cycles=await readObservations(bounded,onStorage);
  lease=await store.acquire(owner);if(lease.status!=='OK')return {status:lease.status};
  const state=await store.read();
  for(const c of cycles){const old=state.intents[c.envelope.sourceCycleId];if(old){const f=JSON.parse(old.frozen);assert(f.sourceEnvelopeHash===c.hash&&f.mappingVersion===MAPPING,'SOURCE_HASH_CONFLICT');}}
  // Resume an unfinished intent first. Never start another cycle around it.
  const pending=Object.values(state.intents).filter(x=>x.status==='RUNNING').sort((a,b)=>lexical(JSON.parse(a.frozen).orderKey,JSON.parse(b.frozen).orderKey));
  const cycle=pending.length?cycles.find(c=>c.envelope.sourceCycleId===pending[0].id):cycles.find(c=>!state.intents[c.envelope.sourceCycleId]);
  if(!cycle){assert(!pending.length,'PENDING_SOURCE_MISSING');return {status:'IDLE',cyclesProcessed:0};}
  const e=cycle.envelope,orderKey=e.observedAt+'|'+e.sourceCycleId;
  item=state.intents[e.sourceCycleId];
  const save=async phase=>{savePhase=phase;ok(await store.save(owner,lease.fence,item));};
  if(!item){
   const timestamp=new Date(now()).toISOString();
   item={id:e.sourceCycleId,frozen:canonicalJSON({mappingVersion:MAPPING,sourceEnvelopeHash:cycle.hash,sourceCycleId:e.sourceCycleId,
    processingIdentity:digest([MAPPING,e.sourceCycleId]),orderKey,workerProcessingStartedAt:timestamp,workerRecordedAt:timestamp}),actions:{},done:{},status:'RUNNING'};
   await save('INITIAL');
  }
  const frozen=JSON.parse(item.frozen);
  const later=Object.values(state.intents).some(x=>x.id!==item.id&&JSON.parse(x.frozen).orderKey>orderKey);
  if(later||e.observations.length>50){item.status='BLOCKED_MAPPING';item.reasons=[later?'LATE_SOURCE_CYCLE':'OBSERVATION_LIMIT_EXCEEDED'];await save('MAPPING_RESULT');return {status:item.status,reasonCodes:item.reasons,cyclesProcessed:1};}
  const mapped=e.observations.map(o=>({o,m:mapObservation(cycle,o)}));
  const invalid=mapped.filter(x=>x.m.status!=='MAPPED');
  // A blocked observation is retained durably. No partial generation mapping of
  // this cycle and no fake initial plan; source data remains untouched.
  const duplicateSymbols=new Set(mapped.map(x=>x.o.payload.symbol)).size!==mapped.length;
  if(duplicateSymbols){item.status='BLOCKED_MAPPING';item.reasons=['MULTIPLE_DIRECTIONS_PER_SYMBOL'];await save('MAPPING_RESULT');return {status:item.status,cyclesProcessed:1,reasonCodes:item.reasons};}
  if(invalid.length){item.status='BLOCKED_MAPPING';item.reasons=[...new Set(invalid.flatMap(x=>x.m.reasonCodes))];
   item.blockedObservationIds=invalid.map(x=>x.o.observationId);await save('MAPPING_RESULT');return {status:item.status,cyclesProcessed:1,blockedObservations:invalid.length,reasonCodes:item.reasons};}
  if(!mapped.length){item.status='COMPLETE';await save('COMPLETE');return {status:'COMPLETE',cyclesProcessed:1,observations:0};}
  const downstream=fencedExecutor(bounded,owner,lease.fence,guard),producer=observe('PRODUCER_LEDGER',createProducerStore(downstream)),shadow=observe('SHADOW_LEDGER',createShadowStore(downstream));
  const action=async(key,make,invoke)=>{
   actionKey=key;guard();ok(await store.check(owner,lease.fence));
   if(item.done[key])return JSON.parse(item.done[key]);
   if(!item.actions[key]){item.actions[key]=canonicalJSON(await make());await save('PREPARED_ACTION');}
   const result=ok(await invoke(JSON.parse(item.actions[key])));
   item.done[key]=canonicalJSON(result);await save('ACTION_RESULT');return result;
  };
  const send=(key,type,data)=>action(key,async()=>{const r=ok(await producer.read(RUN_ID));return {requestId:digest([frozen.processingIdentity,key]),expectedRevision:r.revision,data:await data()};},req=>producer[type](RUN_ID,req));
  await action('producer-init',()=>({runId:RUN_ID,mode:'SHADOW',schemaVersion:1,coreCommit:CORE_COMMIT,officialActivationId:null,officialActivationAt:null,budget:PRODUCER_BUDGET}),m=>producer.createRun(m));
  await action('shadow-init',()=>({runId:RUN_ID,mode:'SHADOW',schemaVersion:1,protocolVersion:'1.1',admissionVersion:'1.1',coreCommit:CORE_COMMIT,
   officialActivationId:null,officialActivationAt:null,ledgerRevision:0,captureWatermark:null,decisionWatermark:null,health:'HEALTHY',failureReason:null,storageBudget:SHADOW_BUDGET}),m=>shadow.createRun(m));
  const cid=(await send('allocate','allocateCycle',()=>({allocationId:frozen.processingIdentity,cycleStartedAt:frozen.workerProcessingStartedAt,sourceTimeLowerBound:frozen.workerProcessingStartedAt}))).reply.cycleId;
  const symbols=mapped.map(x=>x.o.payload.symbol);assert(new Set(symbols).size===symbols.length,'MULTIPLE_DIRECTIONS_PER_SYMBOL');
  await send('manifest','freezeManifest',()=>({cycleId:cid,universeId:e.sourceCycleId,universeHash:universeDigest(symbols),expectedSymbols:symbols,batchCount:1,batches:[{batchId:cid+':0',batchIndex:0,expectedBatchSymbols:symbols}]}));
  for(const {o,m} of mapped){
   const op=digest([MAPPING,e.sourceCycleId,o.observationId]),f=m.frozenCandidate;
   await send(op+':ingest','ingestDelayedObservation',()=>({cycleId:cid,operationId:op,ingestion:{schemaVersion:DELAYED,mappingVersion:MAPPING,
    processingIdentity:op,sourceEnvelope:cycle.raw,sourceCycleId:e.sourceCycleId,sourceEnvelopeHash:cycle.hash,
    observationId:o.observationId,observationPayloadHash:o.payloadHash,sourceObservedAt:e.observedAt,sourceAnalysisAt:o.payload.analysisAt,
    workerProcessingStartedAt:frozen.workerProcessingStartedAt,workerRecordedAt:frozen.workerRecordedAt,frozenCandidate:f}}));
   await send(op+':generation','getOrCreateGeneration',async()=>{
    const current=ok(await producer.read(RUN_ID));
    const exact=current.state.generations.find(g=>g.shadowCandidateId===f.tradeId);
    if(exact){assert(exact.original.frozenFactsHash===producerHash(f),'FROZEN_MAPPING_CONFLICT');return exact.original;}
    return {setupKey:f.setupKey,shadowCandidateId:f.tradeId,identityOrigin:'SHADOW_ONLY',originalSourceOperationId:op,
     originalCapturedAt:f.origin.detectedAt,frozenCandidate:f,frozenFactsHash:producerHash(f)};
   });
   await send(op+':prepare','prepareCapture',async()=>{
    const p=ok(await producer.read(RUN_ID)),s=ok(await shadow.read(RUN_ID));
    const gId=JSON.parse(item.done[op+':generation']).reply.shadowCandidateId,g=p.state.generations.find(x=>x.shadowCandidateId===gId);
    const original=g.original.frozenCandidate,origin=p.state.operations.find(x=>x.operationId===g.original.originalSourceOperationId).result;
    const current=p.state.operations.find(x=>x.operationId===op).result;
    const records=[];if(!s.ledger.records.some(x=>x.shadowCandidateId===gId)){
     const r={identityOrigin:'SHADOW_ONLY',coreTradeId:null,shadowCandidateId:gId,setupKey:original.setupKey,symbol:original.symbol,instrumentType:original.instrumentType,
      direction:original.direction,origin:original.origin,analysisAt:origin.analysisAt,initialPlan:original.initialPlan,originalEligibility:original.originalEligibility,
      recordedAt:frozen.workerRecordedAt,updatedAt:frozen.workerRecordedAt,revision:0,state:'DETECTED',priorDisposition:null,capacityOccupied:false,
      verificationCursor:null,verifiedThrough:null,unresolvedReason:null,eligibleEntryCandle:null,admissionDecision:null,skipReason:null,lifecycleEvidenceRefs:[],terminal:null};
     r.immutableOriginHash=immutableOriginHash(r);records.push({expectedRevision:null,record:r});
    }
    const payload={sourceOperationId:op,sourcePayloadHash:current.payloadHash,shadowCandidateId:gId,frozenFactsHash:g.original.frozenFactsHash,generationSequence:g.generationSequence};
    const captureOperationId=op+':capture',transaction={operationId:captureOperationId,expectedLedgerRevision:s.ledger.meta.ledgerRevision,records,events:[{
     eventId:op+':observed',sourceOperationId:op,sourceRevision:0,identity:gId,type:'CAPTURED',eventTime:e.observedAt,observedAt:frozen.workerRecordedAt,payload,evidenceHash:producerHash(payload)}]};
    return {captureOperationId,sourceOperationId:op,shadowCandidateId:gId,payloadHash:current.payloadHash,expectedShadowRevision:transaction.expectedLedgerRevision,transaction,transactionHash:producerHash(transaction)};
   });
   await action(op+':capture',()=>({runId:RUN_ID,captureOperationId:op+':capture'}),input=>createCaptureAdapter({producerStore:producer,shadowStore:shadow}).recover(input));
  }
  item.status='COMPLETE';await save('COMPLETE');return {status:'COMPLETE',cyclesProcessed:1,observations:mapped.length};
 }catch(error){return {status:['BLOCKED_STORAGE','CONFLICT','BLOCKED_MAPPING','BUSY','FENCED','STALE'].includes(error.message)?error.message:'UNRESOLVED',reasonCode:
  ['DEADLINE','SOURCE_HASH_CONFLICT','PENDING_SOURCE_MISSING','MULTIPLE_DIRECTIONS_PER_SYMBOL'].includes(error.message)?error.message:'PROCESSING_INCOMPLETE'};}
 finally{if(lease?.status==='OK'&&now()-start<=WORKER_MS-COMMAND_MS-1000)try{await store.release(owner,lease.fence);}catch{}}
}
