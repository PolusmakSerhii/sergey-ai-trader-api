// Isolated foundation only. No environment reads, fetch, Redis client or trading imports.
import {createHash,randomUUID} from 'node:crypto';
export const PROVIDER_TIMEOUT_MS=3000,TOTAL_BUDGET_MS=5000,RETENTION_MS=null;
export const KEY_PREFIX='sergey-ai:notifications:ready-trade-v1:telegram:';
export const DASHBOARD_URL='https://sergey-ai-dashboard.vercel.app/';
export const AUTO_RESEND=false;
export const STATES=Object.freeze(['CLAIMED','SENT','FAILED','UNKNOWN']);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const finite=v=>typeof v==='number'&&Number.isFinite(v),positive=v=>finite(v)&&v>0;
const validId=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&!/[\x00-\x1f\x7f]/.test(v);
const absent=v=>v===undefined||v===null;
function instant(v){if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v))return NaN;const n=Date.parse(v);return Number.isFinite(n)&&new Date(n).toISOString()===v.replace(/(?<!\.\d{3})Z$/,'.000Z')?n:NaN;}
function canonical(v){if(v===null||typeof v==='string'||typeof v==='boolean'||finite(v))return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(object(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';throw Error('INVALID_JSON');}
export function safeTradeId(id){if(!validId(id))throw Error('INVALID_IDENTITY');return createHash('sha256').update(id,'utf8').digest('hex');}
export const notificationKey=id=>KEY_PREFIX+safeTradeId(id);
export function canTransition(from,to){return from===null?to==='CLAIMED':from==='CLAIMED'&&['SENT','FAILED','UNKNOWN'].includes(to);}
function preEntry(t,now){
 if(!object(t)||!validId(t.tradeId)||!object(t.initialPlan)||!object(t.outcome))return 'MALFORMED_TRADE';
 const o=t.outcome,p=t.initialPlan;
 if(!['WaitingEntry','Pending'].includes(o.status))return 'NOT_PRE_ENTRY';
 if(!absent(o.activatedAt)||!absent(o.entryPrice)||!absent(o.entryCheck)||!absent(o.exitPrice)||!absent(o.resultR)||!absent(o.stopMovedAt)||!absent(o.lastReanalysis))return 'ENTRY_EVIDENCE_PRESENT';
 if(!Array.isArray(o.exits)||o.exits.length!==0)return 'ENTRY_EVIDENCE_PRESENT';
 if((!absent(o.remainingPosition)&&o.remainingPosition!==1)||(!absent(o.initialPositionSize)&&o.initialPositionSize!==1)||(!absent(o.realizedR)&&o.realizedR!==0)||(!absent(o.reanalysisPending)&&o.reanalysisPending!==false)||(!absent(o.totalR)&&o.totalR!==0)||(!absent(o.unrealizedR)&&o.unrealizedR!==0))return 'ENTRY_EVIDENCE_PRESENT';
 if(!['Long','Short'].includes(t.direction))return 'INVALID_DIRECTION';
 const created=instant(p.createdAt),planned=instant(p.plannedAt),expires=instant(p.expiresAt);
 if(![created,planned,expires].every(Number.isFinite)||created>planned||planned>=expires||created>now)return 'INVALID_TIMESTAMPS';
 if(now>=expires)return 'EXPIRED';
 const z=p.entryZone,sl=p.initialStopLoss,tp=p.takeProfit1,e=p.entryPrice;
 if((!absent(o.currentStopLoss)&&o.currentStopLoss!==sl)||(!absent(o.initialStopLoss)&&o.initialStopLoss!==sl))return 'CONFLICTING_STOP_EVIDENCE';
 if(!object(z)||![z.from,z.to,sl,tp,e].every(positive)||z.from>z.to||e<z.from||e>z.to||sl!==p.stopLoss)return 'INVALID_FROZEN_PLAN';
 if(!(t.direction==='Long'?sl<z.from&&e<tp:sl>z.to&&e>tp))return 'INVALID_GEOMETRY';
 if(!/^[A-Z0-9]{1,24}USDT$/.test(t.symbol||'')||!finite(t.opportunityScore)||t.opportunityScore<0||t.opportunityScore>100||t.opportunityGrade!=='A+'||(t.grade!==undefined&&t.grade!=='A+'))return 'INVALID_MESSAGE_FIELDS';
 return null;
}
export function shouldNotifyReadyTrade(input={}){
 const no=reasonCode=>({allowed:false,reasonCode});
 try{
  const {committedTrade,latestTrade,canonicalEligibilityPassed,now}=input||{};
  if(canonicalEligibilityPassed!==true)return no('CANONICAL_ELIGIBILITY_NOT_PROVEN');
  if(!finite(now))return no('INVALID_CLOCK');
  const a=preEntry(committedTrade,now);if(a)return no(a);const b=preEntry(latestTrade,now);if(b)return no(b);
  if(committedTrade.tradeId!==latestTrade.tradeId)return no('IDENTITY_CONFLICT');
  if(committedTrade.direction!==latestTrade.direction||committedTrade.symbol!==latestTrade.symbol||committedTrade.opportunityScore!==latestTrade.opportunityScore||canonical(committedTrade.initialPlan)!==canonical(latestTrade.initialPlan))return no('FROZEN_EVIDENCE_CONFLICT');
  return {allowed:true,reasonCode:'ELIGIBLE'};
 }catch{return no('MALFORMED_TRADE');}
}
export function projectMessage(trade){
 const allowed=shouldNotifyReadyTrade({committedTrade:trade,latestTrade:trade,canonicalEligibilityPassed:true,now:instant(trade?.initialPlan?.createdAt)});
 if(!allowed.allowed)throw Error('PROJECTION_INVALID');
 const p=trade.initialPlan;
 return ['🟢 НОВЫЙ SETUP · A+','',`${trade.symbol} · ${trade.direction.toUpperCase()}`,'Grade: A+',`Opportunity Score: ${trade.opportunityScore}`,'',`Detected: ${new Date(instant(p.createdAt)).toISOString()}`,'',`Entry Zone: ${p.entryZone.from}–${p.entryZone.to}`,`Planned Entry: ${p.entryPrice}`,`Initial SL: ${p.initialStopLoss}`,`TP1: ${p.takeProfit1}`,'',`Статус при проверке: ${trade.outcome.status}`,'State may have changed.','Verify current Trade Plan before manual entry.','','Dashboard:',DASHBOARD_URL].join('\n');
}
export function findLatestTrade(document,id){
 try{
  let rows=document;if(typeof rows==='string'){if(Buffer.byteLength(rows,'utf8')>16*1024*1024)return null;rows=JSON.parse(rows);}
  if(!Array.isArray(rows)||!validId(id))return null;const ids=new Set(),setups=new Set();let found=null;
  for(const row of rows){if(!object(row)||!validId(row.tradeId)||!validId(row.setupKey)||!object(row.initialPlan)||!object(row.outcome)||!['WaitingEntry','Pending','Active'].includes(row.outcome.status)||ids.has(row.tradeId)||setups.has(row.setupKey))return null;ids.add(row.tradeId);setups.add(row.setupKey);if(row.tradeId===id)found=row;}
  return found;
 }catch{return null;}
}
export function validateConfig(config){try{return object(config)&&typeof config.TELEGRAM_BOT_TOKEN==='string'&&/^[A-Za-z0-9:_-]{8,512}$/.test(config.TELEGRAM_BOT_TOKEN)&&typeof config.TELEGRAM_CHAT_ID==='string'&&/^-?\d{1,20}$/.test(config.TELEGRAM_CHAT_ID);}catch{return false;}}
export function interpretAcknowledgement(response,chatId){
 try{
  if(!object(response)||!Number.isInteger(response.httpStatus))return {status:'UNKNOWN',reasonCode:'ACK_UNCERTAIN'};
  let b=response.body;if(typeof b==='string'){if(Buffer.byteLength(b,'utf8')>16384)return {status:'UNKNOWN',reasonCode:'ACK_UNCERTAIN'};b=JSON.parse(b);}
  if(response.httpStatus===200&&b?.ok===true&&Number.isSafeInteger(b.result?.message_id)&&b.result.message_id>0&&String(b.result.chat?.id)===chatId)return {status:'SENT',reasonCode:'PROVIDER_CONFIRMED',messageId:b.result.message_id};
  if(response.httpStatus>=400&&response.httpStatus<500&&b?.ok===false&&b.error_code===response.httpStatus)return {status:'FAILED',reasonCode:'PROVIDER_REJECTED'};
 }catch{}
 return {status:'UNKNOWN',reasonCode:'ACK_UNCERTAIN'};
}
const systemClock={now:()=>Date.now(),setTimeout:(f,n)=>setTimeout(f,n),clearTimeout:id=>clearTimeout(id)};
function context(clock,deadline){const start=clock.now();if(!finite(start))throw Error('CLOCK');return {clock,deadline:Math.min(start+TOTAL_BUDGET_MS,finite(deadline)?deadline:Infinity)};}
function remaining(ctx){return Math.max(0,ctx.deadline-ctx.clock.now());}
async function bounded(ctx,operation,cap=TOTAL_BUDGET_MS){
 const ms=Math.min(cap,remaining(ctx));if(!(ms>0))return {kind:'DEADLINE'};const controller=new AbortController();let timer;
 const work=Promise.resolve().then(()=>{if(remaining(ctx)<=0)return {kind:'DEADLINE'};return operation(controller.signal);}).then(value=>({kind:'VALUE',value}),()=>({kind:'ERROR'}));
 const timeout=new Promise(resolve=>{timer=ctx.clock.setTimeout(()=>{controller.abort();resolve({kind:'TIMEOUT'});},ms);});
 try{return await Promise.race([work,timeout]);}finally{ctx.clock.clearTimeout(timer);}
}
const skipped=reasonCode=>({status:'SKIPPED',reasonCode,autoResend:false});
// Adapter contract: claim is atomic NX, existing records block sends; finalize is
// ownership-checked CLAIMED -> terminal and MUST retain a permanent tombstone (expiresAt: null).
// No production adapters are supplied by this module.
async function attempt(item,options,ctx){
 let key,attemptId,expiry,claimed=false,providerInvoked=false;
 const finish=async result=>{
  let statusPersisted=false;
  if(claimed&&remaining(ctx)>0){const saved=await bounded(ctx,signal=>options.storage.finalize({key,attemptId,expectedStatus:'CLAIMED',status:result.status,reasonCode:result.reasonCode,messageId:result.messageId??null,completedAt:ctx.clock.now(),expiresAt:expiry,signal}));statusPersisted=saved.kind==='VALUE'&&saved.value?.updated===true;}
  return {...result,statusPersisted,autoResend:false};
 };
 try{
  if(remaining(ctx)<=0)return skipped('BUDGET_EXHAUSTED');
  const t=item.committedTrade,initial=shouldNotifyReadyTrade({...item,latestTrade:t,now:ctx.clock.now()});if(!initial.allowed)return skipped(initial.reasonCode);
  let text=projectMessage(t);key=notificationKey(t.tradeId);attemptId=randomUUID();expiry=null;
  const claim=await bounded(ctx,signal=>options.storage.claim({key,record:{schema:'ready-trade-v1',safeTradeId:safeTradeId(t.tradeId),status:'CLAIMED',attemptId,claimedAt:ctx.clock.now(),expiresAt:expiry},expiresAt:expiry,signal}));
  if(claim.kind!=='VALUE'||claim.value?.acquired!==true)return skipped(claim.kind==='VALUE'&&claim.value?.acquired===false?'ALREADY_CLAIMED':'CLAIM_UNCERTAIN');
  claimed=true;
  const read=await bounded(ctx,signal=>options.latestState.read({signal}));
  if(read.kind!=='VALUE')return finish({status:'FAILED',reasonCode:'LATEST_STATE_UNAVAILABLE'});
  const latest=findLatestTrade(read.value,t.tradeId),guard=shouldNotifyReadyTrade({...item,latestTrade:latest,now:ctx.clock.now()});
  if(!guard.allowed)return finish({status:'FAILED',reasonCode:'LATEST_STATE_REJECTED'});
  text=projectMessage(latest);
  if(remaining(ctx)<=0)return finish({status:'FAILED',reasonCode:'BUDGET_EXHAUSTED'});
  const sent=await bounded(ctx,signal=>{if(remaining(ctx)<=0)throw Error('DEADLINE');providerInvoked=true;return options.provider.send({config:options.config,payload:{chat_id:options.config.TELEGRAM_CHAT_ID,text},signal,timeoutMs:Math.min(PROVIDER_TIMEOUT_MS,remaining(ctx))});},PROVIDER_TIMEOUT_MS);
  if(sent.kind!=='VALUE')return finish({status:providerInvoked?'UNKNOWN':'FAILED',reasonCode:providerInvoked?'DELIVERY_UNCERTAIN':'BUDGET_EXHAUSTED'});
  return finish(interpretAcknowledgement(sent.value,options.config.TELEGRAM_CHAT_ID));
 }catch{return claimed?finish({status:providerInvoked?'UNKNOWN':'FAILED',reasonCode:'NOTIFICATION_ERROR'}):skipped('NOTIFICATION_ERROR');}
}
async function batch(options,ctx){
 try{
  if(!validateConfig(options.config))return {results:[skipped('CONFIG_INVALID')]};
  options={...options,config:{TELEGRAM_BOT_TOKEN:options.config.TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID:options.config.TELEGRAM_CHAT_ID}};
  if(!Array.isArray(options.trades)||options.trades.length>20||typeof options.storage?.claim!=='function'||typeof options.storage?.finalize!=='function'||typeof options.latestState?.read!=='function'||typeof options.provider?.send!=='function')return {results:[skipped('ADAPTER_INVALID')]};
  const results=[];for(const item of options.trades)results.push(remaining(ctx)>0?await attempt(item,options,ctx):skipped('BUDGET_EXHAUSTED'));return {results};
 }catch{return {results:[skipped('NOTIFICATION_ERROR')]};}
}
export async function notifyReadyTrades(options={}){try{return await batch(options,context(options.clock||systemClock,options.deadline));}catch{return {results:[skipped('NOTIFICATION_ERROR')]};}}
export async function notifyReadyTrade(options={}){try{const result=await notifyReadyTrades({...options,trades:[{committedTrade:options.committedTrade,canonicalEligibilityPassed:options.canonicalEligibilityPassed}]});return result.results[0];}catch{return skipped('NOTIFICATION_ERROR');}}
// Future caller boundary: loader/import failures are notification-only failures.
export async function runNotificationHook(loader,options={}){try{const ctx=context(options.clock||systemClock),loaded=await bounded(ctx,()=>loader());if(loaded.kind!=='VALUE'||typeof loaded.value?.notifyReadyTrades!=='function')return {results:[skipped('MODULE_UNAVAILABLE')]};const result=await bounded(ctx,()=>loaded.value.notifyReadyTrades({...options,clock:ctx.clock,deadline:ctx.deadline}));return result.kind==='VALUE'?result.value:{results:[skipped('MODULE_UNAVAILABLE')]};}catch{return {results:[skipped('MODULE_UNAVAILABLE')]};}}
