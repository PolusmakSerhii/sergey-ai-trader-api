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
 test(`${d}: frozen TP1 half exit awaits analysis, ignores targets, survives reload and stops at BE`,()=>{
  const c=runtime(),p=plan(c,d);p.exitStrategy=c.createTp1ReanalysisStrategy();const frozen=JSON.stringify(p);
  const one=evaluate(c,p,active(),[candle(0,105,131,104,130,d)],1,d);
  assert.equal(one.status,'Active');assert.equal(one.realizedR,.5);assert.equal(one.remainingPosition,.5);
  assert.equal(one.currentStopLoss,100);assert.equal(one.reanalysisPending,true);assert.equal(one.resultR,null);
  assert.equal(c.classifyTradeResult({tradeId:'x',outcome:one}),null);
  const two=evaluate(c,p,JSON.parse(JSON.stringify(one)),[candle(1,125,140,110,135,d)],2,d);
  assert.equal(two.exits.length,1);assert.equal(two.remainingPosition,.5);assert.equal(two.resultR,null);
  const stop=evaluate(c,p,two,[candle(2,105,106,99,100,d)],3,d);
  assert.equal(stop.status,'Stopped');assert.equal(stop.resultR,.5);assert.equal(stop.remainingPosition,0);
  assert.equal(stop.exits[1].initialFraction,.5);assert.equal(stop.reanalysisPending,false);
  assert.equal(evaluate(c,p,stop,[],4,d),stop);assert.equal(JSON.stringify(p),frozen);
 });
 test(`${d}: initial SL is full stop; unknown policy and corrupted state fail closed`,()=>{
  const c=runtime(),p=plan(c,d);p.exitStrategy=c.createTp1ReanalysisStrategy();
  const loss=evaluate(c,p,active(),[candle(0,100,131,89,110,d)],1,d);
  assert.equal(loss.status,'Stopped');assert.equal(loss.resultR,-1);
  const one=evaluate(c,p,active(),[candle(0,105,111,104,110,d)],1,d);
  delete one.exits;
  assert.equal(evaluate(c,p,one,[candle(1,105,111,104,110,d)],2,d).priceCheck.status,'invalid_plan');
  p.exitStrategy.version='unknown';
  const invalid=evaluate(c,p,active(),[candle(0,105,131,104,130,d)],1,d);
  assert.equal(invalid.priceCheck.status,'invalid_plan');assert.equal(invalid.resultR,null);
 });
 test(`${d}: ambiguous BE ordering resumes once at next confirmed candle`,()=>{
  const c=runtime(),p=plan(c,d);p.exitStrategy=c.createTp1ReanalysisStrategy();
  const one=evaluate(c,p,active(),[candle(0,105,121,99,115,d)],1,d);
  assert.equal(one.priceCheck.status,'ambiguous_management_candle');assert.equal(one.exits.length,1);
  const two=evaluate(c,p,one,[candle(1,105,106,99,100,d)],2,d);
  assert.equal(two.resultR,.5);assert.equal(two.exits.length,2);
 });
}
test('new canonical candidate gets new frozen policy without changing gate or research',()=>{
 const c=runtime(),p=plan(c);
 const item={...p,symbol:'TESTUSDT',direction:'Long',price:100,opportunityGrade:'A+',opportunityScore:90,confidence:90,riskReward:2,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true},researchProjectionJSON:JSON.stringify({schemaVersion:'original-signal-research-v2',telemetryStatus:'captured',instrument:{symbol:'TESTUSDT',instrumentType:'SWAP'},decision:{confirmedAPlus:true}})};
 const t=c.createFrozenTradeCandidate(item,time(0));
 assert.equal(t.initialPlan.exitStrategy.version,'tp1-50-reanalyse-v1');assert.equal(t.outcome.status,'WaitingEntry');
 assert.equal(t.researchSnapshot.telemetryStatus,'captured');assert.equal(t.researchSnapshot.capturedAt,time(0));
 assert.equal(t.initialPlan.takeProfit2,120);assert.equal(t.initialPlan.takeProfit3,130);
 assert.equal(c.isConfirmedAPlusTrade(item),true);assert.equal(c.isConfirmedAPlusTrade({...item,takeProfit2:null}),false);
});

test('post-TP1 archive stays open and only BE close contributes final R',()=>{
 const c=runtime(),p=plan(c);p.exitStrategy=c.createTp1ReanalysisStrategy();p.createdAt=time(0);
 const signal={tradeId:'TEST:Long:1',symbol:'TESTUSDT',direction:'Long',opportunityScore:90,confidence:90,riskReward:2,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true},initialPlan:p};
 signal.outcome=evaluate(c,p,active(),[candle(0,105,111,104,110)],1);
 const archived=c.projectValidationTrade(signal);
 assert.equal(archived.stage,1);assert.equal(archived.terminal,false);assert.equal(archived.result.classification,null);
 const restored=c.hydrateValidationTrade(archived);assert.equal(restored.outcome.reanalysisPending,true);
 signal.outcome=evaluate(c,p,restored.outcome,[candle(1,105,106,99,100)],2);
 assert.equal(c.projectValidationTrade(signal).terminal,true);
 const stats=c.addTradeToPersistentStats(c.createEmptyPersistentTradeStats(),signal);
 assert.equal(stats.completed,1);assert.equal(stats.netR,.5);assert.equal(stats.wins,1);
});
