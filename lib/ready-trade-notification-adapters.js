// Offline foundation: all I/O is injected; no environment reads or default network client.
import {isDeepStrictEqual} from 'node:util';
import {ACTIVE_KEY_PREFIX,activeNotificationKey,shouldNotifyActiveTrade,notifyActiveTrades,KEY_PREFIX,safeTradeId,notificationKey,findLatestTrade,shouldNotifyReadyTrade,notifyReadyTrades,TOTAL_BUDGET_MS} from './ready-trade-notifications.js';
export const OPEN_KEY='sergey-ai:open-trades:v1';
export const ARCHIVE_KEY='sergey-ai:validation-archive:v1';
export const BASELINE_KEY=KEY_PREFIX+'baseline';
export const ACTIVE_BASELINE_KEY=ACTIVE_KEY_PREFIX+'baseline';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=()=>{throw Error('ADAPTER_REJECTED');};
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function decode(raw){if(typeof raw!=='string'||Buffer.byteLength(raw)>16*1024*1024)fail();return JSON.parse(raw);}
function rows(raw){const a=decode(raw);if(!Array.isArray(a)||a.length>1000)fail();for(const t of a)if(!findLatestTrade(a,t?.tradeId))fail();return a;}
export function createCanonicalReader(read){return {
 async current({signal}){return rows(await read(OPEN_KEY,{signal}));},
 async archive({signal}){const d=decode(await read(ARCHIVE_KEY,{signal}));if(!object(d)||d.schemaVersion!==1||!object(d.tradesById)||Object.keys(d.tradesById).length>10000)fail();return d.tradesById;}
};}
// Atomic persistence contract: createIfAbsent and compareAndSet must be durable,
// linearizable, preserve records forever, and must not retry uncertain operations.
export function createNotificationStorage(kv,{event='ready'}={}){
 if(!['ready','active'].includes(event))fail();
 const prefix=event==='active'?ACTIVE_KEY_PREFIX:KEY_PREFIX;
 const baselineKey=prefix+'baseline';
 const check=k=>{if(k!==baselineKey&&!(typeof k==='string'&&k.startsWith(prefix)&&digest(k.slice(prefix.length))))fail();};
 return {
 async baseline({signal}){return kv.get(baselineKey,{signal});},
 async initialize(value,{signal}){return kv.createIfAbsent(baselineKey,value,{signal,expiresAt:null});},
 async seen(key,{signal}){check(key);return (await kv.get(key,{signal}))!=null;},
 async claim({key,record,expiresAt,signal}){check(key);if(key===baselineKey||expiresAt!==null||record.status!=='CLAIMED'||record.safeTradeId!==key.slice(prefix.length))fail();return {acquired:(await kv.createIfAbsent(key,record,{signal,expiresAt:null}))===true};},
 async finalize({key,attemptId,expectedStatus,status,reasonCode,messageId,completedAt,expiresAt,signal}){
 check(key);if(key===baselineKey||expiresAt!==null||expectedStatus!=='CLAIMED'||!['SENT','FAILED','UNKNOWN'].includes(status))fail();
 // Never spread caller records into the persisted notification result.
 const patch={status,reasonCode,messageId,completedAt,expiresAt:null};
 return {updated:(await kv.compareAndSet(key,{attemptId,status:'CLAIMED'},patch,{signal,expiresAt:null}))===true};
 }
 };}
