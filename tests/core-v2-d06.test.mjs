import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CORE_V2_D06_ATR_PERIOD,
  CORE_V2_D06_CANDLE_COUNT,
  CORE_V2_D06_CONTRACT_VERSION,
  CORE_V2_D06_SOURCE_KIND,
  CORE_V2_D06_STATUS,
  createCoreV2D06InlineEvidence,
  evaluateCoreV2D06,
  measureCoreV2D06InlineBytes
} from '../lib/core-v2-d06.js';
import {
  appendCoreV2D03Evidence,
  createCoreV2BirthEvidence,
  EVIDENCE_STATUS
} from '../lib/core-v2-evidence.js';
import {
  CORE_V2_D03_OI_SOURCE_KIND,
  CORE_V2_D03_PRICE_SOURCE_KIND,
  evaluateCoreV2D03
} from '../lib/core-v2-d03.js';

const DAY_MS = 86_400_000;
const start = Date.parse('2026-11-01T00:00:00.000Z');

function candles(count = CORE_V2_D06_CANDLE_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(start + index * DAY_MS).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    confirmed: true
  }));
}

function input(overrides = {}) {
  return {
    canonicalSymbol: 'BTCUSDT',
    instId: 'BTC-USDT-SWAP',
    instrumentType: 'SWAP',
    source: 'OKX BTC-USDT-SWAP confirmed daily candles',
    sourceKind: CORE_V2_D06_SOURCE_KIND,
    sourceObservedAt: '2026-11-16T00:05:00.000Z',
    evaluatedAt: '2026-11-16T01:00:00.000Z',
    referencePrice: 100,
    candles: candles(),
    ...overrides
  };
}

function validD03Input() {
  const d03Start = Date.parse('2026-11-15T00:00:00.000Z');
  const step = 4 * 60 * 60 * 1000;
  return {
    openInterestChangePct: 2,
    priceChangePct: -3,
    openInterestSource: 'CoinGlass aggregated futures OI',
    openInterestSourceKind: CORE_V2_D03_OI_SOURCE_KIND,
    priceSource: 'OKX BTC-USDT-SWAP closed daily candle',
    priceSourceKind: CORE_V2_D03_PRICE_SOURCE_KIND,
    openInterestObservedAt: '2026-11-16T00:05:00.000Z',
    priceObservedAt: '2026-11-16T00:06:00.000Z',
    oiWindowStart: new Date(d03Start).toISOString(),
    oiWindowEnd: new Date(d03Start + 6 * step).toISOString(),
    priceWindowStart: new Date(d03Start).toISOString(),
    priceWindowEnd: new Date(d03Start + 6 * step).toISOString(),
    oiObservations: Array.from({ length: 6 }, (_, index) => ({
      windowStart: new Date(d03Start + index * step).toISOString(),
      windowEnd: new Date(d03Start + (index + 1) * step).toISOString()
    })),
    priceCandleStatus: 'CLOSED',
    evaluatedAt: '2026-11-16T01:00:00.000Z'
  };
}

function birthInput() {
  return {
    canonicalSymbol: 'BTCUSDT', marketSymbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instrumentType: 'SWAP',
    direction: 'Long', originAt: '2026-11-16T01:00:10.000Z', analysisAt: '2026-11-16T01:00:00.000Z',
    analysisPrice: 100.4, priceSource: 'OKX', priceObservedAt: '2026-11-16T00:59:59.500Z',
    candleSource: 'OKX', candleFirstOpenAt: '2026-04-30T00:00:00.000Z',
    candleLastConfirmedCloseAt: '2026-11-16T00:00:00.000Z',
    instrumentSource: 'OKX public instruments', instrumentRecordObservedAt: '2026-11-16T00:59:30.000Z',
    atr: 2, tickSize: 0.01,
    plan: { plannedEntry: 100, entryZone: { low: 99.5, high: 100.5 }, initialStopLoss: 98,
      takeProfit1: 102, takeProfit2: 104, takeProfit3: 106 }
  };
}

test('no-gap candle true range equals high-low', () => {
  const result = evaluateCoreV2D06(input());
  assert.equal(result.status, CORE_V2_D06_STATUS.AVAILABLE);
  assert.equal(result.atr14, 2);
  assert.equal(result.gapAffectedCount, 0);
});

