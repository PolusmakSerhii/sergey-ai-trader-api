import {
  CORE_V2_D06_CONTRACT_VERSION,
  createCoreV2D06InlineEvidence,
  evaluateCoreV2D06
} from './core-v2-d06.js';

export const CORE_V2_STRATEGY_VERSION = 'core-v2-entry-v1';
export const CORE_V2_ARCHIVE_RULES_VERSION = 'canonical-trade-archive-v2';
export const CORE_V2_EXIT_POLICY_VERSION = 'tp1-50-reanalyse-v1';
export const CORE_V2_EVIDENCE_SCHEMA_VERSION = 'core-v2-evidence-v1';
export const CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION = 'core-v2-evidence-v2';
export const CORE_V2_EVIDENCE_REFERENCE_VERSION = 'core-v2-evidence-ref-v1';
export const CORE_V2_EVIDENCE_MAX_BYTES = 8 * 1024;
export const CORE_V2_ECONOMICS_VERSION = 'lifecycle-aligned-economics-d01-v1';
export const CORE_V2_D03_CONTRACT_VERSION = 'core-v2-d03-oi-price-v1';

export const EVIDENCE_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INVALID: 'INVALID'
});

const COST_RATE = 0.0015;
const TP1_ALLOCATION = 0.5;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const round = value => finite(value) ? Number(value.toPrecision(15)) : null;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const supportedSchema = value => [CORE_V2_EVIDENCE_SCHEMA_VERSION,
  CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION].includes(value);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function field(value, validator, unavailableReason, invalidReason) {
  if (value === null || value === undefined) {
    return { status: EVIDENCE_STATUS.UNAVAILABLE, value: null, reasonCode: unavailableReason };
  }
  if (!validator(value)) return { status: EVIDENCE_STATUS.INVALID, value: null, reasonCode: invalidReason };
  return { status: EVIDENCE_STATUS.AVAILABLE, value, reasonCode: null };
}

function numberField(value, reason = 'VALUE_UNAVAILABLE') {
  return field(value, finite, reason, 'INVALID_NUMBER');
}

function positiveField(value, reason = 'VALUE_UNAVAILABLE') {
  return field(value, positive, reason, 'INVALID_POSITIVE_NUMBER');
}

function textField(value, reason = 'VALUE_UNAVAILABLE') {
  return field(value, nonempty, reason, 'INVALID_TEXT');
}

function timestampField(value, reason = 'TIMESTAMP_UNAVAILABLE') {
  if (value === null || value === undefined) return field(value, () => false, reason, 'INVALID_TIMESTAMP');
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return { status: EVIDENCE_STATUS.INVALID, value: null, reasonCode: 'INVALID_TIMESTAMP' };
  }
  return { status: EVIDENCE_STATUS.AVAILABLE, value: new Date(value).toISOString(), reasonCode: null };
}

function derived(value, available, unavailableReason, invalidReason = 'INVALID_DERIVATION') {
  if (!available) return { status: EVIDENCE_STATUS.UNAVAILABLE, value: null, reasonCode: unavailableReason };
  return finite(value)
    ? { status: EVIDENCE_STATUS.AVAILABLE, value: round(value), reasonCode: null }
    : { status: EVIDENCE_STATUS.INVALID, value: null, reasonCode: invalidReason };
}

function normalizedLocationField(value, inputsAvailable, unavailableReason) {
  if (!inputsAvailable) return { status: EVIDENCE_STATUS.UNAVAILABLE, value: null, reasonCode: unavailableReason };
  if (!finite(value) || value < 0 || value > 1) {
    return { status: EVIDENCE_STATUS.INVALID, value: null, reasonCode: 'INVALID_NORMALIZED_ZONE_LOCATION' };
  }
  return { status: EVIDENCE_STATUS.AVAILABLE, value: round(value), reasonCode: null };
}

function durationField(value, inputsAvailable, unavailableReason) {
  if (!inputsAvailable) return { status: EVIDENCE_STATUS.UNAVAILABLE, value: null, reasonCode: unavailableReason };
  if (!finite(value) || value < 0) return { status: EVIDENCE_STATUS.INVALID, value: null, reasonCode: 'INVALID_DURATION' };
  return { status: EVIDENCE_STATUS.AVAILABLE, value: round(value), reasonCode: null };
}

function collectStatuses(value) {
  if (Array.isArray(value)) return value.flatMap(collectStatuses);
  if (!value || typeof value !== 'object') return [];
  if (Object.hasOwn(value, 'status')) return [value.status];
  return Object.values(value).flatMap(collectStatuses);
}

function sectionStatus(fields) {
  const statuses = fields.flatMap(collectStatuses);
  return statuses.includes(EVIDENCE_STATUS.INVALID) ? EVIDENCE_STATUS.INVALID
    : statuses.includes(EVIDENCE_STATUS.UNAVAILABLE) ? EVIDENCE_STATUS.UNAVAILABLE
      : EVIDENCE_STATUS.AVAILABLE;
}