export function mapEvidence(trade,archive,baseline){
 try{
 const id=safeTradeId(trade.tradeId),a=archive[trade.tradeId],p=trade.initialPlan,o=a?.origin;
 if(baseline.identities.includes(id)||!object(a)||a.tradeId!==trade.tradeId||a.schemaVersion!==1||a.rulesRevision!=='canonical-trade-archive-v1'||o?.confirmedAPlus!==true||o.grade!=='A+')return null;
 const created=Date.parse(p.createdAt),detected=Date.parse(o.detectedAt);
 if(!Number.isFinite(created)||created!==detected||created<=baseline.notificationsEnabledAt)return null;
 if(o.symbol!==trade.symbol||o.direction!==trade.direction||o.opportunityScore!==trade.opportunityScore||!isDeepStrictEqual(JSON.parse(a.initialPlanJSON),p))return null;
 const outcome=JSON.parse(a.outcomeJSON);
 if(!['WaitingEntry','Pending'].includes(outcome.status)||a.stage!==0||a.terminal!==false||!isDeepStrictEqual(outcome,trade.outcome))return null;
 return {committedTrade:trade,canonicalEligibilityPassed:true};
 }catch{return null;}
}
// request is a server-only, abort-aware transport capability; never default global fetch.
export function createTelegramProvider(request){return {async send({config,payload,signal,timeoutMs}){
 try{
 const r=await request({token:config.TELEGRAM_BOT_TOKEN,payload:{chat_id:config.TELEGRAM_CHAT_ID,text:payload.text},signal,timeoutMs});
 if(!object(r)||!Number.isInteger(r.httpStatus))return null;
 let b=r.body;if(typeof b==='string'){if(Buffer.byteLength(b)>16384)return null;b=JSON.parse(b);}
 return {httpStatus:r.httpStatus,body:{ok:b?.ok,error_code:b?.error_code,result:{message_id:b?.result?.message_id,chat:{id:b?.result?.chat?.id}}}};
 }catch{return null;}
}};}
async function runEventNotifier({reader,storage,provider,config,clock={now:()=>Date.now(),setTimeout,clearTimeout}},active=false){
 const evidence=active?mapActiveEvidence:mapEvidence,eligible=active?shouldNotifyActiveTrade:shouldNotifyReadyTrade,keyFor=active?activeNotificationKey:notificationKey,notify=active?notifyActiveTrades:notifyReadyTrades;
 const deadline=clock.now()+TOTAL_BUDGET_MS,controller=new AbortController();let timer;
 const work=async()=>{
 const check=()=>{if(controller.signal.aborted||clock.now()>=deadline)fail();};
 const options={signal:controller.signal};
 let baseline=await storage.baseline(options);check();
 if(baseline==null){
 const boundary=clock.now(),current=await reader.current(options);check();
 const value={version:1,notificationsEnabledAt:boundary,identities:current.filter(t=>!active||t.outcome.status==='Active').map(t=>safeTradeId(t.tradeId))};
 const initialized=await storage.initialize(value,options);check();
 return {status:initialized===true?'BASELINED':'BASELINE_RACE',sent:0};
 }
 if(baseline.version!==1||!Number.isFinite(baseline.notificationsEnabledAt)||baseline.notificationsEnabledAt>clock.now()||!Array.isArray(baseline.identities)||baseline.identities.length>1000||!baseline.identities.every(digest))fail();
 const current=await reader.current(options);check();const archive=await reader.archive(options);check();const trades=[];
 for(const t of current){const item=evidence(t,archive,baseline);if(!item||!eligible({...item,latestTrade:t,now:clock.now()}).allowed)continue;
 const seen=await storage.seen(keyFor(t.tradeId),options);check();if(!seen)trades.push(item);if(trades.length===20)break;}
 const result=await notify({trades,storage,provider,config,clock,deadline,latestState:{read:async({signal})=>{
  const latest=await reader.current({signal});check();
  const archiveLatest=await reader.archive({signal});check();
  return latest.filter(t=>evidence(t,archiveLatest,baseline));
 }}});check();
 return {status:result.results.some(r=>r.diagnosticCode==='FINALIZE_FAILED')?'FINALIZE_FAILED':'COMPLETE',sent:result.results.filter(r=>r.status==='SENT').length,skipped:result.results.filter(r=>r.status==='SKIPPED').length,failed:result.results.filter(r=>r.status==='FAILED').length,unknown:result.results.filter(r=>r.status==='UNKNOWN').length};
 };
 try{return await Promise.race([work().catch(()=>({status:'UNAVAILABLE'})),new Promise(resolve=>{timer=clock.setTimeout(()=>{controller.abort();resolve({status:'BUDGET_EXHAUSTED'});},TOTAL_BUDGET_MS);})]);}
 catch{return {status:'UNAVAILABLE'};}finally{clock.clearTimeout(timer);}
}

