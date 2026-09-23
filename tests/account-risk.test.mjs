import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const now=Date.UTC(2026,8,23,12),day=86400000;
function runtime(){const c=vm.createContext({Date,URL,URLSearchParams,AbortSignal,process:{env:{}},console,fetch(){throw Error('Network forbidden');}});vm.runInContext(source,c);return c;}
const inputs=()=>({now,account:{balance:10000,riskPercent:.5,maxOpenRiskPercent:2,maxTrades:3,leverage:2,
  openRiskAmount:20,openTrades:1,usedMargin:100,confirmedCurrent:true,asOf:new Date(now).toISOString()},
  plan:{entryPrice:100,stopLoss:90},direction:'Long',dataSafety:{status:'READY',reasonCodes:[]}});
const sources=()=>({now,price:{ok:true,source:'OKX',instrumentType:'SWAP',instId:'BTC-USDT-SWAP',price:100,timestamp:now-1000},
  candles:{ok:true,source:'OKX',instrumentType:'SWAP',instId:'BTC-USDT-SWAP',data:[{confirmed:true,openTime:now-day-3600000,open:99,high:110,low:90,close:100}]}});
for(const direction of ['Long','Short'])test(direction+' sizing reuses frozen reference and is symmetric',()=>{
 const c=runtime(),x=inputs();x.direction=direction;x.plan.stopLoss=direction==='Long'?90:110;
 const r=c.calculateAccountRisk(x);assert.equal(r.status,'READY');assert.equal(r.calculation.riskAmount,50);
 assert.equal(r.calculation.positionNotional,500);assert.equal(r.calculation.requiredMargin,250);
 assert.equal(r.calculation.expectedGrossLossAtSL,50);assert.equal(r.executionAuthorized,false);
 assert.equal(r.quantity,null);assert.equal(r.costs.netRisk,null);
});
for(const value of [null,0,-1,NaN,Infinity,'100'])test('invalid balance '+value,()=>{
 const x=inputs();x.account.balance=value;const r=runtime().calculateAccountRisk(x);assert.equal(r.status,'UNAVAILABLE');assert.equal(r.calculation,null);
});
for(const [field,value,reason]of [['entryPrice',0,'INVALID_ENTRY'],['stopLoss',101,'INVALID_STOP'],['stopLoss',100,'INVALID_STOP']])test(reason+value,()=>{
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
 confidence:90,riskReward:2,tradeAllowed:true,tradeReadiness:{ready:true},initialPlan:{entryPrice:100,entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,expiresAt:new Date(t+3600000).toISOString()},outcome:{status:'WaitingEntry'}};
 const before=JSON.stringify(trade);c.getRedisConfig=()=>({});c.runRedisCommand=async cmd=>{calls.push(cmd);assert.equal(cmd[0],'GET');return JSON.stringify([trade]);};
 c.fetchOKXTicker=async()=>s.price;c.fetchOKXKlines=async()=>s.candles;
 c.registerOpenTrade=async()=>assert.fail();c.collectValidationArchive=async()=>assert.fail();
 const account={...inputs().account,asOf:new Date(t).toISOString()};
 const r=await c.readAccountRisk({tradeId:'test',account,plan:{entryPrice:500},confirmedAPlus:true});
 assert.equal(r.status,'READY');assert.equal(r.calculation.referenceEntry,100);assert.equal(calls.length,1);assert.equal(JSON.stringify(trade),before);
 trade.outcome.status='Active';const frozen=JSON.stringify(trade.initialPlan);
 assert.equal((await c.readAccountRisk({tradeId:'test',account})).reasonCodes[0],'EXISTING_ACTIVE_TRADE');assert.equal(JSON.stringify(trade.initialPlan),frozen);
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
