import { canonicalJSON } from './source-contract.js';
import { producerHash } from './producer-store.js';
import { immutableOriginHash } from './store.js';

// Coordinates injected stores only. No transaction construction, market data or Core I/O.
const copy=x=>JSON.parse(canonicalJSON(x));
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const text=x=>typeof x==='string'&&x.length>0&&x.trim()===x;
function requireFact(ok,reason){if(!ok)throw Object.assign(new Error(reason),{integrity:true});}
function failure(r,stage){
  const status=['STALE','BLOCKED_STORAGE','UNRESOLVED','BLOCKED_INTEGRITY'].includes(r?.status)?r.status:
    ['STORAGE_ERROR','NOT_FOUND','RUN_NOT_FOUND'].includes(r?.status)?'UNRESOLVED':'BLOCKED_INTEGRITY';
  return {status,stage,reason:r?.reason??r?.message??r?.status??'MISSING_STORE_RESULT'};
}
function validateProducer(r,captureOperationId,expectedIntent) {
  requireFact(Number.isSafeInteger(r.revision)&&r.state&&Array.isArray(r.state.captures)&&
    Array.isArray(r.state.operations)&&Array.isArray(r.state.generations),'MISSING_PRODUCER_DURABILITY_PRIMITIVE');
  const cap=r.state.captures.find(c=>c.intent?.captureOperationId===captureOperationId);
  requireFact(cap,'CAPTURE_INTENT_MISSING');const i=cap.intent;
  if(expectedIntent!==undefined)requireFact(same(i,expectedIntent),'CALLER_INTENT_CONFLICT');
  requireFact(['PENDING','UNRESOLVED','RECEIPT_RECEIVED','ACKNOWLEDGED'].includes(cap.state),'INVALID_CAPTURE_STATE');
  const op=r.state.operations.find(o=>o.operationId===i.sourceOperationId);
  requireFact(op?.intent&&op.result&&op.result.operationId===i.sourceOperationId,'SOURCE_PAYLOAD_MISSING');
  requireFact(op.result.status==='ANALYZED_A_PLUS_CAPTURE_PENDING'&&producerHash(op.result.payload)===i.payloadHash&&
    op.result.payloadHash===i.payloadHash,'SOURCE_HASH_CONFLICT');
  const g=r.state.generations.find(g=>g.shadowCandidateId===i.shadowCandidateId);
  requireFact(g?.original&&Number.isSafeInteger(g.generationSequence)&&g.generationSequence>0&&
    Number.isSafeInteger(g.revision)&&g.revision<=r.revision,'GENERATION_MISSING');
  const f=g.original.frozenCandidate,originOp=r.state.operations.find(o=>o.operationId===g.original.originalSourceOperationId);
  requireFact(originOp?.result&&same(originOp.result.payload.frozenCandidate,f)&&
    producerHash(originOp.result.payload)===originOp.result.payloadHash&&
    producerHash(f)===g.original.frozenFactsHash,'GENERATION_FROZEN_CONFLICT');
  requireFact(g.original.identityOrigin==='SHADOW_ONLY'&&g.original.shadowCandidateId===i.shadowCandidateId&&
    f.tradeId===i.shadowCandidateId&&g.setupKey===f.setupKey&&g.setupKey===`${f.symbol}:${f.direction}`&&
    op.intent.symbol===f.symbol&&op.intent.instrumentType===f.instrumentType&&
    f.origin.detectedAt===g.original.originalCapturedAt&&f.initialPlan.createdAt===g.original.originalCapturedAt,'GENERATION_IDENTITY_CONFLICT');
  const directlyLinked=op.result.identityRefs.includes(i.shadowCandidateId);
  const linked=r.state.generationLinks?.some(l=>l.sourceOperationId===i.sourceOperationId&&
    l.shadowCandidateId===i.shadowCandidateId&&op.result.identityRefs.includes(l.proposedIdentity));
  requireFact(directlyLinked||linked,'SOURCE_GENERATION_LINK_MISSING');
  const tx=i.transaction;
  requireFact(tx&&same(Object.keys(tx).sort(),['events','expectedLedgerRevision','operationId','records'])&&
    tx.operationId===captureOperationId&&Number.isSafeInteger(i.expectedShadowRevision)&&i.expectedShadowRevision>=0&&
    tx.expectedLedgerRevision===i.expectedShadowRevision&&producerHash(tx)===i.transactionHash,'TRANSACTION_CONFLICT');
  requireFact(Array.isArray(tx.records)&&tx.records.length<=1&&Array.isArray(tx.events)&&tx.events.length>0,'INVALID_CAPTURE_TRANSACTION');
  for(const change of tx.records){
    requireFact(change.expectedRevision===null&&change.record?.revision===0&&
      ['DETECTED','WAITING_ENTRY'].includes(change.record.state),'CAPTURE_CANNOT_UPDATE_LIFECYCLE');
    validateRecord(change.record,g,originOp.result);
  }
  const eventIds=new Set(),sourceRevisions=new Set();
  for(const e of tx.events){
    requireFact(text(e.eventId)&&!eventIds.has(e.eventId)&&Number.isSafeInteger(e.sourceRevision)&&e.sourceRevision>=0&&
      !sourceRevisions.has(e.sourceRevision)&&e.sourceOperationId===i.sourceOperationId&&e.identity===i.shadowCandidateId&&
      e.evidenceHash===producerHash(e.payload),'EVENT_CONFLICT');
    eventIds.add(e.eventId);sourceRevisions.add(e.sourceRevision);
    requireFact(e.payload.sourceOperationId===i.sourceOperationId&&e.payload.sourcePayloadHash===i.payloadHash&&
      e.payload.shadowCandidateId===i.shadowCandidateId&&e.payload.frozenFactsHash===g.original.frozenFactsHash&&
      e.payload.generationSequence===g.generationSequence,'EVENT_PROVENANCE_CONFLICT');
  }
  return {producer:r,cap,intent:i,generation:g,originResult:originOp.result};
}
function validateRecord(record,g,originResult){
  const f=g.original.frozenCandidate;
  requireFact(record.identityOrigin==='SHADOW_ONLY'&&record.coreTradeId===null&&record.shadowCandidateId===g.shadowCandidateId&&
    record.immutableOriginHash===immutableOriginHash(record),'SHADOW_IDENTITY_CONFLICT');
  for(const k of ['setupKey','symbol','direction','instrumentType','origin','initialPlan','originalEligibility'])
    requireFact(same(record[k],f[k]),'SHADOW_FROZEN_CONFLICT');
  requireFact(record.analysisAt===originResult.analysisAt,'SHADOW_ANALYSIS_ORIGIN_CONFLICT');
}
function shadowEvidence(r,ctx,runId){
  const l=r.ledger,i=ctx.intent;
  requireFact(l?.meta?.mode==='SHADOW'&&l.meta.runId===runId&&l.meta.officialActivationId===null&&
    l.meta.officialActivationAt===null&&Array.isArray(l.operations)&&Array.isArray(l.records)&&Array.isArray(l.events),
    'MISSING_SHADOW_DURABILITY_PRIMITIVE');
  const receipt=l.operations.find(o=>o.operationId===i.captureOperationId);
  if(!receipt){
    requireFact(ctx.cap.receipt===null&&ctx.cap.state!=='ACKNOWLEDGED'&&ctx.cap.state!=='RECEIPT_RECEIVED','PRODUCER_ACK_WITHOUT_SHADOW_RECEIPT');
    const existing=l.records.filter(r=>r.shadowCandidateId===i.shadowCandidateId);
    requireFact(existing.length<=1,'SHADOW_RECORD_DUPLICATE');
    if(existing.length) {
      validateRecord(existing[0],ctx.generation,ctx.originResult);
      if(i.transaction.records.length)requireFact(existing[0].immutableOriginHash===i.transaction.records[0].record.immutableOriginHash,'SHADOW_RECORD_CONFLICT');
    }else requireFact(i.transaction.records.length===1,'CAPTURE_RECORD_MISSING');
    return null;
  }
  requireFact(receipt.requestHash===i.transactionHash&&receipt.ledgerRevision===i.expectedShadowRevision+1&&
    l.meta.ledgerRevision>=receipt.ledgerRevision,'SHADOW_RECEIPT_CONFLICT');
  const rows=l.records.filter(r=>r.shadowCandidateId===i.shadowCandidateId);
  requireFact(rows.length===1,'SHADOW_RECORD_MISSING_OR_DUPLICATE');validateRecord(rows[0],ctx.generation,ctx.originResult);
  if(i.transaction.records.length)requireFact(rows[0].immutableOriginHash===i.transaction.records[0].record.immutableOriginHash,'SHADOW_RECORD_CONFLICT');
  for(const event of i.transaction.events){
    const found=l.events.filter(e=>e.eventId===event.eventId);
    requireFact(found.length===1&&same(found[0],event),'SHADOW_EVENT_CONFLICT');
  }
  const mapped={operationId:i.captureOperationId,sourceOperationId:i.sourceOperationId,identityRef:i.shadowCandidateId,
    payloadHash:i.payloadHash,transactionHash:i.transactionHash,ledgerRevision:receipt.ledgerRevision};
  if(ctx.cap.receipt!==null)requireFact(same(ctx.cap.receipt,mapped),'PRODUCER_RECEIPT_CONFLICT');
  return mapped;
}
export function createCaptureAdapter({producerStore,shadowStore}={}){
  requireFact(['read','receiveCaptureReceipt','acknowledgeCapture'].every(k=>typeof producerStore?.[k]==='function')&&
    ['read','commit'].every(k=>typeof shadowStore?.[k]==='function'),'MISSING_DURABILITY_PRIMITIVE');
  const guarded=fn=>async input=>{try{return await fn(copy(input));}catch(e){return {status:e.integrity?'BLOCKED_INTEGRITY':'UNRESOLVED',reason:e.message};}};
  async function load(input){
    requireFact(input&&text(input.runId)&&text(input.captureOperationId)&&
      Object.keys(input).every(k=>['runId','captureOperationId','expectedIntent'].includes(k)),'INVALID_CAPTURE_INPUT');
    const p=await producerStore.read(input.runId);if(p?.status!=='OK')return {error:failure(p,'producer-read')};
    const ctx=validateProducer(p,input.captureOperationId,input.expectedIntent);
    const s=await shadowStore.read(input.runId);if(s?.status!=='OK')return {error:failure(s,'shadow-read')};
    return {...ctx,receipt:shadowEvidence(s,ctx,input.runId)};
  }
  function result(ctx,status){const r=ctx.receipt;return {status,captureOperationId:ctx.intent.captureOperationId,
    identityRef:ctx.intent.shadowCandidateId,receipt:r,
    captureAck:r?{operationId:ctx.intent.sourceOperationId,payloadHash:r.payloadHash,ledgerRevision:r.ledgerRevision,identityRef:r.identityRef}:null};}
  const inspect=guarded(async input=>{const ctx=await load(input);if(ctx.error)return ctx.error;
    return {...result(ctx,ctx.cap.state==='ACKNOWLEDGED'?'IDEMPOTENT':'UNRESOLVED'),
      producerState:ctx.cap.state,shadowCommitted:ctx.receipt!==null};});
  const capture=guarded(async input=>{
    let ctx=await load(input);if(ctx.error)return ctx.error;
    const original=copy(ctx.intent),checked={...input,expectedIntent:original};
    if(ctx.cap.state==='ACKNOWLEDGED')return result(ctx,'IDEMPOTENT');
    if(!ctx.receipt){
      const committed=await shadowStore.commit(input.runId,copy(original.transaction));
      if(!['OK','IDEMPOTENT'].includes(committed?.status))return failure(committed,'shadow-commit');
      // A success flag alone is insufficient: read the durable exact transaction receipt/events.
      ctx=await load(checked);if(ctx.error)return ctx.error;
      requireFact(ctx.receipt,'SHADOW_SUCCESS_WITHOUT_RECEIPT');
    }
    if(ctx.cap.receipt===null){
      const saved=await producerStore.receiveCaptureReceipt(input.runId,{
        requestId:canonicalJSON(['capture-adapter-v1',input.captureOperationId,'receipt',ctx.producer.revision]),
        expectedRevision:ctx.producer.revision,data:{captureOperationId:input.captureOperationId,receipt:copy(ctx.receipt)}});
      if(!['OK','IDEMPOTENT'].includes(saved?.status))return failure(saved,'producer-receipt');
      ctx=await load(checked);if(ctx.error)return ctx.error;
      requireFact(ctx.cap.receipt!==null,'PRODUCER_SUCCESS_WITHOUT_RECEIPT');
    }
    if(ctx.cap.state!=='ACKNOWLEDGED'){
      const saved=await producerStore.acknowledgeCapture(input.runId,{
        requestId:canonicalJSON(['capture-adapter-v1',input.captureOperationId,'ack',ctx.producer.revision]),
        expectedRevision:ctx.producer.revision,data:{captureOperationId:input.captureOperationId}});
      if(!['OK','IDEMPOTENT'].includes(saved?.status))return failure(saved,'producer-ack');
      ctx=await load(checked);if(ctx.error)return ctx.error;
      requireFact(ctx.cap.state==='ACKNOWLEDGED','PRODUCER_SUCCESS_WITHOUT_ACK');
    }
    return result(ctx,'OK');
  });
  return {capture,recover:capture,inspect};
}
