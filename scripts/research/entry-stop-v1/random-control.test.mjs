import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSimulator, CONFIG_SHA } from './simulator.mjs';
import { createRandomControl } from './random-control.mjs';

// Read config only. All candles and signal facts below are synthetic.
const config = JSON.parse(readFileSync(new URL('../../../docs/research/entry-stop-research-v1.0.json', import.meta.url)));
const control = createRandomControl(config), sim = createSimulator(config);
const M=60000,H=60*M,D=24*H,T=Date.parse('2000-02-01T16:00:00.000Z'),instId='FIXTURE-USDT-SWAP';
const iso=t=>new Date(t).toISOString();
const candle=(t,o=100,h=101,l=99,c=100)=>({timestamp:t,instId,open:o,high:h,low:l,close:c,confirmed:true});
function fixture(direction='Long',cutoff=T) {
  const last=Math.floor((cutoff-16*H)/D)*D+16*H-D;
  return {signal:{tradeId:'SYNTHETIC-'+direction,instId,instrumentType:'SWAP',origin:{direction,detectedAt:iso(cutoff)},
    initialPlan:{createdAt:iso(cutoff),entryPrice:100,initialStopLoss:direction==='Long'?90:110,takeProfit1:999}},
    daily:Array.from({length:14},(_,i)=>candle(last-(13-i)*D,100,105,95))};
}
const exec=(minutes,f=fixture(),selectedAt=T+M)=>control.executeSample({...f,minutes,selectedAt});
const path=(start,end)=>Array.from({length:(end-start)/M},(_,i)=>candle(start+i*M));
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
const fields=r=>[r.status,r.exitPrice,r.grossR,r.netR,r.feeR,r.completedAt];

test('config hash mismatch hard refusal',()=>{const c=structuredClone(config);c.randomControl.seed++;assert.throws(()=>createRandomControl(c),/HASH_MISMATCH/);});
test('result identity, including unavailable',()=>{assert.equal(exec([]).configSHA,CONFIG_SHA);assert.equal(exec([]).control,'RANDOM_ENTRY_SANITY_CONTROL');});
test('complete 12h schedule independent of candles',()=>{const p=control.prepare(fixture());assert.equal(p.schedule.length,719);assert.equal(p.schedule[0],T+M);assert.equal(p.schedule.at(-1),T+719*M);});
test('fractional cutoff excludes containing and partial expiry minutes',()=>{const p=control.prepare(fixture('Long',T+12345));assert.equal(p.schedule[0],T+M);assert.equal(p.schedule.at(-1),T+719*M);});
test('original cutoff and horizon preserved for delayed entry',()=>{const r=exec([candle(T+10*M)],fixture(),T+10*M);assert.equal(r.originalCutoff,T);assert.equal(r.originalHorizon,T+72*H);assert.equal(r.filledAt,T+10*M);});
test('sampling is not from 72h population',()=>{assert.throws(()=>exec([],fixture(),T+13*H),/OUTSIDE_FROZEN_SCHEDULE/);});
test('horizon candidate excluded',()=>assert.throws(()=>exec([],fixture(),T+72*H),/OUTSIDE_FROZEN_SCHEDULE/));
test('post-horizon candidate excluded',()=>assert.throws(()=>exec([],fixture(),T+72*H+M),/OUTSIDE_FROZEN_SCHEDULE/));
test('signal minute cannot be selected',()=>assert.throws(()=>exec([],fixture(),T),/OUTSIDE_FROZEN_SCHEDULE/));
test('wrong instrument mapping makes signal ineligible',()=>{const f=fixture();f.signal.instrumentType='SPOT';const r=control.run({...f,minutes:[]});assert.equal(r.eligible,false);assert.equal(r.counts.totalScheduledSamples,0);});
test('missing daily context makes signal ineligible',()=>{const f=fixture();f.daily=[];assert.equal(control.prepare(f).status,'ATR_UNAVAILABLE');});
test('cutoff conflict makes signal ineligible',()=>{const f=fixture();f.signal.initialPlan.createdAt=iso(T+M);assert.equal(control.prepare(f).eligible,false);});
test('invalid V0 geometry not eligible',()=>{const f=fixture();f.signal.initialPlan.initialStopLoss=100;assert.equal(control.prepare(f).status,'GEOMETRY_UNAVAILABLE');});
test('minute availability does not determine signal eligibility',()=>{const r=control.run({...fixture(),minutes:[]});assert.equal(r.eligible,true);assert.equal(r.counts.totalScheduledSamples,100);});

