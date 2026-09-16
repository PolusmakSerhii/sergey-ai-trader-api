import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
function runtime() {
  const c = vm.createContext({process:{env:{}}, Date, console});
  vm.runInContext(source, c); c.fetchOKXRecentPriceRange = async () => null;
  return c;
}
function signal(direction = 'Long') {
  const short = direction === 'Short';
  const plan = { entryPrice:100, entryZone:{from:99,to:101}, stopLoss:short?110:90,
    takeProfit1:short?90:110, takeProfit2:short?80:120, takeProfit3:short?70:130,
    plannedAt:'2026-09-15T00:00:00.000Z', expiresAt:'2026-09-15T01:00:00.000Z' };
  return { ...plan, initialPlan:plan, symbol:'TESTUSDT', direction, price:100,
    tradeId:'frozen',setupKey:`TESTUSDT:${direction}`,opportunityScore:90,opportunityGrade:'A+',grade:'A+',
    confidence:90,riskReward:2,action:short?'Strong Sell':'Strong Buy',tradeAllowed:true,
    tradeReadiness:{ready:true},outcome:{status:'Active',entryPrice:100,
      activatedAt:'2026-09-15T00:01:00.000Z',lastPriceCheckedAt:'2026-09-15T00:01:00.000Z'} };
}
for (const [name, change] of [
  ['readiness false',s=>s.tradeReadiness.ready=false],
  ['tradeAllowed false',s=>s.tradeAllowed=false],
  ['confidence below 85',s=>s.confidence=84],
  ['R/R below 2',s=>s.riskReward=1.9],
  ['Sell',s=>s.action='Sell'],
  ['missing original evidence',s=>{delete s.tradeAllowed;delete s.tradeReadiness;}],
  ['missing entry zone',s=>delete s.initialPlan.entryZone],
  ['reversed entry zone',s=>s.initialPlan.entryZone={from:101,to:99}],
  ['bad SL',s=>s.initialPlan.stopLoss=100],
  ['missing TP3',s=>delete s.initialPlan.takeProfit3],
  ['bad target order',s=>s.initialPlan.takeProfit2=95],
  ['nonfinite target',s=>s.initialPlan.takeProfit3=Infinity]
]) test(`persisted score 90 fails closed: ${name}`,()=>{
  const c=runtime(),s=signal('Short');change(s);
  assert.equal(c.isConfirmedAPlusTradeSignal(s),false);
});
for (const direction of ['Long','Short']) test(`canonical ${direction} evidence survives live gate failure`,async()=>{
  const c=runtime(),s=signal(direction),before=structuredClone(s);
  assert.equal(c.isConfirmedAPlusTradeSignal(s),true);
  const next=await c.createRankingHistoryEntry({generatedAt:'2026-09-15T00:06:00.000Z',globalRanking:[{
    ...s,opportunityScore:20,confidence:20,tradeAllowed:false,tradeReadiness:{ready:false},stopLoss:1
  }]},{readySignals:[s]});
  const kept=next.readySignals[0];
  assert.equal(kept.tradeId,s.tradeId);assert.equal(kept.outcome.status,'Active');
  assert.deepEqual(JSON.parse(JSON.stringify(kept.initialPlan)),s.initialPlan);
  assert.equal(c.isConfirmedAPlusTradeSignal(kept),true);assert.deepEqual(s,before);
});
test('legacy score-only ACTIVE is retained without promoted A+ or borrowed live evidence',async()=>{
  const c=runtime(),s=signal();delete s.opportunityGrade;delete s.tradeAllowed;delete s.tradeReadiness;
  const next=await c.createRankingHistoryEntry({generatedAt:'2026-09-15T00:06:00.000Z',globalRanking:[signal()]},{readySignals:[s]});
  const kept=next.readySignals[0];assert.notEqual(kept.opportunityGrade,'A+');
  assert.equal(kept.tradeId,s.tradeId);assert.deepEqual(JSON.parse(JSON.stringify(kept.initialPlan)),s.initialPlan);
  assert.equal(kept.outcome.status,'Active');assert.equal(c.isVisibleTrackedTradeSignal(kept),true);
  assert.equal(c.isConfirmedAPlusTradeSignal(kept),false);
});
test('new canonical plan persists original evidence',async()=>{
  const c=runtime();const next=await c.createRankingHistoryEntry({generatedAt:'2026-09-15T00:00:00.000Z',globalRanking:[signal()]});
  const s=next.readySignals[0];assert.equal(s.tradeAllowed,true);assert.equal(s.tradeReadiness.ready,true);
  assert.equal(c.isConfirmedAPlusTradeSignal(s),true);
});
test('unproven completed legacy signal cannot enter the ledger',async()=>{
  const c=runtime();c.getRedisConfig=()=>({});const s=signal();delete s.tradeReadiness;
  s.outcome={status:'Stopped',resultR:-1,checkedAt:'2026-09-15T01:00:00Z'};
  let writes=0;assert.equal(await c.recordCompletedTradeSignals([s],async()=>{writes++;}),null);
  assert.equal(writes,0);
});
test('already stored CLOSED records and aggregate are not reclassified on read',async()=>{
  const c=runtime();c.getRedisConfig=()=>({});const s=signal();delete s.tradeReadiness;delete s.tradeAllowed;
  s.outcome={status:'Stopped',resultR:-1,checkedAt:'2026-09-15T01:00:00Z'};
  const stats={completed:1,wins:0,losses:1,netR:-1};
  c.runRedisCommand=async command=>{
    assert.ok(['GET','LRANGE'].includes(command[0]));
    return command[0]==='GET'?JSON.stringify(stats):[JSON.stringify(s)];
  };
  const result=await c.readPersistentTradeData();
  assert.equal(result.stats.completed,1);assert.equal(result.stats.netR,-1);
  assert.equal(JSON.stringify(result.recentTrades[0]),JSON.stringify(s));
});
