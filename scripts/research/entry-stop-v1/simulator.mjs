import { createHash } from 'node:crypto';

export const CONFIG_SHA = '0f14306352dd30abe08bbafc7b87058dd52dbb4b300faa5196d7146676c614c1';
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => finite(x) && x > 0;
const clone = x => JSON.parse(JSON.stringify(x));
function canonical(x) {
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
  if (finite(x)) return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x && Object.getPrototypeOf(x) === Object.prototype) {
    return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  }
  throw new Error('NON_JSON_CONFIG');
}
export function configHash(config) {
  return createHash('sha256').update(canonical(config)).digest('hex');
}
function time(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(s)) return null;
  const t = Date.parse(s);
  if (!Number.isSafeInteger(t)) return null;
  // Reject Date.parse normalization of impossible calendar dates.
  return new Date(t).toISOString().slice(0, 19) === s.slice(0, 19) ? t : null;
}
function freeze(x) {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
}
function validCandle(c, step, shift, instrument) {
  return c && Number.isSafeInteger(c.timestamp) && (c.timestamp - shift) % step === 0 &&
    c.instId === instrument && c.confirmed === true &&
    [c.open, c.high, c.low, c.close].every(positive) &&
    c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high);
}
// Do not sort away duplicate/disordered input. Flag affected timestamps; later
// bad data do not invalidate an outcome already established before those rows.
function indexCandles(rows, start, end) {
  if (!Array.isArray(rows)) return { fatal: true };
  const map = new Map(), bad = new Set(); let previous = null;
  for (const c of rows) {
    if (!Number.isSafeInteger(c?.timestamp)) return { fatal: true };
    const t = c.timestamp;
    if (t < start || t > end) continue;
    if (map.has(t)) bad.add(t);
    if (previous !== null && t < previous) { bad.add(t); bad.add(previous); }
    previous = t; map.set(t, c);
  }
  return { map, bad, fatal: false };
}
function closedContext(rows, cutoff, count, step, shift, instrument) {
  const last = Math.floor((cutoff - shift) / step) * step + shift - step;
  const first = last - (count - 1) * step;
  const idx = indexCandles(rows, first, last), selected = [];
  if (idx.fatal) return null;
  for (let t = first; t <= last; t += step) {
    const c = idx.map.get(t);
    if (idx.bad.has(t) || !validCandle(c, step, shift, instrument)) return null;
    selected.push(c);
  }
  return selected;
}

