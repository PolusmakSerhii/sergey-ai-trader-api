import {canonicalJSON} from './source-contract.js';
import {digest} from './observation-store.js';
import {validateCycle,assert,iso} from './observation-reader.js';
export const MAPPING='forward-worker-mapping-v1';
export const DELAYED='forward-delayed-ingestion-v1';
// An optional explicit frozenCandidate in the original projection is evidence only,
// never reconstructed from current market data or worker time. Current F2 records
// without these facts intentionally block; sourceGeometry alone is not a frozen plan.
export function mapObservation(cycle,observation){
 const p=observation.payload,reasons=[];
 if(p.instrumentType!=='SWAP')reasons.push('NON_SWAP');
 if(!iso(p.detectedAt))reasons.push('MISSING_DETECTED_AT');
 if(!iso(p.createdAt))reasons.push('MISSING_CREATED_AT');
 if(!iso(p.analysisAt))reasons.push('MISSING_ANALYSIS_AT');
 let f;try{f=JSON.parse(p.originalResearchProjectionJSON)?.frozenCandidate;}catch{}
 if(!f?.initialPlan)reasons.push('MISSING_FROZEN_PLAN');
 const plan=f?.initialPlan;
 if(!iso(plan?.expiresAt)||!iso(plan?.plannedAt))reasons.push('MISSING_PLAN_BOUNDARIES');
 if(!plan?.exitStrategy||(typeof plan.exitStrategy.version!=='string'||!plan.exitStrategy.version.trim()))reasons.push('MISSING_EXIT_POLICY');
 if(f){
  if(f.setupKey!==`${p.symbol}:${p.direction}`||f.symbol!==p.symbol||f.direction!==p.direction||f.instrumentType!=='SWAP'||
   f.origin?.detectedAt!==p.detectedAt||plan?.createdAt!==p.createdAt||p.createdAt!==p.detectedAt||
   f.tradeId!==`${f.setupKey}:${p.detectedAt}`)reasons.push('ORIGINAL_IDENTITY_CONFLICT');
  if(!f.originalEligibility||f.originalEligibility.confirmedAPlus!==true)reasons.push('MISSING_ORIGINAL_ELIGIBILITY');
  if(plan){for(const k of ['entryZone','stopLoss','takeProfit1','takeProfit2','takeProfit3'])
   if(canonicalJSON(plan[k]??null)!==canonicalJSON(p.sourceGeometry?.[k]??null))reasons.push('GEOMETRY_CONFLICT');
   const z=plan.entryZone,n=[z?.from,z?.to,plan.stopLoss,plan.takeProfit1,plan.takeProfit2,plan.takeProfit3];
   if(!n.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0)||z.from>z.to)reasons.push('INVALID_GEOMETRY');
   if(n.every(x=>typeof x==='number'&&Number.isFinite(x))&&!(p.direction==='Long'
    ? plan.stopLoss<z.from&&z.to<plan.takeProfit1&&plan.takeProfit1<plan.takeProfit2&&plan.takeProfit2<plan.takeProfit3
    : plan.stopLoss>z.to&&z.from>plan.takeProfit1&&plan.takeProfit1>plan.takeProfit2&&plan.takeProfit2>plan.takeProfit3))reasons.push('INVALID_GEOMETRY');
   if(iso(plan.expiresAt)&&iso(p.detectedAt)&&plan.expiresAt<=p.detectedAt)reasons.push('INVALID_EXPIRY');
  }
 }
 if(iso(p.detectedAt)&&iso(p.analysisAt)&&p.detectedAt>p.analysisAt)reasons.push('SOURCE_TIME_CONFLICT');
 if(iso(p.analysisAt)&&p.analysisAt>cycle.envelope.observedAt)reasons.push('SOURCE_TIME_CONFLICT');
 return reasons.length?{status:'BLOCKED_MAPPING',reasonCodes:[...new Set(reasons)]}:{status:'MAPPED',frozenCandidate:JSON.parse(canonicalJSON(f))};
}
export function validateDelayed(d){
 assert(d.schemaVersion===DELAYED&&d.mappingVersion===MAPPING,'DELAYED_VERSION_CONFLICT');
 const cycle=validateCycle(d.sourceEnvelope,d.sourceCycleId);
 assert(cycle.hash===d.sourceEnvelopeHash,'SOURCE_HASH_CONFLICT');
 const o=cycle.envelope.observations.find(x=>x.observationId===d.observationId);
 assert(o&&o.payloadHash===d.observationPayloadHash,'OBSERVATION_HASH_CONFLICT');
 assert(d.sourceObservedAt===cycle.envelope.observedAt&&d.sourceAnalysisAt===o.payload.analysisAt&&iso(d.sourceAnalysisAt)&&
  iso(d.workerProcessingStartedAt)&&iso(d.workerRecordedAt)&&d.sourceAnalysisAt<=d.workerProcessingStartedAt&&
  d.sourceObservedAt<=d.workerProcessingStartedAt&&d.workerProcessingStartedAt<=d.workerRecordedAt,'DELAYED_TIME_CONFLICT');
 assert(d.processingIdentity===digest([MAPPING,d.sourceCycleId,d.observationId]),'PROCESSING_IDENTITY_CONFLICT');
 const mapped=mapObservation(cycle,o);assert(mapped.status==='MAPPED','BLOCKED_MAPPING');
 assert(canonicalJSON(mapped.frozenCandidate)===canonicalJSON(d.frozenCandidate),'FROZEN_MAPPING_CONFLICT');
 return mapped.frozenCandidate;
}
