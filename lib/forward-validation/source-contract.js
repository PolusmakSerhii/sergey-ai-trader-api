// Pure caller-supplied source facts. No capture, persistence, clock or Core imports.
import { createHash } from 'node:crypto';
export const SYMBOL_STATUSES = Object.freeze(['PENDING','ANALYZED_NO_A_PLUS',
  'ANALYZED_A_PLUS_CAPTURE_PENDING','ANALYZED_A_PLUS_CAPTURED',
  'INSUFFICIENT_DATA_UNRESOLVED','ERROR_RETRYABLE','ERROR_UNRESOLVED']);
const complete = s => ['ANALYZED_NO_A_PLUS','ANALYZED_A_PLUS_CAPTURED'].includes(s);
const text = x => typeof x === 'string' && x.length > 0 && x.trim() === x;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const lexical = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const requireFact = (ok, code) => { if (!ok) throw new Error(code); };
export function canonicalJSON(x) {
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
  if (typeof x === 'number') { requireFact(Number.isFinite(x),'INVALID_NUMBER'); return JSON.stringify(x); }
  if (Array.isArray(x)) return '[' + Array.from(x,canonicalJSON).join(',') + ']';
  requireFact(x && Object.getPrototypeOf(x) === Object.prototype,'INVALID_JSON');
  return '{' + Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON(x[k])).join(',') + '}';
}
const copy = x => JSON.parse(canonicalJSON(x));
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
export const universeDigest = symbols => createHash('sha256').update(canonicalJSON(symbolsSorted(symbols))).digest('hex');
function time(x) {
  requireFact(typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
    Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x,'INVALID_TIMESTAMP');
  return Date.parse(x);
}
function minute(x) { const n=time(x);requireFact(n%60000===0,'INVALID_MINUTE');return n; }
function symbolsSorted(xs) {
  requireFact(Array.isArray(xs) && xs.length > 0 && xs.every(text),'INVALID_SYMBOLS');
  requireFact(new Set(xs).size === xs.length,'DUPLICATE_SYMBOL');return [...xs].sort(lexical);
}
export function cycleIdentity(runId, producerSequence) {
  requireFact(typeof runId==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(runId) && integer(producerSequence),'INVALID_CYCLE_ID');
  return `${runId}:${producerSequence}`;
}
function normalizeOperation(input) {
  const o=copy(input);
  requireFact(text(o.operationId)&&text(o.cycleId),'INVALID_OPERATION_ID');
  time(o.sourceTimeLowerBound);time(o.registeredAt);
  requireFact(['PENDING','COMPLETED','UNRESOLVED'].includes(o.status),'INVALID_OPERATION_STATUS');
  for(const k of ['processingStartedAt','operationCompletedAt','evidenceAt']) if(o[k]!==null) time(o[k]);
  requireFact(o.processingStartedAt===null || time(o.registeredAt)<=time(o.processingStartedAt),'REGISTRATION_AFTER_PROCESSING');
  requireFact(o.evidenceAt===null || o.processingStartedAt!==null && time(o.evidenceAt)>=time(o.sourceTimeLowerBound) &&
    time(o.evidenceAt)>=time(o.processingStartedAt),'BACKDATED_EVIDENCE');
  requireFact(o.payloadHash===null || hash(o.payloadHash),'INVALID_PAYLOAD_HASH');
  if(o.status==='COMPLETED') requireFact(o.processingStartedAt!==null && o.operationCompletedAt!==null && o.evidenceAt!==null &&
    hash(o.payloadHash) && time(o.operationCompletedAt)>=time(o.evidenceAt),'INCOMPLETE_OPERATION');
  return o;
}
// previous is the durable ORIGINAL receipt supplied by a later adapter, never synthesized here.
export function registerSourceOperation(input, {closedFrontier=null,previous=null}={}) {
  const o=normalizeOperation(input);
  if(previous!==null) { requireFact(same(o,normalizeOperation(previous)),'REPLAY_CONFLICT');return o; }
  if(closedFrontier!==null) requireFact(time(o.sourceTimeLowerBound)>minute(closedFrontier),'BACKDATED_OPERATION');
  return o;
}
function normalizeResult(input) {
  const r=copy(input);
  requireFact(text(r.symbol)&&text(r.instrumentType)&&text(r.batchId)&&text(r.operationId),'INVALID_RESULT_ID');
  requireFact(SYMBOL_STATUSES.includes(r.status),'INVALID_RESULT_STATUS');
  if(r.analysisAt!==null) time(r.analysisAt);
  requireFact(r.payloadHash===null || hash(r.payloadHash),'INVALID_PAYLOAD_HASH');
  requireFact(Array.isArray(r.capturedIdentityRefs)&&r.capturedIdentityRefs.every(text) &&
    new Set(r.capturedIdentityRefs).size===r.capturedIdentityRefs.length,'INVALID_IDENTITY_REFS');
  r.capturedIdentityRefs.sort(lexical);
  requireFact(Array.isArray(r.captureAcks),'INVALID_ACKS');
  const acks=new Map();
  for(const a of r.captureAcks) {
    requireFact(text(a.identityRef)&&a.operationId===r.operationId&&hash(a.payloadHash)&&a.payloadHash===r.payloadHash&&
      integer(a.ledgerRevision)&&a.ledgerRevision>0&&r.capturedIdentityRefs.includes(a.identityRef),'ACK_CONFLICT');
    requireFact(!acks.has(a.identityRef)||same(acks.get(a.identityRef),a),'ACK_CONFLICT');acks.set(a.identityRef,a);
  }
  r.captureAcks=[...acks.values()].sort((a,b)=>lexical(a.identityRef,b.identityRef));
  if(r.status.startsWith('ANALYZED_')) requireFact(r.analysisAt!==null&&hash(r.payloadHash),'MISSING_ANALYSIS_EVIDENCE');
  if(r.status==='ANALYZED_NO_A_PLUS') requireFact(!r.capturedIdentityRefs.length&&!r.captureAcks.length,'UNEXPECTED_CAPTURE');
  if(r.status.startsWith('ANALYZED_A_PLUS')) requireFact(r.capturedIdentityRefs.length>0,'MISSING_IDENTITY');
  else requireFact(!r.capturedIdentityRefs.length&&!r.captureAcks.length,'UNEXPECTED_CAPTURE');
  return r;
}
function normalizeManifest(input) {
  const m=copy(input);
  requireFact(m.cycleId===cycleIdentity(m.runId,m.producerSequence),'INVALID_CYCLE_ID');
  time(m.cycleStartedAt);time(m.sourceTimeLowerBound);requireFact(text(m.universeId),'INVALID_UNIVERSE_ID');
  m.expectedSymbols=symbolsSorted(m.expectedSymbols);
  requireFact(m.universeHash===universeDigest(m.expectedSymbols),'UNIVERSE_HASH_CONFLICT');
  requireFact(integer(m.batchCount)&&m.batchCount>0&&Array.isArray(m.batches)&&m.batches.length===m.batchCount,'INVALID_BATCH_COUNT');
  const assigned=new Map(),ids=new Set(),indices=new Set();
  for(const b of m.batches) {
    requireFact(text(b.batchId)&&!ids.has(b.batchId)&&integer(b.batchIndex)&&b.batchIndex<m.batchCount&&!indices.has(b.batchIndex),'INVALID_BATCH');
    ids.add(b.batchId);indices.add(b.batchIndex);b.expectedBatchSymbols=symbolsSorted(b.expectedBatchSymbols);
    for(const s of b.expectedBatchSymbols) {
      requireFact(m.expectedSymbols.includes(s),'UNEXPECTED_SYMBOL');requireFact(!assigned.has(s),'DUPLICATE_BATCH_MEMBERSHIP');assigned.set(s,b.batchId);
    }
  }
  m.batches.sort((a,b)=>a.batchIndex-b.batchIndex);
  requireFact(Array.isArray(m.operations)&&Array.isArray(m.results),'INVALID_MANIFEST');
  m.operations=m.operations.map(normalizeOperation).sort((a,b)=>lexical(a.operationId,b.operationId));
  requireFact(new Set(m.operations.map(o=>o.operationId)).size===m.operations.length,'DUPLICATE_OPERATION');
  for(const o of m.operations) requireFact(o.cycleId===m.cycleId&&time(o.sourceTimeLowerBound)>=time(m.sourceTimeLowerBound),'OPERATION_CYCLE_CONFLICT');
  m.results=m.results.map(normalizeResult).sort((a,b)=>lexical(a.symbol,b.symbol));
  requireFact(new Set(m.results.map(r=>r.symbol)).size===m.results.length,'DUPLICATE_RESULT');
  requireFact(new Set(m.results.map(r=>r.operationId)).size===m.results.length,'DUPLICATE_RESULT_OPERATION');
  for(const r of m.results) {
    requireFact(m.expectedSymbols.includes(r.symbol),'UNEXPECTED_SYMBOL');requireFact(assigned.get(r.symbol)===r.batchId,'BATCH_MISMATCH');
    const o=m.operations.find(o=>o.operationId===r.operationId);requireFact(o,'MISSING_REGISTERED_OPERATION');
    if(r.analysisAt!==null) requireFact(o.processingStartedAt!==null&&time(r.analysisAt)>=time(o.sourceTimeLowerBound)&&
      time(r.analysisAt)>=time(o.processingStartedAt),'BACKDATED_EVIDENCE');
    if(o.status==='COMPLETED') requireFact(r.analysisAt===o.evidenceAt&&r.payloadHash===o.payloadHash,'OPERATION_RESULT_CONFLICT');
  }
  return m;
}
export const createCycle = input => normalizeManifest(input);
export function updateSymbolResult(manifest,input) {
  const m=normalizeManifest(manifest),r=normalizeResult(input),i=m.results.findIndex(x=>x.symbol===r.symbol),old=m.results[i];
  if(old) {
    if(same(old,r))return m;
    requireFact(!complete(old.status),'COMPLETED_RESULT_CONFLICT');
    requireFact(old.operationId===r.operationId&&old.instrumentType===r.instrumentType&&old.batchId===r.batchId,'RESULT_ID_CONFLICT');
    for(const k of ['analysisAt','payloadHash']) if(old[k]!==null)requireFact(old[k]===r[k],'HISTORICAL_OBSERVATION_CONFLICT');
    const allowed={PENDING:SYMBOL_STATUSES.filter(s=>s!=='PENDING'),ERROR_RETRYABLE:SYMBOL_STATUSES.filter(s=>s!=='PENDING'),
      ANALYZED_A_PLUS_CAPTURE_PENDING:['ANALYZED_A_PLUS_CAPTURE_PENDING','ANALYZED_A_PLUS_CAPTURED']};
    requireFact(allowed[old.status]?.includes(r.status),'RESULT_TRANSITION_CONFLICT');
    if(old.status==='ANALYZED_A_PLUS_CAPTURE_PENDING') {
      requireFact(same(old.capturedIdentityRefs,r.capturedIdentityRefs),'IDENTITY_CONFLICT');
      requireFact(old.captureAcks.every(a=>r.captureAcks.some(b=>same(a,b))),'ACK_CONFLICT');
    }
    m.results[i]=r;
  }else m.results.push(r);
  return normalizeManifest(m);
}
const blocker=(kind,code,ref=null)=>({kind,code,ref});
export function canSealCycle(input) {
  const blockers=[];let m;
  try { m=normalizeManifest(input); } catch(e) { return {canSeal:false,blockers:[blocker('INTEGRITY',e.message)]}; }
  const assigned=m.batches.flatMap(b=>b.expectedBatchSymbols);
  for(const s of m.expectedSymbols) {
    if(!assigned.includes(s))blockers.push(blocker('SOURCE','MISSING_BATCH_SYMBOL',s));
    const r=m.results.find(r=>r.symbol===s);
    if(!r) { blockers.push(blocker('SOURCE','MISSING_RESULT',s));continue; }
    if(r.status==='ANALYZED_A_PLUS_CAPTURED') {
      if(r.captureAcks.length!==r.capturedIdentityRefs.length)blockers.push(blocker('CAPTURE','MISSING_CAPTURE_ACK',s));
    }else if(!complete(r.status))blockers.push(blocker(r.status==='ANALYZED_A_PLUS_CAPTURE_PENDING'?'CAPTURE':'SOURCE',r.status,s));
  }
  for(const o of m.operations) if(o.status!=='COMPLETED')blockers.push(blocker('SOURCE','UNRESOLVED_OPERATION',o.operationId));
  return {canSeal:blockers.length===0,blockers};
}
// Registry closure is an explicit prospective producer assertion, NOT inferred from cadence.
// sealedCycles are full manifests so a bare SEALED flag cannot prove capture.
export function evaluateSourceFence({minute:T,operations,sealedCycles,registryProof}={}) {
  const blockers=[];
  try {
    const t=minute(T);
    requireFact(Array.isArray(operations)&&Array.isArray(sealedCycles),'INVALID_FENCE');
    requireFact(registryProof?.complete===true&&minute(registryProof.throughMinute)>=t&&
      time(registryProof.futureSourceTimeLowerBound)>t,'REGISTRY_FRONTIER_UNPROVEN');
    const ops=operations.map(normalizeOperation).sort((a,b)=>lexical(a.operationId,b.operationId));
    requireFact(new Set(ops.map(o=>o.operationId)).size===ops.length,'DUPLICATE_OPERATION');
    requireFact(Array.isArray(registryProof.operationIds)&&new Set(registryProof.operationIds).size===registryProof.operationIds.length&&
      same([...registryProof.operationIds].sort(lexical),ops.map(o=>o.operationId).sort(lexical)),'REGISTRY_MEMBERSHIP_CONFLICT');
    requireFact(new Set(sealedCycles.map(c=>c.cycleId)).size===sealedCycles.length,'DUPLICATE_CYCLE');
    for(const o of ops) {
      if(time(o.sourceTimeLowerBound)>t)continue;
      if(o.status!=='COMPLETED') {blockers.push(blocker('SOURCE','UNRESOLVED_OPERATION',o.operationId));continue;}
      const c=sealedCycles.find(c=>c.cycleId===o.cycleId);
      if(!c) {blockers.push(blocker('SOURCE','MISSING_SEALED_CYCLE',o.operationId));continue;}
      const seal=canSealCycle(c);blockers.push(...seal.blockers);
      requireFact(Array.isArray(c.operations)&&c.operations.every(x=>ops.some(y=>same(normalizeOperation(x),y))),'REGISTRY_MEMBERSHIP_CONFLICT');
      requireFact(c.operations.some(x=>same(normalizeOperation(x),o)),'OPERATION_RECEIPT_CONFLICT');
    }
  }catch(e){blockers.push(blocker(e.message==='REGISTRY_FRONTIER_UNPROVEN'?'SOURCE':'INTEGRITY',e.message));}
  return {minute:T,closed:blockers.length===0,blockers};
}
export function deriveBoundaryProof({minute:T,sourceFence,candidateCompleteness,lifecycleCompleteness}={}) {
  const blockers=[];
  try { minute(T); } catch(e) {blockers.push(blocker('INTEGRITY',e.message));}
  const source=sourceFence?.minute===T&&sourceFence.closed===true&&Array.isArray(sourceFence.blockers)&&sourceFence.blockers.length===0;
  if(!source)blockers.push(blocker('SOURCE','SOURCE_INCOMPLETE'));
  const valid=p=>p?.minute===T&&p.complete===true&&p.unresolvedEarlier===false&&text(p.evidenceRef);
  const candidates=valid(candidateCompleteness),lifecycle=valid(lifecycleCompleteness);
  if(!candidates)blockers.push(blocker('SOURCE','CANDIDATES_INCOMPLETE'));
  if(!lifecycle)blockers.push(blocker('SOURCE','LIFECYCLE_INCOMPLETE'));
  return {minute:T,sealed:blockers.length===0,unresolvedEarlier:blockers.length!==0,
    competingCandidatesComplete:source&&candidates&&lifecycle&&blockers.length===0,blockers};
}
export function classifyHealth({blockers}={}) {
  requireFact(Array.isArray(blockers)&&blockers.every(b=>['INTEGRITY','SOURCE','CAPTURE'].includes(b?.kind)),'INVALID_BLOCKERS');
  return blockers.some(b=>b.kind==='INTEGRITY')?'BLOCKED_INTEGRITY':blockers.some(b=>b.kind==='SOURCE')?'BLOCKED_SOURCE':
    blockers.length?'BLOCKED_CAPTURE':'HEALTHY';
}
