import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../api/market.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const runtime=()=>{const c=vm.createContext({process:{env:{}},Date,console});vm.runInContext(source,c);return c;};
const fixture=(direction='Long')=>({tradeId:'original-id',setupKey:'TESTUSDT:'+direction,symbol:'TESTUSDT',direction,
 opportunityScore:90,confidence:95,action:direction==='Long'?'Strong Buy':'Strong Sell',tradeAllowed:true,tradeReadiness:{ready:true},riskReward:2,
 initialPlan:{createdAt:'2026-09-19T00:00:00Z',plannedAt:'2026-09-19T00:01:00Z',expiresAt:'2026-09-19T01:01:00Z',entryPrice:100,entryZone:{from:99,to:101},stopLoss:direction==='Long'?90:110,takeProfit1:direction==='Long'?110:90,takeProfit2:direction==='Long'?120:80,takeProfit3:direction==='Long'?130:70},outcome:{status:'Active'}});
const ranking={generatedAt:'2026-09-20T00:00:00Z',globalRanking:[{symbol:'TESTUSDT',price:95,opportunityScore:50,grade:'D',confidence:40}]};
for(const [name,mutate] of [
 ['missing readiness',s=>delete s.tradeReadiness],['missing permission',s=>delete s.tradeAllowed],
 ['low confidence',s=>s.confidence=84],['low score',s=>s.opportunityScore=84],['weak action',s=>s.action='Buy'],
 ['low RR',s=>s.riskReward=1],['broken plan',s=>s.initialPlan.takeProfit3=95],
 ['missing origin timestamp',s=>delete s.initialPlan.createdAt],['closed trade',s=>s.outcome.status='Stopped']
])test('exclude ambiguous origin: '+name,()=>{const s=fixture();s.grade='A+';mutate(s);assert.equal(runtime().projectEntrySetup(s,ranking,'now'),null);});
for(const dir of ['Long','Short'])test('verified '+dir+' preserves frozen identity and Active despite current D',()=>{
 const c=runtime(),s=fixture(dir),before=structuredClone(s),r=c.projectEntrySetup(s,ranking,'2026-09-20T00:01:00Z');
 assert.equal(r.tradeId,s.tradeId);assert.equal(r.origin.confirmedAPlus,true);assert.equal(r.current.currentGrade,'D');assert.equal(r.lifecycleStatus,'Active');assert.deepEqual(s,before);
 assert.equal(r.entryAnalysis.status,"ENTRY COMPLETED");assert.equal(r.entryAnalysis.structureValid,null);assert.equal(r.entryAnalysis.quality,undefined);
 assert.equal(r.origin.detectedAt,s.initialPlan.createdAt);assert.equal(r.current.asOf,ranking.generatedAt);assert.notEqual(r.origin.detectedAt,r.current.asOf);
});
test('current C and absent ranking retain origin without fabricated current values',()=>{const c=runtime();assert.equal(c.projectEntrySetup(fixture(),{...ranking,globalRanking:[{...ranking.globalRanking[0],grade:'C'}]},'now').current.currentGrade,'C');const r=c.projectEntrySetup(fixture(),null,'now');assert.equal(r.current.price,null);assert.equal(r.current.currentGrade,null);assert.equal(r.entryAnalysis.currentRR,null);});
test('directionally mirrored arithmetic',()=>{const c=runtime();const a=c.calculateEntryLocationDiagnostics('Long',100,90,120,95),b=c.calculateEntryLocationDiagnostics('Short',100,110,80,105);assert.equal(a.pullbackR,.5);assert.equal(a.currentRR,5);assert.deepEqual(a,b);});
test('invalid geometry never looks profitable',()=>{const c=runtime();for(const price of [90,80,120,130,0,null,NaN])assert.equal(c.calculateEntryLocationDiagnostics('Long',100,90,120,price).currentRR,null);assert.equal(c.calculateEntryLocationDiagnostics('Short',100,110,80,110).currentRR,null);});
test('endpoint only reads two existing keys; never invokes trading paths',async()=>{
 const c=runtime(),commands=[];c.getRedisConfig=()=>({});c.runRedisCommand=async command=>{commands.push(command);assert.equal(command[0],'GET');return JSON.stringify(command[1].includes('open-trades')?[fixture()]:ranking);};
 for(const name of ['registerOpenTrade','registerLiveAnalysisTrade','evaluateTradeLifecycle','writeRankingHistory','calculateScannerOpportunity','fetchOKXKlines'])c[name]=()=>{throw new Error('FORBIDDEN '+name);};
 const res={setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
 await c.handler({method:'GET',query:{mode:'entry-setups'},headers:{}},res);
 assert.equal(res.code,200);assert.equal(res.body.setups.length,1);assert.equal(commands.length,2);
 assert.equal(commands[0][1],'sergey-ai:open-trades:v1');assert.equal(commands[1][1],'sergey-ai:global-ranking:v1');
});
test('storage unavailable fails closed',async()=>{const c=runtime(),res={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;}};await c.handler({method:'GET',query:{mode:'entry-setups'},headers:{}},res);assert.equal(res.code,503);assert.equal(res.body.ok,false);});