for (const direction of ['Long','Short']) {
  const long=direction==='Long';
  test(`${direction} translated stop/TP preserve original absolute distances`,()=>{const r=exec([candle(T+M,200,201,199,200)],fixture(direction));assert.equal(r.plan.entry,200);assert.equal(r.plan.stop,long?190:210);near(r.plan.tp,long?210.75:189.25);assert.equal(r.plan.initialRiskPrice,10);assert.equal(r.plan.atr,10);});
  test(`${direction} immediate random entry does not wait for E0 touch`,()=>{const r=exec([candle(T+M,200,201,199,200)],fixture(direction));assert.equal(r.entryExecutionPrice,200);assert.equal(r.filledAt,T+M);});
  test(`${direction} selected entry candle TP`,()=>{const c=long?candle(T+M,100,111,99):candle(T+M,100,101,89);const r=exec([c],fixture(direction));assert.equal(r.status,'TP');near(r.grossR,1.075);});
  test(`${direction} selected entry candle STOP`,()=>{const c=long?candle(T+M,100,101,89):candle(T+M,100,111,99);const r=exec([c],fixture(direction));assert.equal(r.status,'STOP');near(r.grossR,-1);});
  test(`${direction} selected entry candle both levels ambiguous`,()=>{const r=exec([candle(T+M,100,112,88)],fixture(direction));assert.equal(r.status,'AMBIGUOUS');assert.equal(r.netR,null);});
  test(`${direction} subsequent TP`,()=>{const c=long?candle(T+2*M,100,111,99):candle(T+2*M,100,101,89);assert.equal(exec([candle(T+M),c],fixture(direction)).status,'TP');});
  test(`${direction} subsequent STOP`,()=>{const c=long?candle(T+2*M,100,101,89):candle(T+2*M,100,111,99);assert.equal(exec([candle(T+M),c],fixture(direction)).status,'STOP');});
  test(`${direction} subsequent both levels ambiguous`,()=>assert.equal(exec([candle(T+M),candle(T+2*M,100,112,88)],fixture(direction)).status,'AMBIGUOUS'));
  test(`${direction} adverse gap worse than -1R`,()=>{const c=long?candle(T+2*M,80,85,75,81):candle(T+2*M,120,125,115,121);const r=exec([candle(T+M),c],fixture(direction));near(r.grossR,-2);assert.equal(r.exitPrice,c.open);});
  test(`${direction} TP gap no price improvement`,()=>{const c=long?candle(T+2*M,120,125,115,121):candle(T+2*M,80,85,75,81);const r=exec([candle(T+M),c],fixture(direction));assert.equal(r.status,'TP');near(r.exitPrice,long?110.75:89.25);});
  test(`${direction} exact notional fees and net R`,()=>{const c=long?candle(T+M,100,111,99):candle(T+M,100,101,89);const r=exec([c],fixture(direction));near(r.entryFeeUsd,.05);near(r.exitFeeUsd,(long?110.75:89.25)*.0005);near(r.feeR,(r.entryFeeUsd+r.exitFeeUsd)/10);near(r.netR,1.075-r.feeR);});
}
test('ATR remains original when future daily candle has huge range',()=>{const f=fixture();f.daily.push(candle(T,100,900,1));const r=exec([candle(T+100*M,200,201,199,200)],f,T+100*M);assert.equal(r.plan.atr,10);near(Math.abs(r.plan.tp-r.plan.entry),10.75);});
test('no structure input needed or inspected',()=>{const f=fixture();Object.defineProperty(f,'hourly',{get(){throw Error('must not read structure');}});assert.equal(control.prepare(f).eligible,true);});
test('translation with nonpositive stop is unavailable, not clamped',()=>{const r=exec([candle(T+M,5,6,4,5)]);assert.equal(r.status,'GEOMETRY_UNAVAILABLE');assert.equal(r.grossR,null);assert.equal(r.selectedEntryValid,true);});
test('original horizon not delayed by random entry',()=>{const start=T+700*M,cs=path(start,T+72*H);cs.push(candle(T+72*H,100,999,1));const r=exec(cs,fixture(),start);assert.equal(r.status,'UNRESOLVED_OPEN');assert.equal(r.checkedThrough,T+72*H);assert.equal(r.netR,null);});
test('last complete horizon candle can resolve',()=>{const start=T+700*M,cs=path(start,T+72*H);cs[cs.length-1]=candle(T+72*H-M,100,111,99);assert.equal(exec(cs,fixture(),start).status,'TP');});
test('fractional horizon ignores partial final candle',()=>{const cs=path(T+M,T+72*H);cs.push(candle(T+72*H,100,999,1));assert.equal(exec(cs,fixture('Long',T+1000)).status,'UNRESOLVED_OPEN');});
const mutations={
  'missing selected':cs=>cs.shift(),
  'invalid selected':cs=>{cs[0].low=200;},
  'unconfirmed selected':cs=>{cs[0].confirmed=false;},
  'wrong selected instrument':cs=>{cs[0].instId='OTHER-USDT-SWAP';},
  'missing future minute':cs=>cs.splice(1,1),
  'duplicate future':cs=>cs.splice(1,0,{...cs[1]}),
  'out-of-order':cs=>{[cs[0],cs[1]]=[cs[1],cs[0]];},
  'invalid future OHLC':cs=>{cs[1].high=1;},
  'unconfirmed future':cs=>{cs[1].confirmed=false;},
  'nonfinite future':cs=>{cs[1].close=NaN;},
  'misaligned future':cs=>{cs[1].timestamp+=1;}
};
for(const [label,mutate] of Object.entries(mutations)) test(label+' => DATA_UNAVAILABLE',()=>{const cs=[candle(T+M),candle(T+2*M),candle(T+3*M,100,111,99)];mutate(cs);const r=exec(cs);assert.equal(r.status,'DATA_UNAVAILABLE');assert.equal(r.netR,null);assert.equal(r.completedAt,null);});
test('irrelevant data failure after resolved exit ignored',()=>{const r=exec([candle(T+M,100,111,99),{...candle(T+2*M),high:0}]);assert.equal(r.status,'TP');});
test('no leverage double-count',()=>{const f=fixture();f.signal.leverage=100;const cs=[candle(T+M,100,111,99)];assert.equal(exec(cs,f).feeR,exec(cs).feeR);});
test('input objects and candles unchanged',()=>{const f=fixture(),cs=[candle(T+M,100,111,99)],before=JSON.stringify([f,cs]);exec(cs,f);assert.equal(JSON.stringify([f,cs]),before);});
test('config caller mutation cannot change captured fee',()=>{const c=structuredClone(config),e=createRandomControl(c);c.fees.entryRate=10;assert.equal(e.executeSample({...fixture(),selectedAt:T+M,minutes:[candle(T+M,100,111,99)]}).entryFeeUsd,.05);});

