import { createHash } from 'node:crypto';

// Research-only, pure synchronous API: no filesystem, network, runner or production imports.
// Candle contract: {instrument, openTime, closeTime, open, high, low, close, confirm: 1}.
// Times are integer Unix milliseconds; closeTime is exclusive interval end.
export const HASHES = Object.freeze({
  baseMd: '2306fb61299d8ec61fef8a22293c9c811e0f79d5dc2442d5b14c2a33d595d242',
  baseJson: '76a1876bbc8a73178f2b6b77a41dfa7dd1e98f4878ad48353a5c94bbdea7c17c',
  amendmentMd: '3d4e64c96a13caa13ad6ad7992016eac81f0c796d622453b4f7fa60e2f3b81f3',
  amendmentJson: 'c6d4873b3d1de4b2ac1675126b591079d5b4cffd60f2284bb89b35fa0b09e11b',
});
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
const integer = Number.isSafeInteger;
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
const failure = (status, reason) => freeze({ status, reason, terminal: true, tradingTerminal: false,
  entry: null, exit: null, grossR: null, feeR: null, netR: null, entryFee: null, exitFee: null });
export const STATES = Object.freeze(['WAITING_ENTRY', 'ACTIVE', 'TP', 'STOP', 'TIME_EXIT',
  'UNFILLED', 'INVALIDATED_UNFILLED', 'DATA_UNAVAILABLE', 'INTEGRITY_FAILURE', 'SPECIFICATION_FAILURE']);

/* Finite event table, evaluated in this priority order (both directions):
 * Missing/invalid required candle -> DATA_UNAVAILABLE; no fees/results fabricated.
 * BASELINE waiting: Open outside/equal either barrier -> INVALIDATED_UNFILLED (0 fees).
 * Otherwise fill at Open (entry fee), then ACTIVE intrabar on SAME candle.
 * ALTERNATIVE waiting, entry-eligible only:
 *   Open at/beyond either barrier -> INVALIDATED_UNFILLED (0 fees).
 *   Open inside barriers and d*(Open-EL)<=0 -> fill at EL (entry fee), ACTIVE intrabar.
 *   Remaining intrabar S/T/EL bits:
 *     000 -> WAITING; 001 (EL only) -> fill EL, ACTIVE (no barrier present);
 *     010,011,100,101,110,111 -> INVALIDATED_UNFILLED (any barrier; 0 fees).
 *   S-only is geometrically unreachable from nonmarketable inside-barrier Open
 *   without EL crossing for valid OHLC; same defensive barrier rule covers it.
 * ACTIVE carried into candle: adverse Open -> STOP at Open; target Open -> TP at T.
 * ACTIVE intrabar, including proven open-fill: S touch -> STOP at S (even with T);
 *   otherwise T touch -> TP at T; otherwise ACTIVE.
 * Every executed terminal exit charges exit fee. No favorable target/fill improvement.
 * End of final eligible entry candle, still waiting -> UNFILLED (0 fees).
 * End of final horizon candle, still active -> TIME_EXIT at Close (exit fee).
 * Terminal states are absorbing. No partial boundary candles; no future order resolution.
 */
