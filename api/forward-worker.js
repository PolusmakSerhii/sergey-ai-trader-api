import {requirePrivateApi} from '../lib/private-access.js';
import {runWorker} from '../lib/forward-validation/worker.js';
export default async function handler(req,res){
 if(!requirePrivateApi(req,res))return;
 if(req.method!=='POST')return res.status(405).json({ok:false,error:'POST required'});
 const url=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
 const token=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
 if(!url||!token)return res.status(503).json({ok:false,status:'UNRESOLVED',reasonCode:'STORAGE_UNAVAILABLE'});
 const execute=async command=>{
  const response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command),redirect:'error'});
  if(!response.ok)throw Error('REDIS_TRANSPORT');const payload=await response.json();if(payload.error)throw Error('REDIS_COMMAND');return payload.result;
 };
 const result=await runWorker({execute});
 return res.status(['COMPLETE','IDLE','BLOCKED_MAPPING','BUSY'].includes(result.status)?200:503).json(result);
}