test('sampling exactly reuses frozen primitive',()=>{const f=fixture(),p=control.prepare(f);assert.deepEqual(control.run({...f,minutes:[]}).selectedTimes,sim.sampleControlTimes(p.schedule).samples);});
test('all selected missing minutes remain in 100 denominator without redraw',()=>{const r=control.run({...fixture(),minutes:[]});assert.equal(r.samples.length,100);assert.equal(r.counts.totalScheduledSamples,100);assert.equal(r.counts.dataUnavailable,100);assert.equal(r.counts.validSelectedEntryCandles,0);assert.ok(r.samples.every(s=>s.status==='DATA_UNAVAILABLE'));});
test('mixed missing/valid data preserves selected times and denominator',()=>{const f=fixture(),baseline=control.run({...f,minutes:[]});const t=baseline.selectedTimes[0];const r=control.run({...f,minutes:[candle(t,100,111,99)]});assert.deepEqual(r.selectedTimes,baseline.selectedTimes);assert.equal(r.counts.totalScheduledSamples,100);assert.ok(r.counts.dataUnavailable>0);assert.ok(r.counts.resolvedNumeric>0);});
test('all invalid selected candles remain unavailable without redraw',()=>{const f=fixture(),p=control.prepare(f),cs=p.schedule.map(t=>({...candle(t),confirmed:false}));const r=control.run({...f,minutes:cs});assert.equal(r.counts.dataUnavailable,100);assert.deepEqual(r.selectedTimes,sim.sampleControlTimes(p.schedule).samples);});
test('winning vs losing future data never changes RNG selection',()=>{const f=fixture(),schedule=control.prepare(f).schedule;const wins=control.run({...f,minutes:schedule.map(t=>candle(t,100,111,99))});const losses=control.run({...f,minutes:schedule.map(t=>candle(t,100,101,89))});assert.deepEqual(wins.selectedTimes,losses.selectedTimes);assert.equal(wins.counts.classifications.TP,100);assert.equal(losses.counts.classifications.STOP,100);});
test('ambiguous results never trigger redraw',()=>{const f=fixture(),p=control.prepare(f),r=control.run({...f,minutes:p.schedule.map(t=>candle(t,100,112,88))});assert.equal(r.counts.ambiguous,100);assert.deepEqual(r.selectedTimes,sim.sampleControlTimes(p.schedule).samples);});
test('same seed gives byte-equivalent full result',()=>{const a={...fixture(),minutes:[]};assert.equal(JSON.stringify(control.run(a)),JSON.stringify(control.run(a)));});
test('sampling with replacement matches frozen duplicate selections',()=>{const r=control.run({...fixture(),minutes:[]});assert.ok(new Set(r.selectedTimes).size<100);assert.equal(r.samples.length,100);});
test('schedule order fixed, not supplied candle order',()=>{const f=fixture(),cs=[candle(T+M),candle(T+2*M)];assert.deepEqual(control.run({...f,minutes:cs}).selectedTimes,control.run({...f,minutes:[...cs].reverse()}).selectedTimes);});

