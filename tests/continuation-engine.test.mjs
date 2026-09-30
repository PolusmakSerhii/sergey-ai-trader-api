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


function ctx(d='Long',n=2){const short=d==='Short';return {symbol:'TESTUSDT',analysisAt:time(n),source:'OKX',timeframe:'1D',lastConfirmedAt:time(-60),structure:{bos:short?'Bearish BOS':'Bullish BOS',choch:short?'Bearish CHOCH':'Bullish CHOCH',mss:short?'Bearish MSS':'Bullish MSS'},trend:{trend:short?'Strong Bearish':'Strong Bullish',ema20:short?90:110,ema50:short?95:105,ema100:short?100:100,ema200:short?105:95},momentum:{rsi14:short?35:65,macd:{macd:short?-2:2,signal:short?-1:1,histogram:short?-1:1}},smartMoney:{score:short?20:80},volume:{ratio:1,spike:false}};}
function weak(d='Long',n=2){const x=ctx(d,n);x.structure={bos:'Inside Range',choch:'No CHOCH',mss:'No MSS'};x.trend={trend:'Neutral',ema20:100,ema50:100,ema100:100,ema200:100};x.momentum={rsi14:50,macd:{macd:0,signal:0,histogram:0}};x.smartMoney.score=50;return x;}
function run(c,p,previous,bars,now,d,x){return c.evaluateTradeLifecycle({initialPlan:p,direction:d,previousOutcome:previous,capturedAt:time(now),priceRange:{source:'OKX 1m candles',data:bars},analysisContext:x});}
function post(c,d){const p=plan(c,d);p.createdAt=time(0);p.exitStrategy=c.createTp1ReanalysisStrategy();return {p,one:evaluate(c,p,active(),[candle(0,105,111,104,110,d)],1,d)};}
for(const d of ['Long','Short']){
 test(`${d}: strong HOLD and weak CLOSE use symmetric approved scoring`,()=>{const c=runtime(),strong=c.calculateContinuationDecision(ctx(d),d,time(2)),low=c.calculateContinuationDecision(weak(d),d,time(2));assert.equal(strong.decision,'HOLD');assert.equal(strong.continuationScore,96.67);assert.equal(low.decision,'CLOSE');assert.equal(low.continuationScore,50);assert.ok(strong.reasons.length<=3);assert.equal(strong.structuralReversal,undefined);});
 test(`${d}: HOLD, identical analysis idempotency, later CLOSE, frozen plan and archived final R`,()=>{
  const c=runtime(),{p,one}=post(c,d),frozen=JSON.stringify(p);
  const hold=run(c,p,one,[candle(1,115,140,110,130,d)],2,d,ctx(d,1));
  assert.equal(hold.status,'Active');assert.equal(hold.remainingPosition,.5);assert.equal(hold.currentStopLoss,100);assert.equal(hold.resultR,null);assert.equal(hold.reanalysisPending,true);assert.equal(hold.exits.length,1);
  const replay=run(c,p,hold,[candle(2,120,150,110,130,d)],3,d,ctx(d,1));assert.deepEqual(replay.lastReanalysis,hold.lastReanalysis);assert.equal(replay.exits.length,1);
  const closed=run(c,p,replay,[candle(3,120,140,110,120,d)],4,d,weak(d,3));
  assert.equal(closed.status,'Closed');assert.equal(closed.exits[1].target,'CLOSE');assert.equal(closed.exits[1].initialFraction,.5);assert.equal(closed.exitPrice,mirror(120,d));assert.equal(closed.resultR,1.5);assert.equal(closed.reanalysisPending,false);assert.equal(closed.remainingPosition,0);assert.equal(closed.lastReanalysis.executionStatus,'executed');
  assert.equal(run(c,p,closed,[],5,d,weak(d,4)),closed);assert.equal(JSON.stringify(p),frozen);
  const signal={symbol:'TESTUSDT',tradeId:'TEST:'+d,direction:d,opportunityScore:90,confidence:90,riskReward:2,action:d==='Long'?'Strong Buy':'Strong Sell',tradeAllowed:true,tradeReadiness:{ready:true},initialPlan:p,outcome:closed,researchSnapshot:{immutable:true}};
  assert.equal(c.isCompletedTradeSignal(signal),true);const archived=c.projectValidationTrade(signal);assert.equal(archived.terminal,true);assert.equal(archived.stage,2);assert.equal(c.hydrateValidationTrade(archived).researchSnapshot.immutable,true);assert.equal(c.addTradeToPersistentStats(c.createEmptyPersistentTradeStats(),signal).netR,1.5);
 });
 test(`${d}: BE beats CLOSE and no decision on missing/stale input`,()=>{
  const c=runtime(),{p,one}=post(c,d);
  for(const x of [null,weak(d,-20)]){const out=run(c,p,one,[candle(1,115,140,110,130,d)],2,d,x);assert.equal(out.status,'Active');assert.equal(out.lastReanalysis,undefined);assert.equal(out.resultR,null);}
  const stopped=run(c,p,one,[candle(1,105,120,99,115,d)],2,d,weak(d,1));assert.equal(stopped.status,'Stopped');assert.equal(stopped.resultR,.5);assert.equal(stopped.exits[1].target,'STOP');
 });
 test(`${d}: no look-ahead; accepted pending CLOSE executes without new input exactly once`,()=>{
  const c=runtime(),{p,one}=post(c,d),x=weak(d,2);
  const pending=run(c,p,one,[candle(1,115,140,110,130,d)],2,d,x);assert.equal(pending.status,'Active');assert.equal(pending.lastReanalysis.executionStatus,'pending');
  const missing=run(c,p,pending,[candle(2,115,140,110,130,d)],3,d,null);assert.equal(missing.status,'Closed');assert.equal(missing.exits.length,2);
  const closed=run(c,p,missing,[candle(3,115,140,110,120,d)],4,d,x);assert.equal(closed.status,'Closed');assert.equal(closed.checkedAt,time(3));assert.equal(closed,missing);
 });
}
test('exactly 70 holds; lower score closes; opposing structure caps total below 70',()=>{const c=runtime(),x=ctx();x.structure=weak().structure;x.smartMoney.score=20;assert.equal(c.calculateContinuationDecision(x,'Long',time(2)).continuationScore,70);assert.equal(c.calculateContinuationDecision(x,'Long',time(2)).decision,'HOLD');x.smartMoney.score=19;assert.equal(c.calculateContinuationDecision(x,'Long',time(2)).decision,'CLOSE');x.structure=ctx('Short').structure;x.smartMoney.score=100;const r=c.calculateContinuationDecision(x,'Long',time(2));assert.equal(r.components.structure,0);assert.equal(r.continuationScore,66.67);assert.equal(r.decision,'CLOSE');});
test('volume is diagnostic only and approved RSI breakpoints are exact',()=>{const c=runtime(),x=ctx(),a=c.calculateContinuationDecision(x,'Long',time(2));x.volume={ratio:99,spike:true};assert.deepEqual(c.calculateContinuationDecision(x,'Long',time(2)),a);for(const [r,score] of [[0,0],[30,0],[40,25],[50,50],[55,75],[60,100],[70,100],[80,75],[90,50],[100,50]]){x.momentum.rsi14=r;assert.equal(c.calculateContinuationDecision(x,'Long',time(2)).components.momentum,(score+100)/2);}});
for(const mutate of [x=>x.structure.choch='Nope',x=>x.structure.mss='Bearish MSS',x=>x.trend.trend='Bullish',x=>x.trend.ema20=80,x=>x.momentum.rsi14=101,x=>x.momentum.macd.signal=99,x=>x.smartMoney.score=NaN,x=>delete x.smartMoney])test('invalid component gives no decision: '+mutate,()=>{const c=runtime(),x=ctx();mutate(x);assert.equal(c.calculateContinuationDecision(x,'Long',time(2)),null);});
test('invalid direction, old analysis and unknown policy cannot close',()=>{const c=runtime(),{p,one}=post(c,'Long');assert.equal(c.calculateContinuationDecision(ctx(),'Neutral',time(2)),null);const old=run(c,p,one,[candle(1,115,140,110,130)],2,'Long',weak('Long',0));assert.equal(old.lastReanalysis,undefined);p.exitStrategy.version='unknown';assert.equal(run(c,p,one,[candle(1,115,140,110,130)],2,'Long',weak('Long',1)).priceCheck.status,'invalid_plan');});