test('gap-up uses high minus previous close', () => {
  const values = candles();
  values[14] = { ...values[14], open: 106, high: 107, low: 105, close: 106 };
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.atr14, Number(((13 * 2 + 7) / 14).toPrecision(15)));
  assert.equal(result.gapAffectedCount, 1);
});

test('gap-down uses previous close minus low', () => {
  const values = candles();
  values[14] = { ...values[14], open: 94, high: 95, low: 93, close: 94 };
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.atr14, Number(((13 * 2 + 7) / 14).toPrecision(15)));
  assert.equal(result.gapAffectedCount, 1);
});

test('exactly 15 candles produce 14 True Range observations', () => {
  assert.equal(CORE_V2_D06_ATR_PERIOD, 14);
  assert.equal(CORE_V2_D06_CANDLE_COUNT, 15);
  assert.equal(evaluateCoreV2D06(input()).candleCount, 15);
});

test('fewer than 15 candles are unavailable', () => {
  const result = evaluateCoreV2D06(input({ candles: candles(14) }));
  assert.equal(result.status, CORE_V2_D06_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('INVALID_CANDLE_COUNT'));
});

test('more than 15 candles are unavailable rather than silently sliced', () => {
  const result = evaluateCoreV2D06(input({ candles: candles(16),
    evaluatedAt: '2026-11-17T01:00:00.000Z', sourceObservedAt: '2026-11-17T00:05:00.000Z' }));
  assert.equal(result.status, CORE_V2_D06_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('INVALID_CANDLE_COUNT'));
});

test('duplicate timestamp is invalid', () => {
  const values = candles();
  values[5].timestamp = values[4].timestamp;
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.status, CORE_V2_D06_STATUS.INVALID);
  assert(result.reasonCodes.includes('DUPLICATE_CANDLE_TIMESTAMP'));
});

test('out-of-order timestamps are invalid', () => {
  const values = candles();
  [values[4], values[5]] = [values[5], values[4]];
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.status, CORE_V2_D06_STATUS.INVALID);
  assert(result.reasonCodes.includes('OUT_OF_ORDER_CANDLES'));
});

test('daily continuity gap is unavailable', () => {
  const values = candles();
  values[5].timestamp = new Date(Date.parse(values[5].timestamp) + 60 * 60 * 1000).toISOString();
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.status, CORE_V2_D06_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('CANDLE_GAP'));
});

test('unconfirmed candle is unavailable', () => {
  const values = candles();
  values[5].confirmed = false;
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.status, CORE_V2_D06_STATUS.UNAVAILABLE);
  assert(result.reasonCodes.includes('UNCONFIRMED_CANDLE'));
});

test('invalid OHLC envelope is invalid', () => {
  const values = candles();
  values[5].high = 98;
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.status, CORE_V2_D06_STATUS.INVALID);
  assert(result.reasonCodes.includes('INVALID_OHLC'));
});

test('future timestamp is invalid', () => {
  const values = candles();
  values[14].timestamp = '2026-11-17T00:00:00.000Z';
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.status, CORE_V2_D06_STATUS.INVALID);
  assert(result.reasonCodes.includes('CANDLE_TIMESTAMP_FUTURE'));
});

test('mismatched canonical symbol and SWAP identity are invalid', () => {
  const result = evaluateCoreV2D06(input({ instId: 'ETH-USDT-SWAP' }));
  assert.equal(result.status, CORE_V2_D06_STATUS.INVALID);
  assert(result.reasonCodes.includes('INCOMPATIBLE_INSTRUMENT_IDENTITY'));
});

test('previous close is mandatory and has no high-low fallback', () => {
  const values = candles();
  values[13].close = null;
  const result = evaluateCoreV2D06(input({ candles: values }));
  assert.equal(result.status, CORE_V2_D06_STATUS.INVALID);
  assert(result.reasonCodes.includes('PREVIOUS_CLOSE_MISSING'));
  assert.equal(result.atr14, null);
});

