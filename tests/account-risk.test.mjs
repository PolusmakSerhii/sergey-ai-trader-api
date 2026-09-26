import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const now=Date.UTC(2026,8,23,12),day=86400000;
function runtime(){const c=vm.createContext({Date,URL,URLSearchParams,AbortSignal,structuredClone,process:{env:{}},console,fetch(){throw Error('Network forbidden');}});vm.runInContext(source,c);return c;}
const inputs=()=>({now,account:{balance:10000,riskPercent:.5,maxOpenRiskPercent:2,maxTrades:3,leverage:2,
  openRiskAmount:20,openTrades:1,usedMargin:100,confirmedCurrent:true,asOf:new Date(now).toISOString()},
  plan:{entryPrice:100,entryZone:{from:99,to:101},stopLoss:90,initialStopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130},direction:'Long',dataSafety:{status:'READY',reasonCodes:[]}});
const sources=()=>({now,price:{ok:true,source:'OKX',instrumentType:'SWAP',instId:'BTC-USDT-SWAP',price:100,timestamp:now-1000},
  candles:{ok:true,source:'OKX',instrumentType:'SWAP',instId:'BTC-USDT-SWAP',data:[{confirmed:true,openTime:now-day-3600000,open:99,high:110,low:90,close:100}]}});
for(const direction of ['Long','Short'])test(direction+' sizing reuses frozen reference and is symmetric',()=>{
 const c=runtime(),x=inputs();x.direction=direction;x.plan.stopLoss=x.plan.initialStopLoss=direction==='Long'?90:110;if(direction==='Short')Object.assign(x.plan,{takeProfit1:90,takeProfit2:80,takeProfit3:70});
 const r=c.calculateAccountRisk(x);assert.equal(r.status,'READY');assert.equal(r.calculation.riskAmount,50);
 assert.equal(r.calculation.positionNotional,500);assert.equal(r.calculation.requiredMargin,250);
 assert.equal(r.calculation.expectedGrossLossAtSL,50);assert.equal(r.executionAuthorized,false);
 assert.equal(r.quantity,null);assert.equal(r.costs.netRisk,null);
});
for(const value of [null,0,-1,NaN,Infinity,'100'])test('invalid balance '+value,()=>{
 const x=inputs();x.account.balance=value;const r=runtime().calculateAccountRisk(x);assert.equal(r.status,'UNAVAILABLE');assert.equal(r.calculation,null);
});
for(const [field,value,reason]of [['entryPrice',0,'INVALID_FROZEN_PLAN'],['stopLoss',101,'INVALID_FROZEN_PLAN'],['stopLoss',100,'INVALID_FROZEN_PLAN']])test(reason+value,()=>{
 const x=inputs();x.plan[field]=value;assert.equal(runtime().calculateAccountRisk(x).reasonCodes[0],reason);
});
test('risk/trade/margin controls block without hidden account assumptions',()=>{
 const c=runtime(),x=inputs();x.account.openRiskAmount=200;x.account.openTrades=3;x.account.usedMargin=9999;
 const r=c.calculateAccountRisk(x);assert.equal(r.status,'BLOCKED');assert.deepEqual(Array.from(r.reasonCodes),['RISK_LIMIT_EXCEEDED','MAX_TRADES_REACHED','INSUFFICIENT_MARGIN']);
 delete x.account.openRiskAmount;assert.equal(c.calculateAccountRisk(x).status,'UNAVAILABLE');
});
test('leverage changes margin only, no dollar-risk multiplication',()=>{
 const c=runtime(),x=inputs(),a=c.calculateAccountRisk(x);x.account.leverage=5;const b=c.calculateAccountRisk(x);
 assert.equal(b.calculation.requiredMargin,100);assert.equal(b.calculation.riskAmount,a.calculation.riskAmount);
});
test('stale account observation rejected',()=>{const x=inputs();x.account.asOf=new Date(now-60001).toISOString();assert.equal(runtime().calculateAccountRisk(x).reasonCodes[0],'STALE_ACCOUNT_STATE');});
for(const [name,mutate,reason]of [
 ['stale price',s=>s.price.timestamp=now-60001,'STALE_PRICE'],
 ['stale candles',s=>s.candles.data[0].openTime=now-3*day,'STALE_CANDLES'],
 ['instrument',s=>s.price.instrumentType='SPOT','INSTRUMENT_MISMATCH'],
 ['symbol',s=>s.price.instId='ETH-USDT-SWAP','INSTRUMENT_MISMATCH'],
 ['future',s=>s.price.timestamp=now+1,'MISSING_OR_INVALID_PRICE'],
 ['unknown timestamp',s=>delete s.price.timestamp,'MISSING_OR_INVALID_PRICE'],
 ['unconfirmed',s=>s.candles.data[0].confirmed=false,'MISSING_OR_INVALID_CANDLES']])test(name+' blocks risk READY',()=>{
 const c=runtime(),s=sources();mutate(s);const d=c.assessExecutionData(s);assert.ok(d.reasonCodes.includes(reason));
 const x=inputs();x.dataSafety=d;assert.equal(c.calculateAccountRisk(x).status,'BLOCKED');
});
test('fresh actual daily close, not response timestamp, allows calculation',()=>{
 const c=runtime(),d=c.assessExecutionData(sources());assert.equal(d.status,'READY');assert.equal(d.candles.ageMs,3600000);
 assert.equal(d.price.ageMs,1000);const x=inputs();x.dataSafety=d;assert.equal(c.calculateAccountRisk(x).status,'READY');
});
test('missing optional flow stays null with stable reason codes and no score effect',()=>{
 const c=runtime(),a=c.calculateLiquidationFlow(null,'unavailable'),b=c.calculateOpenInterestPriceContext({ok:false},sources().candles.data,now);
 assert.equal(a.longUsd,null);assert.equal(a.shortUsd,null);assert.equal(a.reasonCode,'PROVIDER_UNAVAILABLE');
 assert.equal(b.openInterestChangePct,null);assert.equal(b.reasonCode,'PROVIDER_UNAVAILABLE');
 assert.equal(a.affectsTradingScore,false);assert.equal(b.affectsTradingScore,false);
 assert.equal(c.calculateOIPrice4h({ok:false},{ok:false},now).reasonCode,'PROVIDER_UNAVAILABLE');
});
test('ticker uses requested instrument and rejects unexpected provider instId',async()=>{
 const c=runtime();let called;
 c.fetch=async url=>{called=url.toString();return {ok:true,json:async()=>({code:'0',data:[{instId:'BTC-USDT',last:'100',ts:String(now)}]})};};
 assert.equal((await c.fetchOKXTicker('BTCUSDT','SPOT')).instrumentType,'SPOT');assert.ok(!called.includes('SWAP'));
 assert.equal((await c.fetchOKXTicker('BTCUSDT','SWAP')).ok,false);
});
test('risk endpoint reuses frozen trade, ignores client plan, performs no writes or duplicate registration',async()=>{
 const c=runtime(),calls=[],t=Date.now(),s=sources();s.now=t;s.price.timestamp=t;s.candles.data[0].openTime=t-day-3600000;
 const trade={tradeId:'test',setupKey:'TEST:Long',symbol:'BTCUSDT',direction:'Long',action:'Strong Buy',opportunityScore:90,
 confidence:90,riskReward:2,tradeAllowed:true,tradeReadiness:{ready:true},initialPlan:{entryPrice:100,entryZone:{from:99,to:101},stopLoss:90,initialStopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,expiresAt:new Date(t+3600000).toISOString()},outcome:{status:'WaitingEntry'}};
 const before=JSON.stringify(trade);c.getRedisConfig=()=>({});c.runRedisCommand=async cmd=>{calls.push(cmd);assert.equal(cmd[0],'GET');return JSON.stringify([trade]);};
 c.fetchOKXTicker=async()=>s.price;c.fetchOKXKlines=async()=>s.candles;
 c.registerOpenTrade=async()=>assert.fail();c.collectValidationArchive=async()=>assert.fail();
 const account={...inputs().account,asOf:new Date(t).toISOString()};
 const r=await c.readAccountRisk({tradeId:'test',account,plan:{entryPrice:500},confirmedAPlus:true});
 assert.equal(r.status,'READY');assert.equal(r.calculation.referenceEntry,100);assert.equal(calls.length,1);assert.equal(JSON.stringify(trade),before);
 s.price.price=500;
 const outside=await c.readAccountRisk({tradeId:'test',account,plan:{entryPrice:500,stopLoss:490}});
 assert.equal(outside.reasonCodes[0],'OUTSIDE_ENTRY_ZONE');assert.equal(outside.calculation.referenceEntry,100);
 s.price.price=100;trade.outcome.status='Pending';
 assert.equal((await c.readAccountRisk({tradeId:'test',account})).calculation.initialStopLoss,90);
 trade.outcome.status='Active';trade.outcome.entryPrice=99.5;trade.outcome.currentStopLoss=99.5;const frozen=JSON.stringify(trade.initialPlan);
 const active=await c.readAccountRisk({tradeId:'test',account});assert.equal(active.reasonCodes[0],'EXISTING_ACTIVE_TRADE');assert.equal(active.mode,'existing-position');assert.equal(active.reference.actualEntry,99.5);assert.equal(active.reference.plannedEntry,100);assert.equal(active.reference.currentStopLoss,99.5);assert.equal(active.calculation,null);assert.equal(JSON.stringify(trade.initialPlan),frozen);
});
test('Redis failure cannot fabricate READY',async()=>{const c=runtime();c.getRedisConfig=()=>({});c.runRedisCommand=async()=>{throw Error('offline');};await assert.rejects(c.readAccountRisk({tradeId:'x'}));});

