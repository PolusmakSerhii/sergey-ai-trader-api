import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
const context = vm.createContext({});
for (const [start, end] of [
  ['function isConfirmedAPlusTrade(signal) {', '\nfunction isConfirmedAPlusTradeSignal'],
  ['function calculateScannerOpportunity(data) {', '\nasync function fetchScannerSymbol']
]) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  vm.runInContext(source.slice(a, b), context);
}
const calculate = context.calculateScannerOpportunity;
const candidate = () => ({
  score: 85, confidence: 85, tradeReadiness: { ready: true, score: 85, status: 'Ready' },
  marketEnvironmentScore: 85, smartMoneyScore: 85, riskReward: 2,
  tradeAllowed: true, probabilities: { neutral: 10 },
  direction: 'Long', action: 'Strong Buy',
  entryZone: { from: 99, to: 101 }, stopLoss: 90,
  takeProfit1: 110, takeProfit2: 120, takeProfit3: 130
});
const high = () => ({ ...candidate(), score: 100, confidence: 100,
  tradeReadiness: { ready: true, score: 100, status: 'Ready' },
  marketEnvironmentScore: 100, smartMoneyScore: 100, riskReward: 3 });

test('score 85 / confidence 85 / valid LONG produces A+', () => {
  const result = calculate(candidate());
  assert.equal(result.score, 85); assert.equal(result.grade, 'A+');
});
test('equivalent valid SHORT produces A+', () => {
  const result = calculate({ ...candidate(), direction: 'Short', action: 'Strong Sell', smartMoneyScore: 15,
    stopLoss: 110, takeProfit1: 90, takeProfit2: 80, takeProfit3: 70 });
  assert.equal(result.score, 85); assert.equal(result.grade, 'A+');
});
for (const [name, patch, expectedScore] of [
  ['confidence 84', { confidence: 84, score: 95 }, 95],
  ['Buy', { action: 'Buy', score: 75 }, 95],
  ['tradeAllowed false', { tradeAllowed: false }, 90],
  ['readiness false', { tradeReadiness: { ready: false, score: 80, status: 'Conditional' } }, 95],
  ['R/R below 2', { riskReward: 1.9 }, 97],
  ['invalid SL', { stopLoss: 100, score: 75 }, 95],
  ['reversed Entry', { entryZone: { from: 101, to: 99 }, score: 75 }, 95],
  ['reversed targets', { takeProfit2: 140, score: 75 }, 95],
  ['missing TP3', { takeProfit3: undefined, score: 75 }, 95]
]) test(`high-score candidate with ${name} falls back to A without changing score`, () => {
  const result = calculate({ ...high(), ...patch });
  assert.equal(result.score, expectedScore); assert.equal(result.grade, 'A');
});
test('existing A/B/C/D thresholds remain unchanged', () => {
  for (const [value, score, grade] of [[74, 75, 'A'], [73, 74, 'B'],
    [63, 65, 'B'], [62, 64, 'C'], [52, 55, 'C'], [51, 54, 'D']]) {
    const result = calculate({ ...candidate(), score: value, confidence: value,
      tradeReadiness: { ready: true, score: value, status: 'Ready' },
      marketEnvironmentScore: value, smartMoneyScore: value });
    assert.equal(result.score, score); assert.equal(result.grade, grade);
  }
});
test('old grade/score labels cannot override the newly calculated dataset', () => {
  assert.equal(calculate({ ...candidate(), grade: 'D', opportunityGrade: 'D', opportunityScore: 0 }).grade, 'A+');
  assert.equal(calculate({ ...candidate(), confidence: 84, grade: 'A+', opportunityGrade: 'A+', opportunityScore: 100 }).grade, 'A');
});
test('geometry affects grade only: numeric score/components/penalties stay identical', () => {
  const valid = calculate(high());
  const invalid = calculate({ ...high(), takeProfit1: 0 });
  assert.equal(valid.grade, 'A+'); assert.equal(invalid.grade, 'A');
  assert.equal(valid.score, invalid.score);
  assert.deepEqual(valid.components, invalid.components);
  assert.deepEqual(valid.penalties, invalid.penalties);
});
test('candidate data and attached frozen/history fields are not mutated', () => {
  const data = { ...candidate(), initialPlan: { stopLoss: 80 },
    outcome: { status: 'Active' }, grade: 'D', opportunityGrade: 'B' };
  const before = structuredClone(data);
  calculate(data);
  assert.deepEqual(data, before);
});

for (const [name, blockers, penalty] of [
  ['sole environment', ['Market environment is not tradable'], false],
  ['other blocker', ['Signal confidence is too low: 50'], true],
  ['environment plus other', ['Market environment is not tradable', 'Signal confidence is too low: 50'], true],
  ['duplicate blockers', ['Market environment is not tradable', 'Market environment is not tradable'], true],
  ['missing blockers', undefined, true],
  ['empty blockers', [], true]
]) test(`Blocked penalty: ${name}`, () => {
  const data = { ...high(), tradeReadiness: { score: 100, ready: false, status: 'Blocked', blockers } };
  const before = structuredClone(data);
  const result = calculate(data);
  assert.equal(result.score, penalty ? 90 : 100);
  assert.equal(result.penalties.includes('Trade readiness is blocked'), penalty);
  assert.equal(result.confirmedAPlus, false);
  assert.equal(result.grade, 'A');
  assert.deepEqual(data, before);
});

test('Scanner projection preserves sole environment blocker and RAVE remains unconfirmed A', () => {
  const payload = { technical: {
    probability: { score: 86, confidence: { score: 99 },
      aiAssessment: { direction: 'Short', tradeAllowed: true }, probabilities: { neutral: 0 } },
    recommendation: { action: 'Strong Sell' }, smartMoney: { score: 30 },
    marketEnvironment: { score: 71, tradable: false },
    tradeReadiness: { score: 88, ready: false, status: 'Blocked', blockers: ['Market environment is not tradable'] },
    tradePlan: { riskReward: 2, entryZone: { from: 99, to: 101 },
      stopLoss: 110, takeProfit1: 90, takeProfit2: 80, takeProfit3: 70 }
  } };
  const data = context.createScannerAnalysis(payload, 'RAVEUSDT');
  assert.equal(data.tradeReadiness.blockers[0], 'Market environment is not tradable');
  assert.notEqual(data.tradeReadiness.blockers, payload.technical.tradeReadiness.blockers);
  const result = calculate(data);
  assert.equal(result.score, 87);
  assert.equal(result.grade, 'A');
  assert.equal(result.confirmedAPlus, false);
  assert.equal(data.tradeReadiness.ready, false);
  assert.equal(data.tradeReadiness.status, 'Blocked');
});

test('environment exception does not remove other Opportunity penalties', () => {
  const result = calculate({ ...high(), tradeAllowed: false, probabilities: { neutral: 60 },
    tradeReadiness: { score: 100, ready: false, status: 'Blocked', blockers: ['Market environment is not tradable'] } });
  assert.equal(result.score, 80);
  assert.deepEqual(Array.from(result.penalties), ['Trade is not currently allowed', 'Neutral probability is too high']);
  assert.equal(result.confirmedAPlus, false);
});