test('ATR14 is the deterministic arithmetic mean, not Wilder smoothing', () => {
  const values = candles();
  values[14] = { ...values[14], open: 106, high: 107, low: 105, close: 106 };
  assert.equal(evaluateCoreV2D06(input({ candles: values })).atr14, Number(((13 * 2 + 7) / 14).toPrecision(15)));
});

test('multiple gap-affected observations are counted', () => {
  const values = candles();
  values[5] = { ...values[5], open: 106, high: 107, low: 105, close: 106 };
  values[6] = { ...values[6], open: 100, high: 101, low: 99, close: 100 };
  assert.equal(evaluateCoreV2D06(input({ candles: values })).gapAffectedCount, 2);
});

test('ATR percent uses the explicit reference price', () => {
  const result = evaluateCoreV2D06(input({ referencePrice: 200 }));
  assert.equal(result.atr14, 2);
  assert.equal(result.atrPercent, 1);
});

test('digest is deterministic SHA-256 for normalized identical input', () => {
  const first = evaluateCoreV2D06(input());
  const second = evaluateCoreV2D06(input());
  assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.sourceDigest, second.sourceDigest);
  console.log('CORE_V2_D06_SOURCE_DIGEST', first.sourceDigest);
});

test('changed candle changes the source digest', () => {
  const changed = candles();
  changed[14] = { ...changed[14], high: 102 };
  assert.notEqual(evaluateCoreV2D06(input()).sourceDigest,
    evaluateCoreV2D06(input({ candles: changed })).sourceDigest);
});

test('minimum inline evidence stores neither candles nor True Range arrays', () => {
  const inline = createCoreV2D06InlineEvidence(evaluateCoreV2D06(input()));
  const json = JSON.stringify(inline);
  assert.doesNotMatch(json, /candles|trueRanges|observations|gapList/);
  assert.equal(inline.candleCount, 15);
  assert.equal(inline.version, CORE_V2_D06_CONTRACT_VERSION);
});

test('minimum inline evidence is bounded near the audited estimate', () => {
  const result = evaluateCoreV2D06(input());
  const bytes = measureCoreV2D06InlineBytes(result);
  console.log('CORE_V2_D06_INLINE_BYTES', bytes);
  assert(bytes >= 280 && bytes <= 360);
});

test('D06 remains isolated while atrVersion stays NOT_IMPLEMENTED', () => {
  const evidence = createCoreV2BirthEvidence(birthInput());
  evaluateCoreV2D06(input());
  assert.equal(evidence.measurementVersions.atrVersion.status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
  assert.equal(evidence.measurementVersions.atrVersion.version, null);
});

test('D03 evidence and Wave 1 birth evidence cannot be mutated by isolated D06', () => {
  const evidence = appendCoreV2D03Evidence(createCoreV2BirthEvidence(birthInput()),
    evaluateCoreV2D03(validD03Input()));
  const before = JSON.stringify(evidence);
  evaluateCoreV2D06({ ...input(), coreV2Evidence: evidence });
  assert.equal(JSON.stringify(evidence), before);
  assert.equal(evidence.measurementVersions.oiSemanticsVersion.status, EVIDENCE_STATUS.AVAILABLE);
  assert.equal(evidence.measurementVersions.atrVersion.status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
});

test('raw provider payload and credentials never enter inline evidence', () => {
  const result = evaluateCoreV2D06({ ...input(), rawProviderPayload: { secret: 'PRIVATE' },
    authorization: 'Bearer PRIVATE', cookies: 'PRIVATE' });
  assert.doesNotMatch(JSON.stringify(createCoreV2D06InlineEvidence(result)),
    /PRIVATE|Bearer|authorization|cookies|rawProviderPayload/);
});

test('V1 ATR source remains unchanged and has no Core v2 D06 import', async () => {
  const source = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
  assert.match(source, /const ranges = recent\.map\(candle => \{[\s\S]*?return high - low;/);
  assert.doesNotMatch(source, /core-v2-d06|evaluateCoreV2D06/);
});

test('repeated D06 result and inline serialization are deterministic', () => {
  const first = evaluateCoreV2D06(input());
  const second = evaluateCoreV2D06(input());
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(createCoreV2D06InlineEvidence(first)),
    JSON.stringify(createCoreV2D06InlineEvidence(second)));
});