function distanceEvidence(distance, referencePrice, atr, riskDistance, tickSize, unavailableReason) {
  const available = finite(distance);
  return {
    status: available ? EVIDENCE_STATUS.AVAILABLE : EVIDENCE_STATUS.UNAVAILABLE,
    absolutePrice: derived(available ? Math.abs(distance) : null, available, unavailableReason),
    directionalPrice: derived(distance, available, unavailableReason),
    percentage: derived(available && positive(referencePrice) ? distance / referencePrice * 100 : null,
      available && positive(referencePrice), 'REFERENCE_PRICE_UNAVAILABLE'),
    atrUnits: derived(available && positive(atr) ? distance / atr : null,
      available && positive(atr), 'ATR_UNAVAILABLE'),
    riskUnits: derived(available && positive(riskDistance) ? distance / riskDistance : null,
      available && positive(riskDistance), 'RISK_DISTANCE_UNAVAILABLE'),
    ticks: derived(available && positive(tickSize) ? distance / tickSize : null,
      available && positive(tickSize), 'AUTHORITATIVE_TICK_UNAVAILABLE')
  };
}

function pointEconomics(direction, entry, stop, tp1) {
  if (!['Long', 'Short'].includes(direction) || ![entry, stop, tp1].every(positive)) return null;
  const sign = direction === 'Long' ? 1 : -1;
  const risk = Math.abs(entry - stop);
  const reward = sign * (tp1 - entry);
  if (!(risk > 0) || !(reward > 0)) return null;
  const tp1RewardR = reward / risk;
  const tp1WeightedR = TP1_ALLOCATION * tp1RewardR;
  const modeledCostR = COST_RATE * entry / risk;
  return {
    entryReference: round(entry),
    initialRisk: round(risk),
    tp1RewardR: round(tp1RewardR),
    tp1WeightedR: round(tp1WeightedR),
    modeledCostR: round(modeledCostR),
    tp1WeightedRAfterCost: round(tp1WeightedR - modeledCostR)
  };
}

function economicsEvidence(direction, plan) {
  const { plannedEntry, entryZoneLow, entryZoneHigh, initialStopLoss, takeProfit1, takeProfit2 } = plan;
  const planned = pointEconomics(direction, plannedEntry, initialStopLoss, takeProfit1);
  if (!planned || !positive(entryZoneLow) || !positive(entryZoneHigh) || entryZoneLow >= entryZoneHigh) {
    return { status: EVIDENCE_STATUS.INVALID, reasonCode: 'INVALID_D01_GEOMETRY', nominalTp2RR: numberField(null),
      tp1RewardRAtPlannedEntry: numberField(null), tp1WeightedR: numberField(null),
      modeledCostRAtPlannedEntry: numberField(null), tp1WeightedRAfterCost: numberField(null), zoneVariants: null };
  }
  const midpoint = (entryZoneLow + entryZoneHigh) / 2;
  const points = [entryZoneLow, midpoint, entryZoneHigh]
    .map(entry => pointEconomics(direction, entry, initialStopLoss, takeProfit1));
  if (points.some(value => value === null)) {
    return { status: EVIDENCE_STATUS.INVALID, reasonCode: 'INVALID_D01_ZONE_GEOMETRY', nominalTp2RR: numberField(null),
      tp1RewardRAtPlannedEntry: numberField(null), tp1WeightedR: numberField(null),
      modeledCostRAtPlannedEntry: numberField(null), tp1WeightedRAfterCost: numberField(null), zoneVariants: null };
  }
  const sign = direction === 'Long' ? 1 : -1;
  const nominalTp2RR = positive(takeProfit2)
    ? sign * (takeProfit2 - plannedEntry) / Math.abs(plannedEntry - initialStopLoss) : null;
  const ordered = [...points].sort((a, b) => a.tp1WeightedRAfterCost - b.tp1WeightedRAfterCost ||
    a.entryReference - b.entryReference);
  return {
    status: EVIDENCE_STATUS.AVAILABLE,
    reasonCode: null,
    nominalTp2RR: derived(nominalTp2RR, finite(nominalTp2RR), 'TP2_UNAVAILABLE'),
    tp1RewardRAtPlannedEntry: numberField(planned.tp1RewardR),
    tp1WeightedR: numberField(planned.tp1WeightedR),
    modeledCostRAtPlannedEntry: numberField(planned.modeledCostR),
    tp1WeightedRAfterCost: numberField(planned.tp1WeightedRAfterCost),
    zoneVariants: {
      best: ordered.at(-1),
      midpoint: points[1],
      worst: ordered[0]
    }
  };
}

function notImplemented(versionSlot) {
  return { status: EVIDENCE_STATUS.NOT_IMPLEMENTED, version: null, reasonCode: `${versionSlot}_NOT_IMPLEMENTED` };
}

function normalizedPlan(input) {
  const zone = input?.entryZone || {};
  return {
    plannedEntry: input?.plannedEntry,
    entryZoneLow: zone.low,
    entryZoneHigh: zone.high,
    initialStopLoss: input?.initialStopLoss,
    takeProfit1: input?.takeProfit1,
    takeProfit2: input?.takeProfit2,
    takeProfit3: input?.takeProfit3
  };
}

