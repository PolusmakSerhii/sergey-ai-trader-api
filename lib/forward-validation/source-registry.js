import {canonicalJSON, evaluateSourceFence} from './source-contract.js';
import {SCHEMA, digest, OBSERVATION_KEY} from './observation-store.js';
import {validateCycle, iso} from './observation-reader.js';

export const VERSION='forward-source-registry-v1';
export const RUN_ID='manual-forward-worker-v1';
export const REGISTRY_KEY=`sergey-ai:forward-source-registry:v1:${RUN_ID}`;
export const BUDGET=Object.freeze({maxBytes:8388608,maxSourceCycles:10000,maxOperations:50000,maxPayloadBytes:32768,maxReceipts:50000});
const check=(v,m)=>{if(!v)throw Error(m);};
export const reservationIdentity=lease=>{check(typeof lease==='string'&&lease.length>0,'INVALID_LEASE');return digest([VERSION,RUN_ID,lease]);};
// No raw lease token is retained. Each receipt is an immutable logical transition.
export const REGISTRY_LUA=`
local raw=redis.call('GET',KEYS[1]);local op=ARGV[1];local input=ARGV[2]
if #input+#ARGV[3]>32768 then return {'BLOCKED_STORAGE'} end
local good,d=pcall(cjson.decode,input);if not good then return {'CONFLICT'} end
local s
if raw then
 if #raw>8388608 then return {'BLOCKED_STORAGE'} end
 local ok,v=pcall(cjson.decode,raw)
 if not ok or v.registryVersion~='forward-source-registry-v1' or type(v.reservations)~='table'
 or type(v.bindings)~='table' or type(v.receipts)~='number' then return {'CONFLICT'} end
 s=v
end
if op=='ACTIVATE' then
 if s then if s.activation==input then return {'IDEMPOTENT'} else return {'CONFLICT'} end end
 local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
 if tonumber(ARGV[4])<now then return {'CONFLICT','HISTORICAL_ACTIVATION'} end
 s={registryVersion='forward-source-registry-v1',activation=input,activationAt=d.activatedAt,
  reservations={},bindings={},count=0,cycles=0,receipts=1,
  coverageBarrier='UNRESOLVED_RESERVATION_GAP'}
else
 if not s then return {'NOT_STARTED'} end
 if op=='RESERVE' then
  if d.boundaryAt<s.activationAt then return {'NOT_STARTED'} end
  local old=s.reservations[d.reservationId]
  if old then if old.original==input then return {'IDEMPOTENT',d.reservationId} else return {'CONFLICT'} end end
  s.reservations[d.reservationId]={original=input,boundaryAt=d.boundaryAt,status='EXPECTED'};s.count=s.count+1
 elseif op=='BIND' then
  local row=s.reservations[d.reservationId];if not row then return {'UNRESOLVED','RESERVATION_MISSING'} end
  if row.binding then if row.binding==input then return {'IDEMPOTENT',d.reservationId} else return {'CONFLICT'} end end
  if d.provenance.generatedAt<row.boundaryAt or s.bindings[d.sourceCycleId] then return {'CONFLICT'} end
  row.binding=input;s.bindings[d.sourceCycleId]=d.reservationId;s.cycles=s.cycles+1
 elseif op=='OBSERVE' then
  local row=s.reservations[d.reservationId];if not row or not row.binding then return {'UNRESOLVED','BINDING_MISSING'} end
  local b=cjson.decode(row.binding)
  if b.sourceCycleId~=d.sourceCycleId or b.envelopeHash~=d.envelopeHash then return {'CONFLICT'} end
  local stored=redis.call('GET',KEYS[2]);if not stored then return {'UNRESOLVED','F2_MISSING'} end
  local ok,l=pcall(cjson.decode,stored)
  if not ok or l.schemaVersion~='forward-observation-ledger-v1' or type(l.cycles)~='table' then return {'CONFLICT'} end
  local actual=l.cycles[d.sourceCycleId]
  if not actual then return {'UNRESOLVED','F2_MISSING'} end
  if actual~=ARGV[3] then return {'CONFLICT'} end
  local valid,e=pcall(cjson.decode,actual)
  if not valid or e.observationPersistenceStatus~='COMPLETE' or e.sourceCycleId~=d.sourceCycleId
   or e.expectedObservationCount~=#e.observations or e.persistedObservationCount~=#e.observations then return {'CONFLICT'} end
  if row.observedReceipt then if row.observedReceipt==input then return {'IDEMPOTENT',d.reservationId} else return {'CONFLICT'} end end
  row.status='OBSERVED';row.observedReceipt=input
 else return {'CONFLICT'} end
 s.receipts=s.receipts+1
end
if s.count>50000 or s.cycles>10000 or s.receipts>50000 then return {'BLOCKED_STORAGE'} end
local encoded=cjson.encode(s)
if #encoded>8388608 then return {'BLOCKED_STORAGE'} end
redis.call('SET',KEYS[1],encoded)
return {op=='OBSERVE' and 'OBSERVED' or op=='RESERVE' and 'EXPECTED' or op=='BIND' and 'BOUND' or 'ACTIVATED',d.reservationId or ''}
`;
export function createSourceRegistry(execute){
 const send=async(op,data,raw='',activationMillis='')=>{
  try{
   const reply=await execute(['EVAL',REGISTRY_LUA,'2',REGISTRY_KEY,OBSERVATION_KEY,op,canonicalJSON(data),raw,String(activationMillis)]);
   if(!Array.isArray(reply)||!['NOT_STARTED','EXPECTED','BOUND','OBSERVED','ACTIVATED','IDEMPOTENT','CONFLICT','UNRESOLVED','BLOCKED_STORAGE'].includes(reply[0]))return {status:'UNRESOLVED',reason:'INVALID_RECEIPT'};
   const successes={RESERVE:['EXPECTED','IDEMPOTENT'],BIND:['BOUND','IDEMPOTENT'],OBSERVE:['OBSERVED','IDEMPOTENT'],ACTIVATE:['ACTIVATED','IDEMPOTENT']};
   if(['EXPECTED','BOUND','OBSERVED','ACTIVATED','IDEMPOTENT'].includes(reply[0])&&
    (!successes[op].includes(reply[0])||(op!=='ACTIVATE'&&reply[1]!==data.reservationId)))return {status:'UNRESOLVED',reason:'RECEIPT_MISMATCH'};
   return {status:reply[0]};
  }catch{return {status:'UNRESOLVED',reason:'TRANSPORT_UNKNOWN'};}
 };
 return {
  // Explicit operator primitive only; never called by scanner. Future boundary is
  // required by Redis TIME on first creation; exact replay does not reactivate.
  activate:async meta=>{
   try{check(meta.registryVersion===VERSION&&meta.runId===RUN_ID&&meta.protocolVersion==='1.1'&&iso(meta.activatedAt)&&
    meta.activationSourceBoundary===meta.activatedAt,'INVALID_ACTIVATION');return send('ACTIVATE',meta,'',Date.parse(meta.activatedAt));}
   catch{return {status:'CONFLICT'};}
  },
  reserve:async(lease,boundaryAt)=>{
   try{check(iso(boundaryAt),'INVALID_BOUNDARY');const reservationId=reservationIdentity(lease);
    return {...await send('RESERVE',{reservationId,boundaryAt}),reservationId};}catch{return {status:'UNRESOLVED'};}
  },
  bind:async(reservation,snapshot,prepared)=>{
   if(!['EXPECTED','IDEMPOTENT'].includes(reservation?.status))return {status:reservation?.status??'UNRESOLVED'};
   try{
    const provenance={source:'global-ranking-snapshot',version:snapshot.version,mode:snapshot.mode,generatedAt:snapshot.generatedAt};
    check(iso(provenance.generatedAt)&&provenance.mode==='global-ranking','INVALID_SNAPSHOT');
    const sourceCycleId=digest([SCHEMA,provenance]);let envelopeHash=null;
    if(prepared?.status==='PREPARED'){const c=validateCycle(prepared.raw,sourceCycleId);envelopeHash=c.hash;}
    const binding={reservationId:reservation.reservationId,sourceCycleId,provenance,snapshotHash:digest(JSON.parse(JSON.stringify(snapshot))),envelopeHash};
    return {...await send('BIND',binding),...binding};
   }catch{return {status:'CONFLICT'};}
  },
  observe:async(binding,prepared,receipt)=>{
   if(!['BOUND','IDEMPOTENT'].includes(binding?.status))return {status:binding?.status??'UNRESOLVED'};
   if(!['COMPLETE','IDEMPOTENT'].includes(receipt?.status))return {status:receipt?.status==='CONFLICT'?'CONFLICT':receipt?.status==='BLOCKED_STORAGE'?'BLOCKED_STORAGE':'UNRESOLVED'};
   try{const c=validateCycle(prepared.raw,binding.sourceCycleId);check(c.hash===binding.envelopeHash&&receipt.sourceCycleId===binding.sourceCycleId,'F2_CONFLICT');
    return send('OBSERVE',{reservationId:binding.reservationId,sourceCycleId:binding.sourceCycleId,envelopeHash:binding.envelopeHash},c.raw);
   }catch{return {status:'CONFLICT'};}
  },
  read:async()=>{const raw=await execute(['GET',REGISTRY_KEY]);if(raw===null)return null;check(typeof raw==='string'&&Buffer.byteLength(raw)<=BUDGET.maxBytes,'INVALID_REGISTRY');return JSON.parse(raw);}
 };
}
export function deriveRegistryFrontier(state,minute){
 if(!state)return {status:'NOT_STARTED',sourceCompleteness:'UNPROVEN',sourceFence:{minute,closed:false,blockers:[{kind:'SOURCE',code:'REGISTRY_NOT_STARTED'}]}};
 check(state.registryVersion===VERSION&&state.coverageBarrier==='UNRESOLVED_RESERVATION_GAP','INVALID_REGISTRY');
 const ordered=Object.entries(state.reservations).map(([reservationId,r])=>({reservationId,boundaryAt:r.boundaryAt,status:r.status,
  sourceCycleId:r.binding?JSON.parse(r.binding).sourceCycleId:null})).sort((a,b)=>a.boundaryAt<b.boundaryAt?-1:a.boundaryAt>b.boundaryAt?1:a.reservationId<b.reservationId?-1:1);
 const unresolved=ordered.filter(r=>r.status!=='OBSERVED');let observedFrontier=null;
 for(const r of ordered){if(r.status!=='OBSERVED')break;observedFrontier=r;}
 // A failed write before Redis commits can leave NO per-attempt row. Consequently
 // even an all-OBSERVED registry cannot prove absence of missing reservations.
 // The activation-level barrier is durable from inception, never self-clears, and
 // conservatively covers the whole run. It is NOT a claim that a gap was observed.
 // Independent verified gap/frontier resolution is explicitly outside F4-A v1.
 const sourceFence=evaluateSourceFence({minute,operations:[],sealedCycles:[],registryProof:null});
 sourceFence.blockers.push({kind:'SOURCE',code:'UNRESOLVED_RESERVATION_GAP'});
 return {status:'UNRESOLVED',sourceCompleteness:'UNPROVEN',ordered,unresolved,observedFrontier,
  sealedFrontier:null,futureSourceTimeLowerBound:null,barrierFrom:state.activationAt,sourceFence};
}