for(const direction of ['Long','Short']) {
  const long=direction==='Long',f=fixture(direction);
  const cases={
    sameTP:[long?candle(T+M,100,111,99):candle(T+M,100,101,89)],
    sameSTOP:[long?candle(T+M,100,101,89):candle(T+M,100,111,99)],
    both:[candle(T+M,100,112,88)],
    laterTP:[candle(T+M),long?candle(T+2*M,100,111,99):candle(T+2*M,100,101,89)],
    gapSTOP:[candle(T+M),long?candle(T+2*M,80,85,75,80):candle(T+2*M,120,125,115,120)],
    gapTP:[candle(T+M),long?candle(T+2*M,120,125,115,120):candle(T+2*M,80,85,75,80)],
    missing:[candle(T+M),candle(T+3*M)],
    invalid:[candle(T+M),{...candle(T+2*M),confirmed:false}]
  };
  for(const [name,cs] of Object.entries(cases)) test(`${direction} frozen post-fill parity: ${name}`,()=>{
    const ordinary=sim.simulate({...f,hourly:[],minutes:cs,variant:'V0'});assert.deepEqual(fields(exec(cs,f)),fields(ordinary));
  });
}
test('horizon post-fill parity',()=>{const f=fixture(),cs=path(T+M,T+72*H);assert.deepEqual(fields(exec(cs,f)),fields(sim.simulate({...f,hourly:[],minutes:cs,variant:'V0'})));});
