import {
  CORE_V2_D03_CONTRACT_VERSION,
  EVIDENCE_STATUS
} from './core-v2-evidence.js';

export const CORE_V2_D03_OI_SOURCE_KIND = 'COINGLASS_AGGREGATED_FUTURES_OI_4H';
export const CORE_V2_D03_PRICE_SOURCE_KIND = 'OKX_SWAP_CLOSED_DAILY_CANDLE_1D';
export const CORE_V2_D03_OI_OBSERVATIONS = 6;
export const CORE_V2_D03_MAX_STALENESS_MS = 24 * 60 * 60 * 1000;

export const CORE_V2_D03_CLASSIFICATION = Object.freeze({
  BULLISH_CONFIRMATION: 'BULLISH_CONFIRMATION',
  BEARISH_CONFIRMATION: 'BEARISH_CONFIRMATION',
  SHORT_COVERING: 'SHORT_COVERING',
  LONG_LIQUIDATION: 'LONG_LIQUIDATION',
  OPEN_INTEREST_FLAT: 'OPEN_INTEREST_FLAT',
  PRICE_FLAT: 'PRICE_FLAT',
  BOTH_FLAT: 'BOTH_FLAT',
  UNAVAILABLE: 'UNAVAILABLE'
});

export const CORE_V2_D03_ALIGNMENT = Object.freeze({
  ALIGNED: 'ALIGNED',
  MISALIGNED: 'MISALIGNED',
  UNAVAILABLE: 'UNAVAILABLE'
});

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const DAY_MS = CORE_V2_D03_MAX_STALENESS_MS;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const sensitive = /authorization|bearer|cookie|credential|secret|api[_ -]?key|token/i;
const sourceLabel = (value, prefix) => nonempty(value) && value.startsWith(prefix) &&
  value.length <= 120 && !sensitive.test(value);
const epoch = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => epoch(value) === null ? null : new Date(value).toISOString();
const rounded = value => finite(value) ? Number(value.toPrecision(15)) : null;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function add(reasons, condition, code) {
  if (condition && !reasons.includes(code)) reasons.push(code);
}

function timestampReasons(input, reasons) {
  const fields = [
    ['evaluatedAt', 'EVALUATED_AT'],
    ['openInterestObservedAt', 'OPEN_INTEREST_OBSERVED_AT'],
    ['priceObservedAt', 'PRICE_OBSERVED_AT'],
    ['oiWindowStart', 'OI_WINDOW_START'],
    ['oiWindowEnd', 'OI_WINDOW_END'],
    ['priceWindowStart', 'PRICE_WINDOW_START'],
    ['priceWindowEnd', 'PRICE_WINDOW_END']
  ];
  for (const [field, code] of fields) {
    add(reasons, input?.[field] == null, `MISSING_${code}`);
    add(reasons, input?.[field] != null && epoch(input[field]) === null, `INVALID_${code}`);
  }
}

function observationReasons(observations, reasons) {
  if (!Array.isArray(observations)) {
    add(reasons, true, 'MISSING_OI_OBSERVATIONS');
    return [];
  }
  add(reasons, observations.length !== CORE_V2_D03_OI_OBSERVATIONS, 'INCOMPLETE_OI_WINDOW');
  const normalized = observations.slice(0, CORE_V2_D03_OI_OBSERVATIONS).map(item => ({
    windowStart: iso(item?.windowStart),
    windowEnd: iso(item?.windowEnd)
  }));
  add(reasons, normalized.some(item => item.windowStart === null || item.windowEnd === null),
    'INVALID_OI_OBSERVATION_TIMESTAMP');
  const valid = normalized.filter(item => item.windowStart !== null && item.windowEnd !== null);
  const starts = valid.map(item => item.windowStart);
  const ends = valid.map(item => item.windowEnd);
  add(reasons, new Set(starts).size !== starts.length || new Set(ends).size !== ends.length,
    'DUPLICATE_OI_OBSERVATION');
  add(reasons, valid.some(item => epoch(item.windowEnd) - epoch(item.windowStart) !== FOUR_HOURS_MS),
    'INVALID_OI_OBSERVATION_INTERVAL');
  add(reasons, valid.some((item, index) => index > 0 &&
    epoch(item.windowStart) !== epoch(valid[index - 1].windowEnd)), 'NON_CONTIGUOUS_OI_OBSERVATIONS');
  return normalized;
}

