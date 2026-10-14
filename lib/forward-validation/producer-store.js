import { createHash } from 'node:crypto';
import { canonicalJSON, cycleIdentity, createCycle, registerSourceOperation,
  canSealCycle, classifyHealth } from './source-contract.js';

// Append-only bounded command ledger. Materialized state is replayed and validated on read.
// Transport is injected; neither Core nor the SHADOW capture ledger is accessed here.
const CAS = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'CREATE' then
  if current then return 0 end
elseif not current or current ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
return 1
`;
const copy = x => JSON.parse(canonicalJSON(x));
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const text = x => typeof x === 'string' && x.length > 0 && x.trim() === x;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const object = x => x && Object.getPrototypeOf(x) === Object.prototype;
function check(ok, reason) { if (!ok) throw new Error(reason); }
function fields(x, names) {
  check(object(x) && same(Object.keys(x).sort(), [...names].sort()), 'INVALID_FIELDS');
}
function iso(x) {
  check(typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
    Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x, 'INVALID_TIMESTAMP');
}
export const producerHash = x => createHash('sha256').update(canonicalJSON(x)).digest('hex');
const bytes = x => Buffer.byteLength(canonicalJSON(x), 'utf8');
export function producerKey(runId) {
  cycleIdentity(runId, 0);
  return `sergey-ai:forward-shadow:v1:${runId}:producer-ledger`;
}
const LIMITS = ['maxBytes','maxCycles','maxOperations','maxEvents','maxGenerations',
  'maxRetainedPayloadBytes','maxPayloadBytes','maxIdempotencyReceipts'];
function validateMeta(m) {
  fields(m, ['runId','mode','schemaVersion','coreCommit','officialActivationId','officialActivationAt','budget']);
  producerKey(m.runId);
  check(m.mode === 'SHADOW' && m.schemaVersion === 1 && m.officialActivationId === null &&
    m.officialActivationAt === null && /^[a-f0-9]{40}$/.test(m.coreCommit), 'INVALID_SHADOW_META');
  check(m.budget !== null, 'BUDGET_UNSET');fields(m.budget,LIMITS);
  check(LIMITS.every(k=>integer(m.budget[k]) && m.budget[k]>0), 'INVALID_BUDGET');
}
const get = (rows,key,id) => { const row=rows.find(x=>x[key]===id);check(row,'MISSING_'+key);return row; };
const repeat = (old,input) => {check(same(old,input),'IMMUTABLE_CONFLICT');};
function initialState() {return {producerSequence:0,cycles:[],operations:[],generations:[],generationLinks:[],captures:[],reconciliations:[],healthHistory:[]};}
function operationFor(s,id) {return get(s.operations,'operationId',id);}
function cycleFor(s,id) {return get(s.cycles,'cycleId',id);}
function openCycle(s,id) {const c=cycleFor(s,id);check(!c.sealed,'CYCLE_SEALED');return c;}
function generationFor(s,id) {return get(s.generations,'shadowCandidateId',id);}
function manifestFor(s,c) {
  check(c.frozenManifest,'MANIFEST_UNSET');
  const operations=[],results=[];
  for(const o of s.operations.filter(o=>o.intent.cycleId===c.cycleId)) {
    const i=o.intent,r=o.result;
    operations.push({operationId:o.operationId,cycleId:c.cycleId,sourceTimeLowerBound:i.sourceTimeLowerBound,
      registeredAt:i.registeredAt,processingStartedAt:i.processingStartedAt,
      status:r?'COMPLETED':'PENDING',operationCompletedAt:r?.completedAt ?? null,
      evidenceAt:r?.analysisAt ?? null,payloadHash:r?.payloadHash ?? null});
    const refs=(r?.identityRefs ?? []).map(id=>s.generationLinks.find(x=>x.sourceOperationId===o.operationId&&x.proposedIdentity===id)?.shadowCandidateId ?? id);
    const captures=s.captures.filter(x=>x.intent.sourceOperationId===o.operationId);
    const acks=captures.filter(x=>x.state==='ACKNOWLEDGED').map(x=>({operationId:o.operationId,
      identityRef:x.intent.shadowCandidateId,payloadHash:x.intent.payloadHash,ledgerRevision:x.receipt.ledgerRevision}));
    let status=r?.status ?? 'PENDING';
    if(status==='ANALYZED_A_PLUS_CAPTURE_PENDING' && refs.every(id=>acks.some(a=>a.identityRef===id)))
      status='ANALYZED_A_PLUS_CAPTURED';
    results.push({symbol:i.symbol,instrumentType:i.instrumentType,batchId:i.batchId,operationId:o.operationId,
      status,analysisAt:r?.analysisAt ?? null,payloadHash:r?.payloadHash ?? null,
      capturedIdentityRefs:refs,captureAcks:acks});
  }
  return createCycle({...c.frozenManifest,operations,results});
}
function sealProof(s,c) {
  if(!c.frozenManifest)return {canSeal:false,blockers:[{kind:'SOURCE',code:'MANIFEST_UNSET',ref:c.cycleId}]};
  const p=canSealCycle(manifestFor(s,c));
  for(const cap of s.captures.filter(x=>operationFor(s,x.intent.sourceOperationId).intent.cycleId===c.cycleId))
    if(cap.state!=='ACKNOWLEDGED')p.blockers.push({kind:'CAPTURE',code:'CAPTURE_NOT_FINALIZED',ref:cap.intent.captureOperationId});
  for(const x of s.reconciliations.filter(x=>operationFor(s,x.proof.sourceOperationId).intent.cycleId===c.cycleId))
    if(x.status==='UNRESOLVED')p.blockers.push({kind:'INTEGRITY',code:'RECONCILIATION_UNRESOLVED',ref:x.proof.reconciliationId});
  p.canSeal=p.blockers.length===0;return p;
}
function sourceGeneration(s,d) {
  const o=operationFor(s,d.originalSourceOperationId);
  check(o.result?.status==='ANALYZED_A_PLUS_CAPTURE_PENDING','GENERATION_SOURCE_NOT_ELIGIBLE');
  check(o.result.identityRefs.includes(d.shadowCandidateId),'GENERATION_IDENTITY_NOT_IN_SOURCE');
  const f=d.frozenCandidate;
  check(object(f)&&f.symbol===o.intent.symbol&&f.instrumentType===o.intent.instrumentType&&
    ['Long','Short'].includes(f.direction)&&d.setupKey===`${f.symbol}:${f.direction}`&&
    f.setupKey===d.setupKey&&f.tradeId===d.shadowCandidateId&&object(f.initialPlan)&&object(f.originalEligibility), 'INVALID_FROZEN_CANDIDATE');
  iso(d.originalCapturedAt);
  check(f.initialPlan.createdAt===d.originalCapturedAt&&f.origin?.detectedAt===d.originalCapturedAt&&
    o.result.capturedAt===d.originalCapturedAt&&d.shadowCandidateId===`${d.setupKey}:${d.originalCapturedAt}`&&
    d.frozenFactsHash===producerHash(f)&&d.identityOrigin==='SHADOW_ONLY','FROZEN_FACTS_CONFLICT');
  check(same(o.result.payload.frozenCandidate,f),'FROZEN_PAYLOAD_CONFLICT');
}
function apply(s,type,d,revision,runId) {
  switch(type) {
    case 'allocateCycle': {
      fields(d,['allocationId','cycleStartedAt','sourceTimeLowerBound']);check(text(d.allocationId),'INVALID_ALLOCATION_ID');
      iso(d.cycleStartedAt);iso(d.sourceTimeLowerBound);
      const old=s.cycles.find(c=>c.allocation.allocationId===d.allocationId);
      if(old){repeat(old.allocation,d);return {cycleId:old.cycleId,producerSequence:old.producerSequence};}
      check(s.producerSequence<Number.MAX_SAFE_INTEGER,'SEQUENCE_EXHAUSTED');
      const seq=++s.producerSequence,cycleId=cycleIdentity(runId,seq);
      s.cycles.push({cycleId,producerSequence:seq,allocation:copy(d),frozenManifest:null,sealed:false,sealEvidence:[],revision});
      return {cycleId,producerSequence:seq};
    }
    case 'freezeManifest': {
      fields(d,['cycleId','universeId','universeHash','expectedSymbols','batchCount','batches']);
      const c=cycleFor(s,d.cycleId);
      const m=createCycle({...d,runId,producerSequence:c.producerSequence,
        cycleStartedAt:c.allocation.cycleStartedAt,sourceTimeLowerBound:c.allocation.sourceTimeLowerBound,operations:[],results:[]});
      if(c.frozenManifest){repeat(c.frozenManifest,m);return {cycleId:c.cycleId};}
      check(!c.sealed,'CYCLE_SEALED');c.frozenManifest=m;c.revision=revision;return {cycleId:c.cycleId};
    }
    case 'registerOperation': {
      fields(d,['operationId','cycleId','batchId','batchIndex','symbol','instrumentType','sourceTimeLowerBound','registeredAt','processingStartedAt']);
      const old=s.operations.find(x=>x.operationId===d.operationId);
      if(old){repeat(old.intent,d);return {operationId:d.operationId};}
      const c=openCycle(s,d.cycleId);check(c.frozenManifest,'MANIFEST_UNSET');
      const b=c.frozenManifest.batches.find(b=>b.batchId===d.batchId);
      check(b&&b.batchIndex===d.batchIndex&&b.expectedBatchSymbols.includes(d.symbol)&&text(d.instrumentType),'BATCH_MEMBERSHIP_CONFLICT');
      check(!s.operations.some(o=>o.intent.cycleId===d.cycleId&&o.intent.symbol===d.symbol),'DUPLICATE_SYMBOL_OPERATION');
      check(d.sourceTimeLowerBound>=c.allocation.sourceTimeLowerBound&&d.registeredAt>=c.allocation.cycleStartedAt,'SOURCE_PROVENANCE_CONFLICT');
      registerSourceOperation({...d,status:'PENDING',operationCompletedAt:null,evidenceAt:null,payloadHash:null});
      check(d.processingStartedAt!==null,'PROCESSING_TIMESTAMP_REQUIRED');
      s.operations.push({operationId:d.operationId,intent:copy(d),result:null,revision});return {operationId:d.operationId};
    }
    case 'persistResult': {
      fields(d,['operationId','analysisAt','capturedAt','completedAt','status','identityRefs','payload','payloadHash']);
      const o=operationFor(s,d.operationId);
      if(o.result){repeat(o.result,d);return {operationId:d.operationId,payloadHash:d.payloadHash};}
      openCycle(s,o.intent.cycleId);iso(d.analysisAt);iso(d.completedAt);if(d.capturedAt!==null)iso(d.capturedAt);
      check(object(d.payload)&&d.payloadHash===producerHash(d.payload),'PAYLOAD_HASH_CONFLICT');
      check(['ANALYZED_NO_A_PLUS','ANALYZED_A_PLUS_CAPTURE_PENDING','INSUFFICIENT_DATA_UNRESOLVED','ERROR_RETRYABLE','ERROR_UNRESOLVED'].includes(d.status),'INVALID_SOURCE_RESULT');
      check(Array.isArray(d.identityRefs)&&d.identityRefs.every(text)&&new Set(d.identityRefs).size===d.identityRefs.length,'INVALID_IDENTITY_REFS');
      check(d.status==='ANALYZED_A_PLUS_CAPTURE_PENDING'?d.identityRefs.length>0:d.identityRefs.length===0,'INVALID_IDENTITY_REFS');
      check(d.analysisAt>=o.intent.processingStartedAt&&d.analysisAt>=o.intent.sourceTimeLowerBound&&d.completedAt>=d.analysisAt,'RESULT_TIME_CONFLICT');
      // Bind metadata to the durable original envelope, not only to an arbitrary hash.
      for(const k of ['analysisAt','capturedAt','status','identityRefs'])check(same(d.payload[k],d[k]),'PAYLOAD_PROVENANCE_CONFLICT');
      check(d.payload.symbol===o.intent.symbol&&d.payload.instrumentType===o.intent.instrumentType,'PAYLOAD_SOURCE_CONFLICT');
      o.result=copy(d);o.revision=revision;manifestFor(s,cycleFor(s,o.intent.cycleId));
      return {operationId:d.operationId,payloadHash:d.payloadHash};
    }
    case 'getOrCreateGeneration': {
      fields(d,['setupKey','shadowCandidateId','identityOrigin','originalSourceOperationId','originalCapturedAt','frozenCandidate','frozenFactsHash']);
      sourceGeneration(s,d);
      const priorLink=s.generationLinks.find(x=>x.sourceOperationId===d.originalSourceOperationId&&x.proposedIdentity===d.shadowCandidateId);
      if(priorLink) {
        const linked=generationFor(s,priorLink.shadowCandidateId);
        return {shadowCandidateId:linked.shadowCandidateId,generationSequence:linked.generationSequence,reused:true};
      }
      const exact=s.generations.find(g=>g.shadowCandidateId===d.shadowCandidateId);
      if(exact){repeat(exact.original,d);return {shadowCandidateId:exact.shadowCandidateId,generationSequence:exact.generationSequence,reused:true};}
      const history=s.generations.filter(g=>g.setupKey===d.setupKey),current=history.at(-1);
      if(current&&current.logicalLifecycleState!=='CLOSED') {
        const link={sourceOperationId:d.originalSourceOperationId,proposedIdentity:d.shadowCandidateId,shadowCandidateId:current.shadowCandidateId};
        const old=s.generationLinks.find(x=>x.sourceOperationId===link.sourceOperationId&&x.proposedIdentity===link.proposedIdentity);
        if(old)repeat(old,link);else s.generationLinks.push(link);
        return {shadowCandidateId:current.shadowCandidateId,generationSequence:current.generationSequence,reused:true};
      }
      if(current)check(d.originalCapturedAt>=current.closedAt&&d.originalSourceOperationId!==current.original.originalSourceOperationId,'GENERATION_PRECEDES_CLOSURE');
      const seq=history.length+1;
      s.generations.push({setupKey:d.setupKey,generationSequence:seq,shadowCandidateId:d.shadowCandidateId,original:copy(d),
        logicalLifecycleState:'OPEN',lifecycleEvidenceRef:null,closureProof:null,closedAt:null,revision});
      return {shadowCandidateId:d.shadowCandidateId,generationSequence:seq,reused:false};
    }
    case 'recordGenerationClosure': {
      fields(d,['shadowCandidateId','proof']);const g=generationFor(s,d.shadowCandidateId),p=d.proof;
      if(g.closureProof){repeat(g.closureProof,p);return {shadowCandidateId:g.shadowCandidateId};}
      check(object(p)&&p.shadowCandidateId===g.shadowCandidateId&&p.frozenFactsHash===g.original.frozenFactsHash&&
        p.verified===true&&p.noGaps===true&&p.noAmbiguity===true&&text(p.evidenceRef)&&object(p.evidence)&&
        p.evidenceHash===producerHash(p.evidence),'INVALID_CLOSURE_PROOF');
      iso(p.closedAt);iso(p.verifiedThrough);check(p.closedAt>=g.original.originalCapturedAt&&p.verifiedThrough>=p.closedAt,'INVALID_CLOSURE_TIME');
      check(['Stopped','Closed','TP1Hit','TP3Hit','Expired'].includes(p.status)&&p.evidence.status===p.status&&
        p.evidence.checkedAt===p.closedAt&&p.evidence.confirmed===true&&p.evidence.shadowCandidateId===g.shadowCandidateId&&
        p.evidence.frozenFactsHash===g.original.frozenFactsHash,'UNVERIFIED_TERMINAL');
      if(p.status==='Expired') {
        iso(g.original.frozenCandidate.initialPlan.expiresAt);
        check(p.neverAdmitted===true&&p.noEligibleTouch===true&&p.sequentialCoverage===true&&
          p.verifiedThrough>=g.original.frozenCandidate.initialPlan.expiresAt&&p.closedAt>=g.original.frozenCandidate.initialPlan.expiresAt,'UNVERIFIED_EXPIRY');
      }
      g.closureProof=copy(p);g.closedAt=p.closedAt;g.lifecycleEvidenceRef=p.evidenceRef;g.logicalLifecycleState='CLOSED';g.revision=revision;
      return {shadowCandidateId:g.shadowCandidateId};
    }
    case 'markGenerationUnresolved': {
      fields(d,['shadowCandidateId','reason','evidenceRef']);check(text(d.reason)&&text(d.evidenceRef),'MISSING_EVIDENCE');
      const g=generationFor(s,d.shadowCandidateId);check(g.logicalLifecycleState!=='CLOSED','FINAL_GENERATION');
      g.logicalLifecycleState='UNRESOLVED';g.lifecycleEvidenceRef=d.evidenceRef;g.revision=revision;
      return {shadowCandidateId:g.shadowCandidateId};
    }
    case 'prepareCapture': {
      fields(d,['captureOperationId','sourceOperationId','shadowCandidateId','payloadHash','expectedShadowRevision','transaction','transactionHash']);
      const old=s.captures.find(x=>x.intent.captureOperationId===d.captureOperationId);
      if(old){repeat(old.intent,d);return {captureOperationId:d.captureOperationId};}
      const o=operationFor(s,d.sourceOperationId);openCycle(s,o.intent.cycleId);
      check(o.result?.status==='ANALYZED_A_PLUS_CAPTURE_PENDING'&&o.result.payloadHash===d.payloadHash,'CAPTURE_SOURCE_CONFLICT');
      const g=generationFor(s,d.shadowCandidateId);
      // Reuse mappings are recorded by getOrCreateGeneration receipts; no guessed remapping.
      check(o.result.identityRefs.includes(d.shadowCandidateId)||s.generationLinks?.some(x=>x.sourceOperationId===d.sourceOperationId&&x.shadowCandidateId===d.shadowCandidateId),'CAPTURE_IDENTITY_CONFLICT');
      check(!s.captures.some(x=>x.intent.sourceOperationId===d.sourceOperationId&&x.intent.shadowCandidateId===d.shadowCandidateId),'DUPLICATE_CAPTURE_IDENTITY');
      check(text(d.captureOperationId)&&integer(d.expectedShadowRevision)&&object(d.transaction)&&
        d.transaction.operationId===d.captureOperationId&&d.transaction.expectedLedgerRevision===d.expectedShadowRevision&&
        d.transactionHash===producerHash(d.transaction),'CAPTURE_TRANSACTION_CONFLICT');
      check(g.setupKey===`${o.intent.symbol}:${g.original.frozenCandidate.direction}`,'CAPTURE_SETUP_CONFLICT');
      s.captures.push({intent:copy(d),state:'PENDING',receipt:null,revision});return {captureOperationId:d.captureOperationId};
    }
    case 'markCaptureUnresolved': {
      fields(d,['captureOperationId','reason']);check(text(d.reason),'MISSING_REASON');
      const actual=s.captures.find(x=>x.intent.captureOperationId===d.captureOperationId);check(actual,'MISSING_CAPTURE');
      check(actual.receipt===null,'CAPTURE_ALREADY_RECEIVED');actual.state='UNRESOLVED';actual.revision=revision;
      return {captureOperationId:d.captureOperationId};
    }
    case 'receiveCaptureReceipt': {
      fields(d,['captureOperationId','receipt']);const c=s.captures.find(x=>x.intent.captureOperationId===d.captureOperationId);check(c,'MISSING_CAPTURE');
      if(c.receipt){repeat(c.receipt,d.receipt);return {captureOperationId:d.captureOperationId};}
      const r=d.receipt;fields(r,['operationId','sourceOperationId','identityRef','payloadHash','transactionHash','ledgerRevision']);
      check(r.operationId===c.intent.captureOperationId&&r.sourceOperationId===c.intent.sourceOperationId&&
        r.identityRef===c.intent.shadowCandidateId&&r.payloadHash===c.intent.payloadHash&&r.transactionHash===c.intent.transactionHash&&
        integer(r.ledgerRevision)&&r.ledgerRevision===c.intent.expectedShadowRevision+1,'CAPTURE_ACK_CONFLICT');
      c.receipt=copy(r);c.state='RECEIPT_RECEIVED';c.revision=revision;return {captureOperationId:d.captureOperationId};
    }
    case 'acknowledgeCapture': {
      fields(d,['captureOperationId']);const c=s.captures.find(x=>x.intent.captureOperationId===d.captureOperationId);check(c?.receipt,'MISSING_CAPTURE_RECEIPT');
      c.state='ACKNOWLEDGED';c.revision=revision;return {captureOperationId:d.captureOperationId};
    }
    case 'recordReconciliation': {
      fields(d,['reconciliationId','shadowCandidateId','linkedCoreTradeId','sourceOperationId','equivalenceProof','proofHash']);
      check(text(d.reconciliationId)&&text(d.linkedCoreTradeId)&&object(d.equivalenceProof)&&d.proofHash===producerHash(d.equivalenceProof),'INVALID_RECONCILIATION');
      const old=s.reconciliations.find(x=>x.proof.reconciliationId===d.reconciliationId);
      if(old){repeat(old.proof,d);return {status:old.status};}
      const g=generationFor(s,d.shadowCandidateId);const source=operationFor(s,d.sourceOperationId);openCycle(s,source.intent.cycleId);
      check(source.result&&source.intent.symbol===g.original.frozenCandidate.symbol,'RECONCILIATION_SOURCE_CONFLICT');
      const p=d.equivalenceProof,f=g.original.frozenCandidate;
      const expected={setupKey:g.setupKey,symbol:f.symbol,direction:f.direction,instrumentType:f.instrumentType,
        initialPlan:f.initialPlan,origin:f.origin,originalEligibility:f.originalEligibility};
      const matches=p.coreTradeId===d.linkedCoreTradeId&&text(p.coreEvidenceRef)&&same(p.shadowFacts,expected)&&same(p.coreFacts,expected);
      if(matches)check(!s.reconciliations.some(x=>x.status==='MATCHED'&&
        ((x.proof.shadowCandidateId===d.shadowCandidateId&&x.proof.linkedCoreTradeId!==d.linkedCoreTradeId)||
         (x.proof.linkedCoreTradeId===d.linkedCoreTradeId&&x.proof.shadowCandidateId!==d.shadowCandidateId))),'RECONCILIATION_LINK_CONFLICT');
      const status=matches?'MATCHED':'UNRESOLVED';s.reconciliations.push({proof:copy(d),status,revision});return {status};
    }
    case 'recordSealEvidence': {
      fields(d,['cycleId','observedAt','proof']);iso(d.observedAt);const c=cycleFor(s,d.cycleId),computed=sealProof(s,c);
      check(same(d.proof,computed),'SEAL_PROOF_CONFLICT');
      c.sealEvidence.push({observedAt:d.observedAt,proof:copy(computed),revision});
      c.sealed=computed.canSeal;c.revision=revision;
      s.healthHistory.push({cycleId:c.cycleId,health:classifyHealth(computed),blockers:copy(computed.blockers),observedAt:d.observedAt,revision});
      return {sealed:c.sealed,blockers:computed.blockers};
    }
    default: throw new Error('UNKNOWN_ACTION');
  }
}
function encode(l) {const {integrityHash,...body}=l;return canonicalJSON({...body,integrityHash:producerHash(body)});}
function materialize(l) {
  fields(l,['meta','revision','entries','integrityHash']);validateMeta(l.meta);
  const {integrityHash,...body}=l;check(integrityHash===producerHash(body),'LEDGER_HASH_CONFLICT');
  check(integer(l.revision)&&Array.isArray(l.entries)&&l.entries.length===l.revision,'PARTIAL_LEDGER');
  const state=initialState(),ids=new Set();
  for(let i=0;i<l.entries.length;i++) {
    const e=l.entries[i];fields(e,['request','requestHash','reply']);validateRequest(e.request);
    check(!ids.has(e.request.requestId)&&e.request.expectedRevision===i&&e.requestHash===producerHash(e.request),'INVALID_RECEIPT');ids.add(e.request.requestId);
    const reply=apply(state,e.request.type,e.request.data,i+1,l.meta.runId);check(same(reply,e.reply),'REPLAY_INTEGRITY_CONFLICT');
  }
  return state;
}
function validateRequest(r) {
  fields(r,['requestId','expectedRevision','type','data']);check(text(r.requestId)&&integer(r.expectedRevision)&&text(r.type)&&object(r.data),'INVALID_REQUEST');
}
function withinBudget(l,s,raw) {
  const b=l.meta.budget;
  // All retained command payloads, including duplicate evidence/receipts, are charged.
  const sizes=l.entries.map(e=>bytes(e.request.data));
  return Buffer.byteLength(raw,'utf8')<=b.maxBytes&&s.cycles.length<=b.maxCycles&&s.operations.length<=b.maxOperations&&
    l.entries.length<=b.maxEvents&&s.generations.length<=b.maxGenerations&&l.entries.length<=b.maxIdempotencyReceipts&&
    sizes.every(n=>n<=b.maxPayloadBytes)&&sizes.reduce((a,n)=>a+n,0)<=b.maxRetainedPayloadBytes;
}
function recovery(s) {
  const cycles=s.cycles.map(c=>({cycleId:c.cycleId,sealed:c.sealed,proof:sealProof(s,c)}));
  const blockers=cycles.flatMap(c=>c.proof.blockers);
  return {unfinishedCycles:cycles.filter(c=>!c.sealed),activeCycle:cycles.filter(c=>!c.sealed).at(-1)?.cycleId??null,
    unresolvedOperations:s.operations.filter(o=>!o.result||!o.result.status.startsWith('ANALYZED_')).map(o=>o.operationId),
    resultsAwaitingCapture:s.operations.filter(o=>o.result?.status==='ANALYZED_A_PLUS_CAPTURE_PENDING'&&
      !manifestFor(s,cycleFor(s,o.intent.cycleId)).results.some(r=>r.operationId===o.operationId&&r.status==='ANALYZED_A_PLUS_CAPTURED')).map(o=>o.operationId),
    pendingCaptures:s.captures.filter(c=>c.state!=='ACKNOWLEDGED'),
    receiptsAwaitingFinalization:s.captures.filter(c=>c.state==='RECEIPT_RECEIVED'),
    unresolvedReconciliation:s.reconciliations.filter(x=>x.status==='UNRESOLVED'),
    currentGenerations:s.generations.filter((g,i,rows)=>!rows.slice(i+1).some(x=>x.setupKey===g.setupKey)),
    health:classifyHealth({blockers}),blockers,healthHistory:s.healthHistory};
}
export function createProducerStore(execute) {
  check(typeof execute==='function','EXECUTOR_REQUIRED');
  const guarded=fn=>async(...args)=>{try{return await fn(...args);}catch(e){return {status:'BLOCKED_INTEGRITY',reason:e.message};}};
  const io=async command=>{try{return {value:await execute(command)};}catch(e){return {error:{status:'UNRESOLVED',reason:'TRANSPORT_FAILURE',detail:e.message}};}};
  async function load(runId) {
    const r=await io(['GET',producerKey(runId)]);if(r.error)return r;
    if(r.value===null)return {raw:null,ledger:null,state:null};
    check(typeof r.value==='string','INVALID_LEDGER_BYTES');const ledger=JSON.parse(r.value),state=materialize(ledger);
    check(ledger.meta.runId===runId,'RUN_ID_CONFLICT');check(withinBudget(ledger,state,r.value),'STORED_BUDGET_CONFLICT');
    return {raw:r.value,ledger,state};
  }
  const api={
    createRun:guarded(async meta=>{
      const m=copy(meta);validateMeta(m);const current=await load(m.runId);if(current.error)return current.error;
      if(current.ledger){repeat(current.ledger.meta,m);return {status:'IDEMPOTENT',revision:current.ledger.revision};}
      const l={meta:m,revision:0,entries:[]},raw=encode(l);
      if(!withinBudget(l,initialState(),raw))return {status:'BLOCKED_STORAGE',reason:'BUDGET_EXCEEDED',persisted:false};
      const r=await io(['EVAL',CAS,'1',producerKey(m.runId),'CREATE','',raw]);return r.error??{status:Number(r.value)===1?'OK':'STALE',revision:0};
    }),
    read:guarded(async runId=>{const r=await load(runId);if(r.error)return r.error;
      return r.ledger?{status:'OK',revision:r.ledger.revision,state:r.state,recovery:recovery(r.state)}:{status:'NOT_FOUND'};}),
    transact:guarded(async(runId,input)=>{
      const request=copy(input);validateRequest(request);const r=await load(runId);if(r.error)return r.error;check(r.ledger,'RUN_NOT_FOUND');
      const requestHash=producerHash(request),old=r.ledger.entries.find(e=>e.request.requestId===request.requestId);
      if(old){check(old.requestHash===requestHash,'IDEMPOTENCY_CONFLICT');return {status:'IDEMPOTENT',reply:old.reply};}
      if(request.expectedRevision!==r.ledger.revision)return {status:'STALE',revision:r.ledger.revision};
      const reply=apply(r.state,request.type,request.data,r.ledger.revision+1,runId);
      r.ledger.revision++;r.ledger.entries.push({request,requestHash,reply});const raw=encode(r.ledger);
      if(!withinBudget(r.ledger,r.state,raw))return {status:'BLOCKED_STORAGE',reason:'BUDGET_EXCEEDED',persisted:false};
      const committed=await io(['EVAL',CAS,'1',producerKey(runId),'UPDATE',r.raw,raw]);
      return committed.error??(Number(committed.value)===1?{status:'OK',revision:r.ledger.revision,reply}:{status:'STALE'});
    })
  };
  for(const type of ['allocateCycle','freezeManifest','registerOperation','persistResult','getOrCreateGeneration',
    'recordGenerationClosure','markGenerationUnresolved','prepareCapture','markCaptureUnresolved','receiveCaptureReceipt',
    'acknowledgeCapture','recordReconciliation','recordSealEvidence'])
    api[type]=(runId,request)=>api.transact(runId,{...request,type});
  api.readRecoveryState=async runId=>{const r=await api.read(runId);return r.status==='OK'?{status:'OK',revision:r.revision,...r.recovery}:r;};
  api.readCycle=async(runId,cycleId)=>{const r=await api.read(runId);if(r.status!=='OK')return r;
    const c=r.state.cycles.find(c=>c.cycleId===cycleId);return c?{status:'OK',cycle:c,manifest:c.frozenManifest?manifestFor(r.state,c):null,proof:sealProof(r.state,c)}:{status:'NOT_FOUND'};};
  return api;
}
