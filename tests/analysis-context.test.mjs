import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
function runtime(){const c=vm.createContext({process:{env:{}},Date,URL,AbortSignal,console,setTimeout});vm.runInContext(source,c);return c;}
const start=Date.parse('2026-09-08T10:00:00Z'), minute=60000;
const time=n=>new Date(start+n*minute).toISOString();
const mirror=(price,d)=>d==='Short'?200-price:price;
const candle=(n,o,h,l,c,d='Long')=>({timestamp:start+n*minute,open:mirror(o,d),high:mirror(d==='Short'?l:h,d),low:mirror(d==='Short'?h:l,d),close:mirror(c,d),confirmed:true});
function plan(c,d='Long'){return {entryPrice:100,entryZone:{from:99,to:101},stopLoss:mirror(90,d),initialStopLoss:mirror(90,d),takeProfit1:mirror(110,d),takeProfit2:mirror(120,d),takeProfit3:mirror(130,d),plannedAt:time(0),expiresAt:time(60),exitStrategy:c.createPartialExitStrategy()};}
const active=()=>({status:'Active',entryPrice:100,activatedAt:time(0),lastPriceCheckedAt:time(0)});
const evaluate=(c,p,previous,data,now=10,d='Long')=>c.evaluateTradeLifecycle({initialPlan:p,direction:d,previousOutcome:previous,capturedAt:time(now),priceRange:data===null?null:{source:'OKX 1m candles',data}});


function payload(){return {time:time(2),technical:{bos:'Bullish BOS',choch:'Bullish CHOCH',mss:'Bullish MSS',trend:'Strong Bullish',ema20:105,ema50:100,ema100:95,ema200:90,rsi14:60,macd:{macd:2,signal:1,histogram:1,extra:'omit'},smartMoney:{score:75},volumeStats:{ratio:1.5,spike:true},extra:'omit'},dataSafety:{candles:{fresh:true,source:'OKX',timeframe:'1D',instrumentType:'SWAP',instId:'TEST-USDT-SWAP',lastConfirmedAt:time(-60)}}};}
function signal(c){const p=plan(c);const item={...p,symbol:'TESTUSDT',direction:'Long',price:100,opportunityScore:90,confidence:90,riskReward:2,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true}};const s=c.createFrozenTradeCandidate(item,time(0));s.outcome=evaluate(c,s.initialPlan,active(),[candle(0,105,111,104,110)],1);return s;}
test('compact current scanner projection carries all five groups, source time and no raw technical data',()=>{
 const c=runtime(),p=payload(),before=JSON.stringify(p),x=c.createScannerAnalysis(p,'TESTUSDT').analysisContext;
 assert.ok(x);assert.deepEqual(Object.keys(x).sort(),['symbol','analysisAt','source','timeframe','lastConfirmedAt','structure','trend','momentum','smartMoney','volume'].sort());
 assert.equal(x.structure.bos,p.technical.bos);assert.equal(x.trend.ema200,90);assert.equal(x.momentum.macd.histogram,1);assert.equal(x.smartMoney.score,75);assert.equal(x.volume.ratio,1.5);assert.equal(x.volume.spike,true);assert.equal(x.analysisAt,time(2));assert.equal(x.lastConfirmedAt,time(-60));assert.equal(x.momentum.macd.extra,undefined);assert.equal(JSON.stringify(p),before);
 assert.match(source,/analysisContext: item.analysisContext/);
});
for(const change of [p=>delete p.time,p=>p.time='bad',p=>p.dataSafety.candles.fresh=false,p=>p.dataSafety.candles.instId='OTHER-USDT-SWAP',p=>p.technical.rsi14=NaN,p=>delete p.technical.macd,p=>p.technical.bos='Unknown']) test('invalid current source fails closed '+change,()=>{const c=runtime(),p=payload();change(p);assert.equal(c.createScannerAnalysis(p,'TESTUSDT').analysisContext,null);});
test('freshness uses original analysis and confirmed close timestamps, not renewed Ranking time',()=>{
 const c=runtime(),x=c.createCurrentAnalysisContext(payload(),'TESTUSDT');
 assert.ok(c.validateCurrentAnalysisContext(x,'TESTUSDT',time(17)));
 for(const [v,now] of [[x,time(18)],[x,time(1)],[{...x,analysisAt:'bad'},time(2)],[{...x,lastConfirmedAt:time(-1500)},time(2)],[{...x,lastConfirmedAt:time(3)},time(2)],[null,time(2)]]) assert.equal(c.validateCurrentAnalysisContext(v,'TESTUSDT',now),null);
});
for(const mode of ['fresh','missing','stale','absent-row']) test('Active post-TP1 transport without current A+: '+mode,async()=>{
 const c=runtime(),s=signal(c),snapshot=JSON.stringify(s),context=c.createCurrentAnalysisContext(payload(),'TESTUSDT');
 s.researchSnapshot={frozen:true,analysisContext:context};s.analysisContext=context;
 const frozen=JSON.stringify(s.researchSnapshot);const row={...s,opportunityScore:20,grade:'D',action:'Wait',tradeAllowed:false,tradeReadiness:{ready:false}};
 delete row.researchSnapshot;delete row.analysisContext;
 if(mode==='fresh')row.analysisContext=context;
 if(mode==='stale')row.analysisContext={...context,analysisAt:time(-20)};
 let received,requests=0;const original=c.evaluateTradeLifecycle;
 c.evaluateTradeLifecycle=args=>{received=args.analysisContext;return original(args);};
 c.fetchOKXRecentPriceRange=async()=>{requests++;return {source:'OKX 1m candles',data:[candle(1,115,140,110,130)]};};
 const out=await c.createRankingHistoryEntry({generatedAt:time(2),globalRanking:mode==='absent-row'?[]:[row]},{readySignals:[s]});
 assert.equal(requests,1);assert.equal(received===null,mode!=='fresh');if(mode==='fresh')assert.equal(received.analysisAt,time(2));
 const next=out.readySignals[0];assert.equal(next.outcome.status,'Active');assert.equal(next.outcome.reanalysisPending,true);assert.equal(next.outcome.remainingPosition,.5);assert.equal(next.outcome.resultR,null);assert.equal(next.outcome.currentStopLoss,100);assert.equal(next.analysisContext,undefined);assert.equal(next.outcome.analysisContext,undefined);assert.equal(JSON.stringify(next.researchSnapshot),frozen);
 c.fetchOKXRecentPriceRange=async()=>({source:'OKX 1m candles',data:[candle(2,105,106,99,100)]});
 const stopped=await c.createRankingHistoryEntry({generatedAt:time(3),globalRanking:[]},{readySignals:[next]});
 assert.equal(stopped.readySignals[0].outcome.resultR,.5);
});
test('projection cannot grant A+ and transport does not introduce IO',()=>{
 const c=runtime(),x=c.createScannerAnalysis(payload(),'TESTUSDT');assert.equal(c.isConfirmedAPlusTrade(x),false);
 for(const name of ['createCurrentAnalysisContext','validateCurrentAnalysisContext'])assert.doesNotMatch(String(c[name]),/fetch\(|runRedis|researchSnapshot/);
});
