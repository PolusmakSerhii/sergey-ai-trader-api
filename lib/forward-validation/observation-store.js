import { createHash } from 'node:crypto';
import { canonicalJSON } from './source-contract.js';

export const SCHEMA = 'forward-observation-cycle-v1';
export const OBSERVATION_KEY = 'sergey-ai:forward-observations:v1:ledger';
export const MAX_ENVELOPE_BYTES = 32768;
export const BUDGETS = Object.freeze({ maxBytes:8388608, maxCycles:10000,
  maxOperations:50000, maxEvents:10000, maxRetainedPayloadBytes:6291456,
  maxPayloadBytes:32768, maxIdempotencyReceipts:50000 });
// No generations exist in this ledger; maxGenerations does not apply.
export const digest = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const check = (ok, reason) => { if (!ok) throw Error(reason); };
const text = x => typeof x === 'string' && x.length > 0;
const iso = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const lex = (a,b) => a < b ? -1 : a > b ? 1 : 0;

export function buildObservationCycle(snapshot, canonicalGate) {
  check(snapshot?.ok === true && snapshot.mode === 'global-ranking' && snapshot.status === 'ready' &&
    text(snapshot.version) && iso(snapshot.generatedAt) && Array.isArray(snapshot.globalRanking) &&
    snapshot.resultsFailed === 0, 'INCOMPLETE_SOURCE_SNAPSHOT');
  const provenance = { source:'global-ranking-snapshot', version:snapshot.version,
    mode:snapshot.mode, generatedAt:snapshot.generatedAt };
  const sourceCycleId = digest([SCHEMA, provenance]);
  const observations = snapshot.globalRanking.filter(canonicalGate).map(row => {
    check(text(row.symbol) && ['Long','Short'].includes(row.direction), 'INVALID_CANDIDATE_ID');
    // fetchScannerSymbol requests instrumentType=SWAP; do not infer from grade.
    const instrumentType = 'SWAP';
    check(row.instrumentType == null || row.instrumentType === instrumentType, 'SOURCE_INSTRUMENT_CONFLICT');
    const observationId = digest([SCHEMA,sourceCycleId,instrumentType,row.symbol,row.direction]);
    const payload = { symbol:row.symbol, instrumentType, direction:row.direction,
      sourceCandidateId:row.tradeId ?? null, sourceBatch:row.batch ?? null,
      analysisAt:row.analysisContext?.analysisAt ?? null,
      detectedAt:row.origin?.detectedAt ?? null, createdAt:row.initialPlan?.createdAt ?? null,
      sourceGeometry:{entryZone:row.entryZone,stopLoss:row.stopLoss,takeProfit1:row.takeProfit1,
        takeProfit2:row.takeProfit2,takeProfit3:row.takeProfit3},
      opportunityScore:row.opportunityScore, confidence:row.confidence,
      recommendation:row.action, recommendationConfidence:row.recommendationConfidence ?? null,
      tradeAllowed:row.tradeAllowed, tradeReadiness:row.tradeReadiness, riskReward:row.riskReward,
      canonicalEvidence:{gate:'isConfirmedAPlusTrade',confirmed:true},
      originalResearchProjectionJSON:row.researchProjectionJSON ?? null };
    return {observationId,payload,payloadHash:digest(payload)};
  }).sort((a,b)=>lex(a.observationId,b.observationId));
  check(new Set(observations.map(x=>x.observationId)).size === observations.length,'DUPLICATE_OBSERVATION');
  return {schemaVersion:SCHEMA,protocolVersion:'1.1',sourceCycleId,provenance,
    observedAt:snapshot.generatedAt,expectedObservationCount:observations.length,
    persistedObservationCount:observations.length,observationPersistenceStatus:'COMPLETE',observations};
}

export function prepareObservationCycle(snapshot, canonicalGate) {
  try {
    const envelope=buildObservationCycle(snapshot,canonicalGate),raw=canonicalJSON(envelope);
    if(Buffer.byteLength(raw,'utf8')>MAX_ENVELOPE_BYTES)return {status:'BLOCKED_STORAGE',reason:'OVERSIZED_CYCLE'};
    return {status:'PREPARED',raw,sourceCycleId:envelope.sourceCycleId};
  } catch { return {status:'UNRESOLVED',reason:'INVALID_SOURCE_ENVELOPE'}; }
}

