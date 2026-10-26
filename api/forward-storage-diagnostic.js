import {createHash} from 'node:crypto';
import {digest} from '../lib/forward-validation/observation-store.js';
import {validateCycle,iso} from '../lib/forward-validation/observation-reader.js';
import {MAPPING,validateDelayed,mapObservation} from '../lib/forward-validation/delayed-ingestion.js';
import {requirePrivateApi} from '../lib/private-access.js';
import {canonicalJSON,universeDigest} from '../lib/forward-validation/source-contract.js';
import {createProducerStore,producerKey} from '../lib/forward-validation/producer-store.js';
import {createShadowStore,shadowKey,hashValue} from '../lib/forward-validation/store.js';
import {WORKER_KEY,STATE_LIMITS} from '../lib/forward-validation/worker-store.js';

const RUN='manual-forward-worker-v1';
export const KEYS=Object.freeze([WORKER_KEY,producerKey(RUN),shadowKey(RUN)]);
const stores=['WORKER_STATE','PRODUCER_LEDGER','SHADOW_LEDGER'];
const producerLimits=['maxBytes','maxCycles','maxOperations','maxEvents','maxGenerations','maxRetainedPayloadBytes','maxPayloadBytes','maxIdempotencyReceipts'];
const shadowLimits=['maxBytes','maxRecords','maxEvents','maxOperations'];
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const bytes=v=>Buffer.byteLength(v,'utf8');
const check=(n,limit)=>integer(n)&&integer(limit)?n<=limit?'PASS':'FAIL':'UNKNOWN';
const unknown=names=>Object.fromEntries(names.map(k=>[k,'UNKNOWN']));
const budgets=(v,names)=>object(v)&&Object.keys(v).length===names.length&&names.every(k=>integer(v[k])&&v[k]>0)
 ? Object.fromEntries(names.map(k=>[k,v[k]])):null;
