import {randomUUID} from 'node:crypto';
import {createLifecycleStore} from './lifecycle-store.js';
import {createWorkerStore,fencedExecutor} from './worker-store.js';
import {createProducerStore,producerHash} from './producer-store.js';
import {readObservations,assert} from './observation-reader.js';
import {createSourceEpoch,deriveEpochProof} from './source-epoch.js';
import {RUN_ID,REGISTRY_KEY} from './source-registry.js';
import {digest} from './observation-store.js';
import {deriveBoundaryProof} from './source-contract.js';
import {reduceMinute,completeTrade} from './engine.js';
const MINUTE=60000;
const terminal=o=>['Expired','Stopped','TP1Hit','TP3Hit','Closed'].includes(o?.status);
const utc=n=>new Date(n).toISOString();
export async function fetchLifecyclePage({symbol,from,to,signal}){
 assert(/^[A-Z0-9]+USDT$/.test(symbol),'INVALID_INSTRUMENT');
 const url=new URL('https://www.okx.com/api/v5/market/history-candles');
 url.searchParams.set('instId',symbol.replace(/USDT$/,'-USDT-SWAP'));url.searchParams.set('bar','1m');
 url.searchParams.set('after',String(to));url.searchParams.set('before',String(from-1));url.searchParams.set('limit','100');
 const response=await fetch(url,{signal,redirect:'error'});const payload=await response.json();
 assert(response.ok&&payload.code==='0'&&Array.isArray(payload.data),'PROVIDER_FAILURE');
 return {source:'OKX 1m candles',url:url.toString(),data:payload.data.map(r=>({timestamp:Number(r[0]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),confirmed:r[8]==='1'}))};
}
export async function runLifecycle({execute,lifecycle,provider=fetchLifecyclePage,now=Date.now,owner=randomUUID()}={}){
 const start=now();let lease,control,loaded,calls=0,processed=0,admissionBlocked=false;
 const phase=()=>assert(now()-start<40000,'PHASE_CUTOFF');
 // Reserve five seconds for transport and one second for local serialization.
 const guard=()=>assert(now()-start<=39000,'DEADLINE');
 const bounded=async command=>{guard();return execute(command);};
 try{
  control=createWorkerStore(bounded);lease=await control.acquire(owner);if(lease.status!=='OK')return {status:lease.status};
  const io=fencedExecutor(bounded,owner,lease.fence,guard),store=createLifecycleStore(io),producer=createProducerStore(io),epoch=createSourceEpoch(io);
  const registry=await epoch.read();if(!registry?.epoch)return {status:'NOT_STARTED'};
  const sources=await readObservations(io),worker=await control.read(),p=await producer.read(RUN_ID);
  if(p.status==='NOT_FOUND')return {status:'IDLE'};assert(p.status==='OK','PRODUCER_UNRESOLVED');
  loaded=await store.read();
  const save=async(id,event,patch={},sourceGuard=null)=>{const next=await store.commit(loaded,id,event,patch,sourceGuard);assert(['OK','IDEMPOTENT'].includes(next.status),next.status);loaded=next;};
  // Finish the frozen admission transaction before advancing any lifecycle cursor.
  const finishAdmission=async(intentId,intent)=>{
   const raw=await io(['GET',REGISTRY_KEY]);
   const currentProof=deriveEpochProof(JSON.parse(raw),intent.minute);
   assert(currentProof.status==='CLOSED'&&digest(currentProof)===digest(intent.sourceProof),'ADMISSION_SOURCE_CHANGED');
   await save(digest(['admission',intent.minute]),{kind:'ADMISSION',intentId,batch:intent.batch},intent.patch,{key:REGISTRY_KEY,raw});
  };
  for(const [id,entry] of Object.entries(loaded.state.events)){
   if(entry.event.kind==='ADMISSION_INTENT'&&!loaded.state.events[digest(['admission',entry.event.minute])]){
    phase();await finishAdmission(id,entry.event);
   }
  }
  const members=Object.values(registry.reservations).filter(m=>m.epochId===registry.epoch.activation.epochId);
  const eligible=[];
  for(const generation of p.state.generations){
   const op=p.state.operations.find(x=>x.operationId===generation.original.originalSourceOperationId),d=op?.delayedIngestion;
   if(!d)continue;
   const m=members.find(x=>x.binding&&JSON.parse(x.binding).sourceCycleId===d.sourceCycleId);
   if(!m||m.status!=='OBSERVED'||m.epochConflict||worker.intents[d.sourceCycleId]?.status!=='COMPLETE')continue;
   const cycle=sources.find(x=>x.envelope.sourceCycleId===d.sourceCycleId),observation=cycle?.envelope.observations.find(x=>x.observationId===d.observationId);
   assert(cycle?.hash===d.sourceEnvelopeHash&&observation?.payloadHash===d.observationPayloadHash,'SOURCE_MAPPING_CONFLICT');
   const f=generation.original.frozenCandidate;
   assert(producerHash(f)===generation.original.frozenFactsHash&&f.tradeId===generation.shadowCandidateId,'GENERATION_HASH_CONFLICT');
   const identity={runId:RUN_ID,epochId:registry.epoch.activation.epochId,setupKey:generation.setupKey,generationSequence:generation.generationSequence,
    shadowCandidateId:generation.shadowCandidateId,originalCapturedAt:generation.original.originalCapturedAt,frozenFactsHash:generation.original.frozenFactsHash,
    sourceCycleId:d.sourceCycleId,observationId:d.observationId,sourceEnvelopeHash:d.sourceEnvelopeHash,sourcePayloadHash:d.observationPayloadHash,
    mappingVersion:d.mappingVersion,reservationId:JSON.parse(m.original).reservationId};
   eligible.push({generation,f,identity});
  }
  const work=eligible.filter(x=>!loaded.state.records[x.f.tradeId]?.closureRecorded).sort((a,b)=>{
   const cursor=x=>Date.parse(loaded.state.records[x.f.tradeId]?.outcome?.lastPriceCheckedAt||x.f.initialPlan.plannedAt);
   return cursor(a)-cursor(b)||(a.f.tradeId<b.f.tradeId?-1:a.f.tradeId>b.f.tradeId?1:0);
  }).slice(0,3);
  for(const x of work){
   phase();processed++;const id=x.f.tradeId;
   let r=structuredClone(loaded.state.records[id]||{identity:x.identity,outcome:{},decision:null,ambiguitySeen:false,closureRecorded:false});
   assert(digest(r.identity)===digest(x.identity),'GENERATION_MAPPING_CHANGED');
   for(let n=0;n<3&&!terminal(r.outcome);n++){
    phase();const from=lifecycle.getLifecycleCursor(r.outcome,x.f.initialPlan.plannedAt),to=Math.min(Math.floor(now()/MINUTE)*MINUTE,from+100*MINUTE);
    if(to<=from)break;
    const prior=Object.entries(loaded.state.events).find(([,e])=>e.event.kind==='PROVIDER'&&e.event.tradeId===id&&e.event.from===from&&e.event.to<=to&&e.event.complete);
    let receipt,receiptId;
    if(prior){[receiptId]=prior;receipt=prior[1].event;}
    else {
     assert(calls<9,'PROVIDER_LIMIT');calls++;
     let page;
     try{page=await provider({symbol:x.f.symbol,from,to,signal:AbortSignal.timeout(5000)});}catch{
      await save(digest(['provider-error',id,from,loaded.state.revision]),{kind:'PROVIDER_ERROR',tradeId:id,from,to},{records:{[id]:{...r,unresolved:'PROVIDER_FAILURE'}}});break;
     }
     const seen=new Set(),data=[];let valid=true;
     for(const candle of page.data||[]){
      if(!lifecycle.isValidLifecycleCandle(candle)||!candle.confirmed||candle.timestamp<from||candle.timestamp>=to||seen.has(candle.timestamp)){valid=false;break;}
      seen.add(candle.timestamp);data.push(candle);
     }
     data.sort((a,b)=>a.timestamp-b.timestamp);
     const complete=valid&&data.length===(to-from)/MINUTE&&data.every((v,i)=>v.timestamp===from+i*MINUTE);
    const contexts=sources.flatMap(c=>c.envelope.observations).filter(o=>o.payload.symbol===x.f.symbol).flatMap(o=>{
     try{const context=JSON.parse(o.payload.originalResearchProjectionJSON)?.analysisContext;return context?[{context,observationId:o.observationId}]:[];}catch{return [];}
    }).filter(v=>Date.parse(v.context.analysisAt)<=to).sort((a,b)=>Date.parse(b.context.analysisAt)-Date.parse(a.context.analysisAt));
    const analysisContext=contexts[0]||null;
     receipt={kind:'PROVIDER',tradeId:id,from,to,source:page.source||'OKX 1m candles',url:page.url||null,data,complete,analysisContext,receivedAt:utc(now())};
     receiptId=digest(['provider',id,from,to,loaded.state.revision]);
     await save(receiptId,receipt);
     if(!complete){await save(digest(['gap',receiptId]),{kind:'GAP',receiptId},{records:{[id]:{...r,unresolved:'VERIFICATION_INCOMPLETE'}}});break;}
    }
    phase();
    const context=receipt.analysisContext;
    const outcome=lifecycle.evaluateTradeLifecycle({initialPlan:structuredClone(x.f.initialPlan),direction:x.f.direction,previousOutcome:structuredClone(r.outcome),
     capturedAt:utc(receipt.to),priceRange:{source:receipt.source,data:structuredClone(receipt.data)},analysisContext:context?.context||null});
    r={...r,outcome:structuredClone(outcome),unresolved:outcome.priceCheck?.status==='verified'?null:outcome.priceCheck?.status||'UNRESOLVED',
     ambiguitySeen:r.ambiguitySeen||String(outcome.priceCheck?.status).startsWith('ambiguous'),lastProviderReceipt:receiptId};
    await save(digest(['checkpoint',id,receiptId,digest(r.outcome)]),{kind:'LIFECYCLE',tradeId:id,receiptId,contextObservationId:context?.observationId||null,outcome:r.outcome},{records:{[id]:r}});
    if(r.unresolved||terminal(outcome))break;
   }
   if(terminal(r.outcome)&&!r.ambiguitySeen&&r.outcome.priceCheck?.status==='verified'&&!r.closureRecorded){
    phase();const closedAt=r.outcome.checkedAt||r.outcome.lastPriceCheckedAt;
    const evidence={status:r.outcome.status,checkedAt:closedAt,confirmed:true,shadowCandidateId:id,frozenFactsHash:r.identity.frozenFactsHash,
     outcome:r.outcome,providerReceipt:r.lastProviderReceipt};
    const proof={shadowCandidateId:id,frozenFactsHash:r.identity.frozenFactsHash,verified:true,noGaps:true,noAmbiguity:true,evidenceRef:digest(evidence),evidence,evidenceHash:producerHash(evidence),
     closedAt,verifiedThrough:r.outcome.lastPriceCheckedAt,status:r.outcome.status,
     ...(r.outcome.status==='Expired'?{neverAdmitted:!r.decision,noEligibleTouch:!r.outcome.entryCheck,sequentialCoverage:true}:{})};
    const current=await producer.read(RUN_ID);assert(current.status==='OK','PRODUCER_UNRESOLVED');
    const request={requestId:digest(['closure',id,digest(proof),current.revision]),expectedRevision:current.revision,data:{shadowCandidateId:id,proof}};
    await save(digest(['closure-intent',request.requestId]),{kind:'CLOSURE_INTENT',request});
    const result=await producer.recordGenerationClosure(RUN_ID,request);assert(['OK','IDEMPOTENT'].includes(result.status),result.status);
    r={...r,closureRecorded:true,closureProof:proof};
    await save(digest(['closure',id,digest(proof)]),{kind:'CLOSURE',tradeId:id,proof},{records:{[id]:r}});
   }
  }
  // Completeness is checked across ALL eligible generations, not the bounded work slice.
  const pending=eligible.map(x=>({x,r:loaded.state.records[x.f.tradeId]})).filter(({r})=>r&&!r.decision&&r.outcome.entryCheck&&!r.ambiguitySeen);
  assert(pending.every(({r})=>!loaded.state.decisionMinute||r.outcome.activatedAt>loaded.state.decisionMinute),'LATE_ENTRY');
  const releaseMinutes=Object.values(loaded.state.records).filter(r=>r.closureRecorded&&r.outcome.exitCheck?.candle&&
   (r.decision?.state==='ADMITTED'||pending.some(x=>x.r.identity.shadowCandidateId===r.identity.shadowCandidateId)))
   .map(r=>utc(r.outcome.exitCheck.candle.timestamp+MINUTE));
  const minutes=[...new Set([...pending.map(({r})=>r.outcome.activatedAt),...releaseMinutes])].filter(T=>!loaded.state.decisionMinute||T>loaded.state.decisionMinute).sort();
  for(const T of minutes){
   phase();assert(!loaded.state.decisionMinute||T>loaded.state.decisionMinute,'LATE_ENTRY');
   const end=Date.parse(T)+MINUTE;
   const complete=eligible.every(x=>{const r=loaded.state.records[x.f.tradeId];if(Date.parse(x.f.origin.detectedAt)>=end)return true;
    return r&&!r.ambiguitySeen&&!r.unresolved&&(terminal(r.outcome)||Date.parse(r.outcome.lastPriceCheckedAt)>=end);});
   const sourceComplete=members.filter(m=>Date.parse(m.sourceLowerBound)<=Date.parse(T)).every(m=>m.binding&&worker.intents[JSON.parse(m.binding).sourceCycleId]?.status==='COMPLETE');
   if(!complete||!sourceComplete){admissionBlocked=true;break;}
   const sealed=await epoch.seal(T);if(!['SEALED','IDEMPOTENT'].includes(sealed.status)){admissionBlocked=true;break;}
   const freshRegistry=await epoch.read();
   const freshMembers=Object.values(freshRegistry.reservations).filter(m=>m.epochId===registry.epoch.activation.epochId&&m.sourceLowerBound<=T);
   // A scanner can append while lifecycle work runs. Never seal admission using
   // a source cycle absent from this invocation's fully mapped F3 snapshot.
   if(!freshMembers.every(m=>m.binding&&worker.intents[JSON.parse(m.binding).sourceCycleId]?.status==='COMPLETE'&&sources.some(c=>c.envelope.sourceCycleId===JSON.parse(m.binding).sourceCycleId))){admissionBlocked=true;break;}
   const proof=deriveEpochProof(freshRegistry,T);
   const boundary=deriveBoundaryProof({minute:T,sourceFence:proof.sourceFence,
    candidateCompleteness:{minute:T,complete:true,unresolvedEarlier:false,evidenceRef:digest(eligible.map(x=>x.identity))},
    lifecycleCompleteness:{minute:T,complete:true,unresolvedEarlier:false,evidenceRef:digest(loaded.state.records)}});
   if(!boundary.sealed){admissionBlocked=true;break;}
   const candidates=pending.filter(({r})=>r.outcome.activatedAt===T).map(({x,r})=>({tradeId:x.f.tradeId,instrument:x.f.symbol,direction:x.f.direction,origin:x.f.origin,state:'WAITING_ENTRY',priorDisposition:null,capacityOccupied:false,
    eligibleEntryCandle:{timestamp:r.outcome.activatedAt,confirmed:true,verified:true,firstEligible:true}}));
   const occupancy=loaded.state.occupancy.map(o=>{
    const r=loaded.state.records[o.tradeId];if(o.state==='COMPLETED'||!r?.closureRecorded||r.outcome.status==='Expired')return o;
    const terminalCandleTimestamp=r.outcome.exitCheck?.candle?.timestamp;
    if(!Number.isFinite(terminalCandleTimestamp))return o;
    return completeTrade(o,{confirmed:true,status:r.outcome.status,terminalCandleTimestamp,releaseAvailableAt:terminalCandleTimestamp+MINUTE,resultRVerified:true,resultR:r.outcome.resultR});
   });
   const releases=occupancy.filter(o=>o.state==='COMPLETED').map(o=>({tradeId:o.tradeId,...o.terminalEvidence}));
   const batch=reduceMinute({minute:T,candidates,occupancy,releases,boundaryProof:boundary});assert(!batch.blockers.length,'ADMISSION_UNRESOLVED');
   const records=Object.fromEntries(batch.decisions.map(d=>[d.tradeId,{...loaded.state.records[d.tradeId],decision:{state:d.state,minute:T,reasons:d.reasons}}]));
   const patch={records,occupancy:batch.nextOccupancy,decisionMinute:T};
   const intent={kind:'ADMISSION_INTENT',minute:T,boundary,sourceProof:proof,candidates,occupancy,releases,batch,patch};
   const intentId=digest(['admission-intent',T]);await save(intentId,intent);
   await finishAdmission(intentId,intent);
  }
  const unresolved=Object.values(loaded.state.records).filter(r=>r.unresolved||r.ambiguitySeen).map(r=>({tradeId:r.identity.shadowCandidateId,reason:r.unresolved||'AMBIGUOUS_EVIDENCE'}));
  return {status:unresolved.length||admissionBlocked?'UNRESOLVED':'COMPLETE',generationsProcessed:processed,providerCalls:calls,unresolved,admissionBlocked};
 }catch(e){return {status:['BLOCKED_STORAGE','STALE','BUSY'].includes(e.message)?e.message:'UNRESOLVED',reasonCode:e.message,generationsProcessed:processed,providerCalls:calls};}
 finally{if(lease?.status==='OK'&&now()-start<40000)try{await control.release(owner,lease.fence);}catch{}}
}
