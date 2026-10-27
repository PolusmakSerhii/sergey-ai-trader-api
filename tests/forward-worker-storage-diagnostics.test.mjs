import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJSON} from '../lib/forward-validation/source-contract.js';
import {buildObservationCycle,digest,OBSERVATION_KEY} from '../lib/forward-validation/observation-store.js';
import {WORKER_KEY} from '../lib/forward-validation/worker-store.js';
const exec=promisify(execFile),T='2026-10-18T10:00:00.000Z',W='2026-10-18T11:00:00.000Z';
const url=new URL('../lib/forward-validation/worker.js',import.meta.url);
const current=await readFile(url,'utf8');
const {stdout:baseline}=await exec('git',['show','3b5bfb7c74a61ec24d6412a13e010d290a7dc802:lib/forward-validation/worker.js'],{cwd:new URL('..',import.meta.url)});
function cycle(){
 const symbol='PRIVATE_SYMBOL',initialPlan={createdAt:T,plannedAt:T,expiresAt:'2026-10-19T10:00:00.000Z',entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,exitStrategy:{version:'tp1-50-reanalyse-v1'}};
 const f={symbol,direction:'Long',instrumentType:'SWAP',setupKey:symbol+':Long',tradeId:symbol+':Long:'+T,origin:{detectedAt:T},initialPlan,originalEligibility:{confirmedAPlus:true}};
 return buildObservationCycle({ok:true,status:'ready',mode:'global-ranking',version:'1.0',generatedAt:T,resultsFailed:0,globalRanking:[{
 symbol,direction:'Long',instrumentType:'SWAP',origin:f.origin,initialPlan,analysisContext:{analysisAt:T},entryZone:initialPlan.entryZone,stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,
 opportunityScore:90,confidence:90,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true},riskReward:3,researchProjectionJSON:JSON.stringify({frozenCandidate:f})}]},()=>true);
}
async function load(source,events,scenario){
 const m=new vm.SourceTextModule(source,{identifier:url.href});
 await m.link(async spec=>{
  const actual=await import(spec.startsWith('.')?new URL(spec,url).href:spec),exports={...actual};
  if(spec.endsWith('/delayed-ingestion.js')&&scenario.invalidMapping)exports.mapObservation=()=>({status:'BLOCKED_MAPPING',reasonCodes:['MISSING_FROZEN_PLAN']});
  for(const [file,factory,component]of [['worker-store.js','createWorkerStore','WORKER_STATE'],['producer-store.js','createProducerStore','PRODUCER_LEDGER'],['store.js','createShadowStore','SHADOW_LEDGER']]){
   if(spec.endsWith('/'+file))exports[factory]=(...args)=>{
    const store=actual[factory](...args);
    return Object.fromEntries(Object.entries(store).map(([method,fn])=>[method,async(...args)=>{
     if(scenario.component===component&&scenario.method===method){
      if(!scenario.when||scenario.when(args)){
       if(scenario.throwError)throw Error('ARBITRARY_SECRET_ERROR');
       if(scenario.largeResult){const r=await fn(...args);return {...r,padding:'PRIVATE_RESULT'.repeat(100)};}
       return {...(scenario.result??{status:'BLOCKED_STORAGE',reason:'BUDGET_EXCEEDED'}),payload:'PRIVATE_PAYLOAD',message:'PRIVATE_MESSAGE'};
      }
     }
     return fn(...args);
    }]));
   };
  }
  const sm=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);});return sm;
 });await m.evaluate();return m.namespace.runWorker;
}
test('diagnostic parity against unchanged worker on isolated Redis only',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-diag-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 const redis=async c=>{const {stdout}=await exec('redis-cli',['-s',socket,'--json',...c.map(String)],{maxBuffer:16*1024*1024});if(stdout.startsWith('error:'))throw Error('LOCAL_REDIS');return JSON.parse(stdout);};
 const e=cycle(),raw=canonicalJSON(e),sourceHash=digest(e);
 async function seed(scenario){
  await redis(['FLUSHDB']);await redis(['SET',OBSERVATION_KEY,JSON.stringify({schemaVersion:'forward-observation-ledger-v1',cycles:{[e.sourceCycleId]:raw},count:1,observations:1,payloadBytes:Buffer.byteLength(raw)})]);
  if(scenario.padded){
   const item={id:e.sourceCycleId,frozen:canonicalJSON({mappingVersion:'forward-worker-mapping-v1',sourceEnvelopeHash:sourceHash,sourceCycleId:e.sourceCycleId,processingIdentity:digest(['forward-worker-mapping-v1',e.sourceCycleId]),orderKey:T+'|'+e.sourceCycleId,workerProcessingStartedAt:W,workerRecordedAt:W}),actions:{padding:''},done:{},status:'RUNNING'};
   item.actions.padding='x'.repeat(32038-Buffer.byteLength(canonicalJSON(item)));assert.equal(Buffer.byteLength(canonicalJSON(item)),32038);
   await redis(['SET',WORKER_KEY,JSON.stringify({schemaVersion:'forward-worker-state-v1',mappingVersion:'forward-worker-mapping-v1',fence:0,owner:'',expiresAt:0,intents:{[item.id]:canonicalJSON(item)}})]);
  }
 }
 async function run(source,scenario){await seed(scenario);const events=[],commands=[];const worker=await load(source,events,scenario);
  const prior=console.info;console.info=(name,raw)=>{events.push({name,data:JSON.parse(raw)});if(scenario.loggerThrows)throw Error('LOGGER_SECRET');};
  try{const result=await worker({execute:async c=>{commands.push(structuredClone(c));return redis(c);},now:()=>Date.parse(W),owner:'PRIVATE_OWNER'});
   return {result:JSON.parse(JSON.stringify(result)),events:events.filter(e=>e.name==='[forward-worker-storage-failure]'),saveEvents:events.filter(e=>e.name==='[forward-worker-save]'),commands,state:await redis(['GET',WORKER_KEY])};
  }finally{console.info=prior;}
 }
 async function compare(scenario){const before=await run(baseline,scenario),after=await run(current,scenario);assert.deepEqual(after.result,before.result);assert.deepEqual(after.commands,before.commands);return after;}
 try{
  let ready=false;for(let i=0;i<100;i++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  for(const [name,scenario,operation,phase]of [
   ['initial save',{component:'WORKER_STATE',method:'save',when:a=>Object.keys(a[2].actions).length===0,result:{status:'BLOCKED_STORAGE'}},'SAVE','INITIAL'],
   ['prepared action save',{component:'WORKER_STATE',method:'save',when:a=>Object.keys(a[2].actions).length===1&&Object.keys(a[2].done).length===0,result:{status:'BLOCKED_STORAGE'}},'SAVE','PREPARED_ACTION'],
   ['action result save',{component:'WORKER_STATE',method:'save',when:a=>Object.keys(a[2].done).length===1,result:{status:'BLOCKED_STORAGE'}},'SAVE','ACTION_RESULT'],
   ['check',{component:'WORKER_STATE',method:'check',result:{status:'BLOCKED_STORAGE'}},'CHECK',null],
   ['mapping result save',{invalidMapping:true,component:'WORKER_STATE',method:'save',when:a=>a[2].status==='BLOCKED_MAPPING',result:{status:'BLOCKED_STORAGE'}},'SAVE','MAPPING_RESULT'],
   ['complete save',{component:'WORKER_STATE',method:'save',when:a=>a[2].status==='COMPLETE',result:{status:'BLOCKED_STORAGE'}},'SAVE','COMPLETE'],
   ['producer read',{component:'PRODUCER_LEDGER',method:'read'},'READ',null],
   ['producer manifest',{component:'PRODUCER_LEDGER',method:'freezeManifest'},'FREEZE_MANIFEST',null],
   ['producer generation',{component:'PRODUCER_LEDGER',method:'getOrCreateGeneration'},'GET_OR_CREATE_GENERATION',null],
   ['producer prepare',{component:'PRODUCER_LEDGER',method:'prepareCapture'},'PREPARE_CAPTURE',null],
   ['shadow read',{component:'SHADOW_LEDGER',method:'read'},'READ',null],
   ['producer create',{component:'PRODUCER_LEDGER',method:'createRun'},'CREATE_RUN',null],
   ['producer allocate',{component:'PRODUCER_LEDGER',method:'allocateCycle'},'ALLOCATE_CYCLE',null],
   ['producer ingest',{component:'PRODUCER_LEDGER',method:'ingestDelayedObservation'},'INGEST_DELAYED_OBSERVATION',null],
   ['shadow create',{component:'SHADOW_LEDGER',method:'createRun'},'CREATE_RUN',null],
   ['capture shadow commit',{component:'SHADOW_LEDGER',method:'commit'},'COMMIT',null],
   ['capture producer receipt',{component:'PRODUCER_LEDGER',method:'receiveCaptureReceipt'},'RECEIVE_CAPTURE_RECEIPT',null],
   ['capture producer ack',{component:'PRODUCER_LEDGER',method:'acknowledgeCapture'},'ACKNOWLEDGE_CAPTURE',null]
  ])await t.test(name,async()=>{
   const r=await compare(scenario);assert.deepEqual(r.result,{status:'BLOCKED_STORAGE',reasonCode:'PROCESSING_INCOMPLETE'});assert.equal(r.events.length,1);
   const ev=r.events[0];assert.equal(ev.name,'[forward-worker-storage-failure]');assert.equal(ev.data.component,scenario.component);assert.equal(ev.data.operation,operation);assert.equal(ev.data.savePhase,phase);
   assert.equal(ev.data.originalReasonCode,scenario.result?'NOT_PROVIDED':'BUDGET_EXCEEDED');
   if(operation==='SAVE'){assert.ok(ev.data.preparedIntentBytes>0);assert.equal(ev.data.preparedIntentOverLimit,false);}
   const serialized=JSON.stringify(r.events);for(const privateValue of ['PRIVATE_',e.sourceCycleId,'payload','message','initialPlan','Authorization'])assert.ok(!serialized.includes(privateValue),privateValue);
   assert.match(ev.data.sourceCycleHash,/^[a-f0-9]{64}$/);
  });
  await t.test('legacy 32038 intent crosses old limit and retains full COMPLETE',async()=>{
   const r=await compare({padded:true});assert.equal(r.result.status,'COMPLETE');assert.equal(r.events.length,0);
   assert.equal(r.saveEvents.length,2);assert.equal(r.saveEvents[0].data.savePhase,'PREPARED_ACTION');
   assert.equal(r.saveEvents[1].data.savePhase,'COMPLETE');
   const i=JSON.parse(Object.values(JSON.parse(r.state).intents)[0]);assert.equal(i.status,'COMPLETE');
   assert.ok(i.actions.padding);assert.ok(Object.keys(i.done).length);assert.ok(i.frozen);assert.equal(i.receiptVersion,undefined);
   for(const {data:d} of r.saveEvents){assert.equal(d.configuredLimitBytes,1048576);assert.ok(d.canonicalIntentBytes>32768);
    assert.equal(d.serializedGrowthBytes,d.prospectiveSerializedBytes-d.previousSerializedBytes);
    assert.equal(d.wholeStateLimitBytes,4194304);assert.equal(d.status,'OK');assert.equal(d.reasonCode,'SAVED');}
   assert.ok(!JSON.stringify(r.saveEvents).includes('PRIVATE_'));
  });
  await t.test('larger result crosses old limit without changing worker decisions',async()=>{
   const r=await compare({padded:true,component:'PRODUCER_LEDGER',method:'createRun',largeResult:true});
   assert.equal(r.result.status,'COMPLETE');assert.equal(r.events.length,0);assert.equal(r.saveEvents.at(-1).data.savePhase,'COMPLETE');
  });
  await t.test('capture observes original status before normalization',async()=>{
   const r=await compare({component:'SHADOW_LEDGER',method:'commit',result:{status:'STORAGE_ERROR',reason:'SECRET_REASON'}});
   assert.equal(r.result.status,'UNRESOLVED');assert.equal(r.events.length,1);assert.equal(r.events[0].data.originalStatus,'STORAGE_ERROR');assert.equal(r.events[0].data.originalReasonCode,'UNCLASSIFIED');
  });
  await t.test('unknown status and reason sanitized',async()=>{const r=await compare({component:'PRODUCER_LEDGER',method:'createRun',result:{status:'SECRET_STATUS',reason:'SECRET_REASON'}});assert.equal(r.events[0].data.originalStatus,'UNKNOWN');assert.equal(r.events[0].data.originalReasonCode,'UNCLASSIFIED');});
  await t.test('throwing logger changes neither result nor Redis commands',async()=>{const r=await compare({component:'PRODUCER_LEDGER',method:'createRun',loggerThrows:true});assert.equal(r.result.status,'BLOCKED_STORAGE');assert.equal(r.events.length,1);});
  await t.test('acquire rejection has one safe event and unchanged early return',async()=>{const r=await compare({component:'WORKER_STATE',method:'acquire',result:{status:'BUSY'}});assert.deepEqual(r.result,{status:'BUSY'});assert.equal(r.events.length,1);assert.equal(r.events[0].data.operation,'ACQUIRE');assert.equal(r.events[0].data.sourceCycleHash,null);});
  await t.test('read exception retains result without leaking exception message',async()=>{const r=await compare({component:'WORKER_STATE',method:'read',throwError:true});assert.equal(r.events.length,1);assert.equal(r.events[0].data.operation,'READ');assert.equal(r.events[0].data.originalStatus,'UNKNOWN');assert.ok(!JSON.stringify(r.events).includes('ARBITRARY'));});
  await t.test('cleanup failure is not a processing event',async()=>{const r=await compare({component:'WORKER_STATE',method:'release',throwError:true});assert.equal(r.result.status,'COMPLETE');assert.equal(r.events.length,0);});
  await t.test('success has no event and identical commands',async()=>{const r=await compare({});assert.equal(r.result.status,'COMPLETE');assert.equal(r.events.length,0);});
 }finally{try{await redis(['SHUTDOWN','NOSAVE']);}catch{}server.kill();await rm(dir,{recursive:true,force:true});}
});
