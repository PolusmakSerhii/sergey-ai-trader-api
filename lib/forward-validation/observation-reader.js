import {canonicalJSON} from './source-contract.js';
import {SCHEMA,digest,MAX_ENVELOPE_BYTES,OBSERVATION_KEY} from './observation-store.js';
export const assert = (ok,message)=>{if(!ok)throw Error(message);};
export const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export const lexical=(a,b)=>a<b?-1:a>b?1:0;
export const order=(a,b)=>lexical(a.envelope.observedAt,b.envelope.observedAt)||lexical(a.envelope.sourceCycleId,b.envelope.sourceCycleId);
export function validateCycle(raw,id){
 assert(typeof raw==='string'&&Buffer.byteLength(raw)<=MAX_ENVELOPE_BYTES,'OVERSIZED_OR_INVALID_CYCLE');
 const e=JSON.parse(raw);assert(canonicalJSON(e)===raw,'NONCANONICAL_ENVELOPE');
 assert(e.schemaVersion===SCHEMA&&e.protocolVersion==='1.1'&&e.sourceCycleId===id&&
  e.provenance?.source==='global-ranking-snapshot'&&e.provenance.mode==='global-ranking'&&
  typeof e.provenance.version==='string'&&iso(e.observedAt)&&e.observedAt===e.provenance.generatedAt&&
  digest([SCHEMA,e.provenance])===id,'CYCLE_IDENTITY_CONFLICT');
 assert(e.observationPersistenceStatus==='COMPLETE'&&Array.isArray(e.observations)&&
  e.expectedObservationCount===e.observations.length&&e.persistedObservationCount===e.observations.length,'INCOMPLETE_CYCLE');
 let prev='';
 for(const o of e.observations){const p=o.payload;
  assert(p&&typeof p.symbol==='string'&&['Long','Short'].includes(p.direction)&&typeof p.instrumentType==='string','INVALID_OBSERVATION');
  assert(o.observationId>prev&&o.observationId===digest([SCHEMA,id,p.instrumentType,p.symbol,p.direction])&&o.payloadHash===digest(p),'OBSERVATION_HASH_CONFLICT');prev=o.observationId;
  assert(p.canonicalEvidence?.confirmed===true&&p.canonicalEvidence.gate==='isConfirmedAPlusTrade','CANONICAL_EVIDENCE_MISSING');
 }
 return {raw,envelope:e,hash:digest(e)};
}
export async function readObservations(execute){
 const raw=await execute(['GET',OBSERVATION_KEY]);if(raw===null)return [];
 assert(typeof raw==='string'&&Buffer.byteLength(raw)<=8388608,'INVALID_OBSERVATION_LEDGER');
 const l=JSON.parse(raw);assert(l.schemaVersion==='forward-observation-ledger-v1'&&l.cycles&&typeof l.cycles==='object'&&!Array.isArray(l.cycles),'INVALID_OBSERVATION_LEDGER');
 const rows=Object.entries(l.cycles).map(([id,bytes])=>validateCycle(bytes,id));
 assert(rows.length===l.count&&rows.length<=10000&&rows.reduce((n,r)=>n+r.envelope.observations.length,0)===l.observations&&l.observations<=50000&&
  rows.reduce((n,r)=>n+Buffer.byteLength(r.raw),0)===l.payloadBytes&&l.payloadBytes<=6291456,'LEDGER_COUNTS_CONFLICT');
 return rows.sort(order);
}
