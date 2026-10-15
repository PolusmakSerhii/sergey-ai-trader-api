import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createProducerStore,producerHash,producerKey} from '../lib/forward-validation/producer-store.js';
import {createShadowStore,immutableOriginHash,shadowKey} from '../lib/forward-validation/store.js';
import {universeDigest} from '../lib/forward-validation/source-contract.js';
import {createCaptureAdapter} from '../lib/forward-validation/capture-adapter.js';
const exec=promisify(execFile),T='2026-10-15T10:00:00.000Z',SHA='a698b88a4286dd032ab098d38fc3753b9aa4f149',clone=structuredClone;
const pBudget=()=>({maxBytes:5000000,maxCycles:100,maxOperations:100,maxEvents:100,maxGenerations:100,
  maxRetainedPayloadBytes:4000000,maxPayloadBytes:1000000,maxIdempotencyReceipts:100});
const sBudget=()=>({maxBytes:1000000,maxRecords:100,maxEvents:100,maxOperations:100});
test('capture adapter with two isolated local stores',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm1m-capture-')),socket=join(dir,'redis.sock');
  const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
  let spawnError;server.on('error',e=>{spawnError=e;});const commands=[];
  const redis=async cmd=>{commands.push(clone(cmd));const {stdout}=await exec('redis-cli',['-s',socket,'--json',...cmd.map(String)],{maxBuffer:12*1024*1024});
    if(stdout.startsWith('error:'))throw new Error(stdout);return JSON.parse(stdout);};
  const producer=createProducerStore(redis),shadow=createShadowStore(redis);let runs=0,requests=0;
  const send=async(id,type,data)=>{const r=await producer.read(id);assert.equal(r.status,'OK',r.reason);
    const out=await producer[type](id,{requestId:`q-${++requests}`,expectedRevision:r.revision,data});assert.equal(out.status,'OK',out.reason);return out;};
  async function fixture({producerBudget={},shadowBudget={},alterIntent=null,prepare=true}={}){
    const id=`capture-${++runs}`;
    assert.equal((await producer.createRun({runId:id,mode:'SHADOW',schemaVersion:1,coreCommit:SHA,officialActivationId:null,
      officialActivationAt:null,budget:{...pBudget(),...producerBudget}})).status,'OK');
    assert.equal((await shadow.createRun({runId:id,mode:'SHADOW',schemaVersion:1,protocolVersion:'1.1',admissionVersion:'1.1',coreCommit:SHA,
      officialActivationId:null,officialActivationAt:null,ledgerRevision:0,captureWatermark:null,decisionWatermark:null,health:'HEALTHY',failureReason:null,
      storageBudget:{...sBudget(),...shadowBudget}})).status,'CREATED');
    const cid=(await send(id,'allocateCycle',{allocationId:'alloc',cycleStartedAt:T,sourceTimeLowerBound:T})).reply.cycleId;
    await send(id,'freezeManifest',{cycleId:cid,universeId:'test',universeHash:universeDigest(['AAA']),expectedSymbols:['AAA'],batchCount:1,
      batches:[{batchId:'batch',batchIndex:0,expectedBatchSymbols:['AAA']}]});
    const op=`${cid}:SWAP:AAA`;
    await send(id,'registerOperation',{operationId:op,cycleId:cid,batchId:'batch',batchIndex:0,symbol:'AAA',instrumentType:'SWAP',
      sourceTimeLowerBound:T,registeredAt:T,processingStartedAt:T});
    const candidateId=`AAA:Long:${T}`,f={tradeId:candidateId,setupKey:'AAA:Long',symbol:'AAA',direction:'Long',instrumentType:'SWAP',
      origin:{detectedAt:T},initialPlan:{createdAt:T,entryZone:{from:99,to:101},stopLoss:95,takeProfit1:110,exitStrategy:{version:'tp1-50-reanalyse-v1'}},
      originalEligibility:{confirmedAPlus:true}};
    const payload={symbol:'AAA',instrumentType:'SWAP',analysisAt:T,capturedAt:T,status:'ANALYZED_A_PLUS_CAPTURE_PENDING',identityRefs:[candidateId],frozenCandidate:f};
    const ph=producerHash(payload);
    await send(id,'persistResult',{operationId:op,analysisAt:T,capturedAt:T,completedAt:T,status:payload.status,identityRefs:[candidateId],payload,payloadHash:ph});
    const g={setupKey:f.setupKey,shadowCandidateId:candidateId,identityOrigin:'SHADOW_ONLY',originalSourceOperationId:op,originalCapturedAt:T,
      frozenCandidate:f,frozenFactsHash:producerHash(f)};
    await send(id,'getOrCreateGeneration',g);
    const record={identityOrigin:'SHADOW_ONLY',coreTradeId:null,shadowCandidateId:candidateId,setupKey:f.setupKey,symbol:f.symbol,instrumentType:f.instrumentType,
      direction:f.direction,origin:f.origin,analysisAt:T,initialPlan:f.initialPlan,originalEligibility:f.originalEligibility,state:'WAITING_ENTRY',priorDisposition:null,
      capacityOccupied:false,verificationCursor:null,verifiedThrough:null,unresolvedReason:null,eligibleEntryCandle:null,admissionDecision:null,skipReason:null,
      lifecycleEvidenceRefs:[],terminal:null,recordedAt:T,updatedAt:T,revision:0};record.immutableOriginHash=immutableOriginHash(record);
    const ep={sourceOperationId:op,sourcePayloadHash:ph,shadowCandidateId:candidateId,frozenFactsHash:g.frozenFactsHash,generationSequence:1};
    const event={eventId:`${op}:observed`,sourceOperationId:op,sourceRevision:0,identity:candidateId,type:'CAPTURED',eventTime:T,observedAt:T,
      payload:ep,evidenceHash:producerHash(ep)};
    const captureId=`capture:${op}`,tx={operationId:captureId,expectedLedgerRevision:0,records:[{expectedRevision:null,record}],events:[event]};
    const intent={captureOperationId:captureId,sourceOperationId:op,shadowCandidateId:candidateId,payloadHash:ph,expectedShadowRevision:0,transaction:tx,transactionHash:producerHash(tx)};
    if(alterIntent){alterIntent(intent);intent.transactionHash=producerHash(intent.transaction);}
    if(prepare)await send(id,'prepareCapture',intent);
    const input={runId:id,captureOperationId:captureId};
    return {id,cid,op,candidateId,f,g,intent,input,adapter:createCaptureAdapter({producerStore:producer,shadowStore:shadow})};
  }
  const capture=async x=>{const r=await x.adapter.capture(x.input);assert.equal(r.status,'OK',JSON.stringify(r));return r;};
  const pstate=async x=>(await producer.read(x.id)).state;
  const ledger=async x=>(await shadow.read(x.id)).ledger;
  const adapter=(p=producer,s=shadow)=>createCaptureAdapter({producerStore:p,shadowStore:s});
  const corruptProducer=fn=>({...producer,read:async id=>{const r=await producer.read(id);fn(r);return r;}});
  try{
    let ready=false;for(let n=0;n<100;n++){if(spawnError)throw spawnError;try{if(await redis(['PING'])==='PONG'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,20));}assert.equal(ready,true);
    await t.test('inspect pending durable intent is read-only',async()=>{const x=await fixture(),before=await redis(['GET',producerKey(x.id)]);const r=await x.adapter.inspect(x.input);assert.equal(r.status,'UNRESOLVED');assert.equal(r.producerState,'PENDING');assert.equal(r.shadowCommitted,false);assert.equal(await redis(['GET',producerKey(x.id)]),before);});
    await t.test('executes EXACT persisted transaction',async()=>{const x=await fixture();let used;const a=adapter(producer,{...shadow,commit:async(id,tx)=>{used=clone(tx);return shadow.commit(id,tx);}});assert.equal((await a.capture(x.input)).status,'OK');assert.deepEqual(used,x.intent.transaction);});
    await t.test('Shadow success and Producer receipt finalized',async()=>{const x=await fixture(),r=await capture(x),s=await pstate(x);assert.equal(s.captures[0].state,'ACKNOWLEDGED');assert.deepEqual(s.captures[0].receipt,r.receipt);assert.equal((await ledger(x)).operations.length,1);});
    await t.test('ack shape compatible with source contract',async()=>{const x=await fixture(),r=await capture(x),c=await producer.readCycle(x.id,x.cid);assert.equal(c.proof.canSeal,true);assert.deepEqual(c.manifest.results[0].captureAcks,[r.captureAck]);assert.equal(r.captureAck.operationId,x.op);});
    await t.test('SHADOW_ONLY remains and Core id null',async()=>{const x=await fixture();await capture(x);const r=(await ledger(x)).records[0];assert.equal(r.identityOrigin,'SHADOW_ONLY');assert.equal(r.coreTradeId,null);assert.equal(r.shadowCandidateId,x.candidateId);});
    await t.test('source hash distinct from event and transaction hashes',async()=>{const x=await fixture(),r=await capture(x);assert.equal(r.receipt.payloadHash,x.intent.payloadHash);assert.equal(r.receipt.transactionHash,x.intent.transactionHash);assert.notEqual(r.receipt.payloadHash,x.intent.transaction.events[0].evidenceHash);assert.notEqual(r.receipt.payloadHash,r.receipt.transactionHash);});
    await t.test('frozen mismatch blocks before Shadow mutation',async()=>{const x=await fixture({alterIntent:i=>{i.transaction.records[0].record.initialPlan.stopLoss=94;i.transaction.records[0].record.immutableOriginHash=immutableOriginHash(i.transaction.records[0].record);}});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_INTEGRITY');assert.equal((await ledger(x)).meta.ledgerRevision,0);});
    await t.test('caller cannot retarget intent',async()=>{const x=await fixture(),expected=clone(x.intent);expected.shadowCandidateId='newest';assert.equal((await x.adapter.capture({...x.input,expectedIntent:expected})).status,'BLOCKED_INTEGRITY');});
    await t.test('caller extra market facts rejected',async()=>{const x=await fixture();assert.equal((await x.adapter.capture({...x.input,currentPrice:123})).status,'BLOCKED_INTEGRITY');});
    await t.test('generation hash conflict blocks',async()=>{const x=await fixture(),a=adapter(corruptProducer(r=>r.state.generations[0].original.frozenFactsHash='0'.repeat(64)));assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('wrong original source operation blocks',async()=>{const x=await fixture(),a=adapter(corruptProducer(r=>r.state.generations[0].original.originalSourceOperationId='missing'));assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('generation sequence bound to event',async()=>{const x=await fixture({alterIntent:i=>{i.transaction.events[0].payload.generationSequence=2;i.transaction.events[0].evidenceHash=producerHash(i.transaction.events[0].payload);}});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('exact completed retry same evidence without writes',async()=>{const x=await fixture(),r=await capture(x),p=await redis(['GET',producerKey(x.id)]),s=await redis(['GET',shadowKey(x.id)]);const retry=await x.adapter.capture(x.input);assert.equal(retry.status,'IDEMPOTENT');assert.deepEqual(retry.receipt,r.receipt);assert.equal(await redis(['GET',producerKey(x.id)]),p);assert.equal(await redis(['GET',shadowKey(x.id)]),s);});
    await t.test('duplicate delivery one identity one event',async()=>{const x=await fixture();await capture(x);await x.adapter.recover(x.input);const l=await ledger(x);assert.equal(l.records.length,1);assert.equal(l.events.length,1);});
    await t.test('crash before Shadow commit preserves pending',async()=>{const x=await fixture(),a=adapter(producer,{...shadow,commit:async()=>{throw new Error('crash');}});assert.equal((await a.capture(x.input)).status,'UNRESOLVED');assert.equal((await pstate(x)).captures[0].state,'PENDING');await capture(x);});
    await t.test('crash after Shadow commit before Producer receipt',async()=>{const x=await fixture(),a=adapter({...producer,receiveCaptureReceipt:async()=>{throw new Error('crash');}});assert.equal((await a.capture(x.input)).status,'UNRESOLVED');assert.equal((await ledger(x)).operations.length,1);await capture(x);assert.equal((await ledger(x)).operations.length,1);});
    await t.test('lost Shadow response recovered by persisted exact receipt',async()=>{const x=await fixture(),a=adapter(producer,{...shadow,commit:async(id,tx)=>{await shadow.commit(id,tx);throw new Error('lost response');}});assert.equal((await a.capture(x.input)).status,'UNRESOLVED');assert.equal((await x.adapter.recover(x.input)).status,'OK');assert.equal((await ledger(x)).events.length,1);});
    await t.test('crash after producer receipt before ack',async()=>{const x=await fixture(),a=adapter({...producer,acknowledgeCapture:async()=>{throw new Error('crash');}});assert.equal((await a.capture(x.input)).status,'UNRESOLVED');assert.equal((await pstate(x)).captures[0].state,'RECEIPT_RECEIVED');assert.equal((await x.adapter.recover(x.input)).status,'OK');});
    await t.test('lost Producer receipt response recovery',async()=>{const x=await fixture(),a=adapter({...producer,receiveCaptureReceipt:async(...args)=>{await producer.receiveCaptureReceipt(...args);throw new Error('lost');}});assert.equal((await a.capture(x.input)).status,'UNRESOLVED');await capture(x);});
    await t.test('lost final acknowledgement response recovery',async()=>{const x=await fixture(),a=adapter({...producer,acknowledgeCapture:async(...args)=>{await producer.acknowledgeCapture(...args);throw new Error('lost');}});assert.equal((await a.capture(x.input)).status,'UNRESOLVED');assert.equal((await x.adapter.recover(x.input)).status,'IDEMPOTENT');});
    await t.test('restart uses persisted stores and transaction',async()=>{const x=await fixture();assert.equal((await shadow.commit(x.id,x.intent.transaction)).status,'OK');const a=createCaptureAdapter({producerStore:createProducerStore(redis),shadowStore:createShadowStore(redis)});assert.equal((await a.recover(x.input)).status,'OK');});
    await t.test('exact committed transaction recognized after revision advanced',async()=>{const x=await fixture();await shadow.commit(x.id,x.intent.transaction);await shadow.commit(x.id,{operationId:'later',expectedLedgerRevision:1,records:[],events:[]});await capture(x);assert.equal((await ledger(x)).meta.ledgerRevision,2);});
    await t.test('genuine stale revision never rebuilt',async()=>{const x=await fixture();await shadow.commit(x.id,{operationId:'other',expectedLedgerRevision:0,records:[],events:[]});const before=await redis(['GET',producerKey(x.id)]);assert.equal((await x.adapter.capture(x.input)).status,'STALE');assert.equal(await redis(['GET',producerKey(x.id)]),before);assert.equal((await ledger(x)).records.length,0);});
    await t.test('same Shadow operation ID different hash blocks',async()=>{const x=await fixture();await shadow.commit(x.id,{operationId:x.intent.captureOperationId,expectedLedgerRevision:0,records:[],events:[]});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('persisted transaction hash conflict blocks',async()=>{const x=await fixture(),a=adapter(corruptProducer(r=>r.state.captures[0].intent.transactionHash='1'.repeat(64)));assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('conflicting Shadow event evidence blocks',async()=>{const x=await fixture();await shadow.commit(x.id,x.intent.transaction);const a=adapter(producer,{...shadow,read:async id=>{const r=await shadow.read(id);r.ledger.events[0].payload.sourcePayloadHash='other';return r;}});assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('conflicting Producer receipt blocks',async()=>{const x=await fixture();await capture(x);const a=adapter(corruptProducer(r=>r.state.captures[0].receipt.ledgerRevision=999));assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('Producer storage overflow preserves recoverable Shadow evidence',async()=>{const x=await fixture({producerBudget:{maxEvents:6}});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_STORAGE');assert.equal((await ledger(x)).records.length,1);assert.equal((await pstate(x)).captures[0].state,'PENDING');});
    await t.test('Producer ack overflow leaves receipt not false completion',async()=>{const x=await fixture({producerBudget:{maxEvents:7}});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_STORAGE');assert.equal((await pstate(x)).captures[0].state,'RECEIPT_RECEIVED');});
    await t.test('Shadow storage overflow no false completion',async()=>{const x=await fixture({shadowBudget:{maxBytes:1200}});const before=await redis(['GET',shadowKey(x.id)]);assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_STORAGE');assert.equal(await redis(['GET',shadowKey(x.id)]),before);assert.equal((await pstate(x)).captures[0].state,'PENDING');});
    await t.test('capture does not seal or advance watermarks',async()=>{const x=await fixture();await capture(x);const l=await ledger(x);assert.equal(l.meta.captureWatermark,null);assert.equal(l.meta.decisionWatermark,null);assert.equal((await pstate(x)).cycles[0].sealed,false);});
    await t.test('transaction with metadata mutation rejected',async()=>{const x=await fixture({alterIntent:i=>i.transaction.metadata={captureWatermark:T}});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('transaction cannot update lifecycle',async()=>{const x=await fixture({alterIntent:i=>i.transaction.records[0].expectedRevision=0});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('source payload missing blocks',async()=>{const x=await fixture(),a=adapter(corruptProducer(r=>r.state.operations[0].result=null));assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('source operation missing blocks',async()=>{const x=await fixture(),a=adapter(corruptProducer(r=>r.state.operations=[]));assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('capture needs durable intent',async()=>{const x=await fixture({prepare:false});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('capture needs historical generation',async()=>{const x=await fixture(),a=adapter(corruptProducer(r=>r.state.generations=[]));assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('unresolved producer read propagated',async()=>{const x=await fixture(),a=adapter({...producer,read:async()=>({status:'UNRESOLVED',reason:'unavailable'})});assert.equal((await a.capture(x.input)).status,'UNRESOLVED');assert.equal((await pstate(x)).captures[0].state,'PENDING');});
    await t.test('missing durability API fails closed',()=>assert.throws(()=>createCaptureAdapter({producerStore:producer,shadowStore:{commit:shadow.commit}}),/MISSING_DURABILITY/));
    await t.test('missing receipt collection blocks',async()=>{const x=await fixture(),a=adapter(producer,{...shadow,read:async id=>{const r=await shadow.read(id);delete r.ledger.operations;return r;}});assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('success flag without durable Shadow receipt blocks',async()=>{const x=await fixture(),a=adapter(producer,{...shadow,commit:async()=>({status:'OK'})});assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');assert.equal((await pstate(x)).captures[0].state,'PENDING');});
    await t.test('acknowledged producer without Shadow proof blocks',async()=>{const x=await fixture();await capture(x);const a=adapter(producer,{...shadow,read:async id=>{const r=await shadow.read(id);r.ledger.operations=[];return r;}});assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('producer CAS stale is surfaced not forced',async()=>{const x=await fixture(),a=adapter({...producer,receiveCaptureReceipt:async()=>({status:'STALE'})});assert.equal((await a.capture(x.input)).status,'STALE');assert.equal((await pstate(x)).captures[0].state,'PENDING');});
    await t.test('producer recovery completed after success',async()=>{const x=await fixture();await capture(x);const r=await producer.readRecoveryState(x.id);assert.equal(r.pendingCaptures.length,0);assert.equal(r.receiptsAwaitingFinalization.length,0);assert.equal(r.resultsAwaitingCapture.length,0);});
    await t.test('immutable caller input',async()=>{const x=await fixture(),input={...x.input,expectedIntent:clone(x.intent)},before=clone(input);await x.adapter.capture(input);assert.deepEqual(input,before);});
    await t.test('no retargeting to latest generation',async()=>{const x=await fixture(),a=adapter(corruptProducer(r=>{r.state.generations.push({...clone(r.state.generations[0]),shadowCandidateId:'latest',generationSequence:2});}));assert.equal((await a.capture(x.input)).status,'OK');assert.equal((await ledger(x)).records[0].shadowCandidateId,x.candidateId);});
    await t.test('wrong source payload hash blocks',async()=>{const x=await fixture(),a=adapter(corruptProducer(r=>r.state.operations[0].result.payload.changed=true));assert.equal((await a.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('core identity mutation refused',async()=>{const x=await fixture({alterIntent:i=>{const r=i.transaction.records[0].record;r.identityOrigin='CORE_REGISTERED';r.coreTradeId=r.shadowCandidateId;r.immutableOriginHash=immutableOriginHash(r);}});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('event source mismatch blocks',async()=>{const x=await fixture({alterIntent:i=>i.transaction.events[0].sourceOperationId='other'});assert.equal((await x.adapter.capture(x.input)).status,'BLOCKED_INTEGRITY');});
    await t.test('no reset/force completion API',()=>{const a=adapter();assert.deepEqual(Object.keys(a).sort(),['capture','inspect','recover']);});
    await t.test('only two isolated namespaces touched',async()=>{for(const c of commands){if(['GET','SET'].includes(c[0]))assert.match(c[1],/^sergey-ai:forward-shadow:v1:capture-\d+:(producer-ledger|ledger)$/);if(c[0]==='EVAL')assert.match(c[3],/^sergey-ai:forward-shadow:v1:capture-\d+:(producer-ledger|ledger)$/);}assert.ok((await redis(['KEYS','*'])).every(k=>/^sergey-ai:forward-shadow:v1:capture-\d+:(producer-ledger|ledger)$/.test(k)));});
    await t.test('no transport clock random or Core imports',async()=>{const s=await readFile(new URL('../lib/forward-validation/capture-adapter.js',import.meta.url),'utf8');assert.doesNotMatch(s,/Date\.now|randomUUID|Math\.random|fetch\(|node:fs|process\.|api\/market|runRedisCommand|registerOpenTrade|createProducerStore|createShadowStore/);});
  }finally{if(server.exitCode===null){const exited=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await exited;}await rm(dir,{recursive:true,force:true});}
});