test('mapped SWAP uses exact SWAP quote, CoinGecko supplies metadata only',async()=>{
 const c=runtime(),start=source.indexOf('let coin = null;'),end=source.indexOf('\nif (\n  !coin ||',start);
 assert.ok(start>0&&end>start);Object.assign(c,{coinGeckoId:'bitcoin',symbol:'BTCUSDT',instrumentType:'SWAP'});
 c.fetch=async()=>({ok:true,json:async()=>[{current_price:99,id:'bitcoin',name:'Bitcoin',market_cap_rank:1,last_updated:new Date(now).toISOString()}]});
 c.fetchOKXTicker=async(symbol,type)=>{assert.equal(symbol,'BTCUSDT');assert.equal(type,'SWAP');return {ok:true,price:101,timestamp:now,instrumentType:type,instId:'BTC-USDT-SWAP'};};
 await vm.runInContext('(async()=>{'+source.slice(start,end)+';globalThis.result={coin,executionPrice};})()',c);
 assert.equal(c.result.coin.current_price,101);assert.equal(c.result.coin.market_cap_rank,1);assert.equal(c.result.executionPrice.timestamp,now);
});
test('new safety functions do not call canonical registration, statistics or archives',()=>{
 const section=source.slice(source.indexOf('// Read-only, user-declared account scenario.'),source.indexOf('// Non-critical audit projection.'));
 assert.doesNotMatch(section,/registerOpenTrade\(|recordCompletedTradeSignals\(|collectValidationArchive\(|calculateScannerOpportunity\(/);
 assert.doesNotMatch(section,/\["(?:SET|EVAL|DEL|LPUSH)"/);
});

for(const mutate of [p=>delete p.entryZone,p=>p.entryZone.from=102,p=>p.entryPrice=99,p=>delete p.initialStopLoss,p=>p.initialStopLoss=100,p=>p.initialStopLoss=Infinity,p=>p.takeProfit2=NaN])test('damaged frozen reference blocks sizing without fallback '+String(mutate),()=>{
 const x=inputs();mutate(x.plan);x.livePlan={entryPrice:100,stopLoss:90};x.price=100;
 const r=runtime().calculateAccountRisk(x);assert.equal(r.status,'BLOCKED');assert.equal(r.calculation,null);
});
test('frozen sizing ignores market price and live plan and preserves algebra',()=>{
 const x=inputs();x.price=500;x.livePlan={entryPrice:500,stopLoss:490};
 const r=runtime().calculateAccountRisk(x);assert.equal(r.calculation.referenceEntry,100);
 assert.equal(r.calculation.positionNotional,r.calculation.riskAmount*100/Math.abs(100-90));
});
test('completed and ambiguous identities never become sizing opportunities',async()=>{
 const c=runtime();c.getRedisConfig=()=>({});c.fetchOKXTicker=async()=>assert.fail('no provider call');
 for(const status of ['Stopped','TP3Hit','TP1Hit','Completed','Expired']){
 c.runRedisCommand=async()=>JSON.stringify([{tradeId:'x',setupKey:'x',initialPlan:inputs().plan,outcome:{status}}]);
 await assert.rejects(c.readAccountRisk({tradeId:'x',account:inputs().account}));
 }
 const trade={tradeId:'x',setupKey:'x',initialPlan:inputs().plan,outcome:{status:'WaitingEntry'}};
 c.runRedisCommand=async()=>JSON.stringify([trade,trade]);await assert.rejects(c.readAccountRisk({tradeId:'x'}));
 c.runRedisCommand=async()=>JSON.stringify([]);assert.equal((await c.readAccountRisk({tradeId:'old'})).status,'UNAVAILABLE');
});

for(const direction of ['Long','Short'])for(const sl of [0,100,NaN,Infinity])test(`invalid ${direction} frozen SL ${sl} blocks`,()=>{
 const x=inputs();x.direction=direction;x.plan.initialStopLoss=x.plan.stopLoss=sl;
 assert.equal(runtime().calculateAccountRisk(x).calculation,null);
});

const projectionInput = (c, direction = 'Long') => {
 const plan = inputs().plan;
 if (direction === 'Short') Object.assign(plan,{stopLoss:110,initialStopLoss:110,takeProfit1:90,takeProfit2:80,takeProfit3:70});
 plan.exitStrategy = c.createPartialExitStrategy();
 return {plan,direction,riskAmount:10,lifecycleStatus:'WaitingEntry',instrument:{source:'OKX',instrumentType:'SWAP',ctType:'linear',settleCcy:'USDT'}};
};
for (const direction of ['Long','Short']) test(`planned ${direction} partial contributions use frozen fractions`,()=>{
 const c=runtime(),x=projectionInput(c,direction),before=JSON.stringify(x),p=c.calculatePlannedTargetPotential(x);
 assert.deepEqual([p.tp1.contribution,p.tp2.contribution,p.tp3.contribution],[2.5,5,15]);
 assert.equal(p.weightedAmount,22.5);assert.equal(p.weightedR,2.25);assert.equal(JSON.stringify(x),before);
 const sign=direction==='Long'?1:-1;
 for(const [i,target] of [x.plan.takeProfit1,x.plan.takeProfit2,x.plan.takeProfit3].entries())
  assert.equal(p['tp'+(i+1)].contribution,10/10*sign*(target-100)*[.25,.25,.5][i]);
});
test('nonuniform frozen geometry, leverage and live inputs do not alter planned basis',()=>{
 const c=runtime(),x=projectionInput(c);Object.assign(x.plan,{takeProfit1:112,takeProfit2:125,takeProfit3:137});
 const a=c.calculatePlannedTargetPotential(x);assert.ok(Math.abs(a.weightedR-2.775)<1e-12);assert.ok(Math.abs(a.weightedAmount-27.75)<1e-12);
 const accountInput=inputs();accountInput.plan=x.plan;
 const low=c.calculateAccountRisk(accountInput);accountInput.account.leverage=10;const high=c.calculateAccountRisk(accountInput);
 assert.notEqual(low.calculation.requiredMargin,high.calculation.requiredMargin);
 assert.equal(low.calculation.riskAmount,high.calculation.riskAmount);
 assert.equal(JSON.stringify(c.calculatePlannedTargetPotential({...x,riskAmount:low.calculation.riskAmount})),JSON.stringify(c.calculatePlannedTargetPotential({...x,riskAmount:high.calculation.riskAmount,price:900,livePlan:{takeProfit1:999}})));
});
for(const [name,mutate] of [
 ['entry',x=>x.plan.entryPrice=0],['stop',x=>x.plan.initialStopLoss=100],
 ['nonfinite',x=>x.plan.takeProfit1=Infinity],['target order',x=>x.plan.takeProfit2=109],
 ['target side',x=>x.plan.takeProfit1=95],['missing strategy',x=>delete x.plan.exitStrategy],
 ['legacy',x=>x.plan.exitStrategy.version='legacy'],['fractions',x=>x.plan.exitStrategy.allocations.TP3=.4],
 ['other allocation',x=>Object.assign(x.plan.exitStrategy.allocations,{TP1:.2,TP2:.3})],
 ['zero risk',x=>x.riskAmount=0],['unknown metadata',x=>delete x.instrument.ctType],
 ['SWAP alone',x=>x.instrument={instrumentType:'SWAP',instId:'BTC-USDT-SWAP'}],
 ['inverse',x=>x.instrument.ctType='inverse'],['settlement',x=>x.instrument.settleCcy='BTC'],
 ...['Active','Completed','Expired','Stopped','TP3Hit'].map(status=>[status,x=>x.lifecycleStatus=status])
]) test('planned potential fails closed: '+name,()=>{const c=runtime(),x=projectionInput(c);mutate(x);assert.equal(c.calculatePlannedTargetPotential(x),null);});
test('Pending supports projection; current ticker metadata cannot prove monetary semantics',()=>{
 const c=runtime(),x=projectionInput(c);x.lifecycleStatus='Pending';assert.ok(c.calculatePlannedTargetPotential(x));
 x.instrument=sources().price;assert.equal(c.calculatePlannedTargetPotential(x),null);
 assert.equal(c.calculateAccountRisk(inputs()).targetPotential,null);
});
test('endpoint keeps unsupported metadata null, ignores client evidence, and gates final risk state',async()=>{
 const c=runtime(),t=Date.now(),s=sources(),x=projectionInput(c),counts={redis:0,ticker:0,candles:0};
 s.price.timestamp=t;s.candles.data[0].openTime=t-day-3600000;
 const trade={tradeId:'test',setupKey:'BTC:Long',symbol:'BTCUSDT',direction:'Long',action:'Strong Buy',opportunityScore:90,confidence:90,riskReward:2,tradeAllowed:true,tradeReadiness:{ready:true},initialPlan:{...x.plan,expiresAt:new Date(t+3600000).toISOString()},outcome:{status:'WaitingEntry'}};
 c.getRedisConfig=()=>({});c.runRedisCommand=async cmd=>{assert.equal(cmd[0],'GET');counts.redis++;return JSON.stringify([trade]);};
 c.fetchOKXTicker=async()=>{counts.ticker++;return s.price;};c.fetchOKXKlines=async()=>{counts.candles++;return s.candles;};
 const body={tradeId:'test',account:{...inputs().account,asOf:new Date(t).toISOString()},instrument:x.instrument,plan:x.plan};
 let r=await c.readAccountRisk(body);assert.equal(r.targetPotential,null);assert.equal(r.targetPotentialReason,'UNVERIFIED_INSTRUMENT_OR_EXIT_STRATEGY');assert.deepEqual(counts,{redis:1,ticker:1,candles:1});
 // Authoritative universe fixture, separate from ticker and client metadata.
 c.fetchOKXSwapSymbols=async()=>({ok:true,source:'OKX',symbols:[{instId:'BTC-USDT-SWAP',symbol:'BTC-USDT-SWAP',marketSymbol:'BTCUSDT',instType:'SWAP',ctType:'linear',settleCcy:'USDT',state:'live'}]});r=await c.readAccountRisk(body);assert.equal(r.targetPotential.weightedAmount,112.5);assert.equal(r.executionAuthorized,false);
 s.price.price=100.5;body.plan={takeProfit1:999};assert.equal((await c.readAccountRisk(body)).targetPotential.weightedAmount,112.5);
 s.price.price=500;assert.equal((await c.readAccountRisk(body)).targetPotential,null);
 s.price.price=100;trade.outcome.status='Active';assert.equal((await c.readAccountRisk(body)).targetPotential,null);
 trade.outcome.status='Pending';trade.initialPlan.expiresAt=new Date(t-1).toISOString();assert.equal((await c.readAccountRisk(body)).targetPotential,null);
});

const instrumentRecord=()=>({instId:'BTC-USDT-SWAP',instType:'SWAP',ctType:'linear',settleCcy:'USDT',state:'live',ctVal:'0.01',ctValCcy:'BTC',ctMult:'1',lotSz:'0.01',minSz:'0.01',tickSz:'0.1'});
test('universe normalization preserves authoritative fields and existing filter, cache and concurrent dedupe',async()=>{
 const c=runtime(),raw=instrumentRecord();let calls=0;
 c.fetch=async()=>{calls++;return {ok:true,json:async()=>({code:'0',data:[raw,...[{state:'suspend'},{settleCcy:'BTC'},{instType:'SPOT'}].map(change=>({...raw,...change}))]})};};
 const [a,b]=await Promise.all([c.fetchOKXSwapSymbols(),c.fetchOKXSwapSymbols()]);
 assert.equal(calls,1);assert.equal(a.count,1);assert.equal(b.count,1);
 const item=a.symbols[0];for(const key of Object.keys(raw))assert.equal(item[key],raw[key],key);
 for(const [key,value] of Object.entries({symbol:raw.instId,marketSymbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',settleAsset:'USDT'}))assert.equal(item[key],value);
 item.ctType='inverse';assert.equal((await c.fetchOKXSwapSymbols()).symbols[0].ctType,'linear');assert.equal(calls,1);
 vm.runInContext("sourceResponses.get('okx:symbols').expiresAt = 0",c);
 c.fetch=async()=>{calls++;throw Error('offline');};assert.equal((await c.fetchOKXSwapSymbols()).ok,false);assert.equal(calls,2);
});
for(const [name,change] of [
 ['valid',r=>r],['inverse',r=>({...r,ctType:'inverse'})],['settlement',r=>({...r,settleCcy:'BTC'})],
 ['state',r=>({...r,state:'suspend'})],['type',r=>({...r,instType:'FUTURES'})],
 ['wrong identity',r=>({...r,instId:'ETH-USDT-SWAP'})],['missing identity',r=>({...r,instId:undefined})],
 ['wrong market symbol',r=>({...r,marketSymbol:'ETHUSDT'})],['duplicate',r=>[r,r]],
 ['missing',()=>[]],['failed',()=>null],['throws',()=>{throw Error('offline');}]
])test('authoritative risk lookup '+name,async()=>{
 const c=runtime(),t=Date.now(),s=sources(),x=projectionInput(c);s.price.timestamp=t;s.candles.data[0].openTime=t-day-3600000;
 const trade={tradeId:'test',setupKey:'BTC:Long',symbol:'BTCUSDT',direction:'Long',action:'Strong Buy',opportunityScore:90,confidence:90,riskReward:2,tradeAllowed:true,tradeReadiness:{ready:true},initialPlan:{...x.plan,expiresAt:new Date(t+3600000).toISOString()},outcome:{status:'WaitingEntry'}};
 c.getRedisConfig=()=>({});c.runRedisCommand=async cmd=>{assert.equal(cmd[0],'GET');return JSON.stringify([trade]);};
 c.fetchOKXTicker=async()=>s.price;c.fetchOKXKlines=async()=>s.candles;
 c.fetchOKXSwapSymbols=async()=>{const record=change({...instrumentRecord(),symbol:'BTC-USDT-SWAP',marketSymbol:'BTCUSDT'});return {ok:record!==null,source:'OKX',symbols:Array.isArray(record)?record:[record]};};
 const before=JSON.stringify(trade);
 const r=await c.readAccountRisk({tradeId:'test',account:{...inputs().account,asOf:new Date(t).toISOString()},instrument:instrumentRecord(),ctType:'linear',settleCcy:'USDT'});
 assert.equal(r.status,'READY');assert.equal(r.executionAuthorized,false);assert.equal(JSON.stringify(trade),before);
 if(name==='valid')assert.equal(r.targetPotential.weightedAmount,112.5);else {assert.equal(r.targetPotential,null);assert.equal(r.targetPotentialReason,'UNVERIFIED_INSTRUMENT_OR_EXIT_STRATEGY');}
 assert.equal(r.instrument,undefined);
});
