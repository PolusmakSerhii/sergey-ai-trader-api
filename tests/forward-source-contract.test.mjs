import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cycleIdentity,universeDigest,createCycle,updateSymbolResult,canSealCycle,
  registerSourceOperation,evaluateSourceFence,deriveBoundaryProof,classifyHealth } from '../lib/forward-validation/source-contract.js';
import { reduceMinute } from '../lib/forward-validation/engine.js';
const T='2026-10-15T10:00:00.000Z',L='2026-10-15T09:59:00.000Z',U='2026-10-15T10:01:00.000Z';
const H='a'.repeat(64),J='b'.repeat(64),clone=structuredClone;
function op(s='A',status='COMPLETED') {return {operationId:`op-${s}`,cycleId:'run:1',sourceTimeLowerBound:L,
  registeredAt:L,processingStartedAt:L,status,operationCompletedAt:status==='COMPLETED'?T:null,
  evidenceAt:status==='COMPLETED'?T:null,payloadHash:status==='COMPLETED'?H:null};}
function result(s='A',status='ANALYZED_NO_A_PLUS') {const analyzed=status.startsWith('ANALYZED_'),plus=status.startsWith('ANALYZED_A_PLUS');
  return {symbol:s,instrumentType:'SWAP',batchId:`batch-${s}`,operationId:`op-${s}`,status,
    analysisAt:analyzed?T:null,payloadHash:analyzed?H:null,capturedIdentityRefs:plus?[`id-${s}`]:[],
    captureAcks:status==='ANALYZED_A_PLUS_CAPTURED'?[ack(s)]:[]};}
function ack(s='A'){return {operationId:`op-${s}`,identityRef:`id-${s}`,payloadHash:H,ledgerRevision:1};}
function manifest(symbols=['A']) {return {runId:'run',producerSequence:1,cycleId:'run:1',cycleStartedAt:L,sourceTimeLowerBound:L,
  universeId:'explicit-universe',universeHash:universeDigest(symbols),expectedSymbols:symbols,batchCount:symbols.length,
  batches:symbols.map((s,i)=>({batchId:`batch-${s}`,batchIndex:i,expectedBatchSymbols:[s]})),
  operations:symbols.map(s=>op(s)),results:symbols.map(s=>result(s))};}
function pending(status='PENDING'){const m=manifest();m.results=[result('A',status)];m.operations=[op('A','PENDING')];return m;}
const seal=m=>canSealCycle(m).canSeal;
function fence(m=manifest()){return {minute:T,operations:clone(m.operations),sealedCycles:[m],
  registryProof:{complete:true,throughMinute:T,futureSourceTimeLowerBound:U,operationIds:m.operations.map(o=>o.operationId)}};}
function boundary(){return {minute:T,sourceFence:evaluateSourceFence(fence()),
  candidateCompleteness:{minute:T,complete:true,unresolvedEarlier:false,evidenceRef:'candidates'},
  lifecycleCompleteness:{minute:T,complete:true,unresolvedEarlier:false,evidenceRef:'candles'}};}
test('cycle identity deterministic',()=>assert.equal(cycleIdentity('run',1),'run:1'));
test('malformed cycle ID rejected',()=>{const m=manifest();m.cycleId='other';assert.throws(()=>createCycle(m));});
test('same inputs same cycle',()=>assert.deepEqual(createCycle(manifest()),createCycle(manifest())));
test('timestamp does not affect identity',()=>{const m=manifest();m.cycleStartedAt=U;assert.equal(createCycle(m).cycleId,'run:1');});
test('valid explicit universe',()=>assert.equal(seal(createCycle(manifest(['B','A']))),true));
test('duplicate universe rejected',()=>{const m=manifest();m.expectedSymbols=['A','A'];assert.throws(()=>createCycle(m));});
test('unexpected result rejected',()=>{const m=manifest();m.results[0].symbol='X';assert.throws(()=>createCycle(m));});
test('missing result blocks',()=>{const m=manifest();m.results=[];assert.equal(seal(m),false);});
test('duplicate batch membership rejected',()=>{const m=manifest(['A','B']);m.batches[1].expectedBatchSymbols=['A'];assert.throws(()=>createCycle(m));});
test('incomplete batch coverage blocks',()=>{const m=manifest(['A','B']);m.batchCount=1;m.batches.pop();m.results.pop();assert.equal(seal(m),false);});
test('input permutations canonicalized',()=>{const a=manifest(['A','B']),b=clone(a);b.expectedSymbols.reverse();b.batches.reverse();b.results.reverse();b.operations.reverse();assert.deepEqual(createCycle(a),createCycle(b));});
for(const status of ['PENDING','ANALYZED_A_PLUS_CAPTURE_PENDING','INSUFFICIENT_DATA_UNRESOLVED','ERROR_RETRYABLE','ERROR_UNRESOLVED'])
  test(`${status} blocks sealing`,()=>assert.equal(seal(pending(status)),false));
