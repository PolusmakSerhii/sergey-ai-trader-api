import {canonicalJSON,cycleIdentity,universeDigest,createCycle,evaluateSourceFence} from './source-contract.js';
import {SCHEMA,digest,OBSERVATION_KEY} from './observation-store.js';
import {validateCycle,iso} from './observation-reader.js';
import {createSourceRegistry,REGISTRY_KEY,VERSION as REGISTRY_VERSION,RUN_ID,BUDGET,reservationIdentity} from './source-registry.js';
export const VERSION='forward-source-epoch-v1';
const check=(v,m)=>{if(!v)throw Error(m);};
const equal=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const good=r=>['EXPECTED','IDEMPOTENT'].includes(r?.status);
// Optimistic reads followed by ONE atomic transition. No CAS retries. Concurrent
// gate/seal calls cannot both commit against the same registry version.
const CAS=`
local current=redis.call('GET',KEYS[1]);if current~=ARGV[1] then return 0 end
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
if ARGV[3]~='' and tonumber(ARGV[3])<now then return -1 end
if ARGV[4]~='' then
 local f=redis.call('GET',KEYS[2]);if not f then return -2 end
 local ok,l=pcall(cjson.decode,f);if not ok or not l.cycles or l.cycles[ARGV[4]]~=ARGV[5] then return -2 end
end
redis.call('SET',KEYS[1],ARGV[2]);return 1
`;
function validateState(s){
 check(s?.registryVersion===REGISTRY_VERSION&&s.coverageBarrier==='UNRESOLVED_RESERVATION_GAP','INVALID_REGISTRY');
 check(Number.isSafeInteger(s.receipts)&&Number.isSafeInteger(s.count)&&Number.isSafeInteger(s.cycles),'INVALID_REGISTRY');
 if(s.epoch){const e=s.epoch;check(e.activation.epochVersion===VERSION&&e.activation.runId===RUN_ID&&Array.isArray(e.seals),'INVALID_EPOCH');}
}
export function createSourceEpoch(execute){
 const legacy=createSourceRegistry(execute);
 async function load(){const raw=await execute(['GET',REGISTRY_KEY]);if(raw===null)return {raw,s:null};check(typeof raw==='string'&&Buffer.byteLength(raw)<=BUDGET.maxBytes,'INVALID_REGISTRY');const s=JSON.parse(raw);validateState(s);return {raw,s};}
 const safe=fn=>async(...args)=>{try{return await fn(...args);}catch(e){return {status:'UNRESOLVED',reason:e.message==='CONFLICT'?'CONFLICT':'UNPROVEN'};}};
 async function commit(old,s,payload,{future='',cycle='',bytes=''}={}){
  if(Buffer.byteLength(canonicalJSON(payload))+Buffer.byteLength(bytes)>BUDGET.maxPayloadBytes)return {status:'BLOCKED_STORAGE'};
  s.receipts++;const encoded=canonicalJSON(s);
  if(Buffer.byteLength(encoded)>BUDGET.maxBytes||s.receipts>BUDGET.maxReceipts||s.count>BUDGET.maxOperations||s.cycles>BUDGET.maxSourceCycles)return {status:'BLOCKED_STORAGE'};
  const n=await execute(['EVAL',CAS,'2',REGISTRY_KEY,OBSERVATION_KEY,old,encoded,String(future),cycle,bytes]);
  return {status:n===1?'OK':n===0?'UNRESOLVED':n===-1?'CONFLICT':'UNRESOLVED'};
 }
 function member(s,id){const m=s.reservations[id];check(s.epoch&&m?.epochId===s.epoch.activation.epochId,'CONFLICT');return m;}
 async function conflict(old,s,m){
  m.epochConflict=true;
  const result=await commit(old,s,{conflict:true});
  return {status:result.status==='OK'?'CONFLICT':result.status};
 }
 const api={
  activate:safe(async activation=>{
   const {raw,s}=await load();check(s,'REGISTRY_NOT_STARTED');
   check(activation.epochVersion===VERSION&&activation.runId===RUN_ID&&/^[A-Za-z0-9_-]{1,60}$/.test(activation.epochId)&&activation.protocolVersion==='1.1'&&activation.registryVersion===REGISTRY_VERSION&&activation.status==='ACTIVE'&&iso(activation.activatedAt)&&activation.sourceLowerBound===activation.activatedAt&&activation.activatedAt>=s.activationAt,'CONFLICT');
   if(s.epoch)return {status:equal(s.epoch.activation,activation)?'IDEMPOTENT':'CONFLICT'};
   s.epoch={activation,sequence:0,sealedThrough:null,seals:[]};
   const reply=await commit(raw,s,activation,{future:Date.parse(activation.activatedAt)});return {status:reply.status==='OK'?'ACTIVATED':reply.status};
  }),
  register:safe(async(lease,attemptStartedAt,boundaryAt)=>{
   const {raw,s}=await load();if(!s?.epoch)return {status:'NOT_STARTED'};
   const e=s.epoch,id=reservationIdentity(lease);
   check(iso(attemptStartedAt)&&iso(boundaryAt)&&attemptStartedAt<=boundaryAt,'CONFLICT');
   const original={reservationId:id,epochId:e.activation.epochId,attemptStartedAt,boundaryAt,sourceLowerBound:attemptStartedAt};
   const prior=s.reservations[id];
   if(prior)return {status:!prior.epochConflict&&prior.epochId===original.epochId&&equal(JSON.parse(prior.original),original)?'IDEMPOTENT':'CONFLICT',reservationId:id,epochId:original.epochId};
   if(attemptStartedAt<=e.activation.activatedAt||attemptStartedAt<e.activation.sourceLowerBound||(e.sealedThrough&&attemptStartedAt<=e.sealedThrough))return {status:'REJECTED'};
   e.sequence++;s.count++;s.reservations[id]={original:canonicalJSON(original),epochId:original.epochId,sequence:e.sequence,boundaryAt,sourceLowerBound:attemptStartedAt,status:'EXPECTED'};
   const result=await commit(raw,s,original);return {status:result.status==='OK'?'EXPECTED':result.status,reservationId:id,epochId:original.epochId};
  }),
  recover:safe(async(lease,attemptStartedAt,boundaryAt)=>{
   const {s}=await load();if(!s?.epoch)return {status:'NOT_STARTED'};const id=reservationIdentity(lease),m=s.reservations[id];
   const expected={reservationId:id,epochId:s.epoch.activation.epochId,attemptStartedAt,boundaryAt,sourceLowerBound:attemptStartedAt};
   return {status:m&&equal(JSON.parse(m.original),expected)&&!m.epochConflict?'IDEMPOTENT':'UNRESOLVED',reservationId:id,epochId:expected.epochId};
  }),
  bind:safe(async(reg,snapshot,prepared)=>{
   if(!reg?.epochId)return legacy.bind(reg,snapshot,prepared);
   if(!good(reg))return {status:'UNRESOLVED'};
   const {raw,s}=await load(),m=member(s,reg.reservationId);
   const provenance={source:'global-ranking-snapshot',version:snapshot.version,mode:snapshot.mode,generatedAt:snapshot.generatedAt};
   const sourceCycleId=digest([SCHEMA,provenance]);
   // The bound is a source-attempt time, NOT a fabricated market/analysis time.
   // Reject older declared source facts rather than relabelling them as current.
   const declared=(snapshot.globalRanking||[]).flatMap(x=>[x.analysisContext?.analysisAt,x.origin?.detectedAt,x.initialPlan?.createdAt]).filter(x=>x!=null);
   if(!iso(snapshot.generatedAt)||snapshot.generatedAt<m.boundaryAt||declared.some(t=>!iso(t)||t<m.sourceLowerBound))return conflict(raw,s,m);
   const c=prepared?.status==='PREPARED'?validateCycle(prepared.raw,sourceCycleId):null;
   const b={reservationId:reg.reservationId,sourceCycleId,provenance,snapshotHash:digest(JSON.parse(JSON.stringify(snapshot))),envelopeHash:c?.hash??null};
   if(m.epochConflict)return {status:'CONFLICT'};
   if(m.binding)return equal(JSON.parse(m.binding),b)?{status:'IDEMPOTENT',...b,epochId:reg.epochId}:conflict(raw,s,m);
   if(s.bindings[sourceCycleId])return conflict(raw,s,m);
   m.binding=canonicalJSON(b);s.bindings[sourceCycleId]=reg.reservationId;s.cycles++;
   const result=await commit(raw,s,b);return {status:result.status==='OK'?'BOUND':result.status,...b,epochId:reg.epochId};
  }),
  observe:safe(async(b,prepared,receipt)=>{
   if(!b?.epochId)return legacy.observe(b,prepared,receipt);
   if(!['BOUND','IDEMPOTENT'].includes(b.status)||!['COMPLETE','IDEMPOTENT'].includes(receipt?.status))return {status:'UNRESOLVED'};
   const {raw,s}=await load(),m=member(s,b.reservationId),bound=JSON.parse(m.binding);
   const c=validateCycle(prepared.raw,b.sourceCycleId);
   if(c.hash!==bound.envelopeHash||receipt.sourceCycleId!==bound.sourceCycleId||m.epochConflict)return conflict(raw,s,m);
   if(m.status==='OBSERVED')return {status:'IDEMPOTENT'};
   // Source proof concerns persisted canonical OBSERVATIONS, not generation,
   // lifecycle or admission. Source payload retains original analysis timestamps.
   const f2=JSON.parse(await execute(['GET',OBSERVATION_KEY]));
   check(f2.schemaVersion==='forward-observation-ledger-v1'&&f2.cycles?.[b.sourceCycleId]===c.raw&&Number.isSafeInteger(f2.count)&&f2.count>0,'CONFLICT');
   const clock=await execute(['TIME']);const completedAt=new Date(Number(clock[0])*1000+Math.floor(Number(clock[1])/1000)).toISOString();
   const runId=s.epoch.activation.epochId,cycleId=cycleIdentity(runId,m.sequence),at=c.envelope.observedAt;
   check(completedAt>=at,'CONFLICT');
   // F2 is append-only, one cycle per append: count is its logical persisted
   // revision at this verified read, not a fabricated Shadow ledger revision.
   const operations=c.envelope.observations.map(o=>({operationId:o.observationId,cycleId,sourceTimeLowerBound:m.sourceLowerBound,
    registeredAt:m.boundaryAt,processingStartedAt:m.boundaryAt,status:'COMPLETED',operationCompletedAt:completedAt,evidenceAt:at,payloadHash:o.payloadHash}));
   const symbols=c.envelope.observations.map(o=>o.payload.symbol);check(new Set(symbols).size===symbols.length,'CONFLICT');
   let manifest=null;
   if(symbols.length)manifest=createCycle({runId,producerSequence:m.sequence,cycleId,cycleStartedAt:m.boundaryAt,sourceTimeLowerBound:m.sourceLowerBound,universeId:bound.sourceCycleId,
    universeHash:universeDigest(symbols),expectedSymbols:symbols,batchCount:1,batches:[{batchId:cycleId,batchIndex:0,expectedBatchSymbols:symbols}],operations,
    results:c.envelope.observations.map(o=>({symbol:o.payload.symbol,instrumentType:o.payload.instrumentType,batchId:cycleId,operationId:o.observationId,
     status:'ANALYZED_A_PLUS_CAPTURED',analysisAt:at,payloadHash:o.payloadHash,capturedIdentityRefs:[o.observationId],captureAcks:[{operationId:o.observationId,identityRef:o.observationId,payloadHash:o.payloadHash,ledgerRevision:f2.count}]}))});
   m.sourceProof={operations,manifest};m.status='OBSERVED';m.observedReceipt=canonicalJSON({sourceCycleId:bound.sourceCycleId,envelopeHash:c.hash});
   const result=await commit(raw,s,m.sourceProof,{cycle:bound.sourceCycleId,bytes:c.raw});return {status:result.status==='OK'?'OBSERVED':result.status};
  }),
  seal:safe(async T=>{
   const {raw,s}=await load();if(!s?.epoch)return {status:'NOT_STARTED'};const e=s.epoch;
   check(iso(T)&&Date.parse(T)%60000===0&&T>=e.activation.sourceLowerBound,'CONFLICT');
   if(e.sealedThrough&&T<e.sealedThrough)return {status:'CONFLICT'};
   if(e.seals.includes(T))return {status:'IDEMPOTENT'};
   const members=Object.values(s.reservations).filter(m=>m.epochId===e.activation.epochId&&m.sourceLowerBound<=T);
   if(members.some(m=>m.status!=='OBSERVED'||m.epochConflict||!m.sourceProof))return {status:'UNRESOLVED'};
   e.sealedThrough=T;e.seals.push(T);const result=await commit(raw,s,{seal:T});return {status:result.status==='OK'?'SEALED':result.status};
  }),
  read:safe(async()=>{const {s}=await load();return s;}),
  reserve:safe(async(lease,boundaryAt,attemptStartedAt)=>{
   const {s}=await load();return s?.epoch?api.register(lease,attemptStartedAt,boundaryAt):legacy.reserve(lease,boundaryAt);
  })
 };
 return api;
}
export function deriveEpochProof(s,T){
 const e=s?.epoch;
 if(!e||!iso(T)||T<e.activation.sourceLowerBound||!e.sealedThrough||T>e.sealedThrough)return {status:'UNRESOLVED',sourceFence:{minute:T,closed:false,blockers:[{kind:'SOURCE',code:'EPOCH_BOUNDARY_UNPROVEN'}]}};
 const members=Object.values(s.reservations).filter(m=>m.epochId===e.activation.epochId&&m.sourceLowerBound<=T);
 if(members.some(m=>m.status!=='OBSERVED'||m.epochConflict||!m.sourceProof))return {status:'UNRESOLVED',sourceFence:{minute:T,closed:false,blockers:[{kind:'SOURCE',code:'EPOCH_MEMBER_UNRESOLVED'}]}};
 const operations=members.flatMap(m=>m.sourceProof.operations),sealedCycles=members.flatMap(m=>m.sourceProof.manifest?[m.sourceProof.manifest]:[]);
 const registryProof={complete:true,throughMinute:e.sealedThrough,futureSourceTimeLowerBound:new Date(Date.parse(e.sealedThrough)+1).toISOString(),operationIds:operations.map(o=>o.operationId)};
 const sourceFence=evaluateSourceFence({minute:T,operations,sealedCycles,registryProof});
 return {status:sourceFence.closed?'CLOSED':'UNRESOLVED',proofDomain:'CONSTRUCTIVE_EPOCH_MEMBERS_ONLY',epochId:e.activation.epochId,sourceLowerBound:e.activation.sourceLowerBound,registryProof,operations,sealedCycles,sourceFence};
}