function zoneEvidence(plan) {
  const valid = [plan.entryZoneLow, plan.entryZoneHigh].every(positive) && plan.entryZoneLow < plan.entryZoneHigh;
  const midpoint = valid ? (plan.entryZoneLow + plan.entryZoneHigh) / 2 : null;
  const width = valid ? plan.entryZoneHigh - plan.entryZoneLow : null;
  const location = valid && finite(plan.plannedEntry) ? (plan.plannedEntry - plan.entryZoneLow) / width : null;
  return {
    status: valid ? EVIDENCE_STATUS.AVAILABLE : EVIDENCE_STATUS.INVALID,
    low: positiveField(plan.entryZoneLow, 'ENTRY_ZONE_LOW_UNAVAILABLE'),
    high: positiveField(plan.entryZoneHigh, 'ENTRY_ZONE_HIGH_UNAVAILABLE'),
    width: derived(width, valid, 'ENTRY_ZONE_UNAVAILABLE', 'INVALID_OR_COLLAPSED_ENTRY_ZONE'),
    midpoint: derived(midpoint, valid, 'ENTRY_ZONE_UNAVAILABLE', 'INVALID_OR_COLLAPSED_ENTRY_ZONE'),
    plannedEntryLocation: normalizedLocationField(location, valid && finite(plan.plannedEntry), 'PLANNED_ENTRY_UNAVAILABLE')
  };
}

function assertBounded(evidence) {
  const size = bytes(evidence);
  if (size > CORE_V2_EVIDENCE_MAX_BYTES) throw new RangeError(`Core v2 evidence exceeds ${CORE_V2_EVIDENCE_MAX_BYTES} bytes`);
  return size;
}

