import {canonicalJSON} from './source-contract.js';
import {MAPPING} from './delayed-ingestion.js';
import {assert} from './observation-reader.js';
export const WORKER_KEY='sergey-ai:forward-worker:v1:state';
export const LEASE_MS=60000,WORKER_MS=45000,COMMAND_MS=5000;
export const STATE_LIMITS=Object.freeze({maxBytes:4194304,maxCycleReceipts:10000,maxPendingIntents:100,maxPayloadBytes:32768});
export const CONTROL=`
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local raw=redis.call('GET',KEYS[1])
local s={schemaVersion='forward-worker-state-v1',mappingVersion='forward-worker-mapping-v1',fence=0,owner='',expiresAt=0,intents={}}
if raw then
 if #raw>4194304 then return {'BLOCKED_STORAGE'} end
 local ok,v=pcall(cjson.decode,raw)
 if not ok or v.schemaVersion~=s.schemaVersion or v.mappingVersion~=s.mappingVersion or type(v.intents)~='table'
 or type(v.fence)~='number' or type(v.expiresAt)~='number' then return {'CONFLICT'} end
 s=v
end
local op=ARGV[1];local owner=ARGV[2]
if op=='ACQUIRE' then
 if s.expiresAt>now then return {'BUSY'} end
 s.fence=s.fence+1;s.owner=owner;s.expiresAt=now+60000
else
 if s.owner~=owner or s.fence~=tonumber(ARGV[3]) or s.expiresAt<=now then return {'FENCED'} end
 if op=='CHECK' then return {'OK',tostring(s.fence)} end
 if op=='RELEASE' then s.owner='';s.expiresAt=now end
 if op=='SAVE' then
  local itemRaw=ARGV[4]
  if #itemRaw>32768 then return {'BLOCKED_STORAGE'} end
  local ok,item=pcall(cjson.decode,itemRaw)
  if not ok or type(item.id)~='string' or type(item.frozen)~='string' or type(item.actions)~='table'
   or type(item.done)~='table' or (item.status~='RUNNING' and item.status~='COMPLETE' and item.status~='BLOCKED_MAPPING') then return {'CONFLICT'} end
  local prior=s.intents[item.id]
  if prior then
   local p=cjson.decode(prior)
   if p.frozen~=item.frozen then return {'CONFLICT'} end
   if p.status~='RUNNING' and prior~=itemRaw then return {'CONFLICT'} end
   for k,v in pairs(p.actions) do if item.actions[k]~=v then return {'CONFLICT'} end end
   for k,v in pairs(p.done) do if item.done[k]~=v then return {'CONFLICT'} end end
  end
  s.intents[item.id]=itemRaw
  local count=0;local pending=0
  for _,v in pairs(s.intents) do count=count+1;if cjson.decode(v).status=='RUNNING' then pending=pending+1 end end
  if count>10000 or pending>100 then return {'BLOCKED_STORAGE'} end
 end
end
local encoded=cjson.encode(s)
if #encoded>4194304 then return {'BLOCKED_STORAGE'} end
redis.call('SET',KEYS[1],encoded)
return {'OK',tostring(s.fence)}
`;
export function createWorkerStore(execute){
 const command=async(op,owner='',fence=0,item=null)=>{
  const r=await execute(['EVAL',CONTROL,'1',WORKER_KEY,op,owner,String(fence),item?canonicalJSON(item):'']);
  assert(Array.isArray(r),'INVALID_WORKER_RECEIPT');return {status:r[0],fence:r[1]===undefined?null:Number(r[1])};
 };
 return {acquire:owner=>command('ACQUIRE',owner),check:(o,f)=>command('CHECK',o,f),release:(o,f)=>command('RELEASE',o,f),
  save:(o,f,i)=>command('SAVE',o,f,i),read:async()=>{
   const raw=await execute(['GET',WORKER_KEY]);if(raw===null)return {intents:{}};
   assert(typeof raw==='string'&&Buffer.byteLength(raw)<=STATE_LIMITS.maxBytes,'INVALID_WORKER_STATE');
   const s=JSON.parse(raw);assert(s.schemaVersion==='forward-worker-state-v1'&&s.mappingVersion===MAPPING,'WORKER_MAPPING_CONFLICT');
   return {...s,intents:Object.fromEntries(Object.entries(s.intents).map(([k,v])=>[k,JSON.parse(v)]))};
  }};
}
// Fencing is checked atomically in the SAME Redis Lua execution as each downstream
// GET/CAS. A preflight ownership check alone would race lease expiry/takeover.
export function fencedExecutor(execute,owner,fence,guard){return async command=>{
 guard();assert(['GET','EVAL'].includes(command[0]),'UNSUPPORTED_DOWNSTREAM_COMMAND');
 let keys,args,body;
 if(command[0]==='GET'){keys=[command[1]];args=[];body="return redis.call('GET',KEYS[1])";}
 else {const n=Number(command[2]);keys=command.slice(3,3+n);args=command.slice(3+n);body=command[1];}
 const keyIndex=keys.length+1,ownerIndex=args.length+1,fenceIndex=args.length+2;
 const prefix=`local wr=redis.call('GET',KEYS[${keyIndex}]);if not wr then return redis.error_reply('WORKER_FENCED') end
 local ws=cjson.decode(wr);local wt=redis.call('TIME');local wn=tonumber(wt[1])*1000+math.floor(tonumber(wt[2])/1000)
 if ws.owner~=ARGV[${ownerIndex}] or ws.fence~=tonumber(ARGV[${fenceIndex}]) or ws.expiresAt<=wn then return redis.error_reply('WORKER_FENCED') end\n`;
 return execute(['EVAL',prefix+body,String(keys.length+1),...keys,WORKER_KEY,...args,owner,String(fence)]);
};}
