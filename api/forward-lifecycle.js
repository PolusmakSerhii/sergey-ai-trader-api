import {requirePrivateApi} from '../lib/private-access.js';
import {runLifecycle} from '../lib/forward-validation/lifecycle-worker.js';
export default async function handler(req,res){
 if(!requirePrivateApi(req,res))return;
 if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST required'});
 const url=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
 const token=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
 if(!url||!token)return res.status(503).json({status:'UNRESOLVED',reasonCode:'STORAGE_UNAVAILABLE'});
 const execute=async command=>{
  const r=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command)});
  if(!r.ok)throw Error('REDIS_TRANSPORT');const p=await r.json();if(p.error)throw Error('REDIS_COMMAND');return p.result;
 };
 const {default:market}=await import('./market.js');
 const result=await runLifecycle({execute,lifecycle:market.forwardLifecycle});
 return res.status(['COMPLETE','IDLE','BUSY','NOT_STARTED'].includes(result.status)?200:503).json(result);
}