function alignmentStatus(input, observations, reasons) {
  const oiStart = epoch(input?.oiWindowStart);
  const oiEnd = epoch(input?.oiWindowEnd);
  const priceStart = epoch(input?.priceWindowStart);
  const priceEnd = epoch(input?.priceWindowEnd);
  if ([oiStart, oiEnd, priceStart, priceEnd].some(value => value === null)) {
    return CORE_V2_D03_ALIGNMENT.UNAVAILABLE;
  }
  add(reasons, oiEnd - oiStart !== DAY_MS, 'INVALID_OI_WINDOW_DURATION');
  add(reasons, priceEnd - priceStart !== DAY_MS, 'INVALID_PRICE_WINDOW_DURATION');
  if (observations.length === CORE_V2_D03_OI_OBSERVATIONS &&
      observations.every(item => item.windowStart !== null && item.windowEnd !== null)) {
    add(reasons, epoch(observations[0].windowStart) !== oiStart ||
      epoch(observations.at(-1).windowEnd) !== oiEnd, 'OI_WINDOW_COVERAGE_MISMATCH');
  }
  const aligned = oiStart === priceStart && oiEnd === priceEnd;
  add(reasons, !aligned, 'WINDOW_MISALIGNED');
  return aligned ? CORE_V2_D03_ALIGNMENT.ALIGNED : CORE_V2_D03_ALIGNMENT.MISALIGNED;
}

function freshnessReasons(input, reasons) {
  const evaluatedAt = epoch(input?.evaluatedAt);
  const oiObservedAt = epoch(input?.openInterestObservedAt);
  const priceObservedAt = epoch(input?.priceObservedAt);
  const oiEnd = epoch(input?.oiWindowEnd);
  const priceEnd = epoch(input?.priceWindowEnd);
  if ([evaluatedAt, oiObservedAt, priceObservedAt, oiEnd, priceEnd].some(value => value === null)) return;
  add(reasons, oiObservedAt > evaluatedAt || priceObservedAt > evaluatedAt ||
    oiEnd > evaluatedAt || priceEnd > evaluatedAt, 'FUTURE_OBSERVATION');
  add(reasons, oiObservedAt < oiEnd || priceObservedAt < priceEnd, 'OBSERVATION_BEFORE_WINDOW_CLOSE');
  add(reasons, evaluatedAt - oiEnd > DAY_MS || evaluatedAt - priceEnd > DAY_MS ||
    evaluatedAt - oiObservedAt > DAY_MS || evaluatedAt - priceObservedAt > DAY_MS, 'STALE_INPUT');
}

function sourceReasons(input, reasons) {
  add(reasons, !nonempty(input?.openInterestSource), 'MISSING_OPEN_INTEREST_SOURCE');
  add(reasons, !nonempty(input?.priceSource), 'MISSING_PRICE_SOURCE');
  add(reasons, input?.openInterestSourceKind == null, 'MISSING_OPEN_INTEREST_SOURCE_KIND');
  add(reasons, input?.priceSourceKind == null, 'MISSING_PRICE_SOURCE_KIND');
  add(reasons, input?.openInterestSourceKind != null &&
    input.openInterestSourceKind !== CORE_V2_D03_OI_SOURCE_KIND,
    'SEMANTICALLY_INCOMPATIBLE_OI_SOURCE');
  add(reasons, input?.priceSourceKind != null && input.priceSourceKind !== CORE_V2_D03_PRICE_SOURCE_KIND,
    'SEMANTICALLY_INCOMPATIBLE_PRICE_SOURCE');
  add(reasons, nonempty(input?.openInterestSource) && !sourceLabel(input.openInterestSource, 'CoinGlass'),
  'SEMANTICALLY_INCOMPATIBLE_OI_SOURCE_IDENTITY');
  add(reasons, nonempty(input?.priceSource) && !sourceLabel(input.priceSource, 'OKX'),
  'SEMANTICALLY_INCOMPATIBLE_PRICE_SOURCE_IDENTITY');
  add(reasons, input?.priceCandleStatus !== 'CLOSED', 'PRICE_CANDLE_NOT_CLOSED');
}

function classify(openInterestChangePct, priceChangePct) {
  const values = CORE_V2_D03_CLASSIFICATION;
  if (openInterestChangePct === 0 && priceChangePct === 0) return values.BOTH_FLAT;
  if (openInterestChangePct === 0) return values.OPEN_INTEREST_FLAT;
  if (priceChangePct === 0) return values.PRICE_FLAT;
  if (openInterestChangePct > 0 && priceChangePct > 0) return values.BULLISH_CONFIRMATION;
  if (openInterestChangePct > 0 && priceChangePct < 0) return values.BEARISH_CONFIRMATION;
  if (openInterestChangePct < 0 && priceChangePct > 0) return values.SHORT_COVERING;
  return values.LONG_LIQUIDATION;
}

