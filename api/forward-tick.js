import {storageHealth,logStorageHealth} from '../lib/forward-validation/storage-health.js';
import {randomUUID} from 'node:crypto';
import {runWorker} from '../lib/forward-validation/worker.js';
import {runLifecycle} from '../lib/forward-validation/lifecycle-worker.js';

export const config={api:{bodyParser:false}};
export const DESTINATION='https://sergey-ai-trader-api.vercel.app/api/forward-tick';
export const SIGNED_BODY='{}';
const LOCK_KEY='sergey-ai:forward-tick:v1:lock';
// Operational lock only, not evidence retention. Longer than Vercel's hard limit.
const LOCK_MS=130000,DEADLINE_MS=110000;
const RELEASE="if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const statuses=new Set(['COMPLETE','IDLE','BUSY','BLOCKED_MAPPING','BLOCKED_STORAGE','UNRESOLVED','CONFLICT','FENCED','STALE','NOT_STARTED']);
const safeStatus=x=>statuses.has(x?.status)?x.status:'UNRESOLVED';
// Explicit internal codes only: never serialize arbitrary worker error details.
const workerReasons=new Set(['LATE_SOURCE_CYCLE','OBSERVATION_LIMIT_EXCEEDED','MULTIPLE_DIRECTIONS_PER_SYMBOL',
 'NON_SWAP','MISSING_DETECTED_AT','MISSING_CREATED_AT','MISSING_ANALYSIS_AT','MISSING_FROZEN_PLAN',
 'MISSING_PLAN_BOUNDARIES','MISSING_EXIT_POLICY','ORIGINAL_IDENTITY_CONFLICT','MISSING_ORIGINAL_ELIGIBILITY',
 'GEOMETRY_CONFLICT','INVALID_GEOMETRY','INVALID_EXPIRY','SOURCE_TIME_CONFLICT',
 'DEADLINE','SOURCE_HASH_CONFLICT','PENDING_SOURCE_MISSING','PROCESSING_INCOMPLETE']);
function workerDiagnostics(result){
 const codes=[...(Array.isArray(result?.reasonCodes)?result.reasonCodes:[]),result?.reasonCode];
 return {workerReasonCodes:[...new Set(codes.filter(code=>workerReasons.has(code)))],
  // Current worker does not expose a cycle identity; do not infer it or read F2 again.
  workerSourceCycleHash:null};
}

