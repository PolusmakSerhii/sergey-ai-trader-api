import {canonicalJSON,universeDigest} from './source-contract.js';
import {MAPPING,mapObservation,validateDelayed} from './delayed-ingestion.js';
import {digest} from './observation-store.js';
import {assert,validateCycle,iso} from './observation-reader.js';
export const WORKER_KEY='sergey-ai:forward-worker:v1:state';
export const LEASE_MS=60000,WORKER_MS=45000,COMMAND_MS=5000;
export const STATE_LIMITS=Object.freeze({maxBytes:4194304,maxCycleReceipts:10000,maxPendingIntents:100,maxPayloadBytes:1048576});
export const COMPLETE_RECEIPT='forward-worker-complete-v1';
// Pure proof over the already-read source and durable RUNNING preimage. No IO.
export function prepareComplete(item,cycle){
 const requireProof=ok=>assert(ok,'CONFLICT');
 const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
 const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
 const keys=(o,expected)=>object(o)&&same(Object.keys(o).sort(),[...expected].sort());
 requireProof(keys(item,['id','frozen','status','actions','done'])&&item.status==='RUNNING'&&typeof item.frozen==='string');
 const source=validateCycle(cycle.raw,item.id),e=source.envelope,f=JSON.parse(item.frozen);
 requireProof(canonicalJSON(f)===item.frozen&&f.sourceCycleId===item.id&&f.mappingVersion===MAPPING&&
  f.sourceEnvelopeHash===source.hash&&f.processingIdentity===digest([MAPPING,item.id])&&
  f.orderKey===e.observedAt+'|'+item.id&&iso(f.workerProcessingStartedAt)&&iso(f.workerRecordedAt)&&
  f.workerProcessingStartedAt>=e.observedAt&&f.workerRecordedAt>=f.workerProcessingStartedAt);
 requireProof(e.observations.length<=50&&e.observations.every(o=>mapObservation(source,o).status==='MAPPED')&&
  new Set(e.observations.map(o=>o.payload.symbol)).size===e.observations.length);
 const ops=e.observations.map(o=>digest([MAPPING,item.id,o.observationId]));
 const expectedKeys=ops.length?['producer-init','shadow-init','allocate','manifest',...ops.flatMap(op=>['ingest','generation','prepare','capture'].map(type=>op+':'+type))]:[];
 requireProof(keys(item.actions,expectedKeys)&&keys(item.done,expectedKeys));
 const decode=raw=>{requireProof(typeof raw==='string');const x=JSON.parse(raw);requireProof(object(x)&&canonicalJSON(x)===raw);return x;};
 const actions=Object.fromEntries(expectedKeys.map(k=>[k,decode(item.actions[k])]));
 const done=Object.fromEntries(expectedKeys.map(k=>[k,decode(item.done[k])]));
 for(const k of expectedKeys){
  const a=actions[k];requireProof(['OK','CREATED','IDEMPOTENT'].includes(done[k].status));
  if(k==='producer-init'||k==='shadow-init'){
   const fields=k==='producer-init'?['runId','mode','schemaVersion','coreCommit','officialActivationId','officialActivationAt','budget']:
    ['runId','mode','schemaVersion','protocolVersion','admissionVersion','coreCommit','officialActivationId','officialActivationAt','ledgerRevision','captureWatermark','decisionWatermark','health','failureReason','storageBudget'];
   requireProof(keys(a,fields)&&a.runId==='manual-forward-worker-v1'&&a.mode==='SHADOW'&&a.schemaVersion===1);
  }
  else if(k.endsWith(':capture'))requireProof(keys(a,['runId','captureOperationId'])&&a.runId==='manual-forward-worker-v1'&&a.captureOperationId===k);
  else requireProof(keys(a,['requestId','expectedRevision','data'])&&a.requestId===digest([f.processingIdentity,k])&&Number.isSafeInteger(a.expectedRevision)&&a.expectedRevision>=0&&object(a.data));
 }
 if(ops.length){
  const cid=done.allocate.reply?.cycleId,allocation=actions.allocate.data,manifest=actions.manifest.data;
  requireProof(typeof cid==='string'&&keys(allocation,['allocationId','cycleStartedAt','sourceTimeLowerBound'])&&allocation.allocationId===f.processingIdentity&&allocation.cycleStartedAt===f.workerProcessingStartedAt&&allocation.sourceTimeLowerBound===f.workerProcessingStartedAt);
  const symbols=e.observations.map(o=>o.payload.symbol);
  requireProof(keys(manifest,['cycleId','universeId','universeHash','expectedSymbols','batchCount','batches'])&&manifest.cycleId===cid&&manifest.universeId===item.id&&manifest.universeHash===universeDigest(symbols)&&
   same(manifest.expectedSymbols,symbols)&&manifest.batchCount===1&&same(manifest.batches,[{batchId:cid+':0',batchIndex:0,expectedBatchSymbols:symbols}]));
  for(let n=0;n<ops.length;n++){
   const op=ops[n],o=e.observations[n],ingest=actions[op+':ingest'].data,generation=actions[op+':generation'].data,prepare=actions[op+':prepare'].data;
   validateDelayed(ingest.ingestion);
   requireProof(keys(ingest,['cycleId','operationId','ingestion'])&&ingest.cycleId===cid&&ingest.operationId===op&&ingest.ingestion.sourceEnvelope===source.raw&&
    ingest.ingestion.observationId===o.observationId&&ingest.ingestion.processingIdentity===op&&
    ingest.ingestion.workerProcessingStartedAt===f.workerProcessingStartedAt&&ingest.ingestion.workerRecordedAt===f.workerRecordedAt);
   const gid=done[op+':generation'].reply?.shadowCandidateId;
   requireProof(keys(generation,['setupKey','shadowCandidateId','identityOrigin','originalSourceOperationId','originalCapturedAt','frozenCandidate','frozenFactsHash'])&&typeof gid==='string'&&object(generation.frozenCandidate)&&generation.shadowCandidateId===generation.frozenCandidate.tradeId&&
    (generation.shadowCandidateId===gid||done[op+':generation'].reply.reused===true)&&
    generation.frozenFactsHash===digest(generation.frozenCandidate)&&typeof generation.originalSourceOperationId==='string');
   requireProof(keys(prepare,['captureOperationId','sourceOperationId','shadowCandidateId','payloadHash','expectedShadowRevision','transaction','transactionHash'])&&prepare.sourceOperationId===op&&prepare.captureOperationId===op+':capture'&&prepare.shadowCandidateId===gid&&
    object(prepare.transaction)&&prepare.transaction.operationId===op+':capture'&&prepare.transactionHash===digest(prepare.transaction)&&
    prepare.expectedShadowRevision===prepare.transaction.expectedLedgerRevision);
  }
 }
 const expectedPreimage=canonicalJSON(item),full=canonicalJSON({...item,status:'COMPLETE'}),expectedHash=digest({...item,status:'COMPLETE'});
 return {expectedPreimage,expectedKeys,expectedHash,fullIntentCanonicalBytes:Buffer.byteLength(full),
  receipt:{receiptVersion:COMPLETE_RECEIPT,id:item.id,frozen:item.frozen,status:'COMPLETE',fullIntentSha256:expectedHash}};
}
export const CONTROL=`
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local raw=redis.call('GET',KEYS[1])
local previousBytes=raw and #raw or 0
local crossedLegacyLimit=false
local function receipt(status,reason,prospective,fence)
 if ARGV[1]=='FINALIZE_COMPLETE' then
  return {status,'',cjson.encode({reasonCode=reason,previousSerializedBytes=previousBytes,
   prospectiveSerializedBytes=prospective or cjson.null,serializedReductionBytes=prospective and (previousBytes-prospective) or cjson.null,wholeStateLimitBytes=4194304})}
 end
 if ARGV[1]~='SAVE' then return {status} end
 return {status,fence or '',cjson.encode({reasonCode=reason,canonicalIntentBytes=#ARGV[4],
  configuredLimitBytes=1048576,wholeStateLimitBytes=4194304,previousSerializedBytes=previousBytes,
  prospectiveSerializedBytes=prospective or cjson.null,
  serializedGrowthBytes=prospective and (prospective-previousBytes) or cjson.null,
  crossedLegacyLimit=crossedLegacyLimit})}
end
local s={schemaVersion='forward-worker-state-v1',mappingVersion='forward-worker-mapping-v1',fence=0,owner='',expiresAt=0,intents={}}
if raw then
 if #raw>4194304 then return receipt('BLOCKED_STORAGE','CURRENT_STATE_LIMIT') end
 local ok,v=pcall(cjson.decode,raw)
 if not ok or v.schemaVersion~=s.schemaVersion or v.mappingVersion~=s.mappingVersion or type(v.intents)~='table'
 or type(v.fence)~='number' or type(v.expiresAt)~='number' then return receipt('CONFLICT','VALIDATION_CONFLICT') end
 s=v
end
local op=ARGV[1];local owner=ARGV[2]
if op=='ACQUIRE' then
 if s.expiresAt>now then return {'BUSY'} end
 s.fence=s.fence+1;s.owner=owner;s.expiresAt=now+60000
else
 if s.owner~=owner or s.fence~=tonumber(ARGV[3]) or s.expiresAt<=now then return receipt('FENCED','FENCED') end
 if op=='CHECK' then return {'OK',tostring(s.fence)} end
 if op=='RELEASE' then s.owner='';s.expiresAt=now end
 if op=='FINALIZE_COMPLETE' then
  local ok,p=pcall(cjson.decode,ARGV[4])
  if not ok or type(p)~='table' or type(p.expectedPreimage)~='string' or type(p.expectedKeys)~='table' or type(p.receipt)~='table' then return receipt('CONFLICT','VALIDATION_CONFLICT') end
  local r=p.receipt
  local allowed={receiptVersion=true,id=true,frozen=true,status=true,fullIntentSha256=true};local fields=0
  for k,_ in pairs(r) do if not allowed[k] then return receipt('CONFLICT','VALIDATION_CONFLICT') end;fields=fields+1 end
  if fields~=5 or r.receiptVersion~='forward-worker-complete-v1' or r.status~='COMPLETE' or type(r.id)~='string' or type(r.frozen)~='string'
   or type(r.fullIntentSha256)~='string' or #r.fullIntentSha256~=64 or not string.match(r.fullIntentSha256,'^[a-f0-9]+$') or r.fullIntentSha256~=p.expectedHash then return receipt('CONFLICT','VALIDATION_CONFLICT') end
  local prior=s.intents[r.id]
  if type(prior)~='string' then return receipt('CONFLICT','PREIMAGE_CONFLICT') end
  local valid,current=pcall(cjson.decode,prior)
  if not valid or type(current)~='table' then return receipt('CONFLICT','VALIDATION_CONFLICT') end
  local receiptOK,encodedReceipt=pcall(cjson.decode,ARGV[5])
  if not receiptOK or type(encodedReceipt)~='table' then return receipt('CONFLICT','VALIDATION_CONFLICT') end
  local count=0;for k,v in pairs(encodedReceipt) do if r[k]~=v then return receipt('CONFLICT','VALIDATION_CONFLICT') end;count=count+1 end
  if count~=5 then return receipt('CONFLICT','VALIDATION_CONFLICT') end
  if current.receiptVersion~=nil then
   if prior==ARGV[5] then return receipt('IDEMPOTENT','ALREADY_COMPLETE',previousBytes) end
   return receipt('CONFLICT','PREIMAGE_CONFLICT')
  end
  if prior~=p.expectedPreimage or current.status~='RUNNING' or current.id~=r.id or current.frozen~=r.frozen then return receipt('CONFLICT','PREIMAGE_CONFLICT') end
  if #prior>1048576 or #ARGV[5]>1048576 then return receipt('BLOCKED_STORAGE','INTENT_LIMIT') end
  if type(current.actions)~='table' or type(current.done)~='table' then return receipt('CONFLICT','VALIDATION_CONFLICT') end
  local expected={};local total=0
  for _,k in ipairs(p.expectedKeys) do
   if type(k)~='string' or expected[k] then return receipt('CONFLICT','ACTION_COMPLETENESS') end
   expected[k]=true;total=total+1
   if type(current.actions[k])~='string' or type(current.done[k])~='string' then return receipt('CONFLICT','ACTION_COMPLETENESS') end
   local aok,a=pcall(cjson.decode,current.actions[k]);local dok,d=pcall(cjson.decode,current.done[k])
   if not aok or type(a)~='table' or not dok or type(d)~='table' or (d.status~='OK' and d.status~='CREATED' and d.status~='IDEMPOTENT') then return receipt('CONFLICT','RESULT_COMPLETENESS') end
  end
  local ac=0;for k,_ in pairs(current.actions) do if not expected[k] then return receipt('CONFLICT','ACTION_COMPLETENESS') end;ac=ac+1 end
  local dc=0;for k,_ in pairs(current.done) do if not expected[k] then return receipt('CONFLICT','RESULT_COMPLETENESS') end;dc=dc+1 end
  if ac~=total or dc~=total then return receipt('CONFLICT','ACTION_COMPLETENESS') end
  local intents=0;local pending=0
  for _,v in pairs(s.intents) do
   local vok,vi=pcall(cjson.decode,v);if not vok or type(vi)~='table' then return receipt('CONFLICT','VALIDATION_CONFLICT') end
   intents=intents+1;if vi.status=='RUNNING' then pending=pending+1 end
  end
  if intents>10000 or pending>100 then return receipt('BLOCKED_STORAGE','COUNT_LIMIT') end
  s.intents[r.id]=ARGV[5]
 end
 if op=='SAVE' then
  local itemRaw=ARGV[4]
  if #itemRaw>1048576 then return receipt('BLOCKED_STORAGE','INTENT_LIMIT') end
  local ok,item=pcall(cjson.decode,itemRaw)
  if not ok or item.receiptVersion~=nil or type(item.id)~='string' or type(item.frozen)~='string' or type(item.actions)~='table'
   or type(item.done)~='table' or (item.status~='RUNNING' and item.status~='COMPLETE' and item.status~='BLOCKED_MAPPING') then return receipt('CONFLICT','VALIDATION_CONFLICT') end
  local prior=s.intents[item.id]
  if prior then
   local p=cjson.decode(prior)
   if p.frozen~=item.frozen then return receipt('CONFLICT','VALIDATION_CONFLICT') end
   if p.status~='RUNNING' and prior~=itemRaw then return receipt('CONFLICT','VALIDATION_CONFLICT') end
   if p.receiptVersion~=nil then return receipt('CONFLICT','VALIDATION_CONFLICT') end
   for k,v in pairs(p.actions) do if item.actions[k]~=v then return receipt('CONFLICT','VALIDATION_CONFLICT') end end
   for k,v in pairs(p.done) do if item.done[k]~=v then return receipt('CONFLICT','VALIDATION_CONFLICT') end end
  end
  crossedLegacyLimit=#itemRaw>32768 and (not prior or #prior<=32768)
  s.intents[item.id]=itemRaw
  local count=0;local pending=0
  for _,v in pairs(s.intents) do count=count+1;if cjson.decode(v).status=='RUNNING' then pending=pending+1 end end
  if count>10000 or pending>100 then return receipt('BLOCKED_STORAGE','COUNT_LIMIT') end
 end
end
local encoded=cjson.encode(s)
if #encoded>4194304 then return receipt('BLOCKED_STORAGE','WHOLE_STATE_LIMIT',#encoded) end
redis.call('SET',KEYS[1],encoded)
if op=='FINALIZE_COMPLETE' then return receipt('OK','FINALIZED',#encoded,tostring(s.fence)) end
if op=='SAVE' then return receipt('OK','SAVED',#encoded,tostring(s.fence)) end
return {'OK',tostring(s.fence)}
`;
export function createWorkerStore(execute){
 const command=async(op,owner='',fence=0,item=null,compact='')=>{
  const r=await execute(['EVAL',CONTROL,'1',WORKER_KEY,op,owner,String(fence),item?canonicalJSON(item):'',...(op==='FINALIZE_COMPLETE'?[compact]:[])]);
  assert(Array.isArray(r),'INVALID_WORKER_RECEIPT');return {status:r[0],fence:r[1]===undefined||r[1]===''?null:Number(r[1]),
   ...(op==='SAVE'&&typeof r[2]==='string'?{saveMetrics:JSON.parse(r[2])}:{}),
   ...(op==='FINALIZE_COMPLETE'&&typeof r[2]==='string'?{finalizeMetrics:JSON.parse(r[2])}:{})};
 };
 return {acquire:owner=>command('ACQUIRE',owner),check:(o,f)=>command('CHECK',o,f),release:(o,f)=>command('RELEASE',o,f),
  finalize:async(o,f,i,cycle)=>{
   let proof;try{proof=prepareComplete(i,cycle);}catch{return {status:'CONFLICT',finalizeMetrics:{reasonCode:'VALIDATION_CONFLICT'}};}
   return command('FINALIZE_COMPLETE',o,f,proof,canonicalJSON(proof.receipt));
  },
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