export const runNotifier=options=>runEventNotifier(options);
export const runActiveNotifier=options=>runEventNotifier(options,true);
export function mapActiveEvidence(trade,archive,baseline){
 try{
  const id=safeTradeId(trade.tradeId),a=archive[trade.tradeId],p=trade.initialPlan,o=a?.origin;
  if(baseline.identities.includes(id)||!object(a)||a.tradeId!==trade.tradeId||a.schemaVersion!==1||a.rulesRevision!=='canonical-trade-archive-v1'||o?.confirmedAPlus!==true||o.grade!=='A+')return null;
  // Exclude the snapshot of already-Active identities, not plans waiting at baseline.
  // Candle activation time may predate its later canonical persistence.
  const created=Date.parse(p.createdAt);
  if(!Number.isFinite(created)||created!==Date.parse(o.detectedAt))return null;
  if(o.symbol!==trade.symbol||o.direction!==trade.direction||o.opportunityScore!==trade.opportunityScore||!isDeepStrictEqual(JSON.parse(a.initialPlanJSON),p))return null;
  const outcome=JSON.parse(a.outcomeJSON);
  if(outcome.status!=='Active'||a.stage!==1||a.terminal!==false||!isDeepStrictEqual(outcome,trade.outcome))return null;
  return {committedTrade:trade,canonicalEligibilityPassed:true};
 }catch{return null;}
}

