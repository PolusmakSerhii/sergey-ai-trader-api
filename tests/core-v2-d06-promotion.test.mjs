import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCoreV2D03Evidence,
  appendCoreV2D06Evidence,
  appendCoreV2EvidenceReference,
  compactCoreV2Evidence,
  CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION,
  CORE_V2_EVIDENCE_REFERENCE_VERSION,
  createCoreV2BirthEvidence,
  EVIDENCE_STATUS,
  expandCoreV2EvidenceForAudit,
  measureCoreV2EvidenceBytes,
  serializeCoreV2Evidence
} from '../lib/core-v2-evidence.js';
import {
  CORE_V2_D03_OI_SOURCE_KIND,
  CORE_V2_D03_PRICE_SOURCE_KIND,
  evaluateCoreV2D03
} from '../lib/core-v2-d03.js';
import {
  CORE_V2_D06_CONTRACT_VERSION,
  CORE_V2_D06_SOURCE_KIND,
  createCoreV2D06InlineEvidence,
  evaluateCoreV2D06
} from '../lib/core-v2-d06.js';

const DAY_MS = 86_400_000;
const START = Date.parse('2026-11-11T00:00:00.000Z');

function candles(count = 15) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(START + index * DAY_MS).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    confirmed: true
  }));
}

function d06Input(overrides = {}) {
  return {
    canonicalSymbol: 'BTCUSDT',
    instId: 'BTC-USDT-SWAP',
    instrumentType: 'SWAP',
    source: 'OKX BTC-USDT-SWAP confirmed daily candles',
    sourceKind: CORE_V2_D06_SOURCE_KIND,
    sourceObservedAt: '2026-11-26T00:05:00.000Z',
    evaluatedAt: '2026-11-26T01:00:00.000Z',
    referencePrice: 100,
    candles: candles(),
    ...overrides
  };
}

function birthInput() {
  return {
    canonicalSymbol: 'BTCUSDT', marketSymbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instrumentType: 'SWAP',
    direction: 'Long', originAt: '2026-11-26T01:00:10.000Z', analysisAt: '2026-11-26T01:00:00.000Z',
    analysisPrice: 100.4, priceSource: 'OKX', priceObservedAt: '2026-11-26T00:59:59.500Z',
    candleSource: 'OKX', candleFirstOpenAt: '2026-05-10T00:00:00.000Z',
    candleLastConfirmedCloseAt: '2026-11-26T00:00:00.000Z',
    instrumentSource: 'OKX public instruments', instrumentRecordObservedAt: '2026-11-26T00:59:30.000Z',
    atr: 2, tickSize: 0.01,
    plan: { plannedEntry: 100, entryZone: { low: 99.5, high: 100.5 }, initialStopLoss: 98,
      takeProfit1: 102, takeProfit2: 104, takeProfit3: 106 }
  };
}

function d03Input() {
  const start = Date.parse('2026-11-25T00:00:00.000Z');
  const step = 4 * 60 * 60 * 1000;
  return {
    openInterestChangePct: 2,
    priceChangePct: -3,
    openInterestSource: 'CoinGlass aggregated futures OI',
    openInterestSourceKind: CORE_V2_D03_OI_SOURCE_KIND,
    priceSource: 'OKX BTC-USDT-SWAP closed daily candle',
    priceSourceKind: CORE_V2_D03_PRICE_SOURCE_KIND,
    openInterestObservedAt: '2026-11-26T00:05:00.000Z',
    priceObservedAt: '2026-11-26T00:06:00.000Z',
    oiWindowStart: new Date(start).toISOString(),
    oiWindowEnd: new Date(start + 6 * step).toISOString(),
    priceWindowStart: new Date(start).toISOString(),
    priceWindowEnd: new Date(start + 6 * step).toISOString(),
    oiObservations: Array.from({ length: 6 }, (_, index) => ({
      windowStart: new Date(start + index * step).toISOString(),
      windowEnd: new Date(start + (index + 1) * step).toISOString()
    })),
    priceCandleStatus: 'CLOSED',
    evaluatedAt: '2026-11-26T01:00:00.000Z'
  };
}

function legacyEvidence() {
  return appendCoreV2D03Evidence(createCoreV2BirthEvidence(birthInput()), evaluateCoreV2D03(d03Input()));
}

function compactEvidence() {
  return compactCoreV2Evidence(legacyEvidence());
}

test('AVAILABLE D06 is evaluated and promoted into compact evidence v2', () => {
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input());
  assert.equal(promoted.schemaVersion, CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION);
  assert.equal(promoted.measurements.atr.status, EVIDENCE_STATUS.AVAILABLE);
  assert.equal(promoted.measurements.atr.atr14, 2);
  assert.deepEqual(promoted.measurementVersions.atrVersion, {
    status: EVIDENCE_STATUS.AVAILABLE,
    version: CORE_V2_D06_CONTRACT_VERSION,
    reasonCode: null
  });
});

test('UNAVAILABLE D06 remains explicit and versioned', () => {
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input({ candles: candles(14) }));
  assert.equal(promoted.measurements.atr.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert.equal(promoted.measurements.atr.reasonCode, 'INVALID_CANDLE_COUNT');
  assert.deepEqual(promoted.measurementVersions.atrVersion, {
    status: EVIDENCE_STATUS.UNAVAILABLE,
    version: CORE_V2_D06_CONTRACT_VERSION,
    reasonCode: 'INVALID_CANDLE_COUNT'
  });
});