const now = '2026-09-20T00:01:00Z';
const stamp = '2026-09-20T00:00:00Z';
const supportedRow = direction => ({ price: direction === 'Long' ? 95 : 105,
  direction, action: direction === 'Long' ? 'Buy' : 'Sell', tradeAllowed: true,
  tradeReadiness: { ready: true }, grade: 'D' });
function analyze(direction = 'Long', change = () => {}) {
  const signal = fixture(direction); signal.outcome.status = 'WaitingEntry';
  const input = { signal, row: supportedRow(direction), stamp, now };
  change(input);
  const before = structuredClone(input);
  const result = runtime().analyzeEntrySnapshot(input.signal, input.row, input.stamp, input.now);
  assert.deepEqual(input, before, 'analysis must not mutate frozen trade or ranking');
  assert.equal(result.structureValid, null);
  assert.equal(result.quality, undefined);
  assert.ok(!['IMPROVED ENTRY', 'CONTINUATION'].includes(result.status));
  return result;
}
for (const direction of ['Long', 'Short']) {
  test(`${direction} fresh pullback with current D; support uses aligned ordinary action`, () => {
    const a = analyze(direction);
    assert.equal(a.status, 'PULLBACK'); assert.equal(a.pullbackR, .5); assert.equal(a.currentRR, 5);
    assert.equal(a.directionalSupport, 'SUPPORTED');
  });
  for (const price of direction === 'Long' ? [90, 89] : [110, 111]) {
    test(`${direction} SL boundary ${price} analytically invalidates only`, () => {
      const a = analyze(direction, x => x.row.price = price);
      assert.equal(a.status, 'ANALYTICALLY INVALIDATED');
      assert.equal(a.reasonCode, 'ORIGINAL_SL_BOUNDARY_VIOLATED'); assert.equal(a.currentRR, null);
      assert.ok(a.pullbackR >= 1);
    });
  }
  for (const price of direction === 'Long' ? [100, 105, 120, 121] : [100, 95, 80, 79]) {
    test(`${direction} non-pullback ${price}`, () => {
      const a = analyze(direction, x => x.row.price = price);
      assert.equal(a.status, 'NO PULLBACK OBSERVED');
      assert.equal(a.reasonCode, 'NO_MORE_FAVORABLE_PRICE_OBSERVED');
      if (direction === 'Long' ? price >= 120 : price <= 80) assert.equal(a.currentRR, null);
    });
  }
  test(`${direction} Active always entry completed even past SL or stale`, () => {
    for (const stale of [false, true]) {
      const a = analyze(direction, x => { x.signal.outcome.status = 'Active';
        x.row.price = direction === 'Long' ? 80 : 120; if (stale) x.stamp = '2026-09-19T23:00:00Z'; });
      assert.equal(a.status, 'ENTRY COMPLETED'); assert.equal(a.reasonCode, 'ENTRY_ALREADY_ACTIVE');
      if (stale) { assert.equal(a.snapshotReasonCode, 'RANKING_STALE'); assert.equal(a.pullbackR, null); }
    }
  });
}
for (const [name, change, reason] of [
  ['stale', x => x.stamp = '2026-09-19T23:45:59Z', 'RANKING_STALE'],
  ['missing timestamp', x => x.stamp = null, 'RANKING_TIMESTAMP_INVALID'],
  ['invalid timestamp', x => x.stamp = 'invalid', 'RANKING_TIMESTAMP_INVALID'],
  ['future timestamp', x => x.stamp = '2026-09-20T00:02:00Z', 'RANKING_TIMESTAMP_FUTURE'],
  ['before origin', x => x.signal.initialPlan.createdAt = '2026-09-20T00:00:30Z', 'RANKING_BEFORE_ORIGIN'],
  ['missing price', x => delete x.row.price, 'CURRENT_PRICE_MISSING'],
  ['zero price', x => x.row.price = 0, 'CURRENT_PRICE_MISSING'],
  ['NaN price', x => x.row.price = NaN, 'CURRENT_PRICE_MISSING'],
  ['missing row', x => x.row = undefined, 'CURRENT_PRICE_MISSING'],
  ['bad zone', x => x.signal.initialPlan.entryZone.from = 102, 'INVALID_FROZEN_GEOMETRY'],
  ['SL inside zone', x => x.signal.initialPlan.stopLoss = 99.5, 'INVALID_FROZEN_GEOMETRY'],
  ['invalid TP2', x => x.signal.initialPlan.takeProfit2 = 98, 'INVALID_FROZEN_GEOMETRY'],
  ['missing midpoint', x => x.signal.initialPlan.entryPrice = null, 'INVALID_FROZEN_GEOMETRY'],
  ['invalid direction', x => x.signal.direction = 'Neutral', 'INVALID_FROZEN_GEOMETRY'],
  ['closed lifecycle', x => x.signal.outcome.status = 'Stopped', 'LIFECYCLE_NOT_OPEN']
]) test(`unknown: ${name}`, () => {
  const a = analyze('Long', change); assert.equal(a.status, 'UNKNOWN'); assert.equal(a.reasonCode, reason);
  assert.equal(a.currentRR, null); assert.equal(a.pullbackR, null); assert.equal(a.directionalSupport, 'UNKNOWN');
});
test('15 minute stale boundary matches existing frontend policy: exactly limit remains valid', () => {
  assert.equal(analyze('Long', x => x.stamp = '2026-09-19T23:46:00Z').status, 'PULLBACK');
  assert.equal(analyze('Long', x => x.stamp = '2026-09-19T23:45:59.999Z').reasonCode, 'RANKING_STALE');
});
for (const [name, change, expected] of [
  ['opposite direction', r => r.direction = 'Short', 'UNSUPPORTED'],
  ['opposite action', r => r.action = 'Strong Sell', 'UNSUPPORTED'],
  ['Wait', r => r.action = 'Wait', 'UNSUPPORTED'],
  ['permission false', r => r.tradeAllowed = false, 'UNSUPPORTED'],
  ['readiness false', r => r.tradeReadiness.ready = false, 'UNSUPPORTED'],
  ['missing direction', r => delete r.direction, 'UNKNOWN'],
  ['missing action', r => delete r.action, 'UNKNOWN'],
  ['missing permission', r => delete r.tradeAllowed, 'UNKNOWN'],
  ['missing readiness', r => delete r.tradeReadiness, 'UNKNOWN'],
  ['invalid boolean', r => r.tradeAllowed = 'true', 'UNKNOWN'],
  ['strong aligned action', r => r.action = 'Strong Buy', 'SUPPORTED']
]) test(`support ${name} never changes price classification`, () => {
  const a = analyze('Long', x => change(x.row));
  assert.equal(a.directionalSupport, expected); assert.equal(a.status, 'PULLBACK');
});
test('projection uses frozen geometry, preserves identity and original A+ while current grade C/D', () => {
  for (const grade of ['C', 'D']) {
    const signal = fixture(); signal.outcome.status = 'Pending';
    const before = structuredClone(signal);
    const row = { ...supportedRow('Long'), symbol: 'TESTUSDT', grade,
      entryZone: { from: 1, to: 2 }, stopLoss: 3, takeProfit2: 4 };
    const a = runtime().projectEntrySetup(signal, { generatedAt: stamp, globalRanking: [row] }, now);
    assert.equal(a.entryAnalysis.status, 'PULLBACK'); assert.equal(a.entryAnalysis.currentRR, 5);
    assert.equal(a.tradeId, signal.tradeId); assert.equal(a.origin.originalGrade, 'A+');
    assert.equal(a.originalPlan.plannedEntry, 100); assert.equal(a.originalPlan.initialSL, 90);
    assert.equal(a.current.currentGrade, grade); assert.deepEqual(signal, before);
  }
});