// Reserved control key: SHA256 of a fixed domain-separated baseline label, never a trade ID.
// The public BASELINE_KEY remains compatible with the existing worker interface.
export const NOTIFICATION_CAS_SCRIPT="if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end redis.call('SET',KEYS[1],ARGV[2]) return 1";
const storageCodes=new Set(['PROVIDER_CONFIRMED','PROVIDER_REJECTED','ACK_UNCERTAIN','LATEST_STATE_UNAVAILABLE','LATEST_STATE_REJECTED','BUDGET_EXHAUSTED','DELIVERY_UNCERTAIN','NOTIFICATION_ERROR','MESSAGE_INVALID','MESSAGE_TOO_LONG']);
const baselineHash=safeTradeId('ready-trade-v1:telegram:control:baseline');
const activeBaselineHash=safeTradeId('trade-active-v1:telegram:control:baseline');
const isBaseline=k=>k===BASELINE_KEY||k===ACTIVE_BASELINE_KEY;
const prefixFor=k=>typeof k==='string'&&k.startsWith(ACTIVE_KEY_PREFIX)?ACTIVE_KEY_PREFIX:KEY_PREFIX;
const timeValue=x=>Number.isSafeInteger(x)&&x>=0;
function storageKey(key){
 if(key===BASELINE_KEY)return KEY_PREFIX+baselineHash;
 if(key===ACTIVE_BASELINE_KEY)return ACTIVE_KEY_PREFIX+activeBaselineHash;
 const prefix=prefixFor(key),hash=prefix===ACTIVE_KEY_PREFIX?activeBaselineHash:baselineHash;
 if(typeof key!=='string'||!key.startsWith(prefix)||!digest(key.slice(prefix.length))||key===prefix+hash)throw Error('STORAGE_REJECTED');
 return key;
}
function storedRecord(key,value){
 const prefix=prefixFor(key);
 if(!object(value))throw Error('STORAGE_REJECTED');
 if(isBaseline(key)){
  if(value.version!==1||!timeValue(value.notificationsEnabledAt)||!Array.isArray(value.identities)||value.identities.length>1000||!value.identities.every(digest)||new Set(value.identities).size!==value.identities.length||Object.keys(value).some(k=>!['version','notificationsEnabledAt','identities'].includes(k)))throw Error('STORAGE_REJECTED');
  return {version:1,notificationsEnabledAt:value.notificationsEnabledAt,identities:[...value.identities]};
 }
 const allowed=['schema','safeTradeId','status','attemptId','claimedAt','expiresAt','reasonCode','completedAt'];
 if(Object.keys(value).some(k=>!allowed.includes(k))||value.schema!==(prefix===ACTIVE_KEY_PREFIX?'trade-active-v1':'ready-trade-v1')||value.safeTradeId!==key.slice(prefix.length)||!['CLAIMED','SENT','FAILED','UNKNOWN'].includes(value.status)||typeof value.attemptId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.attemptId)||!timeValue(value.claimedAt)||value.expiresAt!==null)throw Error('STORAGE_REJECTED');
 if(value.status==='CLAIMED'?(value.reasonCode!==undefined||value.completedAt!==undefined):(!storageCodes.has(value.reasonCode)||!timeValue(value.completedAt)||value.completedAt<value.claimedAt))throw Error('STORAGE_REJECTED');
 return {...value};
}
export function createPersistentNotificationKV({execute,timeoutMs=1000,clock={setTimeout,clearTimeout}}){
 if(typeof execute!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw Error('STORAGE_REJECTED');
 async function command(args,signal){
  let timer;const controller=new AbortController();let onAbort;
  try{
   if(signal?.aborted)throw Error();
   const stopped=new Promise((_,reject)=>{onAbort=()=>{controller.abort();reject(Error());};signal?.addEventListener('abort',onAbort,{once:true});timer=clock.setTimeout(onAbort,timeoutMs);});
   return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error();return execute(args,{signal:controller.signal});}),stopped]);
  }catch{throw Error('STORAGE_UNAVAILABLE');}finally{clock.clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
 }
 async function read(key,signal){
  const raw=await command(['GET',storageKey(key)],signal);if(raw===null)return null;
  try{if(typeof raw!=='string'||Buffer.byteLength(raw)>131072)throw Error();return {raw,value:storedRecord(key,JSON.parse(raw))};}catch{throw Error('STORAGE_REJECTED');}
 }
 return {
  async get(key,{signal}={}){return (await read(key,signal))?.value??null;},
  async createIfAbsent(key,value,{signal,expiresAt=null}={}){
   const physical=storageKey(key);if(expiresAt!==null)throw Error('STORAGE_REJECTED');
   const record=storedRecord(key,value);if(!isBaseline(key)&&record.status!=='CLAIMED')throw Error('STORAGE_REJECTED');
   const result=await command(['SET',physical,JSON.stringify(record),'NX'],signal);
   if(result==='OK')return true;if(result===null)return false;throw Error('STORAGE_UNAVAILABLE');
  },
  async compareAndSet(key,expected,next,{signal,expiresAt=null}={}){
   storageKey(key);
   if(isBaseline(key)||expiresAt!==null||!object(expected)||expected.status!=='CLAIMED'||Object.keys(expected).some(k=>!['attemptId','status'].includes(k))||!object(next)||Object.keys(next).some(k=>!['status','reasonCode','messageId','completedAt','expiresAt'].includes(k))||!['SENT','FAILED','UNKNOWN'].includes(next.status)||next.expiresAt!==null||!storageCodes.has(next.reasonCode)||!timeValue(next.completedAt))throw Error('STORAGE_REJECTED');
   const current=await read(key,signal);if(!current||current.value.status!=='CLAIMED'||current.value.attemptId!==expected.attemptId)return false;
   // Provider message ID is intentionally not persisted; no payload/chat identifier.
   const replacement=storedRecord(key,{...current.value,status:next.status,reasonCode:next.reasonCode,completedAt:next.completedAt});
   const result=await command(['EVAL',NOTIFICATION_CAS_SCRIPT,'1',storageKey(key),current.raw,JSON.stringify(replacement)],signal);
   if(result===1)return true;if(result===0)return false;throw Error('STORAGE_UNAVAILABLE');
  }
 };
}

