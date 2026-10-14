// Pure Forward overlay only. No Core imports, I/O, clock, or producer-completeness inference.
export const STATES = Object.freeze([
  'DETECTED', 'WAITING_ENTRY', 'UNRESOLVED_VERIFICATION', 'ADMITTED',
  'SKIPPED_MISSED_ENTRY', 'SKIPPED_CAPACITY', 'SKIPPED_DATA_FAILURE', 'COMPLETED'
]);
export const LIMITS = Object.freeze({ total: 3, sameDirection: 2, perInstrument: 1 });
const MINUTE = 60000;
const copy = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const requireFact = (ok, message) => { if (!ok) fail(message); };
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
// Explicit epoch milliseconds or canonical UTC ISO; no local timezone or fallback.
function timestamp(value) {
  const n = typeof value === 'number' ? value :
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      ? Date.parse(value) : NaN;
  requireFact(Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000, 'INVALID_TIMESTAMP');
  if (typeof value === 'string') requireFact(new Date(n).toISOString() === value, 'INVALID_TIMESTAMP');
  return n;
}
function minuteTime(value) {
  const n = timestamp(value);
  requireFact(n % MINUTE === 0, 'INVALID_MINUTE');
  return n;
}
function identity(record) {
  requireFact(record && text(record.tradeId) && text(record.instrument) &&
    ['Long', 'Short'].includes(record.direction), 'INVALID_IDENTITY');
}
function lexical(a, b) {
  // Unicode code-point ordering, including non-BMP IDs; never localeCompare.
  const x = Array.from(a, c => c.codePointAt(0)), y = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
function candidateKey(record) {
  identity(record);
  const event = minuteTime(record.eligibleEntryCandle?.timestamp);
  const detected = timestamp(record.origin?.detectedAt);
  requireFact(detected <= event, 'ENTRY_PRECEDES_ORIGIN');
  return [event, detected, record.tradeId];
}
export function compareCandidates(a, b) {
  const x = candidateKey(a), y = candidateKey(b);
  return x[0] - y[0] || x[1] - y[1] || lexical(x[2], y[2]);
}
function disposition(record) {
  identity(record);
  requireFact(STATES.includes(record.state), 'INVALID_STATE');
  const prior = record.state === 'UNRESOLVED_VERIFICATION' ? record.priorDisposition : record.state;
  requireFact(['DETECTED', 'WAITING_ENTRY', 'ADMITTED'].includes(prior), 'IMMUTABLE_OR_RESERVED_STATE');
  requireFact(record.capacityOccupied === (prior === 'ADMITTED'), 'INVALID_OCCUPANCY');
  return prior;
}
function validateOccupancy(rows) {
  requireFact(Array.isArray(rows), 'INVALID_OCCUPANCY');
  const ids = new Set();
  for (const r of rows) {
    identity(r);
    requireFact(!ids.has(r.tradeId), 'DUPLICATE_IDENTITY'); ids.add(r.tradeId);
    requireFact(r.capacityOccupied === true && (r.state === 'ADMITTED' ||
      (r.state === 'UNRESOLVED_VERIFICATION' && r.priorDisposition === 'ADMITTED') ||
      r.state === 'COMPLETED'), 'INVALID_OCCUPANCY');
    if (r.state === 'COMPLETED') validateRelease(r.terminalEvidence);
  }
  requireFact(rows.length <= LIMITS.total &&
    ['Long', 'Short'].every(d => rows.filter(r => r.direction === d).length <= LIMITS.sameDirection) &&
    rows.every(r => rows.filter(x => x.instrument === r.instrument).length <= LIMITS.perInstrument),
    'OCCUPANCY_ALREADY_EXCEEDS_LIMIT');
}
export function checkCapacity(occupancy, candidate) {
  validateOccupancy(occupancy); identity(candidate);
  requireFact(!occupancy.some(r => r.tradeId === candidate.tradeId), 'DUPLICATE_IDENTITY');
  const reasons = [];
  if (occupancy.length >= LIMITS.total) reasons.push('MAX_TOTAL');
  if (occupancy.filter(r => r.direction === candidate.direction).length >= LIMITS.sameDirection) reasons.push('MAX_SAME_DIRECTION');
  if (occupancy.some(r => r.instrument === candidate.instrument)) reasons.push('MAX_PER_INSTRUMENT');
  return { allowed: reasons.length === 0, reasons };
}
function validateRelease(evidence) {
  requireFact(evidence?.confirmed === true &&
    ['Stopped', 'Closed', 'TP3Hit', 'TP1Hit'].includes(evidence.status), 'UNCONFIRMED_TERMINAL');
  const candle = minuteTime(evidence.terminalCandleTimestamp);
  const release = minuteTime(evidence.releaseAvailableAt);
  requireFact(release === candle + MINUTE, 'INVALID_RELEASE_TIMING');
  return release;
}
// Releases are explicit confirmed Core facts. They must identify an occupied record.
// All validation precedes decisions. Any bad batch returns no partial finalization.
export function reduceMinute({ minute, candidates, occupancy, releases = [], boundaryProof } = {}) {
  const unchanged = Array.isArray(occupancy) ? copy(occupancy).sort((a, b) =>
    lexical(String(a?.tradeId), String(b?.tradeId))) : [];
  try {
    const T = minuteTime(minute);
    requireFact(Array.isArray(candidates), 'INVALID_CANDIDATES');
    validateOccupancy(occupancy);
    const ids = new Set(occupancy.map(r => r.tradeId));
    for (const r of candidates) {
      requireFact(disposition(r) === 'WAITING_ENTRY', 'CANDIDATE_NOT_WAITING');
      requireFact(candidateKey(r)[0] === T && r.eligibleEntryCandle.confirmed === true &&
        r.eligibleEntryCandle.verified === true && r.eligibleEntryCandle.firstEligible === true,
        'UNVERIFIED_FIRST_ENTRY');
      requireFact(!ids.has(r.tradeId), 'DUPLICATE_IDENTITY'); ids.add(r.tradeId);
    }
    requireFact(Array.isArray(releases), 'INVALID_RELEASES');
    const releaseIds = new Set();
    for (const e of releases) {
      requireFact(e && text(e.tradeId) && !releaseIds.has(e.tradeId), 'INVALID_OR_DUPLICATE_RELEASE');
      releaseIds.add(e.tradeId);
      const r = occupancy.find(x => x.tradeId === e.tradeId);
      requireFact(r, 'RELEASE_WITHOUT_OCCUPANCY');
      validateRelease(e);
      if (r.state === 'COMPLETED') requireFact(
        timestamp(r.terminalEvidence.releaseAvailableAt) === timestamp(e.releaseAvailableAt) &&
        r.terminalEvidence.status === e.status, 'CONFLICTING_TERMINAL_EVIDENCE');
    }
    requireFact(boundaryProof && minuteTime(boundaryProof.minute) === T &&
      boundaryProof.sealed === true && boundaryProof.unresolvedEarlier === false &&
      boundaryProof.competingCandidatesComplete === true, 'BOUNDARY_NOT_PROVEN');
    // Never apply a future terminal result to ordering; only its release boundary matters.
    const releasable = new Set(releases.filter(e => timestamp(e.releaseAvailableAt) <= T).map(e => e.tradeId));
    const next = copy(occupancy).filter(r => !releasable.has(r.tradeId));
    const decisions = [];
    for (const r of [...candidates].sort(compareCandidates)) {
      const capacity = checkCapacity(next, r);
      const decision = {
        tradeId: r.tradeId, minute: T,
        state: capacity.allowed ? 'ADMITTED' : 'SKIPPED_CAPACITY',
        final: true, reasons: capacity.reasons,
        record: { ...copy(r), state: capacity.allowed ? 'ADMITTED' : 'SKIPPED_CAPACITY',
          priorDisposition: null, capacityOccupied: capacity.allowed,
          admissionDecision: { minute: T, allowed: capacity.allowed, reasons: [...capacity.reasons] },
          skipReason: capacity.allowed ? null : 'RISK/CAPACITY LIMIT' }
      };
      decisions.push(decision);
      if (capacity.allowed) next.push(copy(decision.record));
    }
    return { minute: T, decisions, nextOccupancy: next.sort((a, b) => lexical(a.tradeId, b.tradeId)), blockers: [] };
  } catch (error) {
    return { minute, decisions: [], nextOccupancy: unchanged, blockers: [error.message] };
  }
}
export function markVerificationGap(record, { reason, progress, evidence } = {}) {
  const prior = disposition(record);
  requireFact(text(reason), 'MISSING_VERIFICATION_REASON');
  return { ...copy(record), state: 'UNRESOLVED_VERIFICATION', priorDisposition: prior,
    verification: { ...(copy(record.verification) || {}), status: 'UNRESOLVED', reason,
      ...(progress !== undefined ? { progress: copy(progress) } : {}),
      ...(evidence !== undefined ? { evidence: copy(evidence) } : {}) } };
}
export function restoreVerification(record, proof) {
  const prior = disposition(record);
  requireFact(record.state === 'UNRESOLVED_VERIFICATION' && proof?.restored === true &&
    proof.noGaps === true && proof.noAmbiguity === true, 'RESTORATION_NOT_PROVEN');
  return { ...copy(record), state: prior, priorDisposition: null,
    verification: { ...copy(record.verification), status: 'RESTORED', restoration: copy(proof) } };
}
export function verifyMissedEntry(record, proof) {
  const prior = disposition(record);
  requireFact(prior === 'WAITING_ENTRY', 'EXPIRY_NOT_WAITING');
  let verified = false;
  try {
    verified = proof?.confirmed === true && proof.neverAdmitted === true &&
      proof.validPlan === true && proof.validBoundaries === true && proof.sequentialCoverage === true &&
      proof.noGaps === true && proof.noAmbiguity === true && proof.noEligibleTouch === true &&
      proof.lifecycleStatus === 'Expired' &&
      timestamp(proof.verifiedThrough) >= timestamp(proof.expiryBoundary) &&
      record.admissionDecision?.allowed !== true;
  } catch { verified = false; }
  if (!verified) return markVerificationGap(record, { reason: 'EXPIRY_NOT_PROVEN', evidence: proof ?? null });
  return { ...copy(record), state: 'SKIPPED_MISSED_ENTRY', priorDisposition: null,
    capacityOccupied: false, skipReason: 'MISSED ENTRY', expiryEvidence: copy(proof) };
}
export function completeTrade(record, evidence) {
  requireFact(disposition(record) === 'ADMITTED', 'TERMINAL_NOT_ADMITTED');
  validateRelease(evidence);
  const resultR = evidence.resultRVerified === true && typeof evidence.resultR === 'number' &&
    Number.isFinite(evidence.resultR) ? evidence.resultR : null;
  // Slot remains reserved until reduceMinute applies the explicit release at an eligible minute.
  return { ...copy(record), state: 'COMPLETED', priorDisposition: null, capacityOccupied: true,
    terminalEvidence: copy(evidence), resultR };
}