export function createCoreV2BirthEvidence(input = {}) {
  const plan = normalizedPlan(input.plan);
  const originAt = timestampField(input.originAt, 'ORIGIN_TIMESTAMP_UNAVAILABLE');
  const analysisAt = timestampField(input.analysisAt, 'ANALYSIS_TIMESTAMP_UNAVAILABLE');
  const signalAgeAvailable = originAt.status === EVIDENCE_STATUS.AVAILABLE && analysisAt.status === EVIDENCE_STATUS.AVAILABLE;
  const signalAge = signalAgeAvailable ? Date.parse(originAt.value) - Date.parse(analysisAt.value) : null;
  const riskDistance = positive(plan.plannedEntry) && positive(plan.initialStopLoss)
    ? Math.abs(plan.plannedEntry - plan.initialStopLoss) : null;
  const sign = input.direction === 'Long' ? 1 : input.direction === 'Short' ? -1 : null;
  const priceExtension = sign && positive(input.analysisPrice) && positive(plan.plannedEntry)
    ? sign * (input.analysisPrice - plan.plannedEntry) : null;
  const tp1Distance = sign && positive(plan.takeProfit1) && positive(plan.plannedEntry)
    ? sign * (plan.takeProfit1 - plan.plannedEntry) : null;
  const tickSize = positive(input.tickSize) ? input.tickSize : null;
  const atr = positive(input.atr) ? input.atr : null;
  const zone = zoneEvidence(plan);
  const identity = {
    status: EVIDENCE_STATUS.AVAILABLE,
    strategyVersion: CORE_V2_STRATEGY_VERSION,
    archiveRulesVersion: CORE_V2_ARCHIVE_RULES_VERSION,
    exitPolicyVersion: CORE_V2_EXIT_POLICY_VERSION,
    canonicalSymbol: textField(input.canonicalSymbol, 'CANONICAL_SYMBOL_UNAVAILABLE'),
    marketSymbol: textField(input.marketSymbol, 'MARKET_SYMBOL_UNAVAILABLE'),
    instId: textField(input.instId, 'INST_ID_UNAVAILABLE'),
    instrumentType: textField(input.instrumentType, 'INSTRUMENT_TYPE_UNAVAILABLE'),
    direction: field(input.direction, value => ['Long', 'Short'].includes(value), 'DIRECTION_UNAVAILABLE', 'INVALID_DIRECTION'),
    originAt,
    analysisAt
  };
  identity.status = sectionStatus(Object.entries(identity).filter(([key]) => key !== 'status').map(([, value]) => value));
  const provenance = {
    status: EVIDENCE_STATUS.AVAILABLE,
    priceSource: textField(input.priceSource, 'PRICE_SOURCE_UNAVAILABLE'),
    priceObservedAt: timestampField(input.priceObservedAt, 'PRICE_TIMESTAMP_UNAVAILABLE'),
    candleSource: textField(input.candleSource, 'CANDLE_SOURCE_UNAVAILABLE'),
    candleFirstOpenAt: timestampField(input.candleFirstOpenAt, 'CANDLE_FIRST_TIMESTAMP_UNAVAILABLE'),
    candleLastConfirmedCloseAt: timestampField(input.candleLastConfirmedCloseAt, 'CANDLE_LAST_TIMESTAMP_UNAVAILABLE'),
    instrumentSource: textField(input.instrumentSource, 'INSTRUMENT_SOURCE_UNAVAILABLE'),
    instrumentRecordObservedAt: timestampField(input.instrumentRecordObservedAt, 'INSTRUMENT_TIMESTAMP_UNAVAILABLE')
  };
  provenance.status = sectionStatus(Object.entries(provenance).filter(([key]) => key !== 'status').map(([, value]) => value));
  const initialRisk = distanceEvidence(riskDistance, plan.plannedEntry, atr, riskDistance, tickSize, 'RISK_DISTANCE_UNAVAILABLE');
  const birth = {
    status: EVIDENCE_STATUS.AVAILABLE,
    capturedAt: originAt,
    signalAgeMs: durationField(signalAge, signalAgeAvailable, 'SIGNAL_AGE_UNAVAILABLE'),
    entryObservation: {
      analysisPrice: positiveField(input.analysisPrice, 'ANALYSIS_PRICE_UNAVAILABLE'),
      priceExtension: distanceEvidence(priceExtension, plan.plannedEntry, atr, riskDistance, tickSize,
        'PRICE_EXTENSION_UNAVAILABLE'),
      entryZone: zone,
      plannedEntry: positiveField(plan.plannedEntry, 'PLANNED_ENTRY_UNAVAILABLE'),
      tp1Distance: distanceEvidence(tp1Distance, plan.plannedEntry, atr, riskDistance, tickSize,
        'TP1_DISTANCE_UNAVAILABLE'),
      initialRiskDistance: initialRisk,
      costInR: derived(positive(plan.plannedEntry) && positive(riskDistance)
        ? COST_RATE * plan.plannedEntry / riskDistance : null,
      positive(plan.plannedEntry) && positive(riskDistance), 'RISK_DISTANCE_UNAVAILABLE')
    },
    economics: economicsEvidence(input.direction, plan)
  };
  birth.status = sectionStatus(Object.entries(birth).filter(([key]) => key !== 'status').map(([, value]) => value));
  const evidence = {
    schemaVersion: CORE_V2_EVIDENCE_SCHEMA_VERSION,
    identity,
    provenance,
    birth,
    activation: {
      status: EVIDENCE_STATUS.UNAVAILABLE,
      reasonCode: 'NOT_ACTIVATED',
      version: 1,
      activationAt: timestampField(null, 'NOT_ACTIVATED'),
      activationDelayMs: numberField(null, 'NOT_ACTIVATED'),
      activationEntry: positiveField(null, 'NOT_ACTIVATED'),
      activationEntryLocation: numberField(null, 'NOT_ACTIVATED'),
      activationExtension: null,
      activationCostInR: numberField(null, 'NOT_ACTIVATED')
    },
    dataAvailability: {
      price: provenance.priceSource.status === EVIDENCE_STATUS.AVAILABLE &&
        provenance.priceObservedAt.status === EVIDENCE_STATUS.AVAILABLE
        ? { status: EVIDENCE_STATUS.AVAILABLE, reasonCode: null }
        : { status: EVIDENCE_STATUS.UNAVAILABLE, reasonCode: 'PRICE_EVIDENCE_UNAVAILABLE' },
      candles: provenance.candleSource.status === EVIDENCE_STATUS.AVAILABLE &&
        provenance.candleLastConfirmedCloseAt.status === EVIDENCE_STATUS.AVAILABLE
        ? { status: EVIDENCE_STATUS.AVAILABLE, reasonCode: null }
        : { status: EVIDENCE_STATUS.UNAVAILABLE, reasonCode: 'CANDLE_EVIDENCE_UNAVAILABLE' },
      instrument: identity.instId.status === EVIDENCE_STATUS.AVAILABLE &&
        provenance.instrumentSource.status === EVIDENCE_STATUS.AVAILABLE
        ? { status: EVIDENCE_STATUS.AVAILABLE, reasonCode: null }
        : { status: EVIDENCE_STATUS.UNAVAILABLE, reasonCode: 'INSTRUMENT_EVIDENCE_UNAVAILABLE' },
      authoritativeTick: tickSize
        ? { status: EVIDENCE_STATUS.AVAILABLE, value: tickSize, reasonCode: null }
        : { status: EVIDENCE_STATUS.UNAVAILABLE, value: null, reasonCode: 'AUTHORITATIVE_TICK_UNAVAILABLE' }
    },
    measurementVersions: {
      economicsVersion: { status: EVIDENCE_STATUS.AVAILABLE, version: CORE_V2_ECONOMICS_VERSION, reasonCode: null },
      oiSemanticsVersion: notImplemented('OI_SEMANTICS'),
      birthSafetyVersion: notImplemented('BIRTH_SAFETY'),
      pricePrecisionVersion: notImplemented('PRICE_PRECISION'),
      atrVersion: notImplemented('ATR')
    }
  };
  assertBounded(evidence);
  return deepFreeze(evidence);
}

