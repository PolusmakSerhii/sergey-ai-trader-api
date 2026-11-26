import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CORE_V2_D03_ALIGNMENT,
  CORE_V2_D03_CLASSIFICATION,
  CORE_V2_D03_OI_SOURCE_KIND,
  CORE_V2_D03_PRICE_SOURCE_KIND,
  compareV1AndCoreV2D03,
  evaluateCoreV2D03,
  measureCoreV2D03Bytes
} from '../lib/core-v2-d03.js';
import {
  appendCoreV2ActivationEvidence,
  appendCoreV2D03Evidence,
  CORE_V2_ARCHIVE_RULES_VERSION,
  CORE_V2_D03_CONTRACT_VERSION,
  CORE_V2_EVIDENCE_MAX_BYTES,
  CORE_V2_EXIT_POLICY_VERSION,
  CORE_V2_STRATEGY_VERSION,
  createCoreV2BirthEvidence,
  EVIDENCE_STATUS,
  measureCoreV2EvidenceBytes
} from '../lib/core-v2-evidence.js';

const windowStart = '2026-11-25T00:00:00.000Z';
const windowEnd = '2026-11-26T00:00:00.000Z';
const fourHours = 4 * 60 * 60 * 1000;

function observations() {
  const start = Date.parse(windowStart);
  return Array.from({ length: 6 }, (_, index) => ({
    windowStart: new Date(start + index * fourHours).toISOString(),
    windowEnd: new Date(start + (index + 1) * fourHours).toISOString()
  }));
}

function d03Input(overrides = {}) {
  return {
    openInterestChangePct: 2,
    priceChangePct: 3,
    openInterestSource: 'CoinGlass aggregated futures OI · BTC',
    openInterestSourceKind: CORE_V2_D03_OI_SOURCE_KIND,
    priceSource: 'OKX BTC-USDT-SWAP closed daily candle',
    priceSourceKind: CORE_V2_D03_PRICE_SOURCE_KIND,
    openInterestObservedAt: '2026-11-26T00:05:00.000Z',
    priceObservedAt: '2026-11-26T00:06:00.000Z',
    oiWindowStart: windowStart,
    oiWindowEnd: windowEnd,
    priceWindowStart: windowStart,
    priceWindowEnd: windowEnd,
    oiObservations: observations(),
    priceCandleStatus: 'CLOSED',
    evaluatedAt: '2026-11-26T01:00:00.000Z',
    ...overrides
  };
}

function birthInput() {
  return {
    canonicalSymbol: 'BTCUSDT', marketSymbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instrumentType: 'SWAP',
    direction: 'Long', originAt: '2026-11-26T01:00:10.000Z', analysisAt: '2026-11-26T01:00:00.000Z',
    analysisPrice: 100.4, priceSource: 'OKX', priceObservedAt: '2026-11-26T00:59:59.500Z',
    candleSource: 'OKX', candleFirstOpenAt: '2026-05-10T16:00:00.000Z',
    candleLastConfirmedCloseAt: '2026-11-26T00:00:00.000Z',
    instrumentSource: 'OKX public instruments', instrumentRecordObservedAt: '2026-11-26T00:59:30.000Z',
    atr: 2, tickSize: 0.01,
    plan: { plannedEntry: 100, entryZone: { low: 99.5, high: 100.5 }, initialStopLoss: 98,
      takeProfit1: 102, takeProfit2: 104, takeProfit3: 106 }
  };
}

for (const [name, oi, price, classification, signal] of [
  ['OI up / price up', 2, 3, CORE_V2_D03_CLASSIFICATION.BULLISH_CONFIRMATION, 'BULLISH'],
  ['OI up / price down', 2, -3, CORE_V2_D03_CLASSIFICATION.BEARISH_CONFIRMATION, 'BEARISH'],
  ['OI down / price up', -2, 3, CORE_V2_D03_CLASSIFICATION.SHORT_COVERING, 'NEUTRAL'],
  ['OI down / price down', -2, -3, CORE_V2_D03_CLASSIFICATION.LONG_LIQUIDATION, 'NEUTRAL']
]) test(name, () => {
  const result = evaluateCoreV2D03(d03Input({ openInterestChangePct: oi, priceChangePct: price }));
  assert.equal(result.classification, classification);
  assert.equal(result.directionalSignal, signal);
  assert.equal(result.status, EVIDENCE_STATUS.AVAILABLE);
});