export function createEngine(documents) {
  for (const [key, expected] of Object.entries(HASHES)) {
    const raw = documents?.[key];
    if (typeof raw !== 'string' || createHash('sha256').update(raw).digest('hex') !== expected)
      throw new Error(`PROTOCOL_HASH_MISMATCH:${key}`);
  }
  const cfg = JSON.parse(documents.baseJson);
  const amendment = JSON.parse(documents.amendmentJson);
  const owned = new WeakSet();
  const identity = freeze({ protocol: cfg.protocolVersion, amendment: amendment.protocolVersion, hashes: { ...HASHES } });
  const observationOK = t => integer(t) && t % DAY === 17 * HOUR;
  function candleOK(c, instrument, step, shift = 0) {
    return c && c.instrument === instrument && integer(c.openTime) && integer(c.closeTime) &&
      (c.openTime - shift) % step === 0 && c.closeTime - c.openTime === step && c.confirm === 1 &&
      [c.open,c.high,c.low,c.close].every(positive) &&
      c.low <= Math.min(c.open,c.close) && c.high >= Math.max(c.open,c.close) && c.low <= c.high;
  }
  // Never silently sort/deduplicate. Rows outside the evaluated window cannot fill a gap.
  function index(rows) {
    if (!Array.isArray(rows)) return null;
    const map = new Map(); let previous = -Infinity;
    for (const c of rows) {
      if (!c || !integer(c.openTime) || c.openTime <= previous) return null;
      previous = c.openTime; map.set(c.openTime,c);
    }
    return map;
  }
  function deriveSetup({ instrument, observationAt, referenceCandles, dailyCandles } = {}) {
    if (!cfg.universe.instruments.includes(instrument) || !observationOK(observationAt))
      return failure('INTEGRITY_FAILURE','INVALID_EPISODE');
    const refs = index(referenceCandles), days = index(dailyCandles);
    if (!refs || !days) return failure('DATA_UNAVAILABLE','CONTEXT_ORDER_OR_DUPLICATE');
    const reference = refs.get(observationAt - MIN);
    if (!candleOK(reference,instrument,MIN)) return failure('DATA_UNAVAILABLE','REFERENCE_CANDLE');
    const lastClose = Math.floor((observationAt - 16*HOUR)/DAY)*DAY + 16*HOUR;
    const selected = [];
    for (let t=lastClose-14*DAY;t<lastClose;t+=DAY) {
      const c=days.get(t);
      if (!candleOK(c,instrument,DAY,16*HOUR)) return failure('DATA_UNAVAILABLE','ATR_CONTEXT');
      selected.push(c);
    }
    const A=selected.reduce((n,c)=>n+(c.high-c.low)/14,0);
    if (!positive(A)) return failure('INTEGRITY_FAILURE','INVALID_ATR');
    return freeze({status:'READY', P0:reference.close,A,provenance:{
      reference:{...reference},daily:selected.map(c=>({...c})), cutoff:observationAt}});
  }
  // Given P0/A contract for synthetic/preregistered caller. deriveSetup provides candle provenance.
  function buildPlan({episodeId,instrument,observationAt,direction,P0,A} = {}) {
    if (typeof episodeId !== 'string' || !episodeId || !cfg.universe.instruments.includes(instrument) ||
        !observationOK(observationAt) || !['LONG','SHORT'].includes(direction) || !positive(P0) || !positive(A))
      return failure('INTEGRITY_FAILURE','INVALID_PLAN_INPUT');
    const d=direction==='LONG'?1:-1, S=P0-d*A, T=P0+d*A, EL=P0-d*.25*A;
    if (![S,T,EL].every(positive) || !(d*(EL-S)>0 && d*(T-EL)>0) ||
        !positive(Math.abs(EL-S))) return failure('INTEGRITY_FAILURE','INVALID_GEOMETRY');
    const plan=freeze({status:'READY',identity,episodeId,instrument,observationAt,direction,d,P0,A,S,T,EL,
      firstExecutionOpen:observationAt,entryExpiry:observationAt+4*HOUR,horizon:observationAt+12*HOUR,feeRate:.0005});
    owned.add(plan); return plan;
  }
  function execute(plan, candles, variant='BASELINE') {
    if (!['BASELINE','ALTERNATIVE','IDENTITY'].includes(variant)) return failure('SPECIFICATION_FAILURE','UNKNOWN_VARIANT');
    if (!owned.has(plan)) return failure('INTEGRITY_FAILURE','UNVERIFIED_PLAN');
    const map=index(candles);
    if (!map) return failure('DATA_UNAVAILABLE','CANDLE_ORDER_OR_DUPLICATE');
    const {S,T,EL,d,observationAt,entryExpiry,horizon,feeRate,instrument}=plan;
    let state='WAITING_ENTRY',entry=null,fillCandleOpen=null,fillPhase=null;
    const trace=[{state,at:observationAt,phase:'INITIAL'}];
    function fill(price,t,phase) {
      if (!positive(Math.abs(price-S))) return false;
      entry=price;fillCandleOpen=t;fillPhase=phase;state='ACTIVE';
      trace.push({state,at:t,phase,entry:price});return true;
    }
    function finish(status,price,t,phase) {
      const zero=['UNFILLED','INVALIDATED_UNFILLED'].includes(status);
      const risk=zero?null:Math.abs(entry-S);
      if (!zero && !positive(risk)) return failure('INTEGRITY_FAILURE','INVALID_INITIAL_RISK');
      const grossR=zero?0:d*(price-entry)/risk;
      const entryFee=zero?0:feeRate*entry, exitFee=zero?0:feeRate*price;
      const feeR=zero?0:(entryFee+exitFee)/risk,netR=grossR-feeR;
      if (![grossR,entryFee,exitFee,feeR,netR].every(Number.isFinite)) return failure('INTEGRITY_FAILURE','NONFINITE_ACCOUNTING');
      return freeze({identity,episodeId:plan.episodeId,direction:plan.direction,variant,status,terminal:true,tradingTerminal:!zero,
        entry,exit:price,initialRisk:risk,grossR,entryFee,exitFee,feeR,netR,fillCandleOpen,fillPhase,
        exitCandleOpen:phase==='EXPIRY'?null:t,exitPhase:phase,
        trace:[...trace,{state:status,at:t,phase}]});
    }
    for (let t=observationAt;t+MIN<=horizon;t+=MIN) {
      if (state==='WAITING_ENTRY' && variant==='ALTERNATIVE' && t+MIN>entryExpiry)
        return finish('UNFILLED',null,entryExpiry,'EXPIRY');
      const c=map.get(t);
      if (!candleOK(c,instrument,MIN)) return failure('DATA_UNAVAILABLE',`REQUIRED_CANDLE:${t}`);
      const stopTouch=d===1?c.low<=S:c.high>=S;
      const targetTouch=d===1?c.high>=T:c.low<=T;
      if (state==='ACTIVE') {
        if (d*(c.open-S)<=0) return finish('STOP',c.open,t,'OPEN');
        if (d*(c.open-T)>=0) return finish('TP',T,t,'OPEN');
      } else {
        if (d*(c.open-S)<=0 || d*(c.open-T)>=0)
          return finish('INVALIDATED_UNFILLED',null,t,'OPEN');
        if (variant!=='ALTERNATIVE' || d*(c.open-EL)<=0) {
          if (!fill(variant==='ALTERNATIVE'?EL:c.open,t,'OPEN')) return failure('INTEGRITY_FAILURE','INVALID_INITIAL_RISK');
        } else {
          if (stopTouch || targetTouch) return finish('INVALIDATED_UNFILLED',null,t,'INTRABAR');
          const limitTouch=d===1?c.low<=EL:c.high>=EL;
          if (limitTouch && !fill(EL,t,'INTRABAR')) return failure('INTEGRITY_FAILURE','INVALID_INITIAL_RISK');
          // EL-only has no same-candle terminal barrier. Do not replay Open as a later event.
        }
      }
      if (state==='ACTIVE') {
        if (stopTouch) return finish('STOP',S,t,'INTRABAR');
        if (targetTouch) return finish('TP',T,t,'INTRABAR');
        if (t+MIN===horizon) return finish('TIME_EXIT',c.close,t,'CLOSE');
      }
    }
    return failure('SPECIFICATION_FAILURE','NONTERMINAL_AT_HORIZON');
  }
  function identityControl(plan,candles) {
    const baseline=execute(plan,candles,'BASELINE'),identityResult=execute(plan,candles,'IDENTITY');
    const keys=['status','entry','exit','grossR','netR','feeR'];
    const matches=keys.every(k=>Object.is(baseline[k],identityResult[k]));
    return freeze({baseline,identity:identityResult,matches,identityDelta:matches && Number.isFinite(baseline.netR)?0:null});
  }
  return Object.freeze({buildPlan,deriveSetup,execute,identityControl});
}