export function appendCoreV2ActivationEvidence(evidence, input = {}) {
  if (!supportedSchema(evidence?.schemaVersion)) throw new TypeError('Invalid Core v2 evidence');
  if (evidence.activation?.status === EVIDENCE_STATUS.AVAILABLE) throw new Error('Activation evidence is immutable once available');
  const birthBefore = JSON.stringify(evidence.birth);
  const copy = structuredClone(evidence);
  const originAt = evidence.identity.originAt;
  const activationAt = timestampField(input.activationAt, 'ACTIVATION_TIMESTAMP_UNAVAILABLE');
  const entry = positiveField(input.activationEntry, 'ACTIVATION_ENTRY_UNAVAILABLE');
  const plan = {
    plannedEntry: evidence.birth.entryObservation.plannedEntry.value,
    low: evidence.birth.entryObservation.entryZone.low.value,
    high: evidence.birth.entryObservation.entryZone.high.value
  };
  const risk = evidence.birth.entryObservation.initialRiskDistance.absolutePrice.value;
  const atrUnits = evidence.birth.entryObservation.initialRiskDistance.atrUnits;
  const tickField = evidence.dataAvailability?.authoritativeTick || evidence.provenance?.authoritativeTick || {};
  const tick = tickField.status === EVIDENCE_STATUS.AVAILABLE ? tickField.value : null;
  const direction = evidence.identity.direction.value;
  const sign = direction === 'Long' ? 1 : direction === 'Short' ? -1 : null;
  const timestampsValid = originAt.status === EVIDENCE_STATUS.AVAILABLE && activationAt.status === EVIDENCE_STATUS.AVAILABLE;
  const delay = timestampsValid ? Date.parse(activationAt.value) - Date.parse(originAt.value) : null;
  const zoneValid = positive(plan.low) && positive(plan.high) && plan.low < plan.high;
  const location = zoneValid && entry.status === EVIDENCE_STATUS.AVAILABLE
    ? (entry.value - plan.low) / (plan.high - plan.low) : null;
  const extension = sign && entry.status === EVIDENCE_STATUS.AVAILABLE && positive(plan.plannedEntry)
    ? sign * (entry.value - plan.plannedEntry) : null;
  const atr = atrUnits.status === EVIDENCE_STATUS.AVAILABLE && positive(risk) && finite(atrUnits.value) && atrUnits.value !== 0
    ? risk / atrUnits.value : null;
  copy.activation = {
    status: timestampsValid && delay >= 0 && entry.status === EVIDENCE_STATUS.AVAILABLE
      ? EVIDENCE_STATUS.AVAILABLE : EVIDENCE_STATUS.INVALID,
    reasonCode: timestampsValid && delay >= 0 && entry.status === EVIDENCE_STATUS.AVAILABLE ? null : 'INVALID_ACTIVATION_EVIDENCE',
    version: 1,
    activationAt,
    activationDelayMs: durationField(delay, timestampsValid, 'ACTIVATION_DELAY_UNAVAILABLE'),
    activationEntry: entry,
    activationEntryLocation: normalizedLocationField(location,
      zoneValid && entry.status === EVIDENCE_STATUS.AVAILABLE, 'ENTRY_ZONE_UNAVAILABLE'),
    activationExtension: distanceEvidence(extension, plan.plannedEntry, atr, risk, tick, 'ACTIVATION_EXTENSION_UNAVAILABLE'),
    activationCostInR: derived(entry.status === EVIDENCE_STATUS.AVAILABLE && positive(risk)
      ? COST_RATE * entry.value / risk : null,
    entry.status === EVIDENCE_STATUS.AVAILABLE && positive(risk), 'RISK_DISTANCE_UNAVAILABLE')
  };
  if (JSON.stringify(copy.birth) !== birthBefore) throw new Error('Birth evidence mutation detected');
  assertBounded(copy);
  return deepFreeze(copy);
}

function boundedD03Evidence(result) {
  const source = result?.sourceEvidence || {};
  const oi = source.openInterest || {};
  const price = source.price || {};
  const contribution = result?.contribution || {};
  return {
    version: CORE_V2_D03_CONTRACT_VERSION,
    status: result.status,
    classification: result.classification,
    directionalSignal: result.directionalSignal,
    reasonCode: result.reasonCode ?? null,
    reasonCodes: Array.isArray(result.reasonCodes) ? result.reasonCodes.slice(0, 16) : [],
    openInterestChangePct: finite(result.openInterestChangePct) ? round(result.openInterestChangePct) : null,
    priceChangePct: finite(result.priceChangePct) ? round(result.priceChangePct) : null,
    sourceEvidence: {
      alignmentStatus: source.alignmentStatus ?? null,
      evaluatedAt: source.evaluatedAt ?? null,
      openInterest: {
        source: oi.source ?? null,
        sourceKind: oi.sourceKind ?? null,
        observedAt: oi.observedAt ?? null,
        windowStart: oi.windowStart ?? null,
        windowEnd: oi.windowEnd ?? null,
        interval: oi.interval ?? null,
        observationCount: Number.isInteger(oi.observationCount) ? oi.observationCount : null,
        expectedObservationCount: Number.isInteger(oi.expectedObservationCount) ? oi.expectedObservationCount : null
      },
      price: {
        source: price.source ?? null,
        sourceKind: price.sourceKind ?? null,
        observedAt: price.observedAt ?? null,
        windowStart: price.windowStart ?? null,
        windowEnd: price.windowEnd ?? null,
        interval: price.interval ?? null,
        candleStatus: price.candleStatus ?? null
      }
    },
    contribution: {
      status: contribution.status ?? null,
      bias: contribution.bias ?? 'Neutral',
      applied: false,
      weight: null,
      reasonCode: contribution.reasonCode ?? null
    }
  };
}