test('NO_A_PLUS seals',()=>assert.equal(seal(manifest()),true));
test('CAPTURED without ack blocks',()=>{const m=manifest();m.results=[result('A','ANALYZED_A_PLUS_CAPTURED')];m.results[0].captureAcks=[];assert.equal(seal(m),false);});
test('CAPTURED matching ack seals',()=>{const m=manifest();m.results=[result('A','ANALYZED_A_PLUS_CAPTURED')];assert.equal(seal(m),true);});
test('exact result retry idempotent',()=>{const m=createCycle(manifest());assert.deepEqual(updateSymbolResult(m,m.results[0]),m);});
test('completed result conflict rejected',()=>{const r=result();r.payloadHash=J;assert.throws(()=>updateSymbolResult(manifest(),r));});
test('retryable recovery with supplied observation accepted',()=>{const m=updateSymbolResult(pending('ERROR_RETRYABLE'),result());assert.equal(m.results[0].status,'ANALYZED_NO_A_PLUS');assert.equal(seal(m),false);});
test('completed result cannot regress',()=>assert.throws(()=>updateSymbolResult(manifest(),result('A','PENDING'))));
test('pending capture becomes captured',()=>{const m=updateSymbolResult(pending('ANALYZED_A_PLUS_CAPTURE_PENDING'),result('A','ANALYZED_A_PLUS_CAPTURED'));assert.equal(m.results[0].captureAcks.length,1);});
test('ack hash mismatch rejected',()=>{const r=result('A','ANALYZED_A_PLUS_CAPTURED');r.captureAcks[0].payloadHash=J;assert.throws(()=>updateSymbolResult(pending(),r));});
test('ack missing identity rejected',()=>{const r=result('A','ANALYZED_A_PLUS_CAPTURED');delete r.captureAcks[0].identityRef;assert.throws(()=>updateSymbolResult(pending(),r));});
test('exact duplicate ack is canonical idempotent',()=>{const r=result('A','ANALYZED_A_PLUS_CAPTURED');r.captureAcks.push(ack());assert.equal(updateSymbolResult(pending(),r).results[0].captureAcks.length,1);});
test('conflicting ack rejected',()=>{const r=result('A','ANALYZED_A_PLUS_CAPTURED');r.captureAcks.push({...ack(),ledgerRevision:2});assert.throws(()=>updateSymbolResult(pending(),r));});
test('mixed fully captured cycle seals',()=>{const m=manifest(['A','B']);m.results[1]=result('B','ANALYZED_A_PLUS_CAPTURED');assert.equal(seal(m),true);});
test('unresolved producer operation blocks',()=>{const m=manifest();m.operations=[op('A','UNRESOLVED')];assert.equal(seal(m),false);});
test('elapsed time cannot seal',()=>{const m=pending();m.elapsed=999999999;m.now='2099-01-01';assert.equal(seal(m),false);});
test('unresolved earlier operation blocks fence',()=>{const f=fence(pending());assert.equal(evaluateSourceFence(f).closed,false);});
test('completed captured operation permits fence',()=>assert.equal(evaluateSourceFence(fence()).closed,true));
test('future lower bound unresolved operation does not block',()=>{const f=fence();f.operations=[{...op('A','PENDING'),sourceTimeLowerBound:U}];f.sealedCycles=[];assert.equal(evaluateSourceFence(f).closed,true);});
test('missing lower bound fails closed',()=>{const f=fence();delete f.operations[0].sourceTimeLowerBound;assert.equal(evaluateSourceFence(f).closed,false);});
test('new operation backdated behind frontier rejected',()=>assert.throws(()=>registerSourceOperation(op(),{closedFrontier:T}),/BACKDATED_OPERATION/));
test('exact original receipt replay allowed',()=>assert.deepEqual(registerSourceOperation(op(),{closedFrontier:T,previous:op()}),op()));
test('replay different hash rejected',()=>assert.throws(()=>registerSourceOperation({...op(),payloadHash:J},{closedFrontier:T,previous:op()})));
test('complete boundary succeeds',()=>{const p=deriveBoundaryProof(boundary());assert.equal(p.sealed,true);assert.equal(p.unresolvedEarlier,false);});
for(const field of ['sourceFence','candidateCompleteness','lifecycleCompleteness'])test(`${field} incomplete fails boundary`,()=>{const b=boundary();b[field]={};assert.equal(deriveBoundaryProof(b).sealed,false);});
test('earlier lifecycle gap blocks',()=>{const b=boundary();b.lifecycleCompleteness.unresolvedEarlier=true;assert.equal(deriveBoundaryProof(b).unresolvedEarlier,true);});
test('proof accepted by unchanged engine',()=>{const p=deriveBoundaryProof(boundary());const r=reduceMinute({minute:T,candidates:[],occupancy:[],boundaryProof:p});assert.deepEqual(r.blockers,[]);});
test('capture health',()=>{const m=manifest();m.results=[result('A','ANALYZED_A_PLUS_CAPTURE_PENDING')];assert.equal(classifyHealth(canSealCycle(m)),'BLOCKED_CAPTURE');});
test('source health',()=>assert.equal(classifyHealth(canSealCycle(pending())),'BLOCKED_SOURCE'));
test('integrity health',()=>{const m=manifest();m.universeHash=J;assert.equal(classifyHealth(canSealCycle(m)),'BLOCKED_INTEGRITY');});
test('resolved healthy',()=>assert.equal(classifyHealth(canSealCycle(manifest())),'HEALTHY'));
test('source inputs unchanged',()=>{const m=pending(),before=clone(m),r=result();createCycle(m);updateSymbolResult(m,r);canSealCycle(m);assert.deepEqual(m,before);assert.deepEqual(r,result());});
test('fence inputs unchanged',()=>{const f=fence(),b=clone(f);evaluateSourceFence(f);assert.deepEqual(f,b);});
test('score/confidence cannot grant sealing',()=>{const m=pending();m.score=100;m.confidence=100;assert.equal(seal(m),false);m.score=0;m.confidence=0;assert.equal(seal(m),false);});
test('no I/O clock random timer or Core import in module',async()=>{const s=await readFile(new URL('../lib/forward-validation/source-contract.js',import.meta.url),'utf8');assert.doesNotMatch(s,/Date\.now|Math\.random|randomUUID|setTimeout|process\.|fetch\(|node:fs|api\/market|runRedisCommand/);});
test('later analysis cannot replace anchored failed result',()=>{const m=pending('ERROR_RETRYABLE');m.results[0].analysisAt=L;m.results[0].payloadHash=H;assert.throws(()=>updateSymbolResult(m,result()),/HISTORICAL_OBSERVATION_CONFLICT/);});
test('empty registry needs explicit frontier proof',()=>assert.equal(evaluateSourceFence({minute:T,operations:[],sealedCycles:[]}).closed,false));
test('registry membership must account for every operation',()=>{const f=fence();f.registryProof.operationIds=[];assert.equal(evaluateSourceFence(f).closed,false);});
test('bare seal flag is not sufficient',()=>{const f=fence();f.sealedCycles=[{cycleId:'run:1',sealed:true,operations:[]}];assert.equal(evaluateSourceFence(f).closed,false);});
test('registered after processing rejected',()=>assert.throws(()=>registerSourceOperation({...op(),registeredAt:U})));
test('invalid calendar timestamp rejected',()=>assert.throws(()=>registerSourceOperation({...op(),registeredAt:'2026-02-30T00:00:00.000Z'})));
test('wrong proof minute rejected',()=>{const b=boundary();b.candidateCompleteness.minute=U;assert.equal(deriveBoundaryProof(b).sealed,false);});
test('result operation payload must match completed receipt',()=>{const m=manifest();m.operations[0].payloadHash=J;assert.equal(seal(m),false);});
test('duplicate operation rejected',()=>{const m=manifest();m.operations.push(op());assert.equal(seal(m),false);});
test('duplicate result rejected',()=>{const m=manifest();m.results.push(result());assert.equal(seal(m),false);});
test('batch mismatch rejected',()=>{const m=manifest();m.results[0].batchId='other';assert.equal(seal(m),false);});
test('empty universe rejected',()=>assert.throws(()=>universeDigest([])));
test('invalid identity sequence rejected',()=>assert.throws(()=>cycleIdentity('run',1.1)));
test('captured identity cannot change during ack completion',()=>{const r=result('A','ANALYZED_A_PLUS_CAPTURED');r.capturedIdentityRefs=['other'];r.captureAcks[0].identityRef='other';assert.throws(()=>updateSymbolResult(pending('ANALYZED_A_PLUS_CAPTURE_PENDING'),r));});

test('sealed cycle cannot conceal operation outside registry',()=>{const f=fence(manifest(['A','B']));f.operations.pop();f.registryProof.operationIds.pop();assert.equal(evaluateSourceFence(f).closed,false);});
