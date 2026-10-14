import { createHash } from 'node:crypto';

// Storage only: executor is injected. No transport, Core imports, admission rules or clock.
// One bounded JSON value makes records/events/receipts/meta an indivisible CAS transaction.
const CAS = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'CREATE' then
  if current then return 0 end
else
  if not current or current ~= ARGV[2] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const str = x => typeof x === 'string' && x.length > 0 && x.trim() === x;
const integer = x => Number.isSafeInteger(x) && x >= 0;
function check(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
export function canonicalJSON(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { check(Number.isFinite(value), 'INVALID_JSON_VALUE'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + Array.from(value, canonicalJSON).join(',') + ']';
  check(value && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_JSON_VALUE');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}
export const hashValue = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const clone = value => JSON.parse(canonicalJSON(value));
function keys(value, allowed) {
  check(value && !Array.isArray(value) && typeof value === 'object' &&
    Object.keys(value).every(k => allowed.includes(k)), 'INVALID_SCHEMA');
}
function iso(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value, 'INVALID_TIMESTAMP');
}
const nullableTime = value => { if (value !== null) iso(value); };
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
export function shadowKey(runId) {
  check(typeof runId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(runId), 'INVALID_RUN_ID');
  return `sergey-ai:forward-shadow:v1:${runId}:ledger`;
}
const IMMUTABLE = ['identityOrigin', 'coreTradeId', 'shadowCandidateId', 'setupKey', 'symbol',
  'instrumentType', 'direction', 'origin', 'analysisAt', 'initialPlan', 'originalEligibility', 'recordedAt'];
const RECORD_FIELDS = [...IMMUTABLE, 'immutableOriginHash', 'state', 'priorDisposition', 'capacityOccupied',
  'verificationCursor', 'verifiedThrough', 'unresolvedReason', 'eligibleEntryCandle', 'admissionDecision',
  'skipReason', 'lifecycleEvidenceRefs', 'terminal', 'updatedAt', 'revision'];
export const immutableOriginHash = record => hashValue(Object.fromEntries(IMMUTABLE.map(k => [k, record[k]])));
const idOf = r => r.identityOrigin === 'CORE_REGISTERED' ? r.coreTradeId : r.shadowCandidateId;
const disposition = r => r.state === 'UNRESOLVED_VERIFICATION' ? r.priorDisposition : r.state;
const FINAL = ['SKIPPED_CAPACITY', 'SKIPPED_MISSED_ENTRY', 'COMPLETED'];
function validateRecord(r) {
  keys(r, RECORD_FIELDS);
  check(RECORD_FIELDS.every(k => own(r, k)), 'MISSING_RECORD_FIELD');
  check(['CORE_REGISTERED', 'SHADOW_ONLY'].includes(r.identityOrigin) && str(idOf(r)) &&
    (r.identityOrigin !== 'SHADOW_ONLY' || r.coreTradeId === null) &&
    (r.shadowCandidateId === null || str(r.shadowCandidateId)), 'INVALID_IDENTITY');
  check(str(r.symbol) && str(r.instrumentType) && ['Long', 'Short'].includes(r.direction) &&
    r.setupKey === `${r.symbol}:${r.direction}`, 'INVALID_IDENTITY');
  keys(r.origin, ['detectedAt']); iso(r.origin.detectedAt); nullableTime(r.analysisAt);
  iso(r.recordedAt); iso(r.updatedAt);
  check(r.updatedAt >= r.recordedAt && integer(r.revision), 'INVALID_RECORD_REVISION');
  check(r.initialPlan && typeof r.initialPlan === 'object' && !Array.isArray(r.initialPlan) &&
    r.originalEligibility && typeof r.originalEligibility === 'object' && !Array.isArray(r.originalEligibility), 'INVALID_ORIGIN');
  check(r.immutableOriginHash === immutableOriginHash(r), 'IMMUTABLE_CONFLICT');
  const d = disposition(r);
  check(['DETECTED', 'WAITING_ENTRY', 'ADMITTED', ...FINAL].includes(d), 'INVALID_OR_RESERVED_STATE');
  check(typeof r.capacityOccupied === 'boolean', 'INVALID_OCCUPANCY');
  if (r.state === 'UNRESOLVED_VERIFICATION') {
    check(['DETECTED', 'WAITING_ENTRY', 'ADMITTED'].includes(r.priorDisposition) && str(r.unresolvedReason), 'INVALID_UNRESOLVED');
  } else check(r.priorDisposition === null, 'INVALID_PRIOR_DISPOSITION');
  if (d !== 'COMPLETED') check(r.capacityOccupied === (d === 'ADMITTED'), 'INVALID_OCCUPANCY');
  nullableTime(r.verificationCursor); nullableTime(r.verifiedThrough);
  check(r.unresolvedReason === null || str(r.unresolvedReason), 'INVALID_REASON');
  check(r.skipReason === null || str(r.skipReason), 'INVALID_REASON');
  check(Array.isArray(r.lifecycleEvidenceRefs) && r.lifecycleEvidenceRefs.every(str), 'INVALID_EVIDENCE_REFS');
  if (r.eligibleEntryCandle !== null) check(typeof r.eligibleEntryCandle === 'object' && !Array.isArray(r.eligibleEntryCandle), 'INVALID_ENTRY_EVIDENCE');
  if (r.admissionDecision !== null) {
    const a = r.admissionDecision;
    keys(a, ['eventTime','decidedAt','comparatorKey','capacityBefore','decision','reason','evidenceRefs']);
    iso(a.eventTime); iso(a.decidedAt);
    check(['ADMITTED','SKIPPED_CAPACITY'].includes(a.decision) && Array.isArray(a.comparatorKey) &&
      Array.isArray(a.capacityBefore) && Array.isArray(a.evidenceRefs) && a.evidenceRefs.every(str) &&
      (a.reason === null || str(a.reason)), 'INVALID_DECISION');
  }
  if (['ADMITTED','COMPLETED','SKIPPED_CAPACITY'].includes(d)) check(r.admissionDecision?.decision ===
    (d === 'SKIPPED_CAPACITY' ? 'SKIPPED_CAPACITY' : 'ADMITTED'), 'MISSING_OR_CONFLICTING_DECISION');
  else check(r.admissionDecision === null, 'CONFLICTING_DECISION');
  if (d === 'COMPLETED') {
    check(r.terminal !== null, 'MISSING_TERMINAL');
    keys(r.terminal, ['status','checkedAt','resultR','evidenceRef']);
    check(['Stopped','Closed','TP3Hit','TP1Hit'].includes(r.terminal.status) &&
      (r.terminal.resultR === null || typeof r.terminal.resultR === 'number' && Number.isFinite(r.terminal.resultR)) &&
      str(r.terminal.evidenceRef), 'INVALID_TERMINAL'); iso(r.terminal.checkedAt);
  } else check(r.terminal === null, 'UNEXPECTED_TERMINAL');
}
function validateUpdate(old, next) {
  check(old.immutableOriginHash === next.immutableOriginHash, 'IMMUTABLE_CONFLICT');
  if (old.admissionDecision !== null) check(canonicalJSON(old.admissionDecision) === canonicalJSON(next.admissionDecision), 'FINAL_DECISION_CONFLICT');
  if (FINAL.includes(old.state)) {
    // COMPLETED may only release its occupied slot; all other final facts are fixed.
    const a = {...old, revision:0, updatedAt:null}, b = {...next, revision:0, updatedAt:null};
    if (old.state === 'COMPLETED' && old.capacityOccupied && !next.capacityOccupied) a.capacityOccupied = false;
    check(canonicalJSON(a) === canonicalJSON(b), 'FINAL_STATE_CONFLICT');
  } else {
    const from = disposition(old), to = disposition(next);
    const allowed = { DETECTED:['DETECTED','WAITING_ENTRY'],
      WAITING_ENTRY:['WAITING_ENTRY','ADMITTED','SKIPPED_CAPACITY','SKIPPED_MISSED_ENTRY'],
      ADMITTED:['ADMITTED','COMPLETED'] };
    check(allowed[from]?.includes(to), 'STATE_REGRESSION');
    if (next.state === 'UNRESOLVED_VERIFICATION') check(next.priorDisposition === from, 'INVALID_PRIOR_DISPOSITION');
  }
  for (const k of ['verificationCursor','verifiedThrough']) if (old[k] !== null) check(next[k] !== null && next[k] >= old[k], 'PROGRESS_REGRESSION');
  check(next.updatedAt >= old.updatedAt, 'TIME_REGRESSION');
}
const META_FIELDS = ['schemaVersion','mode','protocolVersion','admissionVersion','runId','officialActivationId',
  'officialActivationAt','coreCommit','ledgerRevision','captureWatermark','decisionWatermark','health','failureReason','storageBudget'];
function validateMeta(m, runId) {
  keys(m, META_FIELDS); check(META_FIELDS.every(k => own(m,k)), 'MISSING_META_FIELD');
  shadowKey(m.runId);
  check(m.runId === runId && m.schemaVersion === 1 && m.mode === 'SHADOW' &&
    m.protocolVersion === '1.1' && m.admissionVersion === '1.1' &&
    m.officialActivationId === null && m.officialActivationAt === null, 'INVALID_SHADOW_MODE');
  check(typeof m.coreCommit === 'string' && /^[a-f0-9]{40}$/.test(m.coreCommit) && integer(m.ledgerRevision), 'INVALID_META');
  nullableTime(m.captureWatermark); nullableTime(m.decisionWatermark);
  check(m.decisionWatermark === null || m.captureWatermark !== null && m.decisionWatermark <= m.captureWatermark, 'INVALID_WATERMARK');
  check(['HEALTHY','BLOCKED_STORAGE','BLOCKED_INTEGRITY'].includes(m.health) &&
    (m.health === 'HEALTHY' ? m.failureReason === null : str(m.failureReason)), 'INVALID_HEALTH');
  check(m.storageBudget !== null, 'BUDGET_UNSET');
  keys(m.storageBudget, ['maxBytes','maxRecords','maxEvents','maxOperations']);
  check(['maxBytes','maxRecords','maxEvents','maxOperations'].every(k => integer(m.storageBudget[k]) && m.storageBudget[k] > 0), 'INVALID_BUDGET');
}
function validateEvent(e) {
  keys(e, ['eventId','sourceOperationId','sourceRevision','identity','type','eventTime','observedAt','evidenceHash','payload']);
  check([e.eventId,e.sourceOperationId,e.identity,e.type].every(str) && integer(e.sourceRevision), 'INVALID_EVENT');
  iso(e.eventTime); iso(e.observedAt);
  check(e.evidenceHash === hashValue(e.payload), 'EVENT_HASH_CONFLICT');
}
const sourceKey = e => canonicalJSON([e.sourceOperationId,e.sourceRevision]);
function validateLedger(l, runId) {
  keys(l, ['meta','records','events','operations','creationHash','integrityHash']);
  validateMeta(l.meta, runId);
  check(Array.isArray(l.records) && Array.isArray(l.events) && Array.isArray(l.operations) && digest(l.creationHash), 'INCONSISTENT_LEDGER');
  const {integrityHash,...body} = l;
  check(integrityHash === hashValue(body), 'INCONSISTENT_LEDGER');
  const ids=new Set(), events=new Set(), sources=new Set(), ops=new Set();
  for (const r of l.records) { validateRecord(r); check(!ids.has(idOf(r)) && r.revision <= l.meta.ledgerRevision, 'INCONSISTENT_LEDGER'); ids.add(idOf(r)); }
  for (const e of l.events) {
    validateEvent(e); check(ids.has(e.identity) && !events.has(e.eventId) && !sources.has(sourceKey(e)), 'INCONSISTENT_LEDGER');
    events.add(e.eventId); sources.add(sourceKey(e));
  }
  for (const o of l.operations) {
    keys(o,['operationId','requestHash','ledgerRevision']);
    check(str(o.operationId) && digest(o.requestHash) && integer(o.ledgerRevision) &&
      o.ledgerRevision > 0 && o.ledgerRevision <= l.meta.ledgerRevision && !ops.has(o.operationId), 'INCONSISTENT_LEDGER');ops.add(o.operationId);
  }
  check(l.operations.length === l.meta.ledgerRevision &&
    new Set(l.operations.map(o=>o.ledgerRevision)).size === l.meta.ledgerRevision, 'INCONSISTENT_LEDGER');
}
function encode(l) {
  l.records.sort((a,b)=>idOf(a)<idOf(b)?-1:idOf(a)>idOf(b)?1:0);
  l.events.sort((a,b)=>a.eventTime<b.eventTime?-1:a.eventTime>b.eventTime?1:a.eventId<b.eventId?-1:a.eventId>b.eventId?1:0);
  l.operations.sort((a,b)=>a.ledgerRevision-b.ledgerRevision);
  const {integrityHash,...body}=l; return canonicalJSON({...body, integrityHash:hashValue(body)});
}
function withinBudget(l, raw) {
  const b=l.meta.storageBudget;
  return Buffer.byteLength(raw,'utf8')<=b.maxBytes && l.records.length<=b.maxRecords && l.events.length<=b.maxEvents && l.operations.length<=b.maxOperations;
}
// All failures are infrastructure results, never trading dispositions.
export function createShadowStore(execute) {
  check(typeof execute === 'function', 'EXECUTOR_REQUIRED');
  const guarded = fn => async (...args) => { try { return await fn(...args); }
    catch(e) { return {status:e.code || 'STORAGE_ERROR', message:e.message}; } };
  async function load(runId) {
    const raw=await execute(['GET',shadowKey(runId)]);
    if(raw===null) return {raw,ledger:null};
    check(typeof raw==='string','MALFORMED_STORED_JSON');
    let ledger;try{ledger=JSON.parse(raw);}catch{check(false,'MALFORMED_STORED_JSON');}
    validateLedger(ledger,runId);check(withinBudget(ledger,raw),'INCONSISTENT_LEDGER');
    return {raw,ledger};
  }
  return {
    read: guarded(async runId => { const {ledger}=await load(runId);return ledger?{status:'OK',ledger}:{status:'NOT_FOUND'}; }),
    createRun: guarded(async input => {
      const meta=clone(input);validateMeta(meta,meta.runId);
      check(meta.ledgerRevision===0 && meta.captureWatermark===null && meta.decisionWatermark===null && meta.health==='HEALTHY','INVALID_INITIAL_META');
      const creationHash=hashValue(meta), current=await load(meta.runId);
      if(current.ledger) return {status:current.ledger.creationHash===creationHash?'IDEMPOTENT':'RUN_CONFLICT'};
      const l={meta,records:[],events:[],operations:[],creationHash};const raw=encode(l);
      if(!withinBudget(l,raw))return {status:'BLOCKED_STORAGE',reason:'BUDGET_EXCEEDED',persisted:false};
      const result=await execute(['EVAL',CAS,'1',shadowKey(meta.runId),'CREATE','',raw]);
      return {status:Number(result)===1?'CREATED':'STALE'};
    }),
    commit: guarded(async (runId, input) => {
      const tx=clone(input);keys(tx,['operationId','expectedLedgerRevision','records','events','metadata']);
      check(str(tx.operationId)&&integer(tx.expectedLedgerRevision)&&Array.isArray(tx.records)&&Array.isArray(tx.events),'INVALID_TRANSACTION');
      const requestHash=hashValue(tx),{raw,ledger}=await load(runId);check(ledger,'RUN_NOT_FOUND');
      const receipt=ledger.operations.find(o=>o.operationId===tx.operationId);
      if(receipt)return {status:receipt.requestHash===requestHash?'IDEMPOTENT':'OPERATION_CONFLICT',ledgerRevision:receipt.ledgerRevision};
      if(tx.expectedLedgerRevision!==ledger.meta.ledgerRevision)return {status:'STALE',scope:'ledger'};
      const next=clone(ledger), seen=new Set();let changed=false;
      for(const change of tx.records){
        keys(change,['expectedRevision','record']);const r=change.record;validateRecord(r);const id=idOf(r);
        check(!seen.has(id),'DUPLICATE_RECORD');seen.add(id);
        const index=next.records.findIndex(x=>idOf(x)===id),old=next.records[index];
        if(old){
          check(old.immutableOriginHash===r.immutableOriginHash,'IMMUTABLE_CONFLICT');
          if(change.expectedRevision===null){check(canonicalJSON(old)===canonicalJSON(r),'RECORD_CONFLICT');continue;}
          if(change.expectedRevision!==old.revision)return {status:'STALE',scope:'record'};
          check(r.revision===old.revision+1,'INVALID_RECORD_REVISION');validateUpdate(old,r);next.records[index]=r;changed=true;
        }else{
          check(change.expectedRevision===null&&r.revision===0,'STALE_RECORD');
          check(['DETECTED','WAITING_ENTRY'].includes(r.state),'INVALID_INITIAL_STATE');next.records.push(r);changed=true;
        }
      }
      for(const e of tx.events){
        validateEvent(e);check(next.records.some(r=>idOf(r)===e.identity),'EVENT_IDENTITY_MISSING');
        const old=next.events.find(x=>x.eventId===e.eventId||sourceKey(x)===sourceKey(e));
        if(old){check(canonicalJSON(old)===canonicalJSON(e),'EVENT_CONFLICT');continue;}
        next.events.push(e);changed=true;
      }
      if(tx.metadata!==undefined){
        keys(tx.metadata,['captureWatermark','decisionWatermark','health','failureReason']);
        for(const [k,v] of Object.entries(tx.metadata)){
          if(k.endsWith('Watermark')&&next.meta[k]!==null) check(v!==null&&v>=next.meta[k],'WATERMARK_REGRESSION');
          if(canonicalJSON(next.meta[k])!==canonicalJSON(v))changed=true;next.meta[k]=v;
        }
      }
      validateMeta(next.meta,runId);
      // Even a no-op gets a receipt: its operation ID cannot later be reused with different content.
      next.meta.ledgerRevision++;
      next.operations.push({operationId:tx.operationId,requestHash,ledgerRevision:next.meta.ledgerRevision});
      const encoded=encode(next);validateLedger(JSON.parse(encoded),runId);
      // Preserve old bytes on overflow: do not advance health/revision/watermarks to fit a failure marker.
      if(!withinBudget(next,encoded))return {status:'BLOCKED_STORAGE',reason:'BUDGET_EXCEEDED',persisted:false};
      const result=await execute(['EVAL',CAS,'1',shadowKey(runId),'UPDATE',raw,encoded]);
      return Number(result)===1?{status:changed?'OK':'IDEMPOTENT',ledgerRevision:next.meta.ledgerRevision}:{status:'STALE',scope:'cas'};
    })
  };
}
