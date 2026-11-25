import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  appendCoreV2ActivationEvidence,
  CORE_V2_ARCHIVE_RULES_VERSION,
  CORE_V2_EVIDENCE_MAX_BYTES,
  CORE_V2_EXIT_POLICY_VERSION,
  CORE_V2_STRATEGY_VERSION,
  createCoreV2BirthEvidence,
  EVIDENCE_STATUS,
  measureCoreV2EvidenceBytes,
  serializeCoreV2Evidence
} from '../lib/core-v2-evidence.js';

const originAt = '2026-11-25T12:00:10.000Z';
const analysisAt = '2026-11-25T12:00:00.000Z';
function input(overrides = {}) {
  return {
    canonicalSymbol: 'BTCUSDT', marketSymbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instrumentType: 'SWAP',
    direction: 'Long', originAt, analysisAt, analysisPrice: 100.4,
    priceSource: 'OKX', priceObservedAt: '2026-11-25T11:59:59.500Z',
    candleSource: 'OKX', candleFirstOpenAt: '2026-05-10T16:00:00.000Z',
    candleLastConfirmedCloseAt: '2026-11-25T16:00:00.000Z',
    instrumentSource: 'OKX public instruments', instrumentRecordObservedAt: '2026-11-25T11:59:30.000Z',
    atr: 2, tickSize: 0.01,
    plan: { plannedEntry: 100, entryZone: { low: 99.5, high: 100.5 }, initialStopLoss: 98,
      takeProfit1: 102, takeProfit2: 104, takeProfit3: 106 },
    ...overrides
  };
}

test('version identities are explicit and exit policy remains separate', () => {
  const evidence = createCoreV2BirthEvidence(input());
  assert.equal(evidence.identity.strategyVersion, CORE_V2_STRATEGY_VERSION);
  assert.equal(evidence.identity.archiveRulesVersion, CORE_V2_ARCHIVE_RULES_VERSION);
  assert.equal(evidence.identity.exitPolicyVersion, CORE_V2_EXIT_POLICY_VERSION);
  assert.notEqual(evidence.identity.strategyVersion, evidence.identity.exitPolicyVersion);
});

test('valid birth evidence captures deterministic Entry to TP1 primitives', () => {
  const evidence = createCoreV2BirthEvidence(input());
  assert.equal(evidence.birth.signalAgeMs.value, 10_000);
  assert(Math.abs(evidence.birth.entryObservation.priceExtension.absolutePrice.value - 0.4) < 1e-12);
  assert.equal(evidence.birth.entryObservation.entryZone.width.value, 1);
  assert.equal(evidence.birth.entryObservation.entryZone.plannedEntryLocation.value, 0.5);
  assert.equal(evidence.birth.entryObservation.tp1Distance.absolutePrice.value, 2);
  assert.equal(evidence.birth.entryObservation.initialRiskDistance.absolutePrice.value, 2);
  assert.equal(evidence.birth.entryObservation.tp1Distance.ticks.value, 200);
});

