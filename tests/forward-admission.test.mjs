import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCandidates, checkCapacity, reduceMinute, markVerificationGap,
  restoreVerification, verifyMissedEntry, completeTrade, STATES } from '../lib/forward-validation/engine.js';
const T = Date.parse('2026-10-14T10:00:00.000Z'), M = 60000;
const candidate = (id, direction = 'Long', time = T, instrument = id) => ({
  tradeId: id, instrument, direction, state: 'WAITING_ENTRY', capacityOccupied: false,
  origin: { detectedAt: new Date(T - 10*M).toISOString() },
  eligibleEntryCandle: { timestamp: time, confirmed: true, verified: true, firstEligible: true }
});
const occupied = (id, direction = 'Long') => ({ ...candidate(id, direction), state: 'ADMITTED', capacityOccupied: true });
const full = () => [occupied('a'), occupied('b'), occupied('c', 'Short')];
const proof = (minute = T) => ({ minute, sealed: true, unresolvedEarlier: false, competingCandidatesComplete: true });
const input = (candidates = [candidate('z', 'Short')], occupancy = []) => ({ minute: T, candidates, occupancy, releases: [], boundaryProof: proof() });
const release = (id, candle = T) => ({ tradeId: id, confirmed: true, status: 'Stopped', terminalCandleTimestamp: candle, releaseAvailableAt: candle + M });
const expiry = () => ({ confirmed: true, neverAdmitted: true, validPlan: true, validBoundaries: true,
  sequentialCoverage: true, noGaps: true, noAmbiguity: true, noEligibleTouch: true,
  lifecycleStatus: 'Expired', verifiedThrough: T + M, expiryBoundary: T + M });
const restoration = { restored: true, noGaps: true, noAmbiguity: true };
function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }

test('comparator: event timestamp first', () => assert.ok(compareCandidates(candidate('z'), candidate('a', 'Long', T+M)) < 0));
test('comparator: detectedAt tie-break', () => {
  const a=candidate('z'); a.origin.detectedAt=new Date(T-11*M).toISOString();
  assert.ok(compareCandidates(a,candidate('a'))<0);
});
test('comparator: lexical ID tie-break', () => assert.ok(compareCandidates(candidate('A'),candidate('a'))<0));
test('comparator: Unicode code points, not UTF-16 ordering', () => assert.ok(compareCandidates(candidate('\uE000'),candidate('\u{10000}'))<0));
for (const change of [r=>delete r.tradeId,r=>r.origin.detectedAt='bad',r=>delete r.eligibleEntryCandle.timestamp,
  r=>r.eligibleEntryCandle.timestamp=T+1,r=>r.origin.detectedAt='2026-02-30T10:00:00.000Z']) {
  test('comparator rejects invalid identity/time '+String(change),()=>{const r=candidate('z');change(r);assert.throws(()=>compareCandidates(r,candidate('b')));});
}
test('candidate and occupancy permutations produce identical result',()=>{
  const a=input([candidate('z','Short'),candidate('d','Short')],[occupied('a'),occupied('b')]);
  const b=structuredClone(a);b.candidates.reverse();b.occupancy.reverse();
  assert.deepEqual(reduceMinute(a),reduceMinute(b));
});
test('three occupied rejects fourth',()=>assert.equal(reduceMinute(input(undefined,full())).decisions[0].state,'SKIPPED_CAPACITY'));
test('two Long rejects third with free total slot',()=>assert.deepEqual(checkCapacity([occupied('a'),occupied('b')],candidate('d')).reasons,['MAX_SAME_DIRECTION']));
test('same instrument opposite direction rejected',()=>assert.deepEqual(checkCapacity([occupied('a')],candidate('z','Short',T,'a')).reasons,['MAX_PER_INSTRUMENT']));
test('one slot: comparator winner admitted then final capacity skip',()=>{
  const r=reduceMinute(input([candidate('z','Short'),candidate('d','Short')],[occupied('a'),occupied('b')]));
  assert.deepEqual(r.decisions.map(d=>[d.tradeId,d.state]),[['d','ADMITTED'],['z','SKIPPED_CAPACITY']]);
  const retry=r.decisions[1].record;retry.eligibleEntryCandle.timestamp=T+M;
  assert.deepEqual(reduceMinute({...input([retry]),minute:T+M,boundaryProof:proof(T+M)}).decisions,[]);
});
test('terminal during T cannot free slot in T',()=>{
  const i=input(undefined,full());i.releases=[release('a')];
  assert.equal(reduceMinute(i).decisions[0].state,'SKIPPED_CAPACITY');
});
test('release boundary at T frees slot at T',()=>{
  const i=input(undefined,full());i.releases=[release('a',T-M)];
  const r=reduceMinute(i);assert.equal(r.decisions[0].state,'ADMITTED');assert.equal(r.nextOccupancy.length,3);
});
test('terminal T permits fresh first entry at T+1',()=>{
  const i={...input([candidate('z','Short',T+M)],full()),minute:T+M,boundaryProof:proof(T+M),releases:[release('a')]};
  assert.equal(reduceMinute(i).decisions[0].state,'ADMITTED');
});
for(const label of ['TP1','HOLD','pending CLOSE'])test(label+' remains occupied',()=>{
  const rows=full();rows[0].remainingPosition=.5;rows[0].continuation=label;
  assert.equal(reduceMinute(input(undefined,rows)).decisions[0].state,'SKIPPED_CAPACITY');
});
for(const change of [i=>delete i.boundaryProof,i=>i.boundaryProof.sealed=false,
  i=>i.boundaryProof.unresolvedEarlier=true,i=>i.boundaryProof.competingCandidatesComplete=false,
  i=>i.boundaryProof.minute=T-M])test('incomplete boundary blocks '+String(change),()=>{
  const i=input();change(i);const r=reduceMinute(i);
  assert.equal(r.decisions.length,0);assert.equal(r.nextOccupancy.length,0);assert.ok(r.blockers.length);
});
test('waiting gap and recovery preserve progress/evidence',()=>{
  const r=candidate('z');r.verification={cursor:T-M};
  const gap=markVerificationGap(r,{reason:'GAP',progress:{cursor:T-M},evidence:{missing:T}});
  assert.equal(gap.state,'UNRESOLVED_VERIFICATION');assert.equal(gap.priorDisposition,'WAITING_ENTRY');
  assert.equal(gap.capacityOccupied,false);assert.equal(gap.verification.cursor,T-M);
  assert.equal(restoreVerification(gap,restoration).state,'WAITING_ENTRY');
});
test('admitted gap/recovery retains slot and immutable decision',()=>{
  const r=occupied('a');r.admissionDecision={minute:T-M,allowed:true};
  const gap=markVerificationGap(r,{reason:'GAP'});
  assert.equal(gap.priorDisposition,'ADMITTED');assert.equal(gap.capacityOccupied,true);
  assert.deepEqual(gap.admissionDecision,r.admissionDecision);
  assert.equal(checkCapacity([gap,occupied('b'),occupied('c','Short')],candidate('z','Short')).allowed,false);
  assert.equal(restoreVerification(gap,restoration).state,'ADMITTED');
});
test('repeated gap preserves original priorDisposition',()=>{
  const gap=markVerificationGap(occupied('a'),{reason:'GAP'});
  assert.equal(markVerificationGap(gap,{reason:'RETRY'}).priorDisposition,'ADMITTED');
});
test('unproven restoration throws',()=>assert.throws(()=>restoreVerification(markVerificationGap(candidate('a'),{reason:'GAP'}),{})));
test('wall-clock expiry alone is not missed entry',()=>assert.equal(verifyMissedEntry(candidate('a'),{expired:true}).state,'UNRESOLVED_VERIFICATION'));
test('complete verified expiry is missed entry',()=>assert.equal(verifyMissedEntry(candidate('a'),expiry()).state,'SKIPPED_MISSED_ENTRY'));
for(const field of ['neverAdmitted','validPlan','validBoundaries','sequentialCoverage','noGaps','noAmbiguity','noEligibleTouch'])test('expiry requires '+field,()=>{
  const p=expiry();p[field]=false;assert.equal(verifyMissedEntry(candidate('a'),p).state,'UNRESOLVED_VERIFICATION');
});
test('short coverage cannot prove expiry',()=>assert.equal(verifyMissedEntry(candidate('a'),{...expiry(),verifiedThrough:T}).state,'UNRESOLVED_VERIFICATION'));
test('verified recovery may finalize missed entry',()=>assert.equal(verifyMissedEntry(markVerificationGap(candidate('a'),{reason:'GAP'}),expiry()).state,'SKIPPED_MISSED_ENTRY'));
test('admitted cannot become missed entry',()=>assert.throws(()=>verifyMissedEntry(occupied('a'),expiry())));
test('reserved DATA_FAILURE cannot be produced by allowed transitions',()=>{
  assert.ok(STATES.includes('SKIPPED_DATA_FAILURE'));
  const r={...candidate('a'),state:'SKIPPED_DATA_FAILURE'};
  assert.throws(()=>markVerificationGap(r,{reason:'GAP'}));
  assert.throws(()=>restoreVerification(r,restoration));
  assert.throws(()=>verifyMissedEntry(r,expiry()));
  assert.throws(()=>completeTrade(r,release('a')));
  assert.deepEqual(reduceMinute(input([r])).decisions,[]);
  for(const x of [markVerificationGap(candidate('a'),{reason:'FAILURE'}),verifyMissedEntry(candidate('a'),{}),
    verifyMissedEntry(candidate('a'),expiry()),completeTrade(occupied('a'),release('a'))]) assert.notEqual(x.state,'SKIPPED_DATA_FAILURE');
});
test('confirmed terminal completes but reserves slot until boundary release',()=>{
  const e={...release('a'),resultR:.5,resultRVerified:true};
  const r=completeTrade(occupied('a'),e);
  assert.equal(r.state,'COMPLETED');assert.equal(r.resultR,.5);assert.equal(r.capacityOccupied,true);
  const i=input(undefined,[r,occupied('b'),occupied('c','Short')]);i.releases=[e];
  assert.equal(reduceMinute(i).decisions[0].state,'SKIPPED_CAPACITY');
  i.minute=T+M;i.boundaryProof=proof(T+M);i.candidates=[candidate('z','Short',T+M)];
  assert.equal(reduceMinute(i).decisions[0].state,'ADMITTED');
});
test('unresolved admitted can complete',()=>assert.equal(completeTrade(markVerificationGap(occupied('a'),{reason:'GAP'}),release('a')).state,'COMPLETED'));
for(const value of [undefined,NaN,Infinity,'1'])test('missing/invalid terminal R stays null '+String(value),()=>assert.equal(completeTrade(occupied('a'),{...release('a'),resultR:value,resultRVerified:true}).resultR,null));
test('unverified numerical terminal R stays null',()=>assert.equal(completeTrade(occupied('a'),{...release('a'),resultR:1}).resultR,null));
test('unconfirmed terminal rejected',()=>assert.throws(()=>completeTrade(occupied('a'),{...release('a'),confirmed:false})));
test('invented intrabar release rejected',()=>assert.throws(()=>completeTrade(occupied('a'),{...release('a'),releaseAvailableAt:T})));
test('expiry is not a position terminal release',()=>assert.throws(()=>completeTrade(occupied('a'),{...release('a'),status:'Expired'})));
test('duplicate candidates fail entire batch even exact duplicate',()=>{
  const a=candidate('a');const r=reduceMinute(input([a,structuredClone(a)]));
  assert.deepEqual(r.decisions,[]);assert.ok(r.blockers.includes('DUPLICATE_IDENTITY'));
});
test('duplicate occupancy fails closed',()=>assert.ok(reduceMinute(input([], [occupied('a'),occupied('a')])).blockers.length));
test('malformed release never frees slot',()=>{
  const i=input(undefined,full());i.releases=[{...release('a',T-M),confirmed:false}];
  const r=reduceMinute(i);assert.deepEqual(r.decisions,[]);assert.equal(r.nextOccupancy.length,3);
});
test('unknown release identity fails closed',()=>assert.ok(reduceMinute({...input(),releases:[release('missing')]}).blockers.length));
test('unconfirmed/nonfirst entry fails closed',()=>{
  for(const k of ['confirmed','verified','firstEligible']){const r=candidate('a');r.eligibleEntryCandle[k]=false;assert.ok(reduceMinute(input([r])).blockers.length);}
});
test('score confidence future pnl cannot change decisions',()=>{
  const a=input([candidate('a','Short'),candidate('z','Short')],[occupied('b'),occupied('c')]);
  const b=structuredClone(a);b.candidates[0].score=0;b.candidates[0].confidence=0;b.candidates[0].resultR=-100;
  b.candidates[1].opportunityScore=100;b.candidates[1].recommendationConfidence=100;b.candidates[1].futureResultR=100;
  const project=r=>r.decisions.map(d=>({tradeId:d.tradeId,state:d.state,reasons:d.reasons}));
  assert.deepEqual(project(reduceMinute(a)),project(reduceMinute(b)));
});
test('inputs deeply frozen, untouched, and output references detached',()=>{
  const i=deepFreeze(input([candidate('z','Short')],full()));const before=structuredClone(i);
  const r=reduceMinute(i);assert.deepEqual(i,before);r.nextOccupancy[0].instrument='changed';assert.deepEqual(i,before);
  const waiting=deepFreeze(candidate('w')), active=deepFreeze(occupied('a'));
  const w=structuredClone(waiting),a=structuredClone(active);
  const gap=deepFreeze(markVerificationGap(waiting,{reason:'GAP'}));restoreVerification(gap,restoration);
  verifyMissedEntry(waiting,deepFreeze(expiry()));completeTrade(active,deepFreeze(release('a')));
  assert.deepEqual(waiting,w);assert.deepEqual(active,a);
});