const local=(key,raw)=>async command=>{
 if(!Array.isArray(command)||command.length!==2||command[0]!=='GET'||command[1]!==key)throw Error('READ_ONLY');
 return raw;
};
const base=(raw,names)=>({status:raw===null?'NOT_FOUND':'INVALID',schemaVersion:null,serializedBytes:typeof raw==='string'?bytes(raw):null,budgetChecks:unknown(names)});
function finish(out){out.status=Object.values(out.budgetChecks).includes('FAIL')?'CURRENT_BUDGET_VIOLATION':'VALID';return out;}
function worker(raw){
 const out={...base(raw,['serializedBytes','intents','runningIntents','intentPayloadBytes']),mappingVersion:null,
  intents:null,runningIntents:null,statusCounts:null,maxSavedIntentPayloadBytes:null,payloadsOverLimit:null,limits:{...STATE_LIMITS}};
 if(raw===null)return out;
 try{
  const s=JSON.parse(raw),allowed=['RUNNING','COMPLETE','BLOCKED_MAPPING'];
  if(!object(s)||s.schemaVersion!=='forward-worker-state-v1'||s.mappingVersion!=='forward-worker-mapping-v1'||!object(s.intents)||
   !integer(s.fence)||!integer(s.expiresAt)||typeof s.owner!=='string')return out;
  const rows=Object.entries(s.intents).map(([id,v])=>{
   if(typeof v!=='string')throw Error('INVALID');const i=JSON.parse(v);
   if(!object(i)||i.id!==id||typeof i.frozen!=='string'||!allowed.includes(i.status)||!object(JSON.parse(i.frozen)))throw Error('INVALID');
   if(i.receiptVersion===RECEIPT){
    frozenFacts(i);if(i.status!=='COMPLETE'||!hash(i.fullIntentSha256)||!same(Object.keys(i).sort(),['receiptVersion','id','frozen','status','fullIntentSha256'].sort()))throw Error('INVALID');
   }else if(!object(i.actions)||!object(i.done))throw Error('INVALID');
   return {status:i.status,size:bytes(v)};
  });
  out.schemaVersion='forward-worker-state-v1';out.mappingVersion='forward-worker-mapping-v1';
  out.intents=rows.length;out.statusCounts=Object.fromEntries(allowed.map(k=>[k,rows.filter(r=>r.status===k).length]));
  out.runningIntents=out.statusCounts.RUNNING;out.maxSavedIntentPayloadBytes=Math.max(0,...rows.map(r=>r.size));
  out.payloadsOverLimit=rows.filter(r=>r.size>STATE_LIMITS.maxPayloadBytes).length;
  out.budgetChecks={serializedBytes:check(out.serializedBytes,STATE_LIMITS.maxBytes),intents:check(out.intents,STATE_LIMITS.maxCycleReceipts),
   runningIntents:check(out.runningIntents,STATE_LIMITS.maxPendingIntents),intentPayloadBytes:check(out.maxSavedIntentPayloadBytes,STATE_LIMITS.maxPayloadBytes)};
  return finish(out);
 }catch{return out;}
}
async function producer(raw){
 const names=['serializedBytes','cycles','operations','entries','generations','retainedPayloadBytes','requestPayloadBytes','idempotencyReceipts'];
 const out={...base(raw,names),revision:null,entries:null,cycles:null,operations:null,generations:null,
  retainedPayloadBytes:null,maxRequestPayloadBytes:null,payloadsOverLimit:null,limits:null};
 if(raw===null)return out;
 try{
  const l=JSON.parse(raw),limits=budgets(l?.meta?.budget,producerLimits);
  if(!limits||l.meta.schemaVersion!==1||l.meta.runId!==RUN)return out;
  const r=await createProducerStore(local(KEYS[1],raw)).read(RUN);
  // This reason occurs only AFTER integrity validation and deterministic replay.
  const storedOverflow=r.status==='BLOCKED_INTEGRITY'&&r.reason==='STORED_BUDGET_CONFLICT';
  if(r.status!=='OK'&&!storedOverflow)return out;
  const sizes=l.entries.map(e=>bytes(canonicalJSON(e.request.data)));
  Object.assign(out,{schemaVersion:1,revision:l.revision,entries:l.entries.length,limits,
   cycles:r.state?.cycles.length??null,operations:r.state?.operations.length??null,generations:r.state?.generations.length??null,
   retainedPayloadBytes:sizes.reduce((a,b)=>a+b,0),maxRequestPayloadBytes:Math.max(0,...sizes),payloadsOverLimit:sizes.filter(n=>n>limits.maxPayloadBytes).length});
  out.budgetChecks={serializedBytes:check(out.serializedBytes,limits.maxBytes),cycles:check(out.cycles,limits.maxCycles),operations:check(out.operations,limits.maxOperations),
   entries:check(out.entries,limits.maxEvents),generations:check(out.generations,limits.maxGenerations),retainedPayloadBytes:check(out.retainedPayloadBytes,limits.maxRetainedPayloadBytes),
   requestPayloadBytes:check(out.maxRequestPayloadBytes,limits.maxPayloadBytes),idempotencyReceipts:check(out.entries,limits.maxIdempotencyReceipts)};
  finish(out);if(storedOverflow)out.status='CURRENT_BUDGET_VIOLATION';
  out.validation=storedOverflow?'STORED_BUDGET_CONFLICT':'PASS';return out;
 }catch{return out;}
}
async function shadow(raw){
 const out={...base(raw,['serializedBytes','records','events','operations']),protocolVersion:null,admissionVersion:null,
  ledgerRevision:null,records:null,events:null,operations:null,limits:null};
 if(raw===null)return out;
 try{
  const l=JSON.parse(raw),limits=budgets(l?.meta?.storageBudget,shadowLimits);
  if(!limits||l.meta.schemaVersion!==1||l.meta.protocolVersion!=='1.1'||l.meta.admissionVersion!=='1.1')return out;
  const r=await createShadowStore(local(KEYS[2],raw)).read(RUN);
  if(r.status!=='OK'){
   if(r.status!=='INCONSISTENT_LEDGER')return out;
   // INCONSISTENT_LEDGER also covers corruption. Verify the original hash first,
   // then validate an in-memory copy with budget checks disabled numerically.
   // Only this validation copy changes; metrics/checks use the original budgets.
   const {integrityHash,...body}=l;
   if(integrityHash!==hashValue(body))return out;
   const probe=JSON.parse(raw);
   probe.meta.storageBudget=Object.fromEntries(shadowLimits.map(k=>[k,Number.MAX_SAFE_INTEGER]));
   const {integrityHash:ignored,...probeBody}=probe;
   const probeRaw=canonicalJSON({...probeBody,integrityHash:hashValue(probeBody)});
   if((await createShadowStore(local(KEYS[2],probeRaw)).read(RUN)).status!=='OK')return out;
  }
  Object.assign(out,{schemaVersion:1,protocolVersion:'1.1',admissionVersion:'1.1',ledgerRevision:l.meta.ledgerRevision,
   records:l.records.length,events:l.events.length,operations:l.operations.length,limits});
  out.budgetChecks={serializedBytes:check(out.serializedBytes,limits.maxBytes),records:check(out.records,limits.maxRecords),events:check(out.events,limits.maxEvents),operations:check(out.operations,limits.maxOperations)};
  return finish(out);
 }catch{return out;}
}