for (const direction of ['Long', 'Short']) {
 test(`${direction}: pending CLOSE freezes 10:04 across fresh cycles and executes original boundary`, () => {
  const c=runtime(), {p,one}=post(c,direction);
  const bars=[1,2,3].map(n=>candle(n,115,125,110,120,direction));
  const pending=run(c,p,one,bars,4,direction,weak(direction,4));
  assert.equal(pending.lastReanalysis.decidedAt,time(4));
  const next=run(c,p,pending,[],5,direction,weak(direction,5));
  assert.deepEqual(next.lastReanalysis,pending.lastReanalysis);
  const hold=run(c,p,next,[],6,direction,ctx(direction,6));
  assert.deepEqual(hold.lastReanalysis,pending.lastReanalysis);
  const closed=run(c,p,hold,[candle(4,115,125,110,120,direction)],7,direction,ctx(direction,7));
  assert.equal(closed.status,'Closed');assert.equal(closed.resultR,1.5);
  assert.equal(closed.exits.length,2);assert.equal(closed.exits[1].initialFraction,.5);
  assert.equal(closed.lastReanalysis.decidedAt,time(4));assert.equal(closed.checkedAt,time(5));
  assert.equal(run(c,p,closed,[],8,direction,ctx(direction,8)),closed);
 });
 test(`${direction}: pending CLOSE survives missing or expired analysis; BE still wins`, () => {
  const c=runtime(),{p,one}=post(c,direction);
  const pending=run(c,p,one,[candle(1,115,125,110,120,direction)],2,direction,weak(direction,2));
  const closed=run(c,p,pending,[candle(2,115,125,110,120,direction)],25,direction,null);
  assert.equal(closed.status,'Closed');assert.equal(closed.resultR,1.5);
  const be=run(c,p,pending,[candle(2,105,120,99,115,direction)],3,direction,ctx(direction,3));
  assert.equal(be.status,'Stopped');assert.equal(be.resultR,.5);assert.equal(be.exits.length,2);
  assert.equal(be.exits[1].target,'STOP');assert.equal(run(c,p,be,[],4,direction,weak(direction,4)),be);
 });
}