// Unwired server-side transport. fetchImpl is mandatory; never reads environment.
export async function sendTelegramReadyTrade({token,chatId,text,fetchImpl,signal,
 clock={setTimeout,clearTimeout},timeoutMs=3000}={}){
 let dispatched=false,httpStatus=null,timer,onAbort,reader;
 const controller=new AbortController();
 const result=(errorType,deliveryCertainty,code)=>({provider:'telegram',errorType,httpStatus,code,deliveryCertainty,retryAllowed:false});
 try{
  if(typeof token!=='string'||!/^[A-Za-z0-9:_-]{8,512}$/.test(token)||typeof chatId!=='string'||! /^-?\d{1,20}$/.test(chatId)||typeof text!=='string'||text.length===0||text.length>2000||typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3000)return result('UNKNOWN','NOT_DELIVERED','INPUT_REJECTED');
  if(signal?.aborted)return result('UNKNOWN','NOT_DELIVERED','ABORTED_BEFORE_DISPATCH');
  let ownTimeout=false,externalAbort=false;
  const stop=new Promise(resolve=>{
   const cancel=()=>{controller.abort();if(reader)Promise.resolve(reader.cancel()).catch(()=>{});};
   onAbort=()=>{externalAbort=true;cancel();resolve(result('UNKNOWN',dispatched?'UNKNOWN':'NOT_DELIVERED','CALLER_ABORTED'));};
   signal?.addEventListener('abort',onAbort,{once:true});
   timer=clock.setTimeout(()=>{ownTimeout=true;cancel();resolve(result('TIMEOUT',dispatched?'UNKNOWN':'NOT_DELIVERED','TELEGRAM_TIMEOUT'));},timeoutMs);
  });
  const work=async()=>{
   try{
    if(controller.signal.aborted)return result('UNKNOWN','NOT_DELIVERED','ABORTED_BEFORE_DISPATCH');
    dispatched=true;
    const response=await fetchImpl('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text})});
    if(controller.signal.aborted)return result('UNKNOWN','UNKNOWN','REQUEST_ABORTED');
    if(!Number.isInteger(response?.status)||response.status<100||response.status>599)return result('MALFORMED_RESPONSE','UNKNOWN','TELEGRAM_INVALID_STATUS');
    httpStatus=response.status;
    const type=httpStatus>=500?'HTTP_5XX':([400,401,403,404,429].includes(httpStatus)?'HTTP_'+httpStatus:'HTTP_ERROR');
    const httpCode=type==='HTTP_ERROR'?'TELEGRAM_HTTP_ERROR':'TELEGRAM_'+type;
    const success=httpStatus>=200&&httpStatus<300;
    let body;
    try{
     if(!response.body||typeof response.body.getReader!=='function')throw Error();
     reader=response.body.getReader();const chunks=[];let size=0;
     while(true){const part=await reader.read();if(controller.signal.aborted)throw Error();if(part.done)break;if(!(part.value instanceof Uint8Array))throw Error();size+=part.value.byteLength;if(size>16384)throw Error();chunks.push(part.value);}
     const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
     body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    }catch{return result(success?'MALFORMED_RESPONSE':type,'UNKNOWN',success?'TELEGRAM_INVALID_RESPONSE':httpCode);}
    if(success&&object(body)&&body.ok===true)return result('SUCCESS','DELIVERED','TELEGRAM_ACCEPTED');
    if(!success&&httpStatus>=400&&httpStatus<500&&object(body)&&body.ok===false&&body.error_code===httpStatus)return result(type,'NOT_DELIVERED',httpCode);
    return result(success?'MALFORMED_RESPONSE':type,'UNKNOWN',success?'TELEGRAM_INVALID_RESPONSE':httpCode);
   }catch(error){
    if(ownTimeout)return result('TIMEOUT',dispatched?'UNKNOWN':'NOT_DELIVERED','TELEGRAM_TIMEOUT');
    if(externalAbort)return result('UNKNOWN',dispatched?'UNKNOWN':'NOT_DELIVERED','CALLER_ABORTED');
    const codes=['ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'];
    const network=codes.includes(error?.code)||codes.includes(error?.cause?.code);
    return result(network?'NETWORK_ERROR':'UNKNOWN',dispatched?'UNKNOWN':'NOT_DELIVERED',network?'TELEGRAM_NETWORK_ERROR':'TELEGRAM_TRANSPORT_UNKNOWN');
   }finally{if(reader)try{await reader.cancel();}catch{}}
  };
  return await Promise.race([work(),stop]);
 }catch{return result('UNKNOWN',dispatched?'UNKNOWN':'NOT_DELIVERED','TELEGRAM_TRANSPORT_UNKNOWN');}
 finally{if(timer!==undefined)clock.clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}
// Intended mapping only; not connected to existing notification send/finalize flow.
export function telegramDeliveryTerminalState(result){
 if(result?.provider==='telegram'&&result.deliveryCertainty==='DELIVERED'&&result.errorType==='SUCCESS')return 'SENT';
 if(result?.provider==='telegram'&&result.deliveryCertainty==='NOT_DELIVERED')return 'FAILED';
 return 'UNKNOWN';
}

// Explicit offline/test composition only. No default fetch, credentials or scheduler wiring.
export function createReadyTradeNotificationWorker({readCanonical,executeNotification,fetchImpl,config,clock}){
 if(typeof readCanonical!=='function'||typeof executeNotification!=='function'||typeof fetchImpl!=='function')throw Error('ADAPTER_REJECTED');
 const reader=createCanonicalReader(readCanonical);
 const storage=createNotificationStorage(createPersistentNotificationKV({execute:executeNotification,...(clock?{clock}:{})}));
 const provider={send:({config:credentials,payload,signal,timeoutMs})=>sendTelegramReadyTrade({token:credentials.TELEGRAM_BOT_TOKEN,chatId:credentials.TELEGRAM_CHAT_ID,text:payload.text,fetchImpl,signal,timeoutMs,...(clock?{clock}:{})})};
 return ()=>runNotifier({reader,storage,provider,config,...(clock?{clock}:{})});
}


// Server-only composition. Construction validates all configuration before any I/O.
const safeCredential=x=>typeof x==='string'&&x.length>0&&x.length<=8192&&!/\s/.test(x);
export function validNotificationSigningKeys(env){
 return safeCredential(env?.QSTASH_CURRENT_SIGNING_KEY)&&safeCredential(env?.QSTASH_NEXT_SIGNING_KEY);
}
function productionConfig(env){
 try{
  if(env.READY_TRADE_NOTIFICATIONS_ENABLED!=='true'||!validNotificationSigningKeys(env))throw Error();
  const token=env.TELEGRAM_BOT_TOKEN,chatId=env.TELEGRAM_CHAT_ID;
  if(typeof token!=='string'||!/^[A-Za-z0-9:_-]{8,512}$/.test(token)||typeof chatId!=='string'||! /^-?\d{1,20}$/.test(chatId))throw Error();
  const url=env.UPSTASH_REDIS_REST_URL||env.KV_REST_API_URL;
  const redisToken=env.UPSTASH_REDIS_REST_TOKEN||env.KV_REST_API_TOKEN;
  if(typeof url!=='string'||url!==url.trim()||!safeCredential(redisToken))throw Error();
  const u=new URL(url);
  if(u.protocol!=='https:'||! /^[a-z0-9-]+\.upstash\.io$/.test(u.hostname)||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/')throw Error();
  return {url:u.origin,redisToken,TELEGRAM_BOT_TOKEN:token,TELEGRAM_CHAT_ID:chatId};
 }catch{throw Error('CONFIG_INVALID');}
}
export function createProductionRedisIO({env,fetchImpl,clock={setTimeout,clearTimeout}}){
 const cfg=productionConfig(env);if(typeof fetchImpl!=='function')throw Error('CONFIG_INVALID');
 const notification=k=>typeof k==='string'&&[KEY_PREFIX,ACTIVE_KEY_PREFIX].some(prefix=>k.startsWith(prefix)&&digest(k.slice(prefix.length)));
 async function request(args,{signal}={}){
  let timer,onAbort,reader;const controller=new AbortController();
  try{
   if(signal?.aborted)throw Error();
   const stopped=new Promise((_,reject)=>{
    onAbort=()=>{controller.abort();if(reader)Promise.resolve(reader.cancel()).catch(()=>{});reject(Error());};
    signal?.addEventListener('abort',onAbort,{once:true});timer=clock.setTimeout(onAbort,3000);
   });
   const work=async()=>{
    const r=await fetchImpl(cfg.url,{method:'POST',redirect:'error',signal:controller.signal,
     headers:{Authorization:'Bearer '+cfg.redisToken,'Content-Type':'application/json'},body:JSON.stringify(args)});
    if(controller.signal.aborted||!r.ok||!r.body?.getReader)throw Error();
    reader=r.body.getReader();const chunks=[];let size=0;
    while(true){const part=await reader.read();if(controller.signal.aborted)throw Error();if(part.done)break;
     if(!(part.value instanceof Uint8Array))throw Error();size+=part.value.length;if(size>64*1024*1024)throw Error();chunks.push(part.value);}
    const p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
    if(!object(p)||Object.hasOwn(p,'error')||!Object.hasOwn(p,'result'))throw Error();
    return p.result;
   };
   return await Promise.race([work(),stopped]);
  }catch{throw Error('REDIS_UNAVAILABLE');}
  finally{clock.clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(reader)try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}}
 }
 return {
  async readCanonical(key,options){
   if(![OPEN_KEY,ARCHIVE_KEY].includes(key))throw Error('COMMAND_REJECTED');
   const raw=await request(['GET',key],options);
   if(typeof raw!=='string'||Buffer.byteLength(raw)>16*1024*1024)throw Error('CANONICAL_UNAVAILABLE');return raw;
  },
  async executeNotification(args,options){
   if(!Array.isArray(args)||!args.every(x=>typeof x==='string')||args.some(x=>Buffer.byteLength(x)>131072))throw Error('COMMAND_REJECTED');
   const allowed=(args.length===2&&args[0]==='GET'&&notification(args[1]))||
    (args.length===4&&args[0]==='SET'&&notification(args[1])&&args[3]==='NX')||
    (args.length===6&&args[0]==='EVAL'&&args[1]===NOTIFICATION_CAS_SCRIPT&&args[2]==='1'&&notification(args[3]));
   if(!allowed)throw Error('COMMAND_REJECTED');return request([...args],options);
  }
 };
}
export function createProductionNotificationWorker({env,fetchImpl,clock}){
 const cfg=productionConfig(env);
 const io=createProductionRedisIO({env,fetchImpl,...(clock?{clock}:{})});
 return createCombinedNotificationWorker({...io,fetchImpl,clock,config:{TELEGRAM_BOT_TOKEN:cfg.TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID:cfg.TELEGRAM_CHAT_ID}});
}

// READY runs with its existing independent budget; ACTIVE failures cannot suppress it.
export function createCombinedNotificationWorker(options){
 const ready=createReadyTradeNotificationWorker(options);
 const {readCanonical,executeNotification,fetchImpl,config,clock}=options;
 const reader=createCanonicalReader(readCanonical);
 const storage=createNotificationStorage(createPersistentNotificationKV({execute:executeNotification,...(clock?{clock}:{})}),{event:'active'});
 const provider={send:({config:c,payload,signal,timeoutMs})=>sendTelegramReadyTrade({token:c.TELEGRAM_BOT_TOKEN,chatId:c.TELEGRAM_CHAT_ID,text:payload.text,fetchImpl,signal,timeoutMs,...(clock?{clock}:{})})};
 return async()=>{
  const readyResult=await ready();
  // Do not repeat unavailable shared storage reads during the same invocation.
  if(['UNAVAILABLE','BUDGET_EXHAUSTED'].includes(readyResult.status))return readyResult;
  let activeResult;try{activeResult=await runActiveNotifier({reader,storage,provider,config,...(clock?{clock}:{})});}catch{activeResult={status:'UNAVAILABLE'};}
  return {...readyResult,active:activeResult};
 };
}
