import {readObservations} from './observation-reader.js';
import {prepareObservationCycle} from './observation-store.js';
import {createProducerStore} from './producer-store.js';
import {RUN_ID} from './source-registry.js';
import {mapObservation} from './delayed-ingestion.js';

// Source-only projection: never mutate Core ranking rows. Existing immutable
// observations remain the authority for a setup's original frozen facts.
export async function prepareProspectiveObservation(snapshot, gate, freeze, execute, membership) {
 try {
  if (!membership?.epochId || !['EXPECTED','IDEMPOTENT'].includes(membership.status))
   return prepareObservationCycle(snapshot, gate);
  let expectedLedgerRaw;
  const prior = await readObservations(async command => {const raw=await execute(command);expectedLedgerRaw=raw;return raw;});
  const producer=await createProducerStore(execute).read(RUN_ID);
  if (!['OK','NOT_FOUND'].includes(producer.status)) return {status:'UNRESOLVED',reason:'GENERATION_STATE_UNPROVEN'};
  const originals = new Map();
  for (const cycle of prior) for (const observation of cycle.envelope.observations) {
   const mapped = mapObservation(cycle, observation);
   if (mapped.status === 'MAPPED' && mapped.frozenCandidate.sourceProvenance?.epochId === membership.epochId)
    originals.set(mapped.frozenCandidate.setupKey, mapped.frozenCandidate);
  }
  const projected = {...snapshot, globalRanking: snapshot.globalRanking.map(row => {
   if (!gate(row)) return row;
   const key = `${row.symbol}:${row.direction}`;
   let original=originals.get(key);
   const generation=producer.state?.generations.find(g=>g.shadowCandidateId===original?.tradeId);
   if(generation?.logicalLifecycleState==='CLOSED'&&generation.closureProof&&row.analysisContext?.analysisAt>=generation.closedAt)original=null;
   const frozenCandidate = structuredClone(original || {...freeze(row, row.analysisContext?.analysisAt),
    sourceProvenance:{epochId:membership.epochId,reservationId:membership.reservationId,sourceObservedAt:snapshot.generatedAt}});
   const plan = frozenCandidate.initialPlan;
   return {...row, origin: frozenCandidate.origin, initialPlan: plan,
    entryZone: plan.entryZone, stopLoss: plan.stopLoss, takeProfit1: plan.takeProfit1,
    takeProfit2: plan.takeProfit2, takeProfit3: plan.takeProfit3,
    researchProjectionJSON: JSON.stringify({frozenCandidate,analysisContext:row.analysisContext})};
  })};
  return {...prepareObservationCycle(projected, gate),expectedLedgerRaw:expectedLedgerRaw||''};
 } catch { return {status:'UNRESOLVED', reason:'SOURCE_FACTS_UNPROVEN'}; }
}
