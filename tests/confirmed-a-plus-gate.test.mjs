import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
const start = source.indexOf('function isConfirmedAPlusTrade(signal) {');
const end = source.indexOf('\nfunction isConfirmedAPlusTradeSignal', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const gate = context.isConfirmedAPlusTrade;
const long = () => ({
  direction: 'Long', action: 'Strong Buy', tradeAllowed: true,
  tradeReadiness: { ready: true }, opportunityScore: 85, confidence: 85,
  riskReward: 2, entryZone: { from: 99, to: 101 }, stopLoss: 90,
  takeProfit1: 110, takeProfit2: 120, takeProfit3: 130
});
const short = () => ({ ...long(), direction: 'Short', action: 'Strong Sell',
  stopLoss: 110, takeProfit1: 90, takeProfit2: 80, takeProfit3: 70 });

test('valid LONG passes at score 85, confidence 85 and R/R 2 without Grade', () => {
  assert.equal(gate(long()), true);
});
test('valid SHORT with Strong Sell passes', () => assert.equal(gate(short()), true));
test('both Grade fields below A+ do not veto underlying eligibility', () => {
  assert.equal(gate({ ...long(), grade: 'D', opportunityGrade: 'B' }), true);
});
for (const [name, patch] of [
  ['score 84', { opportunityScore: 84 }], ['confidence 84', { confidence: 84 }],
  ['Buy', { action: 'Buy' }], ['Sell', { action: 'Sell' }],
  ['Wait', { action: 'Wait' }], ['Avoid', { action: 'Avoid' }],
  ['wrong strong action for LONG', { action: 'Strong Sell' }],
  ['tradeAllowed false', { tradeAllowed: false }],
  ['readiness false', { tradeReadiness: { ready: false } }],
  ['R/R below 2', { riskReward: 1.99 }],
  ['missing Entry Zone', { entryZone: undefined }],
  ['missing Entry bound', { entryZone: { from: 99 } }],
  ['reversed Entry Zone', { entryZone: { from: 101, to: 99 } }],
  ['invalid Entry', { entryZone: { from: 'invalid', to: 101 } }],
  ['SL touches LONG zone', { stopLoss: 99 }],
  ['SL inside LONG zone', { stopLoss: 100 }],
  ['TP1 at entry reference', { takeProfit1: 100 }],
  ['reversed LONG targets', { takeProfit2: 131 }],
  ['equal targets', { takeProfit2: 110 }],
  ['unknown direction', { direction: 'Neutral' }],
  ['infinite score', { opportunityScore: Infinity }],
  ['infinite confidence', { confidence: Infinity }],
  ['infinite R/R', { riskReward: Infinity }]
]) test(`${name} fails even with A+ labels`, () => {
  assert.equal(gate({ ...long(), grade: 'A+', opportunityGrade: 'A+', ...patch }), false);
});
for (const field of ['stopLoss', 'takeProfit1', 'takeProfit2', 'takeProfit3']) {
  test(`${field} must be present, finite and positive`, () => {
    for (const value of [undefined, null, '', 0, -1, NaN, Infinity, true, []]) {
      assert.equal(gate({ ...long(), [field]: value }), false, `${field}: ${String(value)}`);
    }
  });
}
test('Entry bounds must be finite positive values', () => {
  for (const bound of ['from', 'to']) for (const value of [null, '', 0, -1, Infinity, NaN, true]) {
    const candidate = long(); candidate.entryZone[bound] = value;
    assert.equal(gate(candidate), false);
  }
});
test('SHORT rejects wrong-side SL, targets, ordering and action', () => {
  for (const patch of [{ stopLoss: 101 }, { stopLoss: 90 }, { takeProfit1: 100 },
    { takeProfit2: 95 }, { takeProfit3: 85 }, { action: 'Strong Buy' }]) {
    assert.equal(gate({ ...short(), ...patch }), false);
  }
});
test('finite numeric strings remain compatible and input is not mutated', () => {
  const candidate = long();
  candidate.entryZone = { from: '99', to: '101' };
  candidate.takeProfit3 = '130';
  const before = structuredClone(candidate);
  assert.equal(gate(candidate), true);
  assert.deepEqual(candidate, before);
});
test('missing candidate fails safely', () => {
  assert.equal(gate(null), false); assert.equal(gate(undefined), false);
});
