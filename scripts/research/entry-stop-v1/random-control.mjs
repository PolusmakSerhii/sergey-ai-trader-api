import { createSimulator } from './simulator.mjs';

const MINUTE = 60_000;
const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;

// Equivalent to the frozen simulator's private candle validation/indexing.
// No sorting away defects and no validation-driven sampling filter.
function valid(c, instId) {
  return c && Number.isSafeInteger(c.timestamp) && c.timestamp % MINUTE === 0 &&
    c.instId === instId && c.confirmed === true &&
    [c.open, c.high, c.low, c.close].every(positive) &&
    c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high);
}
function index(rows, start, end) {
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

// Pure research control, not V4. No I/O, archive runner, parameter overrides,
// time shifting, new RNG or changes to the frozen simulator.
export function createRandomControl(config) {
  const simulator = createSimulator(config); // Enforces the frozen canonical SHA.
  const identity = { ...simulator.identity, control: 'RANDOM_ENTRY_SANITY_CONTROL' };
  const entryRate = config.fees.entryRate, exitRate = config.fees.exitRate;

  function prepare({ signal, daily }) {
    // Only the original V0 is used. No hourly data or structure is requested.
    const originalPlan = simulator.buildPlans({ signal, daily, hourly: [] }).V0;
    const schedule = [];
    if (originalPlan.status === 'READY') {
      const b = originalPlan.bounds;
      for (let t = b.firstEligibleMinute; t + MINUTE <= b.expiry && t + MINUTE <= b.horizon; t += MINUTE) schedule.push(t);
    }
    return { ...identity, eligible: originalPlan.status === 'READY',
      status: originalPlan.status, originalPlan, schedule };
  }

  function execute(prepared, minutes, selectedAt, sampleIndex) {
    const original = prepared.originalPlan;
    const d = original.direction === 'Long' ? 1 : -1;
    const bounds = original.bounds;
    let plan = null, filledAt = null, selectedEntryValid = false;
    function finish(status, at = null, exitPrice = null, reason = null) {
      const resolved = status === 'TP' || status === 'STOP';
      const grossR = resolved ? d * (exitPrice - plan.entry) / plan.initialRiskPrice : null;
      const entryFeeUsd = resolved ? Math.abs(plan.entry) * entryRate : null;
      const exitFeeUsd = resolved ? Math.abs(exitPrice) * exitRate : null;
      const feeR = resolved ? (entryFeeUsd + exitFeeUsd) / plan.initialRiskPrice : null;
      return { ...identity, tradeId: original.tradeId, sampleIndex, selectedAt,
        originalCutoff: bounds?.cutoff ?? null, originalHorizon: bounds?.horizon ?? null,
        originalPlan: original, plan, selectedEntryValid, status, reason, filledAt,
        entryExecutionPrice: filledAt === null ? null : plan.entry,
        completedAt: resolved ? at : null, checkedThrough: at, exitPrice,
        grossR, entryFeeUsd, exitFeeUsd, feeR, netR: resolved ? grossR - feeR : null };
    }
    if (!prepared.eligible) return finish(original.status);
    if (!prepared.schedule.includes(selectedAt)) throw new Error('SELECTED_TIME_OUTSIDE_FROZEN_SCHEDULE');
    const idx = index(minutes, selectedAt, Math.floor(bounds.horizon / MINUTE) * MINUTE - MINUTE);
    if (idx.fatal) return finish('DATA_UNAVAILABLE', null, null, 'INVALID_CANDLE_TIMESTAMP_OR_ARRAY');
    const selected = idx.map.get(selectedAt);
    if (idx.bad.has(selectedAt) || !valid(selected, original.instId)) {
      return finish('DATA_UNAVAILABLE', selectedAt, null, 'SELECTED_ENTRY_DATA_UNAVAILABLE');
    }
    selectedEntryValid = true;
    const entry = selected.open;
    const stopDistance = Math.abs(original.entry - original.stop);
    const tpDistance = Math.abs(original.tp - original.entry);
    const stop = entry - d * stopDistance, tp = entry + d * tpDistance;
    plan = { instId: original.instId, direction: original.direction, entry, stop, tp,
      initialRiskPrice: Math.abs(entry - stop), atr: original.atr, bounds: { ...bounds } };
    if (![entry, stop, tp].every(positive) || d * (entry - stop) <= 0 || d * (tp - entry) <= 0) {
      return finish('GEOMETRY_UNAVAILABLE', selectedAt, null, 'INVALID_TRANSLATED_GEOMETRY');
    }
    filledAt = selectedAt; // Immediate open entry, not a second limit order.
    for (let t = selectedAt; t + MINUTE <= bounds.horizon; t += MINUTE) {
      const c = idx.map.get(t), end = t + MINUTE;
      if (idx.bad.has(t) || !valid(c, original.instId)) {
        return finish('DATA_UNAVAILABLE', t, null, 'MISSING_DUPLICATE_DISORDERED_OR_INVALID_CANDLE');
      }
      const stopTouch = d === 1 ? c.low <= stop : c.high >= stop;
      const tpTouch = d === 1 ? c.high >= tp : c.low <= tp;
      // Deliberately equivalent to simulator.mjs's private post-fill branch.
      // Entry-at-open makes this valid for the selected candle too.
      if (d * (c.open - stop) <= 0) return finish('STOP', t, c.open);
      if (d * (c.open - tp) >= 0) return finish('TP', t, tp);
      if (stopTouch && tpTouch) return finish('AMBIGUOUS', end, null, 'SL_TP_ORDER_UNKNOWN');
      if (stopTouch) return finish('STOP', end, stop);
      if (tpTouch) return finish('TP', end, tp);
    }
    return finish('UNRESOLVED_OPEN', Math.floor(bounds.horizon / MINUTE) * MINUTE);
  }

  // Explicit single-sample execution for fixtures; no retry/redraw within it.
  function executeSample({ signal, daily, minutes, selectedAt }) {
    return execute(prepare({ signal, daily }), minutes, selectedAt, null);
  }

  function run({ signal, daily, minutes }) {
    const prepared = prepare({ signal, daily });
    // Select from the COMPLETE schedule before reading any minute candle.
    const selectedTimes = prepared.eligible ? simulator.sampleControlTimes(prepared.schedule).samples : [];
    const samples = selectedTimes.map((t, i) => execute(prepared, minutes, t, i));
    const classifications = {};
    for (const sample of samples) classifications[sample.status] = (classifications[sample.status] || 0) + 1;
    return { ...identity, tradeId: prepared.originalPlan.tradeId,
      eligible: prepared.eligible, status: prepared.status, originalPlan: prepared.originalPlan,
      schedule: prepared.schedule, selectedTimes, samples,
      counts: { totalScheduledSamples: samples.length,
        validSelectedEntryCandles: samples.filter(s => s.selectedEntryValid).length,
        dataUnavailable: classifications.DATA_UNAVAILABLE || 0,
        ambiguous: classifications.AMBIGUOUS || 0,
        unresolvedOpen: classifications.UNRESOLVED_OPEN || 0,
        resolvedNumeric: samples.filter(s => s.grossR !== null).length,
        classifications } };
  }
  return Object.freeze({ prepare, executeSample, run, identity: Object.freeze(identity) });
}
