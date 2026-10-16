import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSimulator, configHash, CONFIG_SHA } from './simulator.mjs';

// The only file read is frozen configuration. No archive or candle cache imports.
const config = JSON.parse(readFileSync(new URL('../../../docs/research/entry-stop-research-v1.0.json', import.meta.url)));
const engine = createSimulator(config);
const M = 60000, H = 60*M, D = 24*H, T = Date.parse('2000-02-01T16:00:00.000Z');
const instId = 'FIXTURE-USDT-SWAP';
const iso = t => new Date(t).toISOString();
const candle = (timestamp, open=100, high=101, low=99, close=100) =>
  ({ instId, timestamp, open, high, low, close, confirmed: true });
function fixture(direction='Long', cutoff=T) {
  const lastD = Math.floor((cutoff-16*H)/D)*D+16*H-D;
  const lastH = Math.floor(cutoff/H)*H-H;
  return { signal: { tradeId: 'SYNTHETIC-'+direction, instId, instrumentType:'SWAP',
    origin:{direction,detectedAt:iso(cutoff)},
    initialPlan:{createdAt:iso(cutoff),entryPrice:100,initialStopLoss:direction==='Long'?90:110,takeProfit1:999} },
    daily:Array.from({length:14},(_,i)=>candle(lastD-(13-i)*D,100,105,95,100)),
    hourly:Array.from({length:12},(_,i)=>candle(lastH-(11-i)*H,100,105,95,100)) };
}
const run = (minutes, f=fixture(), variant='V0') => engine.simulate({...f,minutes,variant});
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-12, `${a} != ${b}`);
function minutes(n, values=[100,101,99,100], cutoff=T) {
  const first=(Math.floor(cutoff/M)+1)*M;
  return Array.from({length:n},(_,i)=>candle(first+i*M,...values));
}
for (const [direction, expected] of [['Long',[[100,90],[97.5,90],[100,94],[97.5,94]]],['Short',[[100,110],[102.5,110],[100,106],[102.5,106]]]]) {
  for (let i=0;i<4;i++) test(`${direction} V${i} frozen geometry and common target`,()=>{
    const p=engine.buildPlans(fixture(direction))['V'+i];assert.equal(p.status,'READY');
    assert.equal(p.entry,expected[i][0]);assert.equal(p.stop,expected[i][1]);
    near(p.tp,p.entry+(direction==='Long'?1:-1)*10.75);near(p.initialRiskPrice,Math.abs(p.entry-p.stop));
    assert.equal(p.originalTP1,999);assert.notEqual(p.tp,999);
  });
}
test('ATR exact 14-range mean, no precision rounding',()=>{
  const f=fixture();f.daily=f.daily.map((c,i)=>({...c,high:100+(i+1)/7,low:99}));
  near(engine.buildPlans(f).V0.atr, f.daily.reduce((s,c)=>s+c.high-c.low,0)/14);
});
test('ATR ignores interday gap unlike true range',()=>{
  const f=fixture();f.daily=f.daily.map((c,i)=>({...c,open:100+i*20,close:100+i*20,high:105+i*20,low:95+i*20}));
  assert.equal(engine.buildPlans(f).V0.atr,10);assert.equal(f.daily[1].high-f.daily[0].close,25);
});
test('15th old daily candle cannot affect ATR',()=>{
  const f=fixture();f.daily.unshift(candle(f.daily[0].timestamp-D,100,900,1));assert.equal(engine.buildPlans(f).V0.atr,10);
});
test('13 daily candles do not backfill ATR',()=>{const f=fixture();f.daily.shift();assert.equal(engine.buildPlans(f).V0.status,'ATR_UNAVAILABLE');});
test('daily gap cannot be substituted by older bar',()=>{const f=fixture();f.daily.splice(5,1);f.daily.unshift(candle(f.daily[0].timestamp-D));assert.equal(engine.buildPlans(f).V0.status,'ATR_UNAVAILABLE');});
test('unclosed future daily candle ignored',()=>{const f=fixture();f.daily.push({...candle(T,100,900,1),confirmed:false});assert.equal(engine.buildPlans(f).V0.atr,10);});
test('UTC daily bars are not silently substituted for source session',()=>{const f=fixture();f.daily=f.daily.map(c=>({...c,timestamp:c.timestamp-16*H}));assert.equal(engine.buildPlans(f).V0.status,'ATR_UNAVAILABLE');});
test('zero ATR rejected without fallback',()=>{const f=fixture();f.daily=f.daily.map(c=>({...c,open:100,high:100,low:100,close:100}));assert.equal(engine.buildPlans(f).V0.status,'ATR_UNAVAILABLE');});
test('exact 12-hour minimum and buffer',()=>{const f=fixture();f.hourly[4].low=80;assert.equal(engine.buildPlans(f).V2.stop,79);});
test('exact 12-hour maximum and buffer Short',()=>{const f=fixture('Short');f.hourly[4].high=120;assert.equal(engine.buildPlans(f).V2.stop,121);});
test('13th older hour ignored',()=>{const f=fixture();f.hourly.unshift(candle(T-13*H,100,500,1));assert.equal(engine.buildPlans(f).V2.stop,94);});
test('future hour cannot become structural reference',()=>{const f=fixture();f.hourly.push(candle(T,100,500,1));assert.equal(engine.buildPlans(f).V2.stop,94);});
test('missing structure affects V2/V3 only',()=>{const f=fixture();f.hourly.pop();const p=engine.buildPlans(f);assert.equal(p.V0.status,'READY');assert.equal(p.V2.status,'STRUCTURE_UNAVAILABLE');assert.equal(p.V3.status,'STRUCTURE_UNAVAILABLE');});
test('Long structural stop on wrong side rejected',()=>{const f=fixture();f.hourly=f.hourly.map(c=>({...c,open:120,close:120,low:110,high:125}));assert.equal(engine.buildPlans(f).V2.status,'STRUCTURE_UNAVAILABLE');});
test('Short structural stop on wrong side rejected',()=>{const f=fixture('Short');f.hourly=f.hourly.map(c=>({...c,open:80,close:80,low:75,high:90}));assert.equal(engine.buildPlans(f).V2.status,'STRUCTURE_UNAVAILABLE');});
test('V3 revalidates stop against pullback entry',()=>{const f=fixture();f.hourly=f.hourly.map(c=>({...c,low:99.5,open:100,close:100,high:101}));const p=engine.buildPlans(f);assert.equal(p.V2.status,'READY');assert.equal(p.V3.status,'STRUCTURE_UNAVAILABLE');});
test('invalid original geometry rejected',()=>{const f=fixture();f.signal.initialPlan.initialStopLoss=101;assert.equal(engine.buildPlans(f).V0.status,'GEOMETRY_UNAVAILABLE');});
test('zero risk rejected',()=>{const f=fixture();f.signal.initialPlan.initialStopLoss=100;assert.equal(engine.buildPlans(f).V1.status,'GEOMETRY_UNAVAILABLE');});
test('nonfinite entry not coerced',()=>{const f=fixture();f.signal.initialPlan.entryPrice=NaN;assert.equal(engine.buildPlans(f).V0.status,'GEOMETRY_UNAVAILABLE');});
test('cutoff/createdAt conflict rejected',()=>{const f=fixture();f.signal.initialPlan.createdAt=iso(T+M);assert.equal(engine.buildPlans(f).V0.status,'DATA_UNAVAILABLE');});
test('invalid calendar timestamp rejected',()=>{const f=fixture();f.signal.origin.detectedAt=f.signal.initialPlan.createdAt='2000-02-31T16:00:00Z';assert.equal(engine.buildPlans(f).V0.status,'DATA_UNAVAILABLE');});
test('SPOT mapping rejected',()=>{const f=fixture();f.signal.instrumentType='SPOT';assert.equal(engine.buildPlans(f).V0.status,'DATA_UNAVAILABLE');});
test('historical lifecycle facts are not plan inputs',()=>{const f=fixture(),a=engine.buildPlans(f);f.signal.outcome={entryPrice:1,activatedAt:iso(T-D),resultR:900,lastReanalysis:{decision:'CLOSE'}};assert.deepEqual(engine.buildPlans(f),a);});
test('cutoff minute excluded, next minute can fill and TP',()=>{const r=run([candle(T,100,999,1),candle(T+M,100,111,99)]);assert.equal(r.status,'TP');assert.equal(r.filledAt,T+M);});
test('fractional cutoff advances to next minute',()=>{const f=fixture('Long',T+12345),p=engine.buildPlans(f).V0;assert.equal(p.bounds.firstEligibleMinute,T+M);});
test('exact minute cutoff also advances',()=>assert.equal(engine.buildPlans(fixture()).V0.bounds.firstEligibleMinute,T+M));
test('fill candle closing exactly at expiry permitted',()=>{const cs=minutes(719,[105,106,104,105]);cs[718]=candle(T+719*M,100,111,99);assert.equal(run(cs).status,'TP');});
test('minute after expiry cannot fill',()=>{const cs=minutes(720,[105,106,104,105]);cs[719]=candle(T+720*M,100,111,99);assert.equal(run(cs).status,'UNFILLED');});
// Updated solely for preregistered v1.1: partial expiry is ineligible, not missing data.
test('partial expiry with exhausted valid entry candles is unfilled zero',()=>{const f=fixture('Long',T+1000),r=run(minutes(719,[105,106,104,105]),f);assert.equal(r.status,'UNFILLED');assert.equal(r.reason,null);assert.equal(r.grossR,0);assert.equal(r.netR,0);assert.equal(r.entryFeeUsd+r.exitFeeUsd,0);assert.equal(r.feeR,0);assert.equal(r.completedAt,T+1000+12*H);});
test('exit at full horizon boundary permitted',()=>{const cs=minutes(4319);cs[4318]=candle(T+4319*M,100,111,99);assert.equal(run(cs).status,'TP');});
test('open at horizon remains unresolved',()=>{const r=run(minutes(4319));assert.equal(r.status,'UNRESOLVED_OPEN');assert.equal(r.netR,null);});
test('candle starting at horizon cannot exit position',()=>{const cs=minutes(4319);cs.push(candle(T+4320*M,100,900,1));assert.equal(run(cs).status,'UNRESOLVED_OPEN');});
test('fractional horizon never inspects partial minute',()=>{const f=fixture('Long',T+1000),cs=minutes(4320);cs[4319]=candle(T+4320*M,100,900,1);assert.equal(run(cs,f).status,'UNRESOLVED_OPEN');});
for (const direction of ['Long','Short']) {
  const long=direction==='Long';
  test(`${direction} clean non-open entry then target`,()=>{
    const cs=[long?candle(T+M,101,102,99,100):candle(T+M,99,101,98,100),long?candle(T+2*M,100,111,99):candle(T+2*M,100,101,89)];
    assert.equal(run(cs,fixture(direction)).status,'TP');
  });
  test(`${direction} active ordinary stop`,()=>{const cs=[candle(T+M),long?candle(T+2*M,100,101,89):candle(T+2*M,100,111,99)];const r=run(cs,fixture(direction));assert.equal(r.status,'STOP');near(r.grossR,-1);});
  test(`${direction} simultaneous entry/stop ambiguity`,()=>{const c=long?candle(T+M,101,102,89):candle(T+M,99,111,98);const r=run([c],fixture(direction));assert.equal(r.status,'AMBIGUOUS');assert.equal(r.grossR,null);});
  test(`${direction} simultaneous entry/TP ambiguity`,()=>{const c=long?candle(T+M,101,111,99):candle(T+M,99,101,89);assert.equal(run([c],fixture(direction)).status,'AMBIGUOUS');});
  test(`${direction} gap entry without observed limit`,()=>{const c=long?candle(T+M,95,96,94,95):candle(T+M,105,106,104,105);assert.equal(run([c],fixture(direction)).status,'AMBIGUOUS_ENTRY');});
  test(`${direction} proven stop before any eligible fill`,()=>{const c=long?candle(T+M,85,89,84,86):candle(T+M,115,116,111,114);const r=run([c],fixture(direction));assert.equal(r.status,'INVALIDATED_UNFILLED');assert.equal(r.feeR,0);assert.equal(r.netR,0);});
  test(`${direction} active both levels ambiguous`,()=>{const r=run([candle(T+M),candle(T+2*M,100,112,88)],fixture(direction));assert.equal(r.status,'AMBIGUOUS');assert.equal(r.netR,null);});
  test(`${direction} adverse stop gap worse than -1R`,()=>{const c=long?candle(T+2*M,80,85,75,81):candle(T+2*M,120,125,115,121);const r=run([candle(T+M),c],fixture(direction));assert.equal(r.status,'STOP');near(r.grossR,-2);assert.equal(r.exitPrice,long?80:120);});
  test(`${direction} target gap has no price improvement`,()=>{const c=long?candle(T+2*M,120,125,115,121):candle(T+2*M,80,85,75,81);const r=run([candle(T+M),c],fixture(direction));assert.equal(r.status,'TP');near(r.exitPrice,long?110.75:89.25);});
  test(`${direction} target R and notional fees exact`,()=>{const c=long?candle(T+M,100,111,99):candle(T+M,100,101,89);const r=run([c],fixture(direction));near(r.grossR,1.075);near(r.entryFeeUsd,.05);near(r.exitFeeUsd,(long?110.75:89.25)*.0005);near(r.feeR,(r.entryFeeUsd+r.exitFeeUsd)/10);near(r.netR,r.grossR-r.feeR);});
}
const qualityCases = {
  'missing minute':cs=>cs.splice(1,1),
  'duplicate minute':cs=>cs.splice(1,0,{...cs[1]}),
  'out-of-order minute':cs=>{[cs[0],cs[1]]=[cs[1],cs[0]];},
  'invalid OHLC':cs=>{cs[1].low=200;},
  'unconfirmed candle':cs=>{cs[1].confirmed=false;},
  'instrument mismatch':cs=>{cs[1].instId='OTHER-USDT-SWAP';},
  'nonfinite OHLC':cs=>{cs[1].high=Infinity;},
  'numeric strings not silently accepted':cs=>{cs[1].open='100';},
  'misaligned minute':cs=>{cs[1].timestamp+=1;}
};
for (const [name,mutate] of Object.entries(qualityCases)) test(name,()=>{const cs=minutes(3);cs[2]=candle(T+3*M,100,111,99);mutate(cs);const r=run(cs);assert.equal(r.status,'DATA_UNAVAILABLE');assert.equal(r.netR,null);});
test('irrelevant future bad OHLC does not invalidate resolved trade',()=>{const r=run([candle(T+M,100,111,99),{...candle(T+2*M),high:0}]);assert.equal(r.status,'TP');});
test('empty path unavailable, not unfilled',()=>assert.equal(run([]).status,'DATA_UNAVAILABLE'));
test('unfilled fees zero and completed at expiry',()=>{const r=run(minutes(719,[105,106,104,105]));assert.equal(r.status,'UNFILLED');assert.equal(r.grossR,0);assert.equal(r.entryFeeUsd,0);assert.equal(r.exitFeeUsd,0);assert.equal(r.completedAt,T+12*H);});
test('leverage does not multiply fees',()=>{const f=fixture();f.signal.leverage=100;const cs=[candle(T+M,100,111,99)];assert.equal(run(cs,f).feeR,run(cs).feeR);});
test('unresolved entry does not fabricate net result',()=>{const r=run([candle(T+M)]);assert.equal(r.status,'DATA_UNAVAILABLE');assert.equal(r.netR,null);assert.equal(r.completedAt,null);});
test('config tampering hard refused',()=>{const c=structuredClone(config);c.geometry.alpha=.2;assert.throws(()=>createSimulator(c),/HASH_MISMATCH/);});
test('fee tampering hard refused',()=>{const c=structuredClone(config);c.fees.rate=0;assert.throws(()=>createSimulator(c),/HASH_MISMATCH/);});
test('config canonical order independent',()=>{const c=Object.fromEntries(Object.entries(config).reverse());assert.equal(configHash(c),CONFIG_SHA);});
test('identity on unresolved and complete results',()=>{assert.equal(run([]).configSHA,CONFIG_SHA);assert.equal(run([candle(T+M,100,111,99)]).configSHA,CONFIG_SHA);});
test('caller config mutation cannot override frozen engine',()=>{const c=structuredClone(config),e=createSimulator(c);c.geometry.alpha=.8;assert.equal(e.buildPlans(fixture()).V1.entry,97.5);});
test('unknown variant refused',()=>assert.throws(()=>run([],fixture(),'V4'),/UNKNOWN_VARIANT/));
test('identical inputs give byte-identical output',()=>{const f=fixture(),cs=[candle(T+M,100,111,99)];assert.equal(JSON.stringify(run(cs,f)),JSON.stringify(run(cs,f)));});
test('source signal and candles never mutated',()=>{const f=fixture(),cs=[candle(T+M,100,111,99)],before=JSON.stringify([f,cs]);run(cs,f);assert.equal(JSON.stringify([f,cs]),before);});
test('Long/Short mirror preserves gross outcomes, fees follow actual notionals',()=>{const a=run([candle(T+M,100,111,99)]),b=run([candle(T+M,100,101,89)],fixture('Short'));assert.equal(a.status,b.status);near(a.grossR,b.grossR);assert.notEqual(a.exitFeeUsd,b.exitFeeUsd);});
test('random same seed same samples',()=>{const ts=[T+M,T+2*M,T+3*M];assert.deepEqual(engine.sampleControlTimes(ts),engine.sampleControlTimes(ts));});
test('random candidate order invariant',()=>{const ts=[T+M,T+2*M,T+3*M];assert.deepEqual(engine.sampleControlTimes(ts),engine.sampleControlTimes([...ts].reverse()));});
test('random count fixed and replacement explicitly permitted',()=>{const r=engine.sampleControlTimes([T+M,T+2*M]);assert.equal(r.samples.length,100);assert.ok(new Set(r.samples).size<=2);});
test('random sample primitive receives no outcomes and cannot redraw losses',()=>{const r=engine.sampleControlTimes([T+M]);assert.equal(r.samples.length,100);assert.ok(r.samples.every(t=>t===T+M));});
test('random empty availability returns no invented samples',()=>assert.equal(engine.sampleControlTimes([]).status,'DATA_UNAVAILABLE'));
test('random invalid timestamp refused',()=>assert.throws(()=>engine.sampleControlTimes([T+1]),/INVALID_CANDIDATE_TIMES/));
test('random duplicate candidate timestamps do not bias distribution',()=>assert.deepEqual(engine.sampleControlTimes([T+M,T+M,T+2*M]),engine.sampleControlTimes([T+M,T+2*M])));