export function appendCoreV2D03Evidence(evidence, result) {
  if (!supportedSchema(evidence?.schemaVersion)) throw new TypeError('Invalid Core v2 evidence');
  if (result?.contract !== 'CORE_V2_D03' || result?.version !== CORE_V2_D03_CONTRACT_VERSION ||
      ![EVIDENCE_STATUS.AVAILABLE, EVIDENCE_STATUS.UNAVAILABLE].includes(result?.status)) {
    throw new TypeError('Invalid Core v2 D03 result');
  }
  if (evidence.measurementVersions?.oiSemanticsVersion?.status !== EVIDENCE_STATUS.NOT_IMPLEMENTED ||
      evidence.measurements?.d03) throw new Error('D03 evidence is immutable once captured');
  const birthBefore = JSON.stringify(evidence.birth);
  const activationBefore = JSON.stringify(evidence.activation);
  const copy = structuredClone(evidence);
  const d03 = boundedD03Evidence(result);
  copy.measurements = { ...(copy.measurements || {}), d03: evidence.schemaVersion ===
    CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION ? compactD03Evidence(d03) : d03 };
  copy.measurementVersions.oiSemanticsVersion = {
    status: EVIDENCE_STATUS.AVAILABLE,
    version: CORE_V2_D03_CONTRACT_VERSION,
    reasonCode: null
  };
  if (JSON.stringify(copy.birth) !== birthBefore) throw new Error('Birth evidence mutation detected');
  if (JSON.stringify(copy.activation) !== activationBefore) throw new Error('Activation evidence mutation detected');
  assertBounded(copy);
  return deepFreeze(copy);
}

export function appendCoreV2D06Evidence(evidence, input = {}) {
  if (evidence?.schemaVersion !== CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError('Core v2 D06 promotion requires compact schema v2');
  }
  if (evidence.measurementVersions?.atrVersion?.status !== EVIDENCE_STATUS.NOT_IMPLEMENTED ||
      evidence.measurements?.atr) throw new Error('D06 evidence is immutable once captured');
  const birthBefore = JSON.stringify(evidence.birth);
  const activationBefore = JSON.stringify(evidence.activation);
  const d03Before = JSON.stringify(evidence.measurements?.d03);
  const result = evaluateCoreV2D06(input);
  const copy = structuredClone(evidence);
  copy.measurements = { ...(copy.measurements || {}), atr: createCoreV2D06InlineEvidence(result) };
  copy.measurementVersions.atrVersion = {
    status: result.status,
    version: CORE_V2_D06_CONTRACT_VERSION,
    reasonCode: result.reasonCode
  };
  if (JSON.stringify(copy.birth) !== birthBefore) throw new Error('Birth evidence mutation detected');
  if (JSON.stringify(copy.activation) !== activationBefore) throw new Error('Activation evidence mutation detected');
  if (JSON.stringify(copy.measurements?.d03) !== d03Before) throw new Error('D03 evidence mutation detected');
  assertBounded(copy);
  return deepFreeze(copy);
}

function notActivatedEvidence() {
  return {
    status: EVIDENCE_STATUS.UNAVAILABLE,
    reasonCode: 'NOT_ACTIVATED',
    version: 1,
    activationAt: timestampField(null, 'NOT_ACTIVATED'),
    activationDelayMs: numberField(null, 'NOT_ACTIVATED'),
    activationEntry: positiveField(null, 'NOT_ACTIVATED'),
    activationEntryLocation: numberField(null, 'NOT_ACTIVATED'),
    activationExtension: null,
    activationCostInR: numberField(null, 'NOT_ACTIVATED')
  };
}

function reconstructZone(zone, plannedEntry) {
  const low = zone?.low?.value;
  const high = zone?.high?.value;
  const valid = positive(low) && positive(high) && low < high;
  const width = valid ? high - low : null;
  const midpoint = valid ? (low + high) / 2 : null;
  const location = valid && finite(plannedEntry) ? (plannedEntry - low) / width : null;
  return {
    status: valid ? EVIDENCE_STATUS.AVAILABLE : EVIDENCE_STATUS.INVALID,
    low: structuredClone(zone?.low),
    high: structuredClone(zone?.high),
    width: derived(width, valid, 'ENTRY_ZONE_UNAVAILABLE', 'INVALID_OR_COLLAPSED_ENTRY_ZONE'),
    midpoint: derived(midpoint, valid, 'ENTRY_ZONE_UNAVAILABLE', 'INVALID_OR_COLLAPSED_ENTRY_ZONE'),
    plannedEntryLocation: normalizedLocationField(location, valid && finite(plannedEntry), 'PLANNED_ENTRY_UNAVAILABLE')
  };
}

