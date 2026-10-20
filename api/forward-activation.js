import {requirePrivateApi} from '../lib/private-access.js';
import {createSourceRegistry,VERSION as REGISTRY_VERSION,RUN_ID} from '../lib/forward-validation/source-registry.js';
import {createSourceEpoch,VERSION as EPOCH_VERSION} from '../lib/forward-validation/source-epoch.js';
import {canonicalJSON} from '../lib/forward-validation/source-contract.js';
import {iso} from '../lib/forward-validation/observation-reader.js';

const EPOCH_ID='sm1m-shadow-forward-v1';
// Five bounded 5s transport operations precede the epoch write after TIME;
// allow 5s additional margin. Redis checks remain authoritative if delayed.
const FUTURE_MS=30000;
const registryMeta=at=>({registryVersion:REGISTRY_VERSION,runId:RUN_ID,protocolVersion:'1.1',activatedAt:at,activationSourceBoundary:at});
const epochMeta=at=>({epochVersion:EPOCH_VERSION,registryVersion:REGISTRY_VERSION,runId:RUN_ID,protocolVersion:'1.1',epochId:EPOCH_ID,status:'ACTIVE',activatedAt:at,sourceLowerBound:at});
const equal=(a,b)=>canonicalJSON(a)===canonicalJSON(b);

export async function activateShadow(execute){
 const registry=createSourceRegistry(execute),epoch=createSourceEpoch(execute);
 let confirmed=null;
 const result=(status,reasonCode)=>({status,registryStatus:confirmed?'CONFIRMED':'UNCONFIRMED',epochStatus:confirmed?.epoch?'CONFIRMED':'UNCONFIRMED',
  ...(confirmed?{registryActivatedAt:confirmed.activationAt}:{}),
  ...(confirmed?.epoch?{epochId:EPOCH_ID,activatedAt:confirmed.epoch.activation.activatedAt,sourceLowerBound:confirmed.epoch.activation.sourceLowerBound}:{}),
  ...(reasonCode?{reasonCode}:{})});
 async function readback(){
  const r=await registry.read(),e=await epoch.read();
  if(e?.status==='UNRESOLVED')throw Error('READBACK_UNAVAILABLE');
  if(r===null&&e===null){confirmed=null;return null;}
  if(!r||!e)throw Error('READBACK_CHANGED');
  const m=JSON.parse(r.activation);
  if(!iso(r.activationAt)||!equal(m,registryMeta(r.activationAt))||!equal(r.activation,e.activation)||r.activationAt!==e.activationAt)throw Error('ACTIVATION_CONFLICT');
  // Concurrent scanner reservations may differ, but immutable activation must agree.
  if(r.epoch&&!equal(r.epoch.activation,e.epoch?.activation))throw Error('READBACK_CHANGED');
  if(e.epoch&&(!iso(e.epoch.activation?.activatedAt)||e.epoch.activation.activatedAt<e.activationAt||!equal(e.epoch.activation,epochMeta(e.epoch.activation.activatedAt))))throw Error('ACTIVATION_CONFLICT');
  confirmed=e;return e;
 }
 async function redisNow(){
  const t=await execute(['TIME']);
  if(!Array.isArray(t)||t.length!==2||!/^\d+$/.test(String(t[0]))||!/^\d+$/.test(String(t[1])))throw Error('CLOCK_UNAVAILABLE');
  const sec=Number(t[0]),micro=Number(t[1]),ms=sec*1000+Math.floor(micro/1000);
  if(!Number.isSafeInteger(ms)||micro>=1000000||!Number.isFinite(new Date(ms+FUTURE_MS).getTime()))throw Error('CLOCK_UNAVAILABLE');
  return ms;
 }
 try{
  let state=await readback();
  if(state?.epoch)return result('ALREADY_ACTIVE');
  const now=await redisNow();
  const boundary=state?.activationAt??new Date(now+FUTURE_MS).toISOString();
  if(Date.parse(boundary)<=now)return result('PARTIAL','BOUNDARY_ELAPSED');
  if(!state){
   const receipt=await registry.activate(registryMeta(boundary));
   state=await readback(); // Also resolves a lost acknowledgement; never blindly retry.
   if(!state)return result(receipt.status==='BLOCKED_STORAGE'?'BLOCKED_STORAGE':'UNRESOLVED','REGISTRY_NOT_CONFIRMED');
   if(state.activationAt!==boundary)return result('CONFLICT','CONCURRENT_ACTIVATION');
   if(state.epoch)return result('ALREADY_ACTIVE');
   if(!['ACTIVATED','IDEMPOTENT','UNRESOLVED'].includes(receipt.status))return result('PARTIAL','REGISTRY_RECEIPT_CONFLICT');
  }
  const receipt=await epoch.activate(epochMeta(boundary));
  state=await readback();
  if(state?.epoch)return state.epoch.activation.activatedAt===boundary?result('ACTIVATED'):result('CONFLICT','CONCURRENT_ACTIVATION');
  return result('PARTIAL',receipt.status==='BLOCKED_STORAGE'?'BLOCKED_STORAGE':receipt.status==='CONFLICT'?'EPOCH_CONFLICT':'EPOCH_NOT_CONFIRMED');
 }catch(e){
  // Only fixed reason codes; no exception, transport or stored payload is exposed.
  const reason=['ACTIVATION_CONFLICT','READBACK_CHANGED','CLOCK_UNAVAILABLE'].includes(e.message)?e.message:'READBACK_UNAVAILABLE';
  return result(reason==='ACTIVATION_CONFLICT'?'CONFLICT':confirmed?'PARTIAL':'UNRESOLVED',reason);
 }
}

export default async function handler(req,res){
 if(!requirePrivateApi(req,res))return;
 if(req.method!=='POST')return res.status(405).json({status:'REJECTED',reasonCode:'POST_REQUIRED'});
 const url=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
 const token=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
 if(!url||!token)return res.status(503).json({status:'UNRESOLVED',reasonCode:'STORAGE_UNAVAILABLE'});
 const execute=async command=>{
  const r=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command)});
  if(!r.ok)throw Error('REDIS_TRANSPORT');const p=await r.json();if(p.error)throw Error('REDIS_COMMAND');return p.result;
 };
 const output=await activateShadow(execute);
 return res.status(['ACTIVATED','ALREADY_ACTIVE'].includes(output.status)?200:503).json(output);
}
