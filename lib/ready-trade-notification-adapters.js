// Offline foundation: all I/O is injected; no environment reads or default network client.
import {isDeepStrictEqual} from 'node:util';
import {KEY_PREFIX,safeTradeId,notificationKey,findLatestTrade,shouldNotifyReadyTrade,notifyReadyTrades,TOTAL_BUDGET_MS} from './ready-trade-notifications.js';
export const OPEN_KEY='sergey-ai:open-trades:v1';
export const ARCHIVE_KEY='sergey-ai:validation-archive:v1';
export const BASELINE_KEY=KEY_PREFIX+'baseline';
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
export function createNotificationStorage(kv){
 const check=k=>{if(k!==BASELINE_KEY&&!(typeof k==='string'&&k.startsWith(KEY_PREFIX)&&digest(k.slice(KEY_PREFIX.length))))fail();};
 return {
 async baseline({signal}){return kv.get(BASELINE_KEY,{signal});},
 async initialize(value,{signal}){return kv.createIfAbsent(BASELINE_KEY,value,{signal,expiresAt:null});},
 async seen(key,{signal}){check(key);return (await kv.get(key,{signal}))!=null;},
 async claim({key,record,expiresAt,signal}){check(key);if(key===BASELINE_KEY||expiresAt!==null||record.status!=='CLAIMED'||record.safeTradeId!==key.slice(KEY_PREFIX.length))fail();return {acquired:(await kv.createIfAbsent(key,record,{signal,expiresAt:null}))===true};},
 async finalize({key,attemptId,expectedStatus,status,reasonCode,messageId,completedAt,expiresAt,signal}){
 check(key);if(key===BASELINE_KEY||expiresAt!==null||expectedStatus!=='CLAIMED'||!['SENT','FAILED','UNKNOWN'].includes(status))fail();
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
export async function runNotifier({reader,storage,provider,config,clock={now:()=>Date.now(),setTimeout,clearTimeout}}){
 const deadline=clock.now()+TOTAL_BUDGET_MS,controller=new AbortController();let timer;
 const work=async()=>{
 const check=()=>{if(controller.signal.aborted||clock.now()>=deadline)fail();};
 const options={signal:controller.signal};
 let baseline=await storage.baseline(options);check();
 if(baseline==null){
 const boundary=clock.now(),current=await reader.current(options);check();
 const value={version:1,notificationsEnabledAt:boundary,identities:current.map(t=>safeTradeId(t.tradeId))};
 const initialized=await storage.initialize(value,options);check();
 return {status:initialized===true?'BASELINED':'BASELINE_RACE',sent:0};
 }
 if(baseline.version!==1||!Number.isFinite(baseline.notificationsEnabledAt)||baseline.notificationsEnabledAt>clock.now()||!Array.isArray(baseline.identities)||baseline.identities.length>1000||!baseline.identities.every(digest))fail();
 const current=await reader.current(options);check();const archive=await reader.archive(options);check();const trades=[];
 for(const t of current){const item=mapEvidence(t,archive,baseline);if(!item||!shouldNotifyReadyTrade({...item,latestTrade:t,now:clock.now()}).allowed)continue;
 const seen=await storage.seen(notificationKey(t.tradeId),options);check();if(!seen)trades.push(item);if(trades.length===20)break;}
 const result=await notifyReadyTrades({trades,storage,provider,config,clock,deadline,latestState:{read:async({signal})=>reader.current({signal})}});check();
 return {status:'COMPLETE',sent:result.results.filter(r=>r.status==='SENT').length,skipped:result.results.filter(r=>r.status==='SKIPPED').length,failed:result.results.filter(r=>r.status==='FAILED').length,unknown:result.results.filter(r=>r.status==='UNKNOWN').length};
 };
 try{return await Promise.race([work().catch(()=>({status:'UNAVAILABLE'})),new Promise(resolve=>{timer=clock.setTimeout(()=>{controller.abort();resolve({status:'BUDGET_EXHAUSTED'});},TOTAL_BUDGET_MS);})]);}
 catch{return {status:'UNAVAILABLE'};}finally{clock.clearTimeout(timer);}
}