function derivedDataAvailability(evidence) {
  const provenance = evidence.provenance || {};
  const identity = evidence.identity || {};
  const tick = provenance.authoritativeTick || evidence.dataAvailability?.authoritativeTick;
  return {
    price: provenance.priceSource?.status === EVIDENCE_STATUS.AVAILABLE &&
      provenance.priceObservedAt?.status === EVIDENCE_STATUS.AVAILABLE
      ? { status: EVIDENCE_STATUS.AVAILABLE, reasonCode: null }
      : { status: EVIDENCE_STATUS.UNAVAILABLE, reasonCode: 'PRICE_EVIDENCE_UNAVAILABLE' },
    candles: provenance.candleSource?.status === EVIDENCE_STATUS.AVAILABLE &&
      provenance.candleLastConfirmedCloseAt?.status === EVIDENCE_STATUS.AVAILABLE
      ? { status: EVIDENCE_STATUS.AVAILABLE, reasonCode: null }
      : { status: EVIDENCE_STATUS.UNAVAILABLE, reasonCode: 'CANDLE_EVIDENCE_UNAVAILABLE' },
    instrument: identity.instId?.status === EVIDENCE_STATUS.AVAILABLE &&
      provenance.instrumentSource?.status === EVIDENCE_STATUS.AVAILABLE
      ? { status: EVIDENCE_STATUS.AVAILABLE, reasonCode: null }
      : { status: EVIDENCE_STATUS.UNAVAILABLE, reasonCode: 'INSTRUMENT_EVIDENCE_UNAVAILABLE' },
    authoritativeTick: tick ? structuredClone(tick)
      : { status: EVIDENCE_STATUS.UNAVAILABLE, value: null, reasonCode: 'AUTHORITATIVE_TICK_UNAVAILABLE' }
  };
}

function expectedD03Contribution(d03) {
  const available = d03?.status === EVIDENCE_STATUS.AVAILABLE;
  const bias = available && d03.classification === 'BULLISH_CONFIRMATION' ? 'Bullish'
    : available && d03.classification === 'BEARISH_CONFIRMATION' ? 'Bearish' : 'Neutral';
  return {
    status: available ? 'OBSERVATIONAL_ONLY' : 'NEUTRAL_UNAVAILABLE',
    bias,
    applied: false,
    weight: null,
    reasonCode: available ? null : 'D03_UNAVAILABLE'
  };
}

function compactD03Evidence(d03) {
  const copy = structuredClone(d03);
  if (JSON.stringify(copy.contribution) === JSON.stringify(expectedD03Contribution(copy))) delete copy.contribution;
  const source = copy.sourceEvidence;
  const oi = source?.openInterest;
  const price = source?.price;
  const aligned = source?.alignmentStatus === 'ALIGNED' && oi?.windowStart === price?.windowStart &&
    oi?.windowEnd === price?.windowEnd;
  if (aligned) {
    copy.sourceEvidence = {
      alignmentStatus: source.alignmentStatus,
      evaluatedAt: source.evaluatedAt,
      windowStart: oi.windowStart,
      windowEnd: oi.windowEnd,
      openInterest: {
        source: oi.source,
        sourceKind: oi.sourceKind,
        observedAt: oi.observedAt,
        observationCount: oi.observationCount
      },
      price: {
        source: price.source,
        sourceKind: price.sourceKind,
        observedAt: price.observedAt,
        candleStatus: price.candleStatus
      }
    };
  }
  return copy;
}

function expandD03Evidence(d03) {
  const copy = structuredClone(d03);
  const source = copy.sourceEvidence;
  if (source?.windowStart !== undefined && source?.windowEnd !== undefined) {
    copy.sourceEvidence = {
      alignmentStatus: source.alignmentStatus,
      evaluatedAt: source.evaluatedAt,
      openInterest: {
        source: source.openInterest?.source ?? null,
        sourceKind: source.openInterest?.sourceKind ?? null,
        observedAt: source.openInterest?.observedAt ?? null,
        windowStart: source.windowStart,
        windowEnd: source.windowEnd,
        interval: '4H',
        observationCount: source.openInterest?.observationCount ?? null,
        expectedObservationCount: 6
      },
      price: {
        source: source.price?.source ?? null,
        sourceKind: source.price?.sourceKind ?? null,
        observedAt: source.price?.observedAt ?? null,
        windowStart: source.windowStart,
        windowEnd: source.windowEnd,
        interval: '1D',
        candleStatus: source.price?.candleStatus ?? null
      }
    };
  }
  if (!copy.contribution) copy.contribution = expectedD03Contribution(copy);
  return copy;
}