// No filesystem, network, historical runner or parameter override interface.
// Candle schema: {instId,timestamp(open ms),open,high,low,close,confirmed:boolean}.
export function createSimulator(suppliedConfig) {
  if (configHash(suppliedConfig) !== CONFIG_SHA) throw new Error('PROTOCOL_CONFIG_HASH_MISMATCH');
  const cfg = freeze(clone(suppliedConfig));
  const identity = { protocolVersion: cfg.protocolVersion, configSHA: CONFIG_SHA };
  function bounds(signal) {
    const cutoff = time(signal?.origin?.detectedAt);
    if (cutoff === null || cutoff !== time(signal?.initialPlan?.createdAt)) return null;
    return { cutoff, firstEligibleMinute: (Math.floor(cutoff / MINUTE) + 1) * MINUTE,
      expiry: cutoff + cfg.execution.entryExpiryHours * HOUR,
      horizon: cutoff + cfg.execution.horizonHours * HOUR };
  }
  function buildPlans({ signal, daily, hourly }) {
    const b = bounds(signal), d = cfg.geometry.d[signal?.origin?.direction];
    const instrument = signal?.instId;
    const base = { ...identity, tradeId: signal?.tradeId ?? null, bounds: b };
    const unavailable = status => Object.fromEntries(Object.keys(cfg.variants).map(variant =>
      [variant, { ...base, variant, status }]));
    if (!b || !['Long', 'Short'].includes(signal?.origin?.direction) ||
        typeof instrument !== 'string' || !/^[A-Z0-9-]+-USDT-SWAP$/.test(instrument) ||
        signal?.instrumentType !== 'SWAP') return unavailable('DATA_UNAVAILABLE');
    const days = closedContext(daily, b.cutoff, cfg.atr.bars, DAY, 16 * HOUR, instrument);
    if (!days) return unavailable('ATR_UNAVAILABLE');
    const atr = days.reduce((n, c) => n + c.high - c.low, 0) / cfg.atr.bars;
    if (!positive(atr)) return unavailable('ATR_UNAVAILABLE');
    const e0 = signal.initialPlan.entryPrice, s0 = signal.initialPlan.initialStopLoss;
    if (![e0, s0].every(positive) || d * (e0 - s0) <= 0) return unavailable('GEOMETRY_UNAVAILABLE');
    const e1 = e0 - d * cfg.geometry.alpha * Math.abs(e0 - s0);
    const hours = closedContext(hourly, b.cutoff, cfg.geometry.structuralBars, HOUR, 0, instrument);
    const structuralStop = !hours ? null : d === 1
      ? Math.min(...hours.map(c => c.low)) - cfg.geometry.bufferATR * atr
      : Math.max(...hours.map(c => c.high)) + cfg.geometry.bufferATR * atr;
    const plans = {};
    for (const variant of Object.keys(cfg.variants)) {
      const structural = variant === 'V2' || variant === 'V3';
      const entry = variant === 'V1' || variant === 'V3' ? e1 : e0;
      const stop = structural ? structuralStop : s0;
      const tp = entry + d * cfg.geometry.targetATR * atr;
      const status = structural && (!positive(stop) || d * (e0 - stop) <= 0 || d * (entry - stop) <= 0)
        ? 'STRUCTURE_UNAVAILABLE'
        : ![entry, stop, tp].every(positive) || d * (entry - stop) <= 0 || d * (tp - entry) <= 0
          ? 'GEOMETRY_UNAVAILABLE' : 'READY';
      plans[variant] = { ...base, variant, status, instId: instrument, direction: signal.origin.direction,
        entry, stop, tp, initialRiskPrice: stop === null ? null : Math.abs(entry - stop), atr,
        originalTP1: finite(signal.initialPlan.takeProfit1) ? signal.initialPlan.takeProfit1 : null };
    }
    return plans;
  }
  function simulate({ signal, daily, hourly, minutes, variant }) {
    if (!Object.hasOwn(cfg.variants, variant)) throw new Error('UNKNOWN_VARIANT');
    const plan = buildPlans({ signal, daily, hourly })[variant];
    let filledAt = null;
    function result(status, at = null, exitPrice = null, reason = null) {
      const resolved = status === 'TP' || status === 'STOP';
      const zero = status === 'UNFILLED' || status === 'INVALIDATED_UNFILLED';
      const d = plan.direction === 'Long' ? 1 : -1;
      const grossR = resolved ? d * (exitPrice - plan.entry) / plan.initialRiskPrice : zero ? 0 : null;
      const entryFeeUsd = resolved ? Math.abs(plan.entry) * cfg.fees.entryRate : zero ? 0 : null;
      const exitFeeUsd = resolved ? Math.abs(exitPrice) * cfg.fees.exitRate : zero ? 0 : null;
      const feeR = resolved ? (entryFeeUsd + exitFeeUsd) / plan.initialRiskPrice : zero ? 0 : null;
      return { ...identity, tradeId: plan.tradeId, variant, status, reason, plan, filledAt,
        completedAt: resolved || zero ? at : null, checkedThrough: at, exitPrice,
        grossR, entryFeeUsd, exitFeeUsd, feeR, netR: grossR === null ? null : grossR - feeR };
    }
    if (plan.status !== 'READY') return result(plan.status);
    const { firstEligibleMinute: first, expiry, horizon } = plan.bounds;
    const idx = indexCandles(minutes, first, Math.floor(horizon / MINUTE) * MINUTE - MINUTE);
    if (idx.fatal) return result('DATA_UNAVAILABLE', null, null, 'INVALID_CANDLE_TIMESTAMP_OR_ARRAY');
    const d = plan.direction === 'Long' ? 1 : -1;
    for (let t = first; t + MINUTE <= horizon; t += MINUTE) {
      if (filledAt === null && t + MINUTE > expiry) {
        return expiry % MINUTE === 0 ? result('UNFILLED', expiry)
          : result('DATA_UNAVAILABLE', t, null, 'PARTIAL_EXPIRY_MINUTE');
      }
      const c = idx.map.get(t), end = t + MINUTE;
      if (idx.bad.has(t) || !validCandle(c, MINUTE, 0, plan.instId)) {
        return result('DATA_UNAVAILABLE', t, null, 'MISSING_DUPLICATE_DISORDERED_OR_INVALID_CANDLE');
      }
      const entryTouch = c.low <= plan.entry && c.high >= plan.entry;
      const stopTouch = d === 1 ? c.low <= plan.stop : c.high >= plan.stop;
      const tpTouch = d === 1 ? c.high >= plan.tp : c.low <= plan.tp;
      if (filledAt === null) {
        if (!entryTouch) {
          // Without any Entry in this minute, a stop-side observation invalidates
          // the still-unfilled order; never invent a fill in an inter-minute gap.
          if (stopTouch) return result('INVALIDATED_UNFILLED', end);
          if (d * (c.open - plan.entry) < 0) return result('AMBIGUOUS_ENTRY', end);
          continue;
        }
        if (c.open !== plan.entry && (stopTouch || tpTouch)) return result('AMBIGUOUS', end, null, 'ENTRY_EXIT_ORDER_UNKNOWN');
        filledAt = t; // Minute precision; not a claim of exact intraminute fill.
        if (c.open !== plan.entry) continue;
      }
      // Established active position, or provable fill at this minute's open.
      if (d * (c.open - plan.stop) <= 0) return result('STOP', t, c.open);
      if (d * (c.open - plan.tp) >= 0) return result('TP', t, plan.tp);
      if (stopTouch && tpTouch) return result('AMBIGUOUS', end, null, 'SL_TP_ORDER_UNKNOWN');
      if (stopTouch) return result('STOP', end, plan.stop);
      if (tpTouch) return result('TP', end, plan.tp);
    }
    if (filledAt !== null) return result('UNRESOLVED_OPEN', Math.floor(horizon / MINUTE) * MINUTE);
    return result('DATA_UNAVAILABLE', null, null, 'INCOMPLETE_ENTRY_WINDOW');
  }
  function sampleControlTimes(candidateTimes) {
    if (!Array.isArray(candidateTimes) || candidateTimes.some(t => !Number.isSafeInteger(t) || t % MINUTE !== 0)) {
      throw new Error('INVALID_CANDIDATE_TIMES');
    }
    const times = [...new Set(candidateTimes)].sort((a, b) => a - b);
    if (!times.length) return { ...identity, status: 'DATA_UNAVAILABLE', samples: [] };
    let state = cfg.randomControl.seed >>> 0;
    const samples = Array.from({ length: cfg.randomControl.samplesPerEligibleSignal }, () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return times[Math.floor(state / 4294967296 * times.length)];
    });
    return { ...identity, status: 'READY', samples }; // With replacement; no outcome/data-dependent redraw.
  }
  return Object.freeze({ buildPlans, simulate, sampleControlTimes, identity: Object.freeze(identity) });
}