test('INVALID D06 remains explicit and versioned', () => {
  const values = candles();
  values[5].timestamp = values[4].timestamp;
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input({ candles: values }));
  assert.equal(promoted.measurements.atr.status, EVIDENCE_STATUS.INVALID);
  assert.equal(promoted.measurements.atr.reasonCode, 'DUPLICATE_CANDLE_TIMESTAMP');
  assert.equal(promoted.measurementVersions.atrVersion.status, EVIDENCE_STATUS.INVALID);
  assert.equal(promoted.measurementVersions.atrVersion.version, CORE_V2_D06_CONTRACT_VERSION);
});

test('D06 inline evidence uses the exact audited bounded field allowlist', () => {
  const atr = appendCoreV2D06Evidence(compactEvidence(), d06Input()).measurements.atr;
  assert.deepEqual(Object.keys(atr), [
    'version', 'status', 'reasonCode', 'atr14', 'atrPercent', 'windowStart', 'windowEnd',
    'candleCount', 'gapAffectedCount', 'sourceDigest'
  ]);
});

test('source digest is preserved exactly from evaluator output', () => {
  const evaluated = evaluateCoreV2D06(d06Input());
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input());
  assert.equal(promoted.measurements.atr.sourceDigest, evaluated.sourceDigest);
  assert.match(promoted.measurements.atr.sourceDigest, /^[a-f0-9]{64}$/);
});

test('no raw candles, TR arrays, gap lists or provider payloads persist', () => {
  const promoted = appendCoreV2D06Evidence(compactEvidence(), {
    ...d06Input(), rawProviderPayload: { secret: 'PRIVATE' }, authorization: 'Bearer PRIVATE'
  });
  assert.doesNotMatch(JSON.stringify(promoted),
    /PRIVATE|Bearer|rawProviderPayload|authorization|"candles"|trueRanges|gapList|observations/);
});

test('D03 evidence is byte-identical across D06 promotion', () => {
  const compact = compactEvidence();
  const before = JSON.stringify(compact.measurements.d03);
  const promoted = appendCoreV2D06Evidence(compact, d06Input());
  assert.equal(JSON.stringify(promoted.measurements.d03), before);
  assert.equal(promoted.measurementVersions.oiSemanticsVersion.version, 'core-v2-d03-oi-price-v1');
});

test('audit expansion reconstructs legacy fields and retains promoted D06 exactly', () => {
  const legacy = legacyEvidence();
  const promoted = appendCoreV2D06Evidence(compactCoreV2Evidence(legacy), d06Input());
  const expected = structuredClone(legacy);
  expected.measurements.atr = createCoreV2D06InlineEvidence(evaluateCoreV2D06(d06Input()));
  expected.measurementVersions.atrVersion = {
    status: EVIDENCE_STATUS.AVAILABLE,
    version: CORE_V2_D06_CONTRACT_VERSION,
    reasonCode: null
  };
  assert.deepEqual(expandCoreV2EvidenceForAudit(promoted), expected);
});

test('existing schema-v1 records remain readable and cannot receive D06 promotion', () => {
  const legacy = legacyEvidence();
  assert.deepEqual(JSON.parse(serializeCoreV2Evidence(legacy)), JSON.parse(JSON.stringify(legacy)));
  assert.throws(() => appendCoreV2D06Evidence(legacy, d06Input()), /compact schema v2/);
  assert.equal(legacy.measurementVersions.atrVersion.status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
});

test('existing v1 to v2 compaction parity remains exact before D06 promotion', () => {
  const legacy = legacyEvidence();
  assert.deepEqual(expandCoreV2EvidenceForAudit(compactCoreV2Evidence(legacy)), legacy);
});

test('D06 promotion is deterministic and input evidence stays immutable', () => {
  const compact = compactEvidence();
  const before = JSON.stringify(compact);
  const first = appendCoreV2D06Evidence(compact, d06Input());
  const second = appendCoreV2D06Evidence(compact, d06Input());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(compact), before);
  assert.equal(serializeCoreV2Evidence(first), serializeCoreV2Evidence(second));
});

test('D06 evidence is immutable once captured', () => {
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input());
  assert.throws(() => appendCoreV2D06Evidence(promoted, d06Input()), /immutable/);
});

test('promoted evidence remains below the safe inline target', () => {
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input());
  assert(measureCoreV2EvidenceBytes(promoted) <= 7680);
  assert(measureCoreV2EvidenceBytes(promoted) <= 8192);
});

test('content-addressed reference capability remains available after D06 promotion', () => {
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input());
  const referenced = appendCoreV2EvidenceReference(promoted, {
    version: CORE_V2_EVIDENCE_REFERENCE_VERSION,
    schemaVersion: 'core-v2-d05-source-v1',
    digestAlgorithm: 'sha256',
    digest: 'a'.repeat(64),
    byteLength: 24_576
  });
  assert.equal(referenced.references[0].digest, 'a'.repeat(64));
  assert.equal(referenced.measurements.atr.sourceDigest, promoted.measurements.atr.sourceDigest);
});

test('D04 and D05 remain NOT_IMPLEMENTED after D06 promotion', () => {
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input());
  assert.equal(promoted.measurementVersions.pricePrecisionVersion.status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
  assert.equal(promoted.measurementVersions.birthSafetyVersion.status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
});

test('D06 promotion cannot create trading decision fields', () => {
  const promoted = appendCoreV2D06Evidence(compactEvidence(), d06Input());
  for (const field of ['eligible', 'probability', 'confidence', 'readiness', 'opportunityScore', 'confirmedAPlus']) {
    assert.equal(Object.hasOwn(promoted, field), false);
  }
});