test('unavailable values stay unavailable and never coerce to zero', () => {
  const evidence = createCoreV2BirthEvidence(input({ tickSize: null, atr: null, priceObservedAt: null }));
  assert.equal(evidence.dataAvailability.authoritativeTick.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert.equal(evidence.birth.entryObservation.tp1Distance.ticks.value, null);
  assert.equal(evidence.birth.entryObservation.tp1Distance.atrUnits.value, null);
  assert.equal(evidence.provenance.priceObservedAt.value, null);
});

test('D01 metrics are deterministic and use the frozen cost assumption', () => {
  const evidence = createCoreV2BirthEvidence(input());
  const economics = evidence.birth.economics;
  assert.equal(economics.tp1RewardRAtPlannedEntry.value, 1);
  assert.equal(economics.tp1WeightedR.value, 0.5);
  assert.equal(economics.modeledCostRAtPlannedEntry.value, 0.075);
  assert.equal(economics.tp1WeightedRAfterCost.value, 0.425);
  assert.deepEqual(createCoreV2BirthEvidence(input()).birth.economics, economics);
});

test('headline RR is stored only as nominal TP2 RR and expected value does not exist', () => {
  const evidence = createCoreV2BirthEvidence(input());
  assert.equal(evidence.birth.economics.nominalTp2RR.value, 2);
  assert.doesNotMatch(JSON.stringify(evidence), /expectedValue|expectancy/i);
});

test('invalid and collapsed zones remain invalid', () => {
  for (const entryZone of [{ low: 100, high: 100 }, { low: 101, high: 100 }]) {
    const evidence = createCoreV2BirthEvidence(input({ plan: { ...input().plan, entryZone } }));
    assert.equal(evidence.birth.entryObservation.entryZone.status, EVIDENCE_STATUS.INVALID);
    assert.equal(evidence.birth.entryObservation.entryZone.width.value, null);
  }
});

test('planned entry outside the zone has INVALID normalized location', () => {
  const evidence = createCoreV2BirthEvidence(input({ plan: { ...input().plan, plannedEntry: 101 } }));
  assert.equal(evidence.birth.entryObservation.entryZone.plannedEntryLocation.status, EVIDENCE_STATUS.INVALID);
  assert.equal(evidence.birth.entryObservation.entryZone.plannedEntryLocation.value, null);
});

test('negative signal age is INVALID rather than unavailable or zero', () => {
  const evidence = createCoreV2BirthEvidence(input({ originAt: analysisAt,
    analysisAt: '2026-11-25T12:00:01.000Z' }));
  assert.equal(evidence.birth.signalAgeMs.status, EVIDENCE_STATUS.INVALID);
  assert.equal(evidence.birth.signalAgeMs.value, null);
});

test('cost-in-R formula is exact and never becomes a gate', () => {
  const evidence = createCoreV2BirthEvidence(input());
  assert.equal(evidence.birth.entryObservation.costInR.value, 0.0015 * 100 / Math.abs(100 - 98));
  assert.equal(Object.hasOwn(evidence, 'eligible'), false);
});

test('future measurement versions are explicit NOT_IMPLEMENTED slots', () => {
  const versions = createCoreV2BirthEvidence(input()).measurementVersions;
  for (const key of ['oiSemanticsVersion', 'birthSafetyVersion', 'pricePrecisionVersion', 'atrVersion']) {
    assert.equal(versions[key].status, EVIDENCE_STATUS.NOT_IMPLEMENTED);
    assert.equal(versions[key].version, null);
  }
  assert.equal(versions.economicsVersion.status, EVIDENCE_STATUS.AVAILABLE);
});

test('activation evidence is separate and birth evidence is immutable', () => {
  const birthOnly = createCoreV2BirthEvidence(input());
  const frozenBirth = JSON.stringify(birthOnly.birth);
  const activated = appendCoreV2ActivationEvidence(birthOnly, {
    activationAt: '2026-11-25T12:05:10.000Z', activationEntry: 99.75
  });
  assert.equal(activated.activation.status, EVIDENCE_STATUS.AVAILABLE);
  assert.equal(activated.activation.activationDelayMs.value, 300_000);
  assert.equal(activated.activation.activationEntryLocation.value, 0.25);
  assert.equal(JSON.stringify(activated.birth), frozenBirth);
  assert.equal(birthOnly.activation.status, EVIDENCE_STATUS.UNAVAILABLE);
  assert.throws(() => appendCoreV2ActivationEvidence(activated, {
    activationAt: '2026-11-25T12:06:10.000Z', activationEntry: 99.8
  }), /immutable/);
});

test('activation cost and extension use activation entry without replacing plan birth values', () => {
  const evidence = appendCoreV2ActivationEvidence(createCoreV2BirthEvidence(input()), {
    activationAt: '2026-11-25T12:05:10.000Z', activationEntry: 99.75
  });
  assert.equal(evidence.activation.activationEntry.value, 99.75);
  assert.equal(evidence.activation.activationExtension.directionalPrice.value, -0.25);
  assert.equal(evidence.activation.activationCostInR.value, 0.0015 * 99.75 / 2);
  assert.equal(evidence.birth.entryObservation.plannedEntry.value, 100);
});

test('serialization is stable, deterministic and bounded', () => {
  const evidence = appendCoreV2ActivationEvidence(createCoreV2BirthEvidence(input()), {
    activationAt: '2026-11-25T12:05:10.000Z', activationEntry: 99.75
  });
  const first = serializeCoreV2Evidence(evidence);
  const second = serializeCoreV2Evidence(evidence);
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first), JSON.parse(second));
  assert(measureCoreV2EvidenceBytes(evidence) <= CORE_V2_EVIDENCE_MAX_BYTES);
});

test('allowlist excludes secret and provider payload material', () => {
  const evidence = createCoreV2BirthEvidence({ ...input(), authorization: 'Bearer SECRET',
    cookies: 'SECRET', headers: { authorization: 'SECRET' }, rawProviderResponse: { secret: 'SECRET' } });
  assert.doesNotMatch(JSON.stringify(evidence), /Bearer|SECRET|authorization|cookies|rawProviderResponse/);
});

test('V1 record and production source stay unchanged and Core v2 is not wired into eligibility', async () => {
  const v1 = Object.freeze({ strategyVersion: null, exitStrategy: Object.freeze({ version: 'tp1-50-reanalyse-v1' }),
    opportunityScore: 91, confirmedAPlus: true, initialPlan: Object.freeze({ entryPrice: 100 }) });
  const before = JSON.stringify(v1);
  createCoreV2BirthEvidence(input());
  assert.equal(JSON.stringify(v1), before);
  const marketSource = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
  assert.doesNotMatch(marketSource, /core-v2-evidence|coreV2Evidence/);
});

test('representative archive impact is measured without full candle payloads', () => {
  const v1Record = { tradeId: 'BTCUSDT:Long:2026-11-25T12:00:10.000Z', symbol: 'BTCUSDT', direction: 'Long',
    opportunityScore: 91, confidence: 95, riskReward: 2, initialPlan: input().plan,
    outcome: { status: 'WaitingEntry' } };
  const evidence = createCoreV2BirthEvidence(input());
  const v1Bytes = Buffer.byteLength(JSON.stringify(v1Record));
  const evidenceBytes = measureCoreV2EvidenceBytes(evidence);
  const projectedBytes = Buffer.byteLength(JSON.stringify({ ...v1Record, coreV2Evidence: evidence }));
  const percentIncrease = Number(((projectedBytes - v1Bytes) / v1Bytes * 100).toFixed(2));
  console.log('CORE_V2_WAVE1_BYTES', JSON.stringify({ v1Bytes, evidenceBytes, projectedBytes, percentIncrease }));
  assert(projectedBytes < v1Bytes + CORE_V2_EVIDENCE_MAX_BYTES + 32);
  assert.doesNotMatch(JSON.stringify(evidence), /candles\s*:/i);
});