const RECEIPT='forward-worker-complete-v1';
const sha=raw=>createHash('sha256').update(raw,'utf8').digest('hex');
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const contribution=(id,raw)=>bytes(JSON.stringify(id))+1+bytes(JSON.stringify(raw));
const successful=r=>object(r)&&['OK','CREATED','IDEMPOTENT'].includes(r.status);
function frozenFacts(i){
 const f=JSON.parse(i.frozen);
 if(!hash(i.id)||!object(f)||f.mappingVersion!==MAPPING||f.sourceCycleId!==i.id||!hash(f.sourceEnvelopeHash)||
  f.processingIdentity!==digest([MAPPING,i.id])||typeof f.orderKey!=='string'||
  !f.orderKey.endsWith('|'+i.id)||!iso(f.orderKey.slice(0,-65))||!iso(f.workerProcessingStartedAt)||
  !iso(f.workerRecordedAt)||f.workerRecordedAt<f.workerProcessingStartedAt)throw Error('INVALID');
 return f;
}
function actionEvidence(i,f){
 const actions=Object.fromEntries(Object.entries(i.actions).map(([k,v])=>{
  if(typeof v!=='string')throw Error('INVALID');const x=JSON.parse(v);if(!object(x)||canonicalJSON(x)!==v)throw Error('INVALID');return [k,x];
 }));
 const done=Object.fromEntries(Object.entries(i.done).map(([k,v])=>{
  if(typeof v!=='string')throw Error('INVALID');const x=JSON.parse(v);if(!successful(x)||canonicalJSON(x)!==v)throw Error('INVALID');return [k,x];
 }));
 let source=null;
 for(const [key,request]of Object.entries(actions)){
  if(!key.endsWith(':ingest'))continue;
  const d=request.data?.ingestion;
  validateDelayed(d);
  const c=validateCycle(d.sourceEnvelope,d.sourceCycleId);
  if(c.envelope.sourceCycleId!==i.id||c.hash!==f.sourceEnvelopeHash||
   d.workerProcessingStartedAt!==f.workerProcessingStartedAt||d.workerRecordedAt!==f.workerRecordedAt||
   key!==d.processingIdentity+':ingest'||request.data.operationId!==d.processingIdentity||
   d.processingIdentity!==digest([MAPPING,i.id,d.observationId])||
   f.orderKey!==c.envelope.observedAt+'|'+i.id||
   (source&&source.raw!==c.raw))throw Error('INVALID');
  if(c.envelope.observations.some(o=>mapObservation(c,o).status!=='MAPPED'))throw Error('INVALID');
  source=c;
 }
 let symbols=null;
 const manifest=actions.manifest?.data;
 if(manifest){
  symbols=manifest.expectedSymbols;
  if(!Array.isArray(symbols)||!symbols.length||symbols.some(s=>typeof s!=='string'||!s||s.trim()!==s)||
   new Set(symbols).size!==symbols.length||manifest.universeId!==i.id||manifest.universeHash!==universeDigest(symbols)||
   manifest.batchCount!==1||!Array.isArray(manifest.batches)||manifest.batches.length!==1||
   !object(manifest.batches[0])||manifest.batches[0].batchIndex!==0||
   manifest.batches[0].batchId!==manifest.cycleId+':0'||!same(manifest.batches[0].expectedBatchSymbols,symbols)||
   done.allocate?.reply?.cycleId!==manifest.cycleId)throw Error('INVALID');
 }
 let ops=null,n=null,origin=null;
 if(source){
  n=source.envelope.observations.length;origin='VALIDATED_SOURCE_ENVELOPE';
  if(!symbols||!same(symbols,source.envelope.observations.map(o=>o.payload.symbol)))throw Error('INVALID');
  ops=source.envelope.observations.map(o=>digest([MAPPING,i.id,o.observationId]));
 }else if(symbols){
  n=symbols.length;origin='CONSISTENT_MANIFEST';
  // Direction is absent from manifest. Bind later operation keys only when
  // validated ingest source is available; never guess the mapping order.
 }
 if(n!==null&&n>50)throw Error('INVALID');
 const base=['producer-init','shadow-init','allocate','manifest'];
 const sequence=ops?base.concat(ops.flatMap(op=>['ingest','generation','prepare','capture'].map(type=>op+':'+type))):base;
 const a=Object.keys(actions),d=Object.keys(done);
 if(a.length>sequence.length||d.length>a.length||a.length-d.length>1)throw Error('INVALID');
 // Canonical JSON sorts object keys. Logical order comes from the worker plan,
 // never from persisted object insertion order.
 if(!same([...a].sort(),sequence.slice(0,a.length).sort())||!same([...d].sort(),sequence.slice(0,d.length).sort()))throw Error('INVALID');
 for(const key of a){
  const r=actions[key];
  if(key==='producer-init'||key==='shadow-init'){if(r.runId!==RUN||r.mode!=='SHADOW')throw Error('INVALID');}
  else if(key.endsWith(':capture')){if(r.runId!==RUN||r.captureOperationId!==key)throw Error('INVALID');}
  else if(r.requestId!==digest([f.processingIdentity,key])||!integer(r.expectedRevision)||!object(r.data))throw Error('INVALID');
 }
 const total=n===null?null:n===0?0:4+4*n;
 const stage=!a.length?'INITIAL':a.length>d.length?'PREPARED_ACTION':
  total!==null&&d.length===total?'READY_TO_FINALIZE':'ACTION_RESULT_SAVED';
 const key=a.length?sequence[a.length-1]:null;
 return {n,origin,total,stage,ordinal:key?a.length:null,type:key?(key.includes(':')?key.slice(key.lastIndexOf(':')+1):key):null,
  remainingActions:total===null?null:total-a.length,remainingResults:total===null?null:total-d.length,source:!!source};
}
function workerDetails(raw){
 const known=typeof raw==='string',size=known?bytes(raw):null;
 const capacity={assessmentStatus:'NOT_DERIVABLE',currentRawBytes:size,maxBytes:STATE_LIMITS.maxBytes,
  currentFreeBytes:known?Math.max(0,STATE_LIMITS.maxBytes-size):null,currentOverflowBytes:known?Math.max(0,size-STATE_LIMITS.maxBytes):null,
  totalIntents:null,runningCount:null,legacyCompleteCount:null,compactCompleteCount:null,blockedMappingCount:null,
  reservationSchemaStatus:'NOT_APPLICABLE',reservationsCount:0};
 const legacyCompaction={assessmentStatus:'NOT_DERIVABLE',legacyCompleteCount:null,legacyCompleteSerializedContributionBytes:null,
  legacyCompleteProjectedCompactContributionBytes:null,legacyCompleteReclaimableBytes:null,normalizedStateBytesBeforeCompaction:null,
  stateBytesAfterFullLegacyCompactionEstimate:null,serializationModel:'CANONICAL_JSON_OUTER_PRESERVED_INTENT_STRINGS',estimateOnly:true};
 const running=[];
 try{
  const s=JSON.parse(raw);
  if(!object(s)||s.schemaVersion!=='forward-worker-state-v1'||s.mappingVersion!==MAPPING||!object(s.intents)||
   !integer(s.fence)||!integer(s.expiresAt)||typeof s.owner!=='string')throw Error('INVALID');
  const projected=structuredClone(s);
  let legacy=0,compact=0,blocked=0,oldBytes=0,newBytes=0,valid=true;
  for(const [id,v]of Object.entries(s.intents)){
   if(typeof v!=='string')throw Error('INVALID');
   const i=JSON.parse(v);if(!object(i)||i.id!==id||!['RUNNING','COMPLETE','BLOCKED_MAPPING'].includes(i.status))throw Error('INVALID');
   if(i.status==='BLOCKED_MAPPING'){blocked++;continue;}
   let f=null,e=null;
   try{f=frozenFacts(i);}catch{}
   if(i.status==='COMPLETE'&&i.receiptVersion===RECEIPT){
    if(!f||!hash(i.fullIntentSha256)||!same(Object.keys(i).sort(),['receiptVersion','id','frozen','status','fullIntentSha256'].sort()))throw Error('INVALID');
    compact++;continue;
   }
   if(!object(i.actions)||!object(i.done)||typeof i.frozen!=='string')throw Error('INVALID');
   try{if(!f)throw Error('INVALID');e=actionEvidence(i,f);}catch{}
   if(i.status==='RUNNING'){
    running.push({sourceCycleHash:sha(id),canonicalIntentBytes:bytes(canonicalJSON(i)),serializedContributionBytes:contribution(id,v),
     actionsCount:Object.keys(i.actions).length,doneCount:Object.keys(i.done).length,frozenBytes:bytes(i.frozen),
     observationCount:e?.n??null,observationCountSource:e?.origin??null,expectedTotalActionCount:e?.total??null,
     persistedStage:e?.stage??'INVALID_OR_UNRESOLVED_PREFIX',currentActionOrdinal:e?.ordinal??null,currentActionType:e?.type??null,
     remainingActionsToPrepare:e?.remainingActions??null,remainingResultsToPersist:e?.remainingResults??null,
     actionPrefixValidation:e?'PASS':'UNVERIFIED',mappingVersion:f?MAPPING:null,hasReservation:false});
    continue;
   }
   legacy++;
   const empty=f&&Object.keys(i.actions).length===0&&Object.keys(i.done).length===0;
   if(!f||(!empty&&e?.stage!=='READY_TO_FINALIZE')||
    !same(Object.keys(i).sort(),['id','frozen','status','actions','done'].sort())){valid=false;continue;}
   const receipt={receiptVersion:RECEIPT,id,frozen:i.frozen,status:'COMPLETE',fullIntentSha256:sha(canonicalJSON(i))};
   const next=canonicalJSON(receipt);
   oldBytes+=contribution(id,v);newBytes+=contribution(id,next);projected.intents[id]=next;
  }
  Object.assign(capacity,{assessmentStatus:'VALID',totalIntents:Object.keys(s.intents).length,runningCount:running.length,
   legacyCompleteCount:legacy,compactCompleteCount:compact,blockedMappingCount:blocked});
  Object.assign(legacyCompaction,{assessmentStatus:valid?'PROJECTED':'PARTIAL_UNVERIFIED',legacyCompleteCount:legacy,
   legacyCompleteSerializedContributionBytes:valid?oldBytes:null,legacyCompleteProjectedCompactContributionBytes:valid?newBytes:null,
   legacyCompleteReclaimableBytes:valid?oldBytes-newBytes:null,normalizedStateBytesBeforeCompaction:bytes(canonicalJSON(s)),
   stateBytesAfterFullLegacyCompactionEstimate:valid?bytes(canonicalJSON(projected)):null});
 }catch{running.length=0;}
 return {capacity,legacyCompaction,running};
}
function capacityProjection(details){
 const {capacity:c,legacyCompaction:l,running}=details;
 const missing=['WORKER_STATE_SERIALIZATION_BOUND_UNAVAILABLE','LEASE_METADATA_HEADROOM_BOUND_UNAVAILABLE','CROSS_STORE_SNAPSHOT_NOT_ATOMIC'];
 if(running.some(r=>r.remainingActionsToPrepare===null||r.remainingActionsToPrepare>0))missing.push('FUTURE_REQUEST_SIZE_BOUNDS_UNAVAILABLE');
 if(running.some(r=>r.remainingResultsToPersist===null||r.remainingResultsToPersist>0))missing.push('SUCCESS_REPLAY_RESULT_SIZE_BOUNDS_UNAVAILABLE');
 if(c.assessmentStatus!=='VALID'||running.some(r=>r.observationCountSource!=='VALIDATED_SOURCE_ENVELOPE'))missing.push('SOURCE_ENVELOPE_UNAVAILABLE');
 if(c.assessmentStatus!=='VALID'||running.some(r=>r.actionPrefixValidation!=='PASS'))missing.push('ACTION_PREFIX_UNVERIFIED');
 if(running.some(r=>r.remainingActionsToPrepare===null||r.remainingActionsToPrepare>0))missing.push('RETAINED_GENERATION_BINDING_UNVERIFIED');
 if(running.length>1)missing.push('OTHER_RUNNING_RESERVATIONS_UNASSESSED');
 const oversized=c.currentOverflowBytes>0;
 return {reservationAssessment:'NOT_DERIVABLE',missingStructuralInputs:missing,
  currentContributionBytes:c.assessmentStatus==='VALID'?running.reduce((n,r)=>n+r.serializedContributionBytes,0):null,
  projectedMaximumContributionBytes:null,reservationNeededBytes:null,reclaimableBytes:l.legacyCompleteReclaimableBytes,
  stateAfterMakeRoomBytes:l.stateBytesAfterFullLegacyCompactionEstimate,boundedHeaderHeadroomBytes:null,
  stateAfterMakeRoomAndReservationBytes:null,headroomAfterReservationBytes:null,legacyRunningAdoptionFeasible:'UNKNOWN',
  makeRoomAcquisition:oversized?'BLOCKED_OVERSIZED_CURRENT_STATE':null,
  acquisitionAssessmentStatus:oversized?'DETERMINED':'NOT_DERIVABLE',atomicSnapshot:false};
}