test('OI flat has a stable explicit classification', () => assert.equal(
  evaluateCoreV2D03(d03Input({ openInterestChangePct: 0 })).classification,
  CORE_V2_D03_CLASSIFICATION.OPEN_INTEREST_FLAT));

test('price flat has a stable explicit classification', () => assert.equal(
  evaluateCoreV2D03(d03Input({ priceChangePct: 0 })).classification,
  CORE_V2_D03_CLASSIFICATION.PRICE_FLAT));

test('both flat has a stable explicit classification', () => assert.equal(
  evaluateCoreV2D03(d03Input({ openInterestChangePct: 0, priceChangePct: 0 })).classification,
  CORE_V2_D03_CLASSIFICATION.BOTH_FLAT));

test('missing OI is unavailable and never coerced to zero', () => {
  const result = evaluateCoreV2D03(d03Input({ openInterestChangePct: null }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert.equal(result.openInterestChangePct, null);
  assert(result.reasonCodes.includes('MISSING_OPEN_INTEREST_CHANGE_PCT'));
});

test('missing price is unavailable and never replaced by OI', () => {
  const result = evaluateCoreV2D03(d03Input({ priceChangePct: undefined }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert.equal(result.priceChangePct, null);
  assert(result.reasonCodes.includes('MISSING_PRICE_CHANGE_PCT'));
});

test('NaN is unavailable', () => assert.equal(
  evaluateCoreV2D03(d03Input({ priceChangePct: Number.NaN })).status, EVIDENCE_STATUS.UNAVAILABLE));

test('Infinity is unavailable', () => assert.equal(
  evaluateCoreV2D03(d03Input({ openInterestChangePct: Number.POSITIVE_INFINITY })).status,
  EVIDENCE_STATUS.UNAVAILABLE));

test('future observations fail safe', () => {
  const result = evaluateCoreV2D03(d03Input({ priceObservedAt: '2026-11-26T01:00:00.001Z' }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('FUTURE_OBSERVATION'));
});

test('stale inputs fail safe', () => {
  const result = evaluateCoreV2D03(d03Input({ evaluatedAt: '2026-11-27T00:06:00.001Z' }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('STALE_INPUT'));
});

test('incomplete six-observation OI window fails safe', () => {
  const result = evaluateCoreV2D03(d03Input({ oiObservations: observations().slice(0, 5) }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('INCOMPLETE_OI_WINDOW'));
});

test('duplicate OI observation fails safe', () => {
  const rows = observations();
  rows[1] = { ...rows[0] };
  const result = evaluateCoreV2D03(d03Input({ oiObservations: rows }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('DUPLICATE_OI_OBSERVATION'));
});

test('non-contiguous 4H observations fail safe', () => {
  const rows = observations();
  rows[2] = { windowStart: '2026-11-25T09:00:00.000Z', windowEnd: '2026-11-25T13:00:00.000Z' };
  const result = evaluateCoreV2D03(d03Input({ oiObservations: rows }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('NON_CONTIGUOUS_OI_OBSERVATIONS'));
});

test('misaligned price and OI windows fail safe', () => {
  const result = evaluateCoreV2D03(d03Input({
    priceWindowStart: '2026-11-25T01:00:00.000Z',
    priceWindowEnd: '2026-11-26T01:00:00.000Z'
  }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert.equal(result.sourceEvidence.alignmentStatus, CORE_V2_D03_ALIGNMENT.MISALIGNED);
  assert(result.reasonCodes.includes('WINDOW_MISALIGNED'));
});

test('exact aligned closed window is available', () => {
  const result = evaluateCoreV2D03(d03Input());
  assert.equal(result.status, EVIDENCE_STATUS.AVAILABLE);
  assert.equal(result.sourceEvidence.alignmentStatus, CORE_V2_D03_ALIGNMENT.ALIGNED);
  assert.equal(result.sourceEvidence.openInterest.observationCount, 6);
});

test('source identities and typed source contracts are preserved', () => {
  const input = d03Input();
  const result = evaluateCoreV2D03(input);
  assert.equal(result.sourceEvidence.openInterest.source, input.openInterestSource);
  assert.equal(result.sourceEvidence.openInterest.sourceKind, CORE_V2_D03_OI_SOURCE_KIND);
  assert.equal(result.sourceEvidence.price.source, input.priceSource);
  assert.equal(result.sourceEvidence.price.sourceKind, CORE_V2_D03_PRICE_SOURCE_KIND);
});

test('source and window timestamps are preserved canonically', () => {
  const result = evaluateCoreV2D03(d03Input());
  assert.equal(result.sourceEvidence.openInterest.observedAt, '2026-11-26T00:05:00.000Z');
  assert.equal(result.sourceEvidence.price.observedAt, '2026-11-26T00:06:00.000Z');
  assert.equal(result.sourceEvidence.openInterest.windowStart, windowStart);
  assert.equal(result.sourceEvidence.price.windowEnd, windowEnd);
});

test('OI change is never substituted for price change', () => {
  const result = evaluateCoreV2D03(d03Input({ openInterestChangePct: 2, priceChangePct: -3 }));
  assert.equal(result.classification, CORE_V2_D03_CLASSIFICATION.BEARISH_CONFIRMATION);
  assert.equal(result.openInterestChangePct, 2);
  assert.equal(result.priceChangePct, -3);
});

test('unavailable result retains neutral inactive contribution semantics', () => {
  const result = evaluateCoreV2D03(d03Input({ priceChangePct: null }));
  assert.deepEqual(result.contribution, {
    status: 'NEUTRAL_UNAVAILABLE', bias: 'Neutral', applied: false, weight: null, reasonCode: 'D03_UNAVAILABLE'
  });
});

test('semantically incompatible source types fail safe', () => {
  const result = evaluateCoreV2D03(d03Input({ priceSourceKind: 'SPOT_TICKER_24H' }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('SEMANTICALLY_INCOMPATIBLE_PRICE_SOURCE'));
});

test('source identities cannot persist credential-shaped text', () => {
  const result = evaluateCoreV2D03(d03Input({ priceSource: 'OKX Bearer PRIVATE_TOKEN' }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert.equal(result.sourceEvidence.price.source, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN/);
});

test('an unclosed daily candle fails safe', () => {
  const result = evaluateCoreV2D03(d03Input({ priceCandleStatus: 'OPEN' }));
  assert.equal(result.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('PRICE_CANDLE_NOT_CLOSED'));
});

test('D03 output is bounded and excludes observation arrays and raw provider material', () => {
  const result = evaluateCoreV2D03({ ...d03Input(), rawProviderPayload: { secret: 'PRIVATE' },
    authorization: 'Bearer PRIVATE', cookies: 'PRIVATE' });
  const json = JSON.stringify(result);
  assert(measureCoreV2D03Bytes(result) < 2048);
  assert.doesNotMatch(json, /PRIVATE|Bearer|authorization|cookies|rawProviderPayload|oiObservations/);
});

test('D03 evidence updates only the OI semantics version and stays bounded', () => {
  const before = createCoreV2BirthEvidence(birthInput());
  const after = appendCoreV2D03Evidence(before, evaluateCoreV2D03(d03Input()));
  assert.equal(before.measurementVersions.oiSemanticsVersion.status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
  assert.equal(after.measurementVersions.oiSemanticsVersion.status, EVIDENCE_STATUS.AVAILABLE);
  assert.equal(after.measurementVersions.oiSemanticsVersion.version, CORE_V2_D03_CONTRACT_VERSION);
  assert.equal(after.measurements.d03.classification, CORE_V2_D03_CLASSIFICATION.BULLISH_CONFIRMATION);
  assert(measureCoreV2EvidenceBytes(after) <= CORE_V2_EVIDENCE_MAX_BYTES);
});

test('an unavailable executed D03 result is stored as unavailable with neutral contribution', () => {
  const after = appendCoreV2D03Evidence(createCoreV2BirthEvidence(birthInput()),
    evaluateCoreV2D03(d03Input({ priceChangePct: null })));
  assert.equal(after.measurements.d03.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert.equal(after.measurements.d03.contribution.bias, 'Neutral');
  assert.equal(after.measurementVersions.oiSemanticsVersion.version, CORE_V2_D03_CONTRACT_VERSION);
});

test('D03 evidence cannot overwrite birth or activation evidence', () => {
  const activated = appendCoreV2ActivationEvidence(createCoreV2BirthEvidence(birthInput()), {
    activationAt: '2026-11-26T01:05:10.000Z', activationEntry: 99.75
  });
  const birthBefore = JSON.stringify(activated.birth);
  const activationBefore = JSON.stringify(activated.activation);
  const after = appendCoreV2D03Evidence(activated, evaluateCoreV2D03(d03Input()));
  assert.equal(JSON.stringify(after.birth), birthBefore);
  assert.equal(JSON.stringify(after.activation), activationBefore);
  assert.throws(() => appendCoreV2D03Evidence(after, evaluateCoreV2D03(d03Input())), /immutable/);
});

test('V1 and V2 dual result keeps V1 authoritative and unchanged', () => {
  const v1 = Object.freeze({ version: '1.0', available: true, bias: 'Bullish Confirmation',
    priceChange24h: 2, recentChangePercent: 2 });
  const before = JSON.stringify(v1);
  const comparison = compareV1AndCoreV2D03(v1, d03Input({ openInterestChangePct: 2, priceChangePct: -3 }));
  assert.equal(JSON.stringify(v1), before);
  assert.deepEqual(comparison.v1OiResult, v1);
  assert.equal(comparison.authoritativePath, 'V1');
  assert.equal(comparison.v2D03OiResult.classification, CORE_V2_D03_CLASSIFICATION.BEARISH_CONFIRMATION);
  assert.equal(comparison.productionBehaviorChanged, false);
});

test('D03 evaluation and evidence serialization are deterministic', () => {
  const first = evaluateCoreV2D03(d03Input());
  const second = evaluateCoreV2D03(d03Input());
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(appendCoreV2D03Evidence(createCoreV2BirthEvidence(birthInput()), first)),
    JSON.stringify(appendCoreV2D03Evidence(createCoreV2BirthEvidence(birthInput()), second)));
});

test('Wave 1 identities and D04/D05/D06 placeholders remain unchanged', () => {
  const evidence = appendCoreV2D03Evidence(createCoreV2BirthEvidence(birthInput()), evaluateCoreV2D03(d03Input()));
  assert.equal(evidence.identity.strategyVersion, CORE_V2_STRATEGY_VERSION);
  assert.equal(evidence.identity.archiveRulesVersion, CORE_V2_ARCHIVE_RULES_VERSION);
  assert.equal(evidence.identity.exitPolicyVersion, CORE_V2_EXIT_POLICY_VERSION);
  for (const key of ['birthSafetyVersion', 'pricePrecisionVersion', 'atrVersion']) {
    assert.equal(evidence.measurementVersions[key].status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
  }
});

test('V1 production market path remains byte-untouched and has no Core v2 imports', async () => {
  const source = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /core-v2-d03|coreV2D03|evaluateCoreV2D03|appendCoreV2D03Evidence/);
});

test('representative pre/post D03 evidence sizes remain within the frozen contract', () => {
  const before = createCoreV2BirthEvidence(birthInput());
  const after = appendCoreV2D03Evidence(before, evaluateCoreV2D03(d03Input()));
  const sizes = { preD03Bytes: measureCoreV2EvidenceBytes(before), postD03Bytes: measureCoreV2EvidenceBytes(after),
    limitBytes: CORE_V2_EVIDENCE_MAX_BYTES };
  console.log('CORE_V2_WAVE2_D03_BYTES', JSON.stringify(sizes));
  assert(sizes.postD03Bytes > sizes.preD03Bytes);
  assert(sizes.postD03Bytes <= sizes.limitBytes);
});
