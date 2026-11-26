import { createHash } from 'node:crypto';

export const CORE_V2_D06_CONTRACT_VERSION = 'core-v2-d06-true-range-v1';
export const CORE_V2_D06_SOURCE_KIND = 'OKX_SWAP_CONFIRMED_DAILY_CANDLES';
export const CORE_V2_D06_ATR_PERIOD = 14;
export const CORE_V2_D06_CANDLE_COUNT = CORE_V2_D06_ATR_PERIOD + 1;

export const CORE_V2_D06_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  INVALID: 'INVALID'
});

const DAY_MS = 24 * 60 * 60 * 1000;
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => timestamp(value) === null ? null : new Date(value).toISOString();
const round = value => Number.isFinite(value) ? Number(value.toPrecision(15)) : null;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function add(reasons, condition, code) {
  if (condition && !reasons.includes(code)) reasons.push(code);
}

function validOhlc(candle) {
  return [candle?.open, candle?.high, candle?.low, candle?.close].every(finitePositive) &&
    candle.low <= Math.min(candle.open, candle.close) &&
    candle.high >= Math.max(candle.open, candle.close) && candle.low <= candle.high;
}

function validateIdentity(input, reasons) {
  add(reasons, !nonempty(input?.canonicalSymbol), 'MISSING_CANONICAL_SYMBOL');
  add(reasons, nonempty(input?.canonicalSymbol) && !/^[A-Z0-9]{1,20}USDT$/.test(input.canonicalSymbol),
    'INVALID_CANONICAL_SYMBOL');
  add(reasons, !nonempty(input?.instId), 'MISSING_INST_ID');
  const expectedInstId = /^[A-Z0-9]{1,20}USDT$/.test(input?.canonicalSymbol || '')
    ? `${input.canonicalSymbol.slice(0, -4)}-USDT-SWAP` : null;
  add(reasons, nonempty(input?.instId) && expectedInstId !== null && input.instId !== expectedInstId,
    'INCOMPATIBLE_INSTRUMENT_IDENTITY');
  add(reasons, input?.instrumentType !== 'SWAP', 'INCOMPATIBLE_INSTRUMENT_TYPE');
  add(reasons, input?.sourceKind !== CORE_V2_D06_SOURCE_KIND, 'INCOMPATIBLE_CANDLE_SOURCE');
  add(reasons, !nonempty(input?.source) || !input.source.startsWith('OKX') || input.source.length > 120,
    'INVALID_CANDLE_SOURCE_IDENTITY');
}

function validateTimes(input, candles, reasons) {
  const evaluatedAt = timestamp(input?.evaluatedAt);
  const sourceObservedAt = timestamp(input?.sourceObservedAt);
  add(reasons, evaluatedAt === null, 'INVALID_EVALUATED_AT');
  add(reasons, sourceObservedAt === null, 'INVALID_SOURCE_OBSERVED_AT');
  add(reasons, evaluatedAt !== null && sourceObservedAt !== null && sourceObservedAt > evaluatedAt,
    'SOURCE_OBSERVED_AT_FUTURE');
  const times = candles.map(candle => timestamp(candle?.timestamp));
  add(reasons, times.some(value => value === null), 'INVALID_CANDLE_TIMESTAMP');
  if (times.some(value => value === null)) return times;
  add(reasons, new Set(times).size !== times.length, 'DUPLICATE_CANDLE_TIMESTAMP');
  add(reasons, times.some((value, index) => index > 0 && value < times[index - 1]), 'OUT_OF_ORDER_CANDLES');
  const orderedUnique = new Set(times).size === times.length &&
    !times.some((value, index) => index > 0 && value < times[index - 1]);
  add(reasons, orderedUnique && times.some((value, index) => index > 0 && value - times[index - 1] !== DAY_MS),
    'CANDLE_GAP');
  add(reasons, evaluatedAt !== null && times.some(value => value > evaluatedAt), 'CANDLE_TIMESTAMP_FUTURE');
  return times;
}

function normalizedSource(input, candles) {
  return {
    version: CORE_V2_D06_CONTRACT_VERSION,
    canonicalSymbol: input.canonicalSymbol,
    instId: input.instId,
    instrumentType: input.instrumentType,
    source: input.source,
    sourceKind: input.sourceKind,
    sourceObservedAt: iso(input.sourceObservedAt),
    evaluatedAt: iso(input.evaluatedAt),
    referencePrice: round(input.referencePrice),
    candles: candles.map(candle => ({
      timestamp: iso(candle.timestamp),
      open: round(candle.open),
      high: round(candle.high),
      low: round(candle.low),
      close: round(candle.close),
      confirmed: candle.confirmed === true
    }))
  };
}