export async function diagnose(raws){
 const results=[worker(raws[0]),await producer(raws[1]),await shadow(raws[2])];
 const details=workerDetails(raws[0]);Object.assign(results[0],details);
 const blocked=results.flatMap((r,i)=>r.status==='CURRENT_BUDGET_VIOLATION'?[stores[i]]:[]);
 return {capacityProjection:capacityProjection(details),workerState:results[0],producerLedger:results[1],shadowLedger:results[2],
  blockingStore:blocked.length>1?'MULTIPLE':blocked[0]??'UNDETERMINED',
  blockingStoreScope:'CURRENT_STATE_ONLY',nextStateAssessment:'NOT_REPRODUCED',atomicSnapshot:false};
}
export default async function handler(req,res){
 if(!requirePrivateApi(req,res))return;
 if(req.method!=='GET')return res.status(405).json({error:'GET_REQUIRED'});
 const url=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
 const token=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
 if(!url||!token)return res.status(503).json({error:'STORAGE_UNAVAILABLE'});
 const raws=[],reads=[];
 for(let i=0;i<KEYS.length;i++){
  const startedAt=new Date().toISOString();let raw;
  try{
   const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(['GET',KEYS[i]])});
   if(!response.ok)throw Error('READ_FAILED');const data=await response.json();
   if(!object(data)||data.error||!(data.result===null||typeof data.result==='string'))throw Error('READ_FAILED');raw=data.result;
  }catch{raw=undefined;}
  raws.push(raw);reads.push({store:stores[i],order:i+1,startedAt,completedAt:new Date().toISOString(),status:raw===undefined?'READ_FAILED':'READ'});
 }
 const result=await diagnose(raws);
 for(let i=0;i<3;i++)if(raws[i]===undefined)result[['workerState','producerLedger','shadowLedger'][i]].status='UNVERIFIED';
 return res.status(200).json({...result,reads});
}
