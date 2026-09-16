import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
const start = source.indexOf('function calculateRecommendation(data) {');
const end = source.indexOf('\nasync function fetchOKXSwapSymbols()', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const calculate = context.calculateRecommendation;
const input = (direction, score) => ({
  probability: { score: 86, scoreDifference: 59 },
  smartMoney: { score },
  tradePlan: { direction, validTrade: true, setupScore: 86, riskReward: 2 },
  trend: direction === 'Short' ? 'Strong Bearish' : 'Strong Bullish'
});

test('LONG raw 70 preserves existing confidence and raw-based grade', () => {
  const data = input('Long', 70), before = structuredClone(data);
  const result = calculate(data);
  assert.equal(result.confidence, 82);
  assert.equal(result.action, 'Strong Buy');
  assert.equal(result.gradeScore, 83);
  assert.equal(result.grade, 'A');
  assert.deepEqual(data, before);
});

test('RAVE-like SHORT raw 30 uses quality 70 and matches LONG', () => {
  const data = input('Short', 30), before = structuredClone(data);
  const result = calculate(data);
  assert.equal(result.confidence, 82);
  assert.equal(result.confidence, calculate(input('Long', 70)).confidence);
  assert.equal(result.action, 'Strong Sell');
  assert.equal(result.gradeScore, 75);
  assert.equal(result.grade, 'A');
  assert.deepEqual(data, before);
});

for (const direction of ['Neutral', 'Wait', undefined, 'Unknown']) {
  test(`unknown/neutral direction uses quality 50: ${direction}`, () => {
    const result = calculate(input(direction, 10));
    assert.equal(result.confidence, 78);
    assert.equal(result.action, 'Wait');
  });
}

for (const raw of [undefined, null, '30', NaN, Infinity, -1, 101]) {
  test(`invalid raw uses confidence fallback 50: ${String(raw)}`, () => {
    assert.equal(calculate(input('Short', raw)).confidence, 78);
  });
}

test('existing action threshold and invalid-plan Wait remain unchanged', () => {
  for (const [direction, raw, weak, strong] of [
    ['Long', 70, 'Buy', 'Strong Buy'], ['Short', 30, 'Sell', 'Strong Sell']
  ]) {
    const data = input(direction, raw);
    data.probability.score = 60;
    assert.equal(calculate(data).confidence, 74);
    assert.equal(calculate(data).action, weak);
    data.probability.score = 62;
    assert.equal(calculate(data).confidence, 75);
    assert.equal(calculate(data).action, strong);
    data.tradePlan.validTrade = false;
    assert.equal(calculate(data).action, 'Wait');
  }
});
