import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCoreV2ActivationEvidence,
  appendCoreV2D03Evidence,
  appendCoreV2EvidenceReference,
  compactCoreV2Evidence,
  CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION,
  CORE_V2_EVIDENCE_MAX_BYTES,
  CORE_V2_EVIDENCE_REFERENCE_VERSION,
  CORE_V2_EVIDENCE_SCHEMA_VERSION,
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

function birthInput(overrides = {}) {
  return {
    canonicalSymbol: 'BTCUSDT', marketSymbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instrumentType: 'SWAP',
    direction: 'Long', originAt: '2026-11-26T01:00:10.000Z', analysisAt: '2026-11-26T01:00:00.000Z',
    analysisPrice: 100.4, priceSource: 'OKX', priceObservedAt: '2026-11-26T00:59:59.500Z',
    candleSource: 'OKX', candleFirstOpenAt: '2026-05-10T00:00:00.000Z',
    candleLastConfirmedCloseAt: '2026-11-26T00:00:00.000Z',
    instrumentSource: 'OKX public instruments', instrumentRecordObservedAt: '2026-11-26T00:59:30.000Z',
    atr: 2, tickSize: 0.01,
    plan: { plannedEntry: 100, entryZone: { low: 99.5, high: 100.5 }, initialStopLoss: 98,
      takeProfit1: 102, takeProfit2: 104, takeProfit3: 106 },
    ...overrides
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

function d06Input() {
  const start = Date.parse('2026-11-11T00:00:00.000Z');
  const day = 86_400_000;
  return {
    canonicalSymbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instrumentType: 'SWAP',
    source: 'OKX BTC-USDT-SWAP confirmed daily candles', sourceKind: CORE_V2_D06_SOURCE_KIND,
    sourceObservedAt: '2026-11-26T00:05:00.000Z', evaluatedAt: '2026-11-26T01:00:00.000Z',
    referencePrice: 100,
    candles: Array.from({ length: 15 }, (_, index) => ({
      timestamp: new Date(start + index * day).toISOString(),
      open: 100, high: 101, low: 99, close: 100, confirmed: true
    }))
  };
}

function legacyEvidence(input = birthInput()) {
  return appendCoreV2D03Evidence(createCoreV2BirthEvidence(input), evaluateCoreV2D03(d03Input()));
}

test('old schema remains readable, measurable and auditable', () => {
  const legacy = legacyEvidence();
  assert.equal(legacy.schemaVersion, CORE_V2_EVIDENCE_SCHEMA_VERSION);
  assert.deepEqual(JSON.parse(serializeCoreV2Evidence(legacy)), JSON.parse(JSON.stringify(legacy)));
  assert.equal(measureCoreV2EvidenceBytes(legacy), Buffer.byteLength(JSON.stringify(legacy)));
  assert.equal(expandCoreV2EvidenceForAudit(legacy), legacy);
});

test('compaction introduces an explicit new schema without mutating v1', () => {
  const legacy = legacyEvidence();
  const before = JSON.stringify(legacy);
  const compact = compactCoreV2Evidence(legacy);
  assert.equal(compact.schemaVersion, CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION);
  assert.equal(legacy.schemaVersion, CORE_V2_EVIDENCE_SCHEMA_VERSION);
  assert.equal(JSON.stringify(legacy), before);
});

test('expanded compact evidence reconstructs the exact legacy audit view', () => {
  const legacy = legacyEvidence();
  assert.deepEqual(expandCoreV2EvidenceForAudit(compactCoreV2Evidence(legacy)), legacy);
});

test('capturedAt reconstructs exactly from immutable originAt', () => {
  const compact = compactCoreV2Evidence(legacyEvidence());
  assert.equal(Object.hasOwn(compact.birth, 'capturedAt'), false);
  const expanded = expandCoreV2EvidenceForAudit(compact);
  assert.deepEqual(expanded.birth.capturedAt, expanded.identity.originAt);
});

test('zone width midpoint and location reconstruct exactly from immutable primitives', () => {
  const legacy = legacyEvidence();
  const expected = legacy.birth.entryObservation.entryZone;
  const compact = compactCoreV2Evidence(legacy);
  assert.deepEqual(Object.keys(compact.birth.entryObservation.entryZone), ['status', 'low', 'high']);
  assert.deepEqual(expandCoreV2EvidenceForAudit(compact).birth.entryObservation.entryZone, expected);
});

test('duplicate cost-in-R reconstructs exactly from frozen D01 economics', () => {
  const legacy = legacyEvidence();
  const expected = legacy.birth.entryObservation.costInR;
  const compact = compactCoreV2Evidence(legacy);
  assert.equal(Object.hasOwn(compact.birth.entryObservation, 'costInR'), false);
  assert.deepEqual(expandCoreV2EvidenceForAudit(compact).birth.entryObservation.costInR, expected);
});

test('availability reconstructs exactly while authoritative tick remains immutable', () => {
  const legacy = legacyEvidence();
  const compact = compactCoreV2Evidence(legacy);
  assert.equal(Object.hasOwn(compact, 'dataAvailability'), false);
  assert.deepEqual(compact.provenance.authoritativeTick, legacy.dataAvailability.authoritativeTick);
  assert.deepEqual(expandCoreV2EvidenceForAudit(compact).dataAvailability, legacy.dataAvailability);
});

test('not-activated placeholder compacts without collapsing availability semantics', () => {
  const legacy = legacyEvidence();
  const compact = compactCoreV2Evidence(legacy);
  assert.deepEqual(compact.activation, { status: EVIDENCE_STATUS.UNAVAILABLE,
    reasonCode: 'NOT_ACTIVATED', version: 1 });
  assert.deepEqual(expandCoreV2EvidenceForAudit(compact).activation, legacy.activation);
});

test('available activation evidence stays complete and immutable', () => {
  const activated = appendCoreV2ActivationEvidence(legacyEvidence(), {
    activationAt: '2026-11-26T01:05:10.000Z', activationEntry: 99.75
  });
  const compact = compactCoreV2Evidence(activated);
  assert.deepEqual(compact.activation, activated.activation);
  assert.deepEqual(expandCoreV2EvidenceForAudit(compact), activated);
});

test('activation appended after compaction matches compacted legacy activation', () => {
  const legacy = legacyEvidence();
  const activation = { activationAt: '2026-11-26T01:05:10.000Z', activationEntry: 99.75 };
  const expected = compactCoreV2Evidence(appendCoreV2ActivationEvidence(legacy, activation));
  const actual = appendCoreV2ActivationEvidence(compactCoreV2Evidence(legacy), activation);
  assert.deepEqual(actual, expected);
  assert.equal(actual.activation.status, EVIDENCE_STATUS.AVAILABLE);
});

test('D01 frozen outputs remain byte-equivalent', () => {
  const legacy = legacyEvidence();
  const compact = compactCoreV2Evidence(legacy);
  assert.equal(JSON.stringify(compact.birth.economics), JSON.stringify(legacy.birth.economics));
});

test('D03 classification and provenance semantics reconstruct exactly', () => {
  const legacy = legacyEvidence();
  const compact = compactCoreV2Evidence(legacy);
  assert.equal(compact.measurements.d03.classification, legacy.measurements.d03.classification);
  assert.equal(compact.measurements.d03.sourceEvidence.alignmentStatus, 'ALIGNED');
  assert.equal(compact.measurements.d03.sourceEvidence.windowStart,
    legacy.measurements.d03.sourceEvidence.openInterest.windowStart);
  assert.deepEqual(expandCoreV2EvidenceForAudit(compact).measurements.d03, legacy.measurements.d03);
});

test('D03 appended after compaction matches compacted legacy D03 evidence', () => {
  const birth = createCoreV2BirthEvidence(birthInput());
  const result = evaluateCoreV2D03(d03Input());
  const expected = compactCoreV2Evidence(appendCoreV2D03Evidence(birth, result));
  const actual = appendCoreV2D03Evidence(compactCoreV2Evidence(birth), result);
  assert.deepEqual(actual, expected);
});

test('invalid/missing birth evidence is preserved unless exact reconstruction is proven', () => {
  const legacy = legacyEvidence(birthInput({ tickSize: null,
    plan: { ...birthInput().plan, entryZone: { low: 100, high: 100 } } }));
  const compact = compactCoreV2Evidence(legacy);
  assert.deepEqual(expandCoreV2EvidenceForAudit(compact), legacy);
  assert.equal(expandCoreV2EvidenceForAudit(compact).dataAvailability.authoritativeTick.status,
    EVIDENCE_STATUS.UNAVAILABLE);
});

test('compact serialization is deterministic and idempotent', () => {
  const compact = compactCoreV2Evidence(legacyEvidence());
  assert.equal(serializeCoreV2Evidence(compact), serializeCoreV2Evidence(compact));
  assert.equal(compactCoreV2Evidence(compact), compact);
});

test('compaction reclaims at least 700 bytes on representative available evidence', () => {
  const legacy = legacyEvidence();
  const compact = compactCoreV2Evidence(legacy);
  const reclaimed = measureCoreV2EvidenceBytes(legacy) - measureCoreV2EvidenceBytes(compact);
  console.log('CORE_V2_COMPACTION_BYTES', JSON.stringify({ pre: measureCoreV2EvidenceBytes(legacy),
    post: measureCoreV2EvidenceBytes(compact), reclaimed }));
  assert(reclaimed >= 700);
});

test('simulated D06 remains below safe target without promoting atrVersion', () => {
  const compact = compactCoreV2Evidence(legacyEvidence());
  const simulated = structuredClone(compact);
  simulated.measurements.d06 = createCoreV2D06InlineEvidence(evaluateCoreV2D06(d06Input()));
  simulated.measurementVersions.atrVersion = {
    status: EVIDENCE_STATUS.AVAILABLE, version: CORE_V2_D06_CONTRACT_VERSION, reasonCode: null
  };
  assert(Buffer.byteLength(JSON.stringify(simulated)) <= 7680);
  assert.equal(compact.measurementVersions.atrVersion.status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
  assert.equal(CORE_V2_EVIDENCE_MAX_BYTES, 8192);
});

test('compact schema is ready for a bounded content-addressed reference', () => {
  const compact = compactCoreV2Evidence(legacyEvidence());
  const reference = {
    version: CORE_V2_EVIDENCE_REFERENCE_VERSION,
    schemaVersion: 'core-v2-d05-source-v1',
    digestAlgorithm: 'sha256',
    digest: 'a'.repeat(64),
    byteLength: 24_576,
    authorization: 'Bearer PRIVATE',
    rawProviderPayload: { secret: 'PRIVATE' }
  };
  const referenced = appendCoreV2EvidenceReference(compact, reference);
  assert.deepEqual(referenced.references, [{
    version: CORE_V2_EVIDENCE_REFERENCE_VERSION,
    schemaVersion: 'core-v2-d05-source-v1',
    digestAlgorithm: 'sha256',
    digest: 'a'.repeat(64),
    byteLength: 24_576
  }]);
  assert(Buffer.byteLength(JSON.stringify(referenced.references[0])) <= 256);
  assert.doesNotMatch(JSON.stringify(referenced), /PRIVATE|authorization|rawProviderPayload/);
  assert.throws(() => appendCoreV2EvidenceReference(referenced, reference), /Duplicate/);
});

test('compaction persists no raw payload, candle array or secret material', () => {
  const compact = compactCoreV2Evidence(legacyEvidence({ ...birthInput(), authorization: 'Bearer PRIVATE',
    cookies: 'PRIVATE', rawProviderPayload: { candles: [1, 2, 3], secret: 'PRIVATE' } }));
  assert.doesNotMatch(JSON.stringify(compact), /PRIVATE|Bearer|authorization|cookies|rawProviderPayload|candles/);
});

test('compaction cannot create or alter trading decision fields', () => {
  const legacy = legacyEvidence();
  const compact = compactCoreV2Evidence(legacy);
  for (const field of ['eligible', 'probability', 'confidence', 'readiness', 'opportunityScore', 'confirmedAPlus']) {
    assert.equal(Object.hasOwn(compact, field), false);
  }
});
