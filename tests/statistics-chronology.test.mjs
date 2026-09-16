import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const plain = value => JSON.parse(JSON.stringify(value));
function signal(id, hour, resultR, direction='Long', targets=null) {
  const short = direction==='Short';
  return {tradeId:id, direction, opportunityGrade:'A+', opportunityScore:90, confidence:90,
    riskReward:2, action:short?'Strong Sell':'Strong Buy', tradeAllowed:true, tradeReadiness:{ready:true},
    initialPlan:{entryPrice:100,entryZone:{from:99,to:101},stopLoss:short?110:90,
      takeProfit1:short?90:110,takeProfit2:short?80:120,takeProfit3:short?70:130,
      ...(targets===null?{}:{exitStrategy:{version:'partial-25-25-50-be-v1'}})},
    outcome:{status:'Stopped',checkedAt:`2026-09-16T${String(hour).padStart(2,'0')}:00:00.000Z`,resultR,
      ...(targets===null?{}:{lifecycleVersion:'partial-candles-v1',exits:targets.map(target=>({target,initialFraction:.25}))})}};
}
// Exercise production orchestration and CAS retries without pretending to execute Redis Lua.
function ledger(baseline=null, oldIds=[]) {
  const c=vm.createContext({process:{env:{UPSTASH_REDIS_REST_URL:'local',UPSTASH_REDIS_REST_TOKEN:'test'}},Date,console});
  vm.runInContext(source,c);
  let raw=baseline===null?'':JSON.stringify(baseline), ids=new Set(oldIds), recent=[], conflict=null, loseReply=false;
  const execute=async command=>{
    assert.equal(command[0],'EVAL');
    if(command[2]==='2') return [raw,ids.size,command.slice(5).map(id=>ids.has(id)?1:0)];
    assert.equal(command[2],'3');
    if(conflict){const run=conflict;conflict=null;await run();}
    const [expected,next,encoded,limit]=command.slice(6), entries=JSON.parse(encoded);
    if(raw!==expected || entries.some(e=>Number(ids.has(e.id))!==e.member)) return 0;
    for(const e of entries) if(!e.member){ids.add(e.id);recent.unshift(JSON.parse(e.json));}
    recent=recent.slice(0,Number(limit));raw=next;
    if(loseReply){loseReply=false;throw new Error('lost response');}
    return 1;
  };
  return {c, record: trades=>c.recordCompletedTradeSignals(trades,execute), stats:()=>JSON.parse(raw),
    raw:()=>raw, ids:()=>[...ids], recent:()=>recent, conflict:fn=>{conflict=fn;}, loseReply:()=>{loseReply=true;}};
}
async function ingest(trades) {const l=ledger();for(const s of trades) await l.record([s]);return l;}
function comparable(l){const stats=l.stats();delete stats.chronology.initializedAt;return stats;}
test('migration preserves exact legacy aggregate and all IDs; no last-20 reconstruction',async()=>{
  const baseline={completed:100,wins:60,losses:35,breakEvens:5,grossProfitR:70,grossLossR:35,
    netR:35,equityR:35,peakR:45,maxDrawdownR:12,currentStreak:{type:'Loss',count:2},
    maxConsecutiveLosses:4,customLegacyField:'retain'};
  const oldIds=Array.from({length:100},(_,i)=>`old-${i}`), l=ledger(baseline,oldIds);
  await l.record([signal('new',10,2)]);
  assert.deepEqual(l.stats().chronology.legacyBaseline,baseline);
  assert.equal(l.stats().completed,101);assert.equal(l.stats().netR,37);
  assert.equal(l.stats().chronology.postMigration.completed,1);
  const before=l.raw();await l.record([signal('old-0',9,-100)]);assert.equal(l.raw(),before);
  await l.record([signal('older-new',8,-1)]);
  assert.deepEqual(l.stats().chronology.legacyBaseline,baseline);
  assert.equal(l.stats().completed,102);assert.equal(l.stats().netR,36);
  assert.equal(l.ids().length,102);assert.equal(l.stats().chronology.legacyTradeIdCount,100);
});
test('B then delayed A has identical chronological metrics to A then B',async()=>{
  const a=signal('a',10,-1),b=signal('b',11,2);
  assert.deepEqual(comparable(await ingest([b,a])),comparable(await ingest([a,b])));
});
test('reverse three trades reconciles drawdown and streaks',async()=>{
  const trades=[signal('a',10,-1),signal('b',11,3),signal('c',12,-2)];
  const forward=await ingest(trades), reverse=await ingest([...trades].reverse());
  assert.deepEqual(comparable(reverse),comparable(forward));
  const s=reverse.stats().chronology.postMigration;
  assert.equal(s.equityR,0);assert.equal(s.peakR,2);assert.equal(s.maxDrawdownR,2);
  assert.deepEqual(s.currentStreak,{type:'Loss',count:1});assert.equal(s.maxConsecutiveLosses,1);
});
test('duplicate delayed trade is exactly once, including conflicting replay payload',async()=>{
  const a=signal('a',10,-1),b=signal('b',11,2),l=await ingest([b,a]);const before=l.raw();
  await l.record([a,b,{...a,outcome:{...a.outcome,resultR:999}}]);assert.equal(l.raw(),before);
  assert.equal(l.stats().completed,2);assert.equal(l.stats().netR,1);
});
test('same closing time orders by stable tradeId, not ingestion',async()=>{
  const a=signal('a',10,-1),b=signal('b',10,2),l=await ingest([b,a]);
  assert.deepEqual(comparable(l),comparable(await ingest([a,b])));
  assert.deepEqual(l.stats().chronology.records.map(r=>r.tradeId),['a','b']);
  assert.equal(l.stats().chronology.postMigration.maxDrawdownR,1);
});
test('journal retains all records past recent display cap',async()=>{
  const l=ledger();await l.record(Array.from({length:35},(_,i)=>signal(`trade-${i}`,10,1)));
  assert.equal(l.recent().length,20);assert.equal(l.stats().chronology.records.length,35);
  assert.equal(l.stats().completed,35);assert.equal(l.ids().length,35);
  await l.record([signal('delayed',9,-1)]);assert.equal(l.stats().chronology.records.length,36);
});
test('LONG/SHORT and TP analytics survive reconciliation exactly once',async()=>{
  const a=signal('a',10,.25,'Long',['TP1']),b=signal('b',11,2.25,'Short',['TP1','TP2','TP3']);
  const l=await ingest([b,a]);await l.record([a,b]);const s=l.stats();
  assert.deepEqual(s.tradeAnalytics.hits,{TP1:2,TP2:1,TP3:1});
  assert.equal(s.tradeAnalytics.directions.Long.netR,.25);assert.equal(s.tradeAnalytics.directions.Short.netR,2.25);
  assert.equal(s.tradeAnalytics.partialCompleted,2);
  assert.deepEqual(comparable(l),comparable(await ingest([a,b])));
});
test('normal chronological ingestion retains existing aggregate results',async()=>{
  const trades=[signal('a',10,-1),signal('b',11,0),signal('c',12,2)];const l=await ingest(trades);
  let expected=l.c.createEmptyPersistentTradeStats();for(const t of trades)expected=l.c.addTradeToPersistentStats(expected,t);
  const actual=l.stats();delete actual.chronology;delete actual.scope;
  assert.deepEqual(actual,plain(expected));
});
test('Expired does not initialize migration or enter journal/statistics',async()=>{
  const l=ledger(),expired=signal('expired',10,1);expired.outcome.status='Expired';
  await l.record([expired]);assert.equal(l.raw(),'');assert.equal(l.ids().length,0);
});
test('CAS conflict rebuilds from the winning journal without losing entries',async()=>{
  const l=ledger();l.conflict(()=>l.record([signal('winner',11,2)]));
  await l.record([signal('delayed',10,-1)]);
  assert.deepEqual(comparable(l),comparable(await ingest([signal('delayed',10,-1),signal('winner',11,2)])));
});
test('lost response after atomic commit is safe to retry',async()=>{
  const l=ledger(),s=signal('a',10,-1);l.loseReply();await assert.rejects(l.record([s]),/lost response/);
  const before=l.raw();await l.record([s]);assert.equal(l.raw(),before);
});
test('corrupt journal fails closed without overwriting existing totals or IDs',async()=>{
  const l=await ingest([signal('a',10,1)]), bad=l.stats();bad.chronology.records=[];
  const broken=ledger(bad,['a']),before=broken.raw();
  await assert.rejects(broken.record([signal('b',11,1)]),/explicit recovery/);
  assert.equal(broken.raw(),before);assert.deepEqual(broken.ids(),['a']);
});