function sourceDigest(input, candles) {
  return createHash('sha256').update(JSON.stringify(normalizedSource(input, candles))).digest('hex');
}

function unavailable(status, reasons, input, candles) {
  const digestReady = candles.length === CORE_V2_D06_CANDLE_COUNT &&
    candles.every(candle => timestamp(candle?.timestamp) !== null && validOhlc(candle));
  return deepFreeze({
    version: CORE_V2_D06_CONTRACT_VERSION,
    status,
    reasonCode: reasons[0] || 'D06_UNAVAILABLE',
    reasonCodes: reasons,
    atr14: null,
    atrPercent: null,
    windowStart: null,
    windowEnd: null,
    candleCount: candles.length,
    gapAffectedCount: null,
    sourceDigest: digestReady ? sourceDigest(input, candles) : null
  });
}

export function evaluateCoreV2D06(input = {}) {
  const reasons = [];
  const candles = Array.isArray(input.candles) ? input.candles : [];
  add(reasons, !Array.isArray(input.candles), 'MISSING_CANDLES');
  add(reasons, candles.length !== CORE_V2_D06_CANDLE_COUNT, 'INVALID_CANDLE_COUNT');
  add(reasons, !finitePositive(input.referencePrice), 'INVALID_REFERENCE_PRICE');
  validateIdentity(input, reasons);
  add(reasons, candles.some(candle => candle?.confirmed !== true), 'UNCONFIRMED_CANDLE');
  add(reasons, candles.some(candle => !validOhlc(candle)), 'INVALID_OHLC');
  add(reasons, candles.slice(0, -1).some(candle => !finitePositive(candle?.close)), 'PREVIOUS_CLOSE_MISSING');
  const times = validateTimes(input, candles, reasons);
  if (reasons.length) {
    const invalidCodes = new Set([
      'INVALID_CANONICAL_SYMBOL', 'INCOMPATIBLE_INSTRUMENT_TYPE', 'INCOMPATIBLE_CANDLE_SOURCE',
      'INCOMPATIBLE_INSTRUMENT_IDENTITY', 'INVALID_CANDLE_SOURCE_IDENTITY',
      'INVALID_EVALUATED_AT', 'INVALID_SOURCE_OBSERVED_AT',
      'SOURCE_OBSERVED_AT_FUTURE', 'INVALID_CANDLE_TIMESTAMP', 'DUPLICATE_CANDLE_TIMESTAMP',
      'OUT_OF_ORDER_CANDLES', 'INVALID_OHLC', 'CANDLE_TIMESTAMP_FUTURE', 'PREVIOUS_CLOSE_MISSING'
    ]);
    const status = reasons.some(code => invalidCodes.has(code))
      ? CORE_V2_D06_STATUS.INVALID : CORE_V2_D06_STATUS.UNAVAILABLE;
    return unavailable(status, reasons, input, candles);
  }

  const trueRanges = [];
  let gapAffectedCount = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    const highLow = candle.high - candle.low;
    const highPreviousClose = Math.abs(candle.high - previousClose);
    const lowPreviousClose = Math.abs(candle.low - previousClose);
    const trueRange = Math.max(highLow, highPreviousClose, lowPreviousClose);
    if (trueRange > highLow) gapAffectedCount += 1;
    trueRanges.push(trueRange);
  }
  const atr14 = trueRanges.reduce((sum, value) => sum + value, 0) / CORE_V2_D06_ATR_PERIOD;
  return deepFreeze({
    version: CORE_V2_D06_CONTRACT_VERSION,
    status: CORE_V2_D06_STATUS.AVAILABLE,
    reasonCode: null,
    reasonCodes: [],
    atr14: round(atr14),
    atrPercent: round(atr14 / input.referencePrice * 100),
    windowStart: new Date(times[0]).toISOString(),
    windowEnd: new Date(times.at(-1) + DAY_MS).toISOString(),
    candleCount: candles.length,
    gapAffectedCount,
    sourceDigest: sourceDigest(input, candles)
  });
}

export function createCoreV2D06InlineEvidence(result) {
  if (result?.version !== CORE_V2_D06_CONTRACT_VERSION ||
      !Object.values(CORE_V2_D06_STATUS).includes(result?.status)) {
    throw new TypeError('Invalid Core v2 D06 result');
  }
  return deepFreeze({
    version: CORE_V2_D06_CONTRACT_VERSION,
    status: result.status,
    reasonCode: result.reasonCode,
    atr14: result.atr14,
    atrPercent: result.atrPercent,
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    candleCount: result.candleCount,
    gapAffectedCount: result.gapAffectedCount,
    sourceDigest: result.sourceDigest
  });
}

export function measureCoreV2D06InlineBytes(result) {
  return Buffer.byteLength(JSON.stringify(createCoreV2D06InlineEvidence(result)), 'utf8');
}