export function compactCoreV2Evidence(evidence) {
  if (!supportedSchema(evidence?.schemaVersion)) throw new TypeError('Invalid Core v2 evidence');
  if (evidence.schemaVersion === CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION) return evidence;
  const copy = structuredClone(evidence);
  if (JSON.stringify(copy.birth?.capturedAt) === JSON.stringify(copy.identity?.originAt)) delete copy.birth.capturedAt;
  const entry = copy.birth?.entryObservation;
  if (entry?.entryZone) {
    const rebuilt = reconstructZone(entry.entryZone, entry.plannedEntry?.value);
    if (JSON.stringify(rebuilt) === JSON.stringify(entry.entryZone)) {
      entry.entryZone = { status: entry.entryZone.status, low: entry.entryZone.low, high: entry.entryZone.high };
    }
  }
  if (JSON.stringify(entry?.costInR) === JSON.stringify(copy.birth?.economics?.modeledCostRAtPlannedEntry)) {
    delete entry.costInR;
  }
  if (JSON.stringify(copy.activation) === JSON.stringify(notActivatedEvidence())) {
    copy.activation = { status: EVIDENCE_STATUS.UNAVAILABLE, reasonCode: 'NOT_ACTIVATED', version: 1 };
  }
  if (copy.dataAvailability?.authoritativeTick) {
    copy.provenance.authoritativeTick = structuredClone(copy.dataAvailability.authoritativeTick);
  }
  if (copy.dataAvailability &&
      JSON.stringify(derivedDataAvailability(copy)) === JSON.stringify(copy.dataAvailability)) {
    delete copy.dataAvailability;
  }
  if (copy.measurements?.d03) copy.measurements.d03 = compactD03Evidence(copy.measurements.d03);
  copy.schemaVersion = CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION;
  assertBounded(copy);
  return deepFreeze(copy);
}

export function expandCoreV2EvidenceForAudit(evidence) {
  if (!supportedSchema(evidence?.schemaVersion)) throw new TypeError('Invalid Core v2 evidence');
  if (evidence.schemaVersion === CORE_V2_EVIDENCE_SCHEMA_VERSION) return evidence;
  const copy = structuredClone(evidence);
  copy.schemaVersion = CORE_V2_EVIDENCE_SCHEMA_VERSION;
  if (!copy.birth.capturedAt) copy.birth.capturedAt = structuredClone(copy.identity.originAt);
  const entry = copy.birth?.entryObservation;
  if (entry?.entryZone && !entry.entryZone.width) {
    entry.entryZone = reconstructZone(entry.entryZone, entry.plannedEntry?.value);
  }
  if (!entry?.costInR && copy.birth?.economics?.modeledCostRAtPlannedEntry) {
    entry.costInR = structuredClone(copy.birth.economics.modeledCostRAtPlannedEntry);
  }
  if (copy.activation?.status === EVIDENCE_STATUS.UNAVAILABLE &&
      copy.activation?.reasonCode === 'NOT_ACTIVATED' && !copy.activation.activationAt) {
    copy.activation = notActivatedEvidence();
  }
  if (!copy.dataAvailability) copy.dataAvailability = derivedDataAvailability(copy);
  delete copy.provenance.authoritativeTick;
  if (copy.measurements?.d03) copy.measurements.d03 = expandD03Evidence(copy.measurements.d03);
  return deepFreeze(copy);
}

export function appendCoreV2EvidenceReference(evidence, reference) {
  if (evidence?.schemaVersion !== CORE_V2_COMPACT_EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError('Evidence references require compact schema v2');
  }
  if (reference?.version !== CORE_V2_EVIDENCE_REFERENCE_VERSION ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(reference?.schemaVersion || '') ||
      reference?.digestAlgorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(reference?.digest || '') ||
      !Number.isSafeInteger(reference?.byteLength) || reference.byteLength <= 0) {
    throw new TypeError('Invalid Core v2 evidence reference');
  }
  const boundedReference = {
    version: CORE_V2_EVIDENCE_REFERENCE_VERSION,
    schemaVersion: reference.schemaVersion,
    digestAlgorithm: 'sha256',
    digest: reference.digest,
    byteLength: reference.byteLength
  };
  if (bytes(boundedReference) > 256) throw new TypeError('Invalid Core v2 evidence reference');
  const copy = structuredClone(evidence);
  const references = Array.isArray(copy.references) ? copy.references : [];
  if (references.some(item => item.digest === boundedReference.digest)) throw new Error('Duplicate evidence reference');
  copy.references = [...references, boundedReference];
  assertBounded(copy);
  return deepFreeze(copy);
}

export function serializeCoreV2Evidence(evidence) {
  if (!supportedSchema(evidence?.schemaVersion)) throw new TypeError('Invalid Core v2 evidence');
  assertBounded(evidence);
  return JSON.stringify(evidence);
}

export function measureCoreV2EvidenceBytes(evidence) {
  return assertBounded(evidence);
}