export async function runTick({execute,worker=runWorker,lifecycle=runLifecycle,loadLifecycle=async()=>{
 const {default:market}=await import('./market.js');return market.forwardLifecycle;
},now=Date.now,owner=randomUUID()}={}){
 const started=now();let releaseNeeded=false,output;
 let storage=storageHealth(null),workerLog;
 const io=async command=>{if(now()-started>DEADLINE_MS-5000)throw Error('TICK_DEADLINE');return execute(command);};
 try{
  releaseNeeded=true;
  const lock=await io(['SET',LOCK_KEY,owner,'NX','PX',String(LOCK_MS)]);
  if(lock===null){releaseNeeded=false;output={status:'BUSY',phase:'LOCK'};}
  else if(lock!=='OK'){output={status:'UNRESOLVED',phase:'LOCK',reasonCode:'LOCK_UNCONFIRMED'};}
  else {
   output={status:'UNRESOLVED',phase:'WORKER'};
   const result=await worker({execute:io,onStorage:metrics=>{storage=storageHealth(metrics,metrics?.blocked===true);}});
   const w=safeStatus(result),diagnostics=workerDiagnostics(result);
   output={status:w,phase:'WORKER',workerStatus:w,...diagnostics};
   if(!['COMPLETE','IDLE'].includes(w))workerLog={status:w,reasonCodes:diagnostics.workerReasonCodes,sourceCycleHash:diagnostics.workerSourceCycleHash};
   if(['COMPLETE','IDLE'].includes(w)){
    // Leave a full lifecycle budget plus release/response margin.
    if(now()-started>60000)output={...output,status:'UNRESOLVED',reasonCode:'TICK_DEADLINE'};
    else {
     output={...output,phase:'LIFECYCLE'};
     const adapter=await loadLifecycle();
     if(now()-started>60000)output={...output,status:'UNRESOLVED',reasonCode:'TICK_DEADLINE'};
     else {const l=safeStatus(await lifecycle({execute:io,lifecycle:adapter}));output={...output,status:l,phase:'LIFECYCLE',workerStatus:w,lifecycleStatus:l};}
    }
   }
  }
 }catch{output={...output,status:'UNRESOLVED',phase:output?.phase||'LOCK',reasonCode:'TICK_INCOMPLETE'};}
 finally{
  // Also resolve an unknown acquire acknowledgement by a token-safe release.
  // No retry, no release of another owner's lock; transport is bounded to 5s.
  if(releaseNeeded)try{
   if(await execute(['EVAL',RELEASE,'1',LOCK_KEY,owner])!==1)output={...output,status:'UNRESOLVED',reasonCode:'LOCK_RELEASE_UNCONFIRMED'};
  }catch{output={...output,status:'UNRESOLVED',reasonCode:'LOCK_RELEASE_UNCONFIRMED'};}
 }
 // Logging must never change processing or HTTP results.
 if(workerLog)try{console.info('[forward-worker-result]',JSON.stringify(workerLog));}catch{}
 logStorageHealth(storage);
 return {...output,storage};
}

async function fixedBody(req){
 let body=Buffer.alloc(0);
 for await(const part of req){body=Buffer.concat([body,Buffer.isBuffer(part)?part:Buffer.from(part)]);if(body.length>2)return false;}
 return body.toString('utf8')===SIGNED_BODY;
}
export function createHandler({receiverClass=async()=>{const {Receiver}=await import('@upstash/qstash');return Receiver;},tick=runTick}={}){
 return async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({status:'REJECTED',reasonCode:'POST_REQUIRED'});
  if(req.url!=='/api/forward-tick')return res.status(403).json({status:'REJECTED',reasonCode:'DESTINATION_MISMATCH'});
  const currentSigningKey=process.env.QSTASH_CURRENT_SIGNING_KEY,nextSigningKey=process.env.QSTASH_NEXT_SIGNING_KEY;
  if(!currentSigningKey||!nextSigningKey)return res.status(503).json({status:'UNRESOLVED',reasonCode:'AUTH_UNAVAILABLE'});
  const signature=req.headers?.['upstash-signature'];
  if(typeof signature!=='string'||signature.length>8192)return res.status(401).json({status:'REJECTED',reasonCode:'INVALID_SIGNATURE'});
  try{
   if(!await fixedBody(req))return res.status(400).json({status:'REJECTED',reasonCode:'INVALID_BODY'});
   const Receiver=await receiverClass();
   if(!await new Receiver({currentSigningKey,nextSigningKey}).verify({signature,body:SIGNED_BODY,url:DESTINATION}))throw Error('SIGNATURE');
  }catch{return res.status(401).json({status:'REJECTED',reasonCode:'INVALID_SIGNATURE'});}
  const url=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
  const token=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
  if(!url||!token)return res.status(503).json({status:'UNRESOLVED',reasonCode:'STORAGE_UNAVAILABLE'});
  const execute=async command=>{
   const r=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command)});
   if(!r.ok)throw Error('REDIS_TRANSPORT');const p=await r.json();if(p.error)throw Error('REDIS_COMMAND');return p.result;
  };
  let result;try{result=await tick({execute});}catch{result={status:'UNRESOLVED',reasonCode:'TICK_INCOMPLETE'};}
  return res.status(['COMPLETE','IDLE','BUSY'].includes(result.status)?200:503).json(result);
 };
}
export default createHandler();