// Synthetic boundary regression only: all variants and both directions.
for (const direction of ['Long','Short']) for (const variant of ['V0','V1','V2','V3']) {
  const away=direction==='Long'?[105,106,104,105]:[95,96,94,95];
  for (const offset of [0,1000]) test(`${direction} ${variant}: final eligible close at/before expiry (${offset}) fills`,()=>{
    const f=fixture(direction,T+offset),p=engine.buildPlans(f)[variant];
    const cs=minutes(719,away);
    cs[718]=candle(T+719*M,p.entry,Math.max(p.entry,p.tp),Math.min(p.entry,p.tp),p.tp);
    const r=run(cs,f,variant);
    assert.equal(r.status,'TP');assert.equal(r.filledAt,T+719*M);
    assert.equal(r.completedAt,T+720*M);
  });
  test(`${direction} ${variant}: touch only in partial expiry minute is excluded`,()=>{
    const f=fixture(direction,T+1000),p=engine.buildPlans(f)[variant];
    const cs=minutes(719,away);
    const baseline=run(cs,f,variant);
    cs.push(candle(T+720*M,p.entry,Math.max(p.entry,p.tp),Math.min(p.entry,p.tp),p.tp));
    const r=run(cs,f,variant);
    assert.deepEqual(r,baseline);assert.equal(r.status,'UNFILLED');
    assert.equal(r.filledAt,null);assert.equal(r.grossR,0);assert.equal(r.netR,0);
    assert.equal(r.entryFeeUsd+r.exitFeeUsd,0);assert.equal(r.feeR,0);
    assert.equal(r.completedAt,T+1000+12*H);
  });
  test(`${direction} ${variant}: required pre-expiry missing/invalid candle remains unavailable`,()=>{
    const f=fixture(direction,T+1000);
    for (const invalid of [false,true]) {
      const cs=minutes(719,away);
      if(invalid) cs[718].confirmed=false; else cs.pop();
      const r=run(cs,f,variant);
      assert.equal(r.status,'DATA_UNAVAILABLE');
      assert.equal(r.reason,'MISSING_DUPLICATE_DISORDERED_OR_INVALID_CANDLE');
      assert.equal(r.netR,null);assert.equal(r.completedAt,null);
    }
  });
}