// One atomic append of exact canonical bytes. No TTL, pruning, rollover or retry.
// Receipts are retained in the cycles themselves; count limits are ledger-wide.
export const OBSERVATION_LUA = `
local raw=ARGV[1]
local id=ARGV[2]
if #raw > 32768 then return {'BLOCKED_STORAGE','OVERSIZED_CYCLE'} end
local valid,e=pcall(cjson.decode,raw)
if not valid or e.schemaVersion ~= 'forward-observation-cycle-v1' or e.protocolVersion ~= '1.1'
 or e.sourceCycleId ~= id or #id ~= 64 or not string.match(id,'^[a-f0-9]+$')
 or type(e.observations) ~= 'table' or e.expectedObservationCount ~= #e.observations
 or e.persistedObservationCount ~= #e.observations or e.observationPersistenceStatus ~= 'COMPLETE'
 then return {'CONFLICT','INVALID_ENVELOPE'} end
local seen={}
for _,o in ipairs(e.observations) do
 if type(o.observationId) ~= 'string' or #o.observationId ~= 64 or seen[o.observationId]
 or type(o.payloadHash) ~= 'string' or #o.payloadHash ~= 64 or type(o.payload) ~= 'table'
 then return {'CONFLICT','INVALID_OBSERVATION'} end
 seen[o.observationId]=true
end
local old=redis.call('GET',KEYS[1])
local l={schemaVersion='forward-observation-ledger-v1',cycles={},count=0,observations=0,payloadBytes=0}
if old then
 local ok,stored=pcall(cjson.decode,old)
 if not ok or stored.schemaVersion ~= l.schemaVersion or type(stored.cycles) ~= 'table'
 then return {'CONFLICT','INVALID_LEDGER'} end
 l=stored
 local n=0
 local bytes=0
 local observations=0
 for k,v in pairs(l.cycles) do
  if type(v) ~= 'string' then return {'CONFLICT','INVALID_LEDGER'} end
  local ok2,c=pcall(cjson.decode,v)
  if not ok2 or c.sourceCycleId ~= k or type(c.expectedObservationCount) ~= 'number'
  then return {'CONFLICT','INVALID_LEDGER'} end
  n=n+1;bytes=bytes+#v;observations=observations+c.expectedObservationCount
 end
 if l.count ~= n or l.payloadBytes ~= bytes or l.observations ~= observations
 or #old > 8388608 or n > 10000 or observations > 50000 or bytes > 6291456
 then return {'CONFLICT','INVALID_LEDGER'} end
end
if l.cycles[id] then
 if l.cycles[id] == raw then return {'IDEMPOTENT',id} end
 return {'CONFLICT','CYCLE_CONTENT_CONFLICT'}
end
if ARGV[4]=='1' and (old or '')~=ARGV[3] then return {'CONFLICT','SOURCE_CHANGED'} end
if l.count+1 > 10000 or l.count+1 > 50000 or l.observations+#e.observations > 50000
 or l.payloadBytes+#raw > 6291456 then return {'BLOCKED_STORAGE','BUDGET_EXCEEDED'} end
l.cycles[id]=raw;l.count=l.count+1;l.observations=l.observations+#e.observations;l.payloadBytes=l.payloadBytes+#raw
local encoded=cjson.encode(l)
if #encoded > 8388608 then return {'BLOCKED_STORAGE','BUDGET_EXCEEDED'} end
redis.call('SET',KEYS[1],encoded)
return {'COMPLETE',id}
`;

export async function persistObservationCycle(prepared, execute) {
  if(prepared?.status !== 'PREPARED')return {status:prepared?.status ?? 'UNRESOLVED',reason:prepared?.reason ?? 'NOT_PREPARED'};
  try {
    const reply=await execute(['EVAL',OBSERVATION_LUA,'1',OBSERVATION_KEY,prepared.raw,prepared.sourceCycleId, ...(Object.hasOwn(prepared,'expectedLedgerRaw')?[prepared.expectedLedgerRaw,'1']:[])]);
    if(!Array.isArray(reply)||reply.length!==2)return {status:'UNRESOLVED',reason:'INVALID_RECEIPT'};
    if(['COMPLETE','IDEMPOTENT'].includes(reply[0]))return reply[1]===prepared.sourceCycleId
      ? {status:reply[0],sourceCycleId:reply[1]} : {status:'UNRESOLVED',reason:'RECEIPT_ID_MISMATCH'};
    if(['CONFLICT','BLOCKED_STORAGE'].includes(reply[0]))return {status:reply[0],reason:reply[1]};
    return {status:'UNRESOLVED',reason:'INVALID_RECEIPT'};
  } catch { return {status:'UNRESOLVED',reason:'TRANSPORT_FAILURE'}; }
}
