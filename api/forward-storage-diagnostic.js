import {requirePrivateApi} from '../lib/private-access.js';
import {canonicalJSON} from '../lib/forward-validation/source-contract.js';
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
   if(!object(i)||i.id!==id||typeof i.frozen!=='string'||!object(i.actions)||!object(i.done)||!allowed.includes(i.status)||!object(JSON.parse(i.frozen)))throw Error('INVALID');
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
export async function diagnose(raws){
 const results=[worker(raws[0]),await producer(raws[1]),await shadow(raws[2])];
 const blocked=results.flatMap((r,i)=>r.status==='CURRENT_BUDGET_VIOLATION'?[stores[i]]:[]);
 return {workerState:results[0],producerLedger:results[1],shadowLedger:results[2],
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
