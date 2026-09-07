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
for(const d of ['Long','Short']){
  test(`${d}: TP1/TP2/TP3 close 25/25/50 of initial size; stop stays at actual entry`,()=>{
    const c=runtime(),p=plan(c,d);
    const one=evaluate(c,p,active(),[candle(0,105,111,104,110,d)],1,d);
    assert.equal(one.status,'Active');assert.equal(one.remainingPosition,.75);assert.equal(one.realizedR,.25);
    assert.equal(one.currentStopLoss,100);assert.equal(one.initialStopLoss,mirror(90,d));assert.equal(one.resultR,null);
    assert.equal(one.unrealizedR,.75);assert.equal(one.totalR,1);
    const two=evaluate(c,p,one,[candle(1,111,121,110,120,d)],2,d);
    assert.equal(two.status,'Active');assert.equal(two.remainingPosition,.5);assert.equal(two.realizedR,.75);assert.equal(two.currentStopLoss,100);
    const three=evaluate(c,p,two,[candle(2,121,131,120,130,d)],3,d);
    assert.equal(three.status,'TP3Hit');assert.equal(three.remainingPosition,0);assert.equal(three.realizedR,2.25);assert.equal(three.resultR,2.25);assert.equal(three.totalR,2.25);assert.equal(three.unrealizedR,0);
    assert.deepEqual(Array.from(three.exits,e=>e.initialFraction),[.25,.25,.5]);
    assert.equal(evaluate(c,p,three,[],5,d),three);
  });
  test(`${d}: TP1 then break-even stop realizes +0.25R, not a full-position +1R`,()=>{
    const c=runtime(),p=plan(c,d);
    const out=evaluate(c,p,active(),[candle(0,105,111,104,110,d),candle(1,105,106,99,100,d)],2,d);
    assert.equal(out.status,'Stopped');assert.equal(out.resultR,.25);assert.equal(out.exits[1].initialFraction,.75);
    assert.equal(c.classifyTradeResult({tradeId:'test',outcome:out}),'Win');
  });
  test(`${d}: TP2 then break-even stop retains weighted TP1+TP2 R`,()=>{
    const c=runtime(),p=plan(c,d);
    const out=evaluate(c,p,active(),[candle(0,105,111,104,110,d),candle(1,111,121,110,120,d),candle(2,105,106,99,100,d)],3,d);
    assert.equal(out.status,'Stopped');assert.equal(out.resultR,.75);assert.equal(out.exits[2].initialFraction,.5);
  });
  test(`${d}: initial stop keeps existing conservative same-candle rule`,()=>{
    const c=runtime(),p=plan(c,d);
    const out=evaluate(c,p,active(),[candle(0,100,131,89,110,d)],1,d);
    assert.equal(out.status,'Stopped');assert.equal(out.resultR,-1);assert.equal(out.exits.length,1);assert.equal(out.exits[0].initialFraction,1);
    assert.equal(out.exitCheck.rule,'same-candle-sl-first');
  });
  test(`${d}: all targets in one candle without a new-stop touch close exactly once`,()=>{
    const c=runtime(),p=plan(c,d);
    const out=evaluate(c,p,active(),[candle(0,105,131,104,130,d)],1,d);
    assert.equal(out.status,'TP3Hit');assert.equal(out.resultR,2.25);assert.equal(out.exits.length,3);
  });
  test(`${d}: uncertain new-stop ordering preserves TP1 and cannot double count on retries`,()=>{
    const c=runtime(),p=plan(c,d),bar=candle(0,105,121,99,115,d);
    const out=evaluate(c,p,active(),[bar],1,d);
    assert.equal(out.status,'Active');assert.equal(out.realizedR,.25);assert.equal(out.remainingPosition,.75);
    assert.equal(out.priceCheck.status,'ambiguous_management_candle');assert.equal(out.resultR,null);assert.equal(out.totalR,null);assert.equal(out.lastPriceCheckedAt,time(0));
    const retry=evaluate(c,p,JSON.parse(JSON.stringify(out)),[bar,candle(1,110,131,109,130,d)],2,d);
    assert.equal(retry.exits.length,1);assert.equal(retry.realizedR,.25);assert.equal(retry.priceCheck.status,'ambiguous_management_candle');
  });
  test(`${d}: close beyond new stop confirms TP1 then BE when no later target is touched`,()=>{
    const c=runtime(),p=plan(c,d);
    const out=evaluate(c,p,active(),[candle(0,105,111,99,99,d)],1,d);
    assert.equal(out.status,'Stopped');assert.equal(out.resultR,.25);
  });
  test(`${d}: break-even uses actual zone entry, and original risk stays fixed`,()=>{
    const c=runtime(),p=plan(c,d);
    const entry=d==='Long'?101:99;
    const one=evaluate(c,p,{},[candle(0,105,106,100,103,d)],1,d);
    assert.equal(one.entryPrice,entry);
    const out=evaluate(c,p,one,[candle(1,105,111,104,110,d)],2,d);
    assert.equal(out.currentStopLoss,entry);
    assert.ok(Math.abs(out.realizedR - .25*9/11)<1e-12);
  });
}
test('missing candles preserve realized exits and resume without duplicates',()=>{
  const c=runtime(),p=plan(c);
  const one=evaluate(c,p,active(),[candle(0,105,111,104,110)],1);
  const missing=evaluate(c,p,one,null,3);
  assert.equal(missing.realizedR,.25);assert.equal(missing.exits.length,1);assert.equal(missing.unrealizedR,null);assert.equal(missing.lastPriceCheckedAt,time(1));
  const out=evaluate(c,p,missing,[candle(1,111,121,110,120),candle(2,121,131,120,130)],3);
  assert.equal(out.resultR,2.25);assert.equal(out.exits.length,3);
});
test('invalid snapshot allocation or corrupted active accounting never resets to a full position',()=>{
  const c=runtime(),p=plan(c);
  const one=evaluate(c,p,active(),[candle(0,105,111,104,110)],1);
  for(const change of [o=>delete o.exits,o=>o.remainingPosition=1,o=>o.currentStopLoss=90,o=>o.realizedR=999]){
    const bad=JSON.parse(JSON.stringify(one));change(bad);
    const invalid=evaluate(c,p,bad,[candle(1,111,131,110,130)],2);
    assert.equal(invalid.priceCheck.status,'invalid_plan');
    const retry=evaluate(c,p,JSON.parse(JSON.stringify(invalid)),[candle(1,111,131,110,130)],3);
    assert.equal(retry.priceCheck.status,'invalid_plan');
  }
  p.exitStrategy.allocations.TP1=.5;
  assert.equal(evaluate(c,p,active(),[candle(0,105,131,104,130)],1).priceCheck.status,'invalid_plan');
});
test('new snapshots get frozen strategy while existing waiting and active plans remain legacy',async()=>{
  const c=runtime(),p=plan(c);delete p.exitStrategy;delete p.initialStopLoss;
  const item={...p,symbol:'TESTUSDT',direction:'Long',price:100,opportunityGrade:'A+',opportunityScore:90,confidence:90,riskReward:2,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true}};
  const first=await c.createRankingHistoryEntry({generatedAt:time(0),globalRanking:[item]});
  assert.equal(first.readySignals[0].initialPlan.exitStrategy.allocations.TP1,.25);
  const old={...first.readySignals[0],initialPlan:p,outcome:{status:'WaitingEntry',plannedAt:time(0),lastPriceCheckedAt:time(0)}};
  c.fetchOKXRecentPriceRange=async()=>({source:'OKX 1m candles',data:[candle(0,100,111,99,110)]});
  const next=await c.createRankingHistoryEntry({generatedAt:time(1),globalRanking:[{...item,stopLoss:80}]},{readySignals:[old]});
  assert.equal(next.readySignals[0].initialPlan.exitStrategy,undefined);
  assert.equal(next.readySignals[0].outcome.status,'TP1Hit');assert.equal(next.readySignals[0].outcome.resultR,1);
  const legacy=evaluate(c,p,active(),[candle(0,105,111,104,110)],1);
  assert.equal(legacy.status,'TP1Hit');assert.equal(legacy.resultR,1);assert.equal(legacy.exits,undefined);
});
test('new plans still require entry and verified expiry; unconfirmed candles cannot take profits',()=>{
  const c=runtime(),p=plan(c);
  const waiting=evaluate(c,p,{},null,60);
  assert.equal(waiting.status,'WaitingEntry');assert.equal(waiting.resultR,null);assert.equal(waiting.exits.length,0);
  const expired=evaluate(c,p,{},Array.from({length:60},(_,i)=>candle(i,105,106,104,105)),60);
  assert.equal(expired.status,'Expired');assert.equal(expired.resultR,null);assert.equal(c.isCompletedTradeSignal({tradeId:'expired',outcome:expired}),false);
  const open=evaluate(c,p,active(),[{...candle(0,105,131,104,130),confirmed:false}],1);
  assert.equal(open.exits.length,0);assert.equal(open.realizedR,0);assert.equal(open.remainingPosition,1);
});
test('persisted allocation is consumed without reading mutable defaults',()=>{
  const c=runtime(),p=plan(c);
  c.createPartialExitStrategy=()=>({version:'future-policy'});
  const result=evaluate(c,p,active(),[candle(0,105,131,104,130)],1);
  assert.equal(result.resultR,2.25);assert.equal(p.exitStrategy.allocations.TP1,.25);
});
test('an existing break-even stop wins over later targets in the same candle',()=>{
  const c=runtime(),p=plan(c);
  const one=evaluate(c,p,active(),[candle(0,105,111,104,110)],1);
  const out=evaluate(c,p,one,[candle(1,110,131,99,125)],2);
  assert.equal(out.status,'Stopped');assert.equal(out.resultR,.25);assert.equal(out.exits.length,2);
});
for(const direction of ['Long','Short']) {
  test(`${direction}: targets already reached at candle open precede later SL`,()=>{
    const c=runtime(),p=plan(c,direction);
    for(const [open,expected,exitCount] of [[111,.25,2],[121,.75,3],[131,2.25,3]]){
      const out=evaluate(c,p,active(),[candle(0,open,Math.max(132,open),89,100,direction)],1,direction);
      assert.equal(out.resultR,expected);assert.equal(out.exits.length,exitCount);
      assert.equal(out.exits[0].evidence.rule,'target-reached-at-candle-open');
    }
  });
}