function contribution(classification, available) {
  const bias = available && classification === CORE_V2_D03_CLASSIFICATION.BULLISH_CONFIRMATION ? 'Bullish'
    : available && classification === CORE_V2_D03_CLASSIFICATION.BEARISH_CONFIRMATION ? 'Bearish' : 'Neutral';
  return {
    status: available ? 'OBSERVATIONAL_ONLY' : 'NEUTRAL_UNAVAILABLE',
    bias,
    applied: false,
    weight: null,
    reasonCode: available ? null : 'D03_UNAVAILABLE'
  };
}

function sourceEvidence(input, observations, alignment) {
  return {
    alignmentStatus: alignment,
    evaluatedAt: iso(input?.evaluatedAt),
    openInterest: {
      source: sourceLabel(input?.openInterestSource, 'CoinGlass') ? input.openInterestSource : null,
      sourceKind: input?.openInterestSourceKind === CORE_V2_D03_OI_SOURCE_KIND
        ? CORE_V2_D03_OI_SOURCE_KIND : null,
      observedAt: iso(input?.openInterestObservedAt),
      windowStart: iso(input?.oiWindowStart),
      windowEnd: iso(input?.oiWindowEnd),
      interval: '4H',
      observationCount: Array.isArray(input?.oiObservations) ? input.oiObservations.length : 0,
      expectedObservationCount: CORE_V2_D03_OI_OBSERVATIONS
    },
    price: {
      source: sourceLabel(input?.priceSource, 'OKX') ? input.priceSource : null,
      sourceKind: input?.priceSourceKind === CORE_V2_D03_PRICE_SOURCE_KIND
        ? CORE_V2_D03_PRICE_SOURCE_KIND : null,
      observedAt: iso(input?.priceObservedAt),
      windowStart: iso(input?.priceWindowStart),
      windowEnd: iso(input?.priceWindowEnd),
      interval: '1D',
      candleStatus: input?.priceCandleStatus === 'CLOSED' ? 'CLOSED' : null
    },
    validatedObservationWindows: observations.length === CORE_V2_D03_OI_OBSERVATIONS &&
      observations.every((item, index) => item.windowStart !== null && item.windowEnd !== null &&
        epoch(item.windowEnd) - epoch(item.windowStart) === FOUR_HOURS_MS &&
        (index === 0 || epoch(item.windowStart) === epoch(observations[index - 1].windowEnd)))
  };
}

export function evaluateCoreV2D03(input = {}) {
  const reasons = [];
  add(reasons, input.openInterestChangePct == null, 'MISSING_OPEN_INTEREST_CHANGE_PCT');
  add(reasons, input.openInterestChangePct != null && !finite(input.openInterestChangePct),
    'INVALID_OPEN_INTEREST_CHANGE_PCT');
  add(reasons, input.priceChangePct == null, 'MISSING_PRICE_CHANGE_PCT');
  add(reasons, input.priceChangePct != null && !finite(input.priceChangePct), 'INVALID_PRICE_CHANGE_PCT');
  sourceReasons(input, reasons);
  timestampReasons(input, reasons);
  const observations = observationReasons(input.oiObservations, reasons);
  const alignment = alignmentStatus(input, observations, reasons);
  freshnessReasons(input, reasons);
  const available = reasons.length === 0;
  const classification = available
    ? classify(input.openInterestChangePct, input.priceChangePct)
    : CORE_V2_D03_CLASSIFICATION.UNAVAILABLE;
  const directionalSignal = classification === CORE_V2_D03_CLASSIFICATION.BULLISH_CONFIRMATION ? 'BULLISH'
    : classification === CORE_V2_D03_CLASSIFICATION.BEARISH_CONFIRMATION ? 'BEARISH' : 'NEUTRAL';
  return deepFreeze({
    contract: 'CORE_V2_D03',
    version: CORE_V2_D03_CONTRACT_VERSION,
    status: available ? EVIDENCE_STATUS.AVAILABLE : EVIDENCE_STATUS.UNAVAILABLE,
    available,
    classification,
    directionalSignal,
    reasonCode: reasons[0] || null,
    reasonCodes: reasons,
    openInterestChangePct: finite(input.openInterestChangePct) ? rounded(input.openInterestChangePct) : null,
    priceChangePct: finite(input.priceChangePct) ? rounded(input.priceChangePct) : null,
    sourceEvidence: sourceEvidence(input, observations, alignment),
    contribution: contribution(classification, available)
  });
}

export function compareV1AndCoreV2D03(v1OiResult, input) {
  return deepFreeze({
    authoritativePath: 'V1',
    v1OiResult: v1OiResult && typeof v1OiResult === 'object' ? structuredClone(v1OiResult) : null,
    v2D03OiResult: evaluateCoreV2D03(input),
    productionBehaviorChanged: false
  });
}

export function measureCoreV2D03Bytes(result) {
  return Buffer.byteLength(JSON.stringify(result), 'utf8');
}
