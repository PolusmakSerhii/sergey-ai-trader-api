export const CORE_V2_STRATEGY_VERSION = 'core-v2-entry-v1';
export const CORE_V2_ARCHIVE_RULES_VERSION = 'canonical-trade-archive-v2';
export const CORE_V2_EXIT_POLICY_VERSION = 'tp1-50-reanalyse-v1';
export const CORE_V2_EVIDENCE_SCHEMA_VERSION = 'core-v2-evidence-v1';
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
  if (evidence?.schemaVersion !== CORE_V2_EVIDENCE_SCHEMA_VERSION) throw new TypeError('Invalid Core v2 evidence');
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
  const tickField = evidence.dataAvailability.authoritativeTick;
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
  if (evidence?.schemaVersion !== CORE_V2_EVIDENCE_SCHEMA_VERSION) throw new TypeError('Invalid Core v2 evidence');
  if (result?.contract !== 'CORE_V2_D03' || result?.version !== CORE_V2_D03_CONTRACT_VERSION ||
      ![EVIDENCE_STATUS.AVAILABLE, EVIDENCE_STATUS.UNAVAILABLE].includes(result?.status)) {
    throw new TypeError('Invalid Core v2 D03 result');
  }
  if (evidence.measurementVersions?.oiSemanticsVersion?.status !== EVIDENCE_STATUS.NOT_IMPLEMENTED ||
      evidence.measurements?.d03) throw new Error('D03 evidence is immutable once captured');
  const birthBefore = JSON.stringify(evidence.birth);
  const activationBefore = JSON.stringify(evidence.activation);
  const copy = structuredClone(evidence);
  copy.measurements = { ...(copy.measurements || {}), d03: boundedD03Evidence(result) };
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

export function serializeCoreV2Evidence(evidence) {
  if (evidence?.schemaVersion !== CORE_V2_EVIDENCE_SCHEMA_VERSION) throw new TypeError('Invalid Core v2 evidence');
  assertBounded(evidence);
  return JSON.stringify(evidence);
}

export function measureCoreV2EvidenceBytes(evidence) {
  return assertBounded(evidence);
}
