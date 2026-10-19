import {canonicalJSON} from './source-contract.js';
import {digest} from './observation-store.js';
import {assert} from './observation-reader.js';
export const VERSION='forward-lifecycle-evidence-v1';
export const KEY='sergey-ai:forward-lifecycle:v1:evidence';
export const BUDGET=Object.freeze({maxBytes:8388608,maxGenerations:10000,maxEvidenceEvents:100000,maxProviderReceipts:50000,maxAdmissionBatches:50000,maxPayloadBytes:32768});
const CAS=`local old=redis.call('GET',KEYS[1]);if (old or '')~=ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2]);return 1`;
const initial=()=>({version:VERSION,revision:0,records:{},events:{},providers:0,batches:0,occupancy:[],decisionMinute:null});
export function createLifecycleStore(execute){
 async function read(){
  const raw=await execute(['GET',KEY]);if(raw===null)return {raw:null,state:initial()};
  assert(typeof raw==='string'&&Buffer.byteLength(raw)<=BUDGET.maxBytes,'BLOCKED_STORAGE');
  const state=JSON.parse(raw);assert(state.version===VERSION&&state.records&&state.events&&Array.isArray(state.occupancy),'F4_INTEGRITY');
  const {hash,...body}=state;assert(hash===digest(body),'F4_INTEGRITY');
  return {raw,state};
 }
 return {read,commit:async (loaded,id,event,patch={},sourceGuard=null)=>{
  const request={event,patch},requestHash=digest(request),prior=loaded.state.events[id];
  if(prior){assert(prior.requestHash===requestHash,'F4_REPLAY_CONFLICT');return {status:'IDEMPOTENT',...loaded};}
  if(Buffer.byteLength(canonicalJSON(request))>BUDGET.maxPayloadBytes)return {status:'BLOCKED_STORAGE'};
  const s=structuredClone(loaded.state);delete s.hash;
  for(const [key,r] of Object.entries(patch.records||{})){
   const old=s.records[key];assert(r.identity&&key===r.identity.shadowCandidateId,'F4_IDENTITY');
   if(old){assert(digest(old.identity)===digest(r.identity),'F4_IDENTITY_CONFLICT');
    assert(!old.decision||canonicalJSON(old.decision)===canonicalJSON(r.decision),'F4_DECISION_CONFLICT');
    if(old.closureRecorded)assert(r.closureRecorded&&digest(old.closureProof)===digest(r.closureProof)&&digest(old.outcome)===digest(r.outcome),'F4_TERMINAL_CONFLICT');
    assert(!old.outcome?.lastPriceCheckedAt||r.outcome?.lastPriceCheckedAt>=old.outcome.lastPriceCheckedAt,'F4_CURSOR_REGRESSION');}
   s.records[key]=r;
  }
  if(patch.occupancy)s.occupancy=patch.occupancy;
  if(patch.decisionMinute){assert(!s.decisionMinute||patch.decisionMinute>=s.decisionMinute,'F4_TIME_REGRESSION');s.decisionMinute=patch.decisionMinute;}
  s.events[id]={requestHash,event,patchHash:digest(patch)};s.revision++;
  if(['PROVIDER','PROVIDER_ERROR'].includes(event.kind))s.providers++;
  if(event.kind==='ADMISSION')s.batches++;
  if(Object.keys(s.records).length>BUDGET.maxGenerations||Object.keys(s.events).length>BUDGET.maxEvidenceEvents||s.providers>BUDGET.maxProviderReceipts||s.batches>BUDGET.maxAdmissionBatches)return {status:'BLOCKED_STORAGE'};
  s.hash=digest(s);const raw=canonicalJSON(s);
  if(Buffer.byteLength(raw)>BUDGET.maxBytes)return {status:'BLOCKED_STORAGE'};
  const command=sourceGuard?['EVAL',"if (redis.call('GET',KEYS[2]) or '')~=ARGV[3] then return -1 end\n"+CAS,'2',KEY,sourceGuard.key,loaded.raw||'',raw,sourceGuard.raw]:['EVAL',CAS,'1',KEY,loaded.raw||'',raw];
  const result=await execute(command);
  return result===1?{status:'OK',raw,state:s}:{status:'STALE'};
 }};
}
