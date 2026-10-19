import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSourceRegistry,RUN_ID,REGISTRY_KEY,VERSION as RV} from '../lib/forward-validation/source-registry.js';
import {createSourceEpoch,VERSION as EV} from '../lib/forward-validation/source-epoch.js';
import {prepareProspectiveObservation} from '../lib/forward-validation/prospective-source.js';
import {persistObservationCycle} from '../lib/forward-validation/observation-store.js';
import {runWorker} from '../lib/forward-validation/worker.js';
import {runLifecycle} from '../lib/forward-validation/lifecycle-worker.js';
import {createLifecycleStore,KEY} from '../lib/forward-validation/lifecycle-store.js';
import handler from '../api/forward-lifecycle.js';
const text=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const core=vm.createContext({Date,console,process:{env:{}}});vm.runInContext(text,core);
const exec=promisify(execFile),M=60000;
test('private lifecycle auth rejects before any network',async()=>{
 const old=process.env.SM1M_API_SECRET;process.env.SM1M_API_SECRET='x'.repeat(40);
 try{for(const [headers,method,expected]of [[{},'POST',401],[{authorization:'Bearer '+'x'.repeat(40)},'GET',405]]){
  const res={setHeader(){},status(n){this.code=n;return this;},json(){return this;}};await handler({headers,method},res);assert.equal(res.code,expected);
 }}finally{if(old===undefined)delete process.env.SM1M_API_SECRET;else process.env.SM1M_API_SECRET=old;}
});
test('F4 real durable pipeline with isolated Unix Redis and injected candles only',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'f4-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:'ignore'});
 const base=Math.ceil(Date.now()/M)*M+5*M,at=n=>new Date(base+n*M).toISOString();
 const io=async cmd=>{if(cmd[0]==='TIME')return [String(Math.floor((base+100*M)/1000)),'0'];const {stdout}=await exec('redis-cli',['-s',socket,'--json',...cmd.map(String)],{maxBuffer:20*1024*1024});if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);};
 const epoch=createSourceEpoch(io);
 const seed=async(n=1)=>{
  await io(['FLUSHDB']);
  assert.equal((await createSourceRegistry(io).activate({registryVersion:RV,runId:RUN_ID,activatedAt:at(-3),activationSourceBoundary:at(-3),protocolVersion:'1.1'})).status,'ACTIVATED');
  assert.equal((await epoch.activate({epochVersion:EV,runId:RUN_ID,epochId:'f4-test',activatedAt:at(-3),sourceLowerBound:at(-3),protocolVersion:'1.1',registryVersion:RV,status:'ACTIVE'})).status,'ACTIVATED');
  for(let i=0;i<n;i++)await publish(i);
 };
 const publish=async(i=0,minute=0,context={})=>{
  const membership=await epoch.register('lease-'+i+'-'+minute,at(minute-2),at(minute-1));assert.equal(membership.status,'EXPECTED');
  const symbol='S'+i+'USDT';
  const analysisContext={symbol,analysisAt:at(minute),source:'OKX',timeframe:'1D',lastConfirmedAt:new Date(base-3600000).toISOString(),
   structure:{bos:'Bullish BOS',choch:'Bullish CHOCH',mss:'Bullish MSS'},trend:{trend:'Strong Bullish',ema20:104,ema50:103,ema100:102,ema200:101},
   momentum:{rsi14:65,macd:{macd:2,signal:1,histogram:1}},smartMoney:{score:100},volume:{ratio:1,spike:false},...context};
  const snapshot={ok:true,status:'ready',mode:'global-ranking',version:'1.0',generatedAt:new Date(base+minute*M+i).toISOString(),resultsFailed:0,globalRanking:[{symbol,direction:'Long',price:100,opportunityScore:95,confidence:95,tradeAllowed:true,tradeReadiness:{ready:true},action:'Strong Buy',riskReward:3,
   analysisContext,entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130}]};
  const prepared=await prepareProspectiveObservation(snapshot,core.isConfirmedAPlusTrade,core.createForwardFrozenCandidate,io,membership);
  assert.equal(prepared.status,'PREPARED');const binding=await epoch.bind(membership,snapshot,prepared);assert.equal(binding.status,'BOUND');
  const receipt=await persistObservationCycle(prepared,io);assert.equal(receipt.status,'COMPLETE');assert.equal((await epoch.observe(binding,prepared,receipt)).status,'OBSERVED');
  const r=await runWorker({execute:io,now:()=>base+(minute+2)*M});assert.equal(r.status,'COMPLETE',JSON.stringify(r));
 };
 const provider=(fn=()=>({}))=>async({from,to})=>({source:'OKX 1m candles',data:Array.from({length:(to-from)/M},(_,i)=>({timestamp:from+i*M,open:100,high:102,low:98,close:100,confirmed:true,...fn((from+i*M-base)/M)}))});
 const run=(p=provider(),minutes=5,execute=io)=>runLifecycle({execute,lifecycle:core.handler.forwardLifecycle,provider:p,now:()=>base+minutes*M});
 const state=async()=> (await createLifecycleStore(io).read()).state;
 try{
  for(let i=0;i<100;i++){try{await io(['PING']);break;}catch{await new Promise(r=>setTimeout(r,20));}}
  await t.test('not activated produces no lifecycle evidence',async()=>{assert.equal((await run()).status,'NOT_STARTED');assert.equal(await io(['GET',KEY]),null);});
  await t.test('first entry, verified stop, chronological admission and T+1 release',async()=>{
   await seed();const r=await run(provider(()=>({low:89,close:89})));assert.equal(r.status,'COMPLETE',JSON.stringify(r));
   const s=await state(),record=Object.values(s.records)[0];assert.equal(record.outcome.status,'Stopped');assert.equal(record.outcome.resultR,-1);
   assert.equal(record.closureRecorded,true);assert.equal(record.decision.state,'ADMITTED');assert.equal(s.occupancy.length,0);
   assert.equal(s.decisionMinute,at(1));
   const before=await io(['GET',KEY]);assert.equal((await run()).status,'COMPLETE');assert.equal(await io(['GET',KEY]),before);
  });
  await t.test('WaitingEntry then proven expiry without entry',async()=>{
   await seed();const r=await run(provider(()=>({open:105,low:104,high:106,close:105})),65);assert.equal(r.status,'COMPLETE',JSON.stringify(r));
   const record=Object.values((await state()).records)[0];assert.equal(record.outcome.status,'Expired');assert.equal(record.closureRecorded,true);assert.equal(record.decision,null);
  });
  await t.test('TP1 realizes half, BE stop retained, generation and capacity remain open',async()=>{
   await seed();const r=await run(provider(i=>i===0?{}:{open:105,low:101,high:111,close:108}),3);assert.equal(r.status,'COMPLETE',JSON.stringify(r));
   const s=await state(),record=Object.values(s.records)[0];assert.equal(record.outcome.status,'Active');assert.equal(record.outcome.remainingPosition,0.5);assert.equal(record.outcome.currentStopLoss,100);
   assert.equal(record.outcome.exits.length,1);assert.equal(record.outcome.exits[0].initialFraction,0.5);assert.equal(record.outcome.reanalysisPending,true);
   assert.equal(record.closureRecorded,false);assert.equal(s.occupancy.length,1);
  });
  await t.test('fresh repeated source preserves generation and allows HOLD or CLOSE',async()=>{
   for(const close of [false,true]){
    await seed();assert.equal((await run(provider(i=>i===0?{}:{open:105,low:101,high:111,close:108}),3)).status,'COMPLETE');
    await publish(0,3,close?{structure:{bos:'Bearish BOS',choch:'Bearish CHOCH',mss:'Bearish MSS'},trend:{trend:'Strong Bearish',ema20:101,ema50:102,ema100:103,ema200:104},momentum:{rsi14:20,macd:{macd:-2,signal:-1,histogram:-1}},smartMoney:{score:0}}:{});
    const r=await run(provider(()=>({open:105,low:101,high:109,close:105})),5);assert.equal(r.status,'COMPLETE',JSON.stringify(r));
    const record=Object.values((await state()).records)[0];assert.equal(record.outcome.lastReanalysis.decision,close?'CLOSE':'HOLD');
    assert.equal(record.outcome.status,close?'Closed':'Active');assert.equal(record.closureRecorded,close);
   }
  });
  await t.test('gap/unconfirmed data cannot advance or fabricate expiry',async()=>{
   for(const invalid of ['gap','unconfirmed']){await seed();const p=provider();const r=await run(async req=>{const v=await p(req);if(invalid==='gap')v.data.shift();else v.data[0].confirmed=false;return v;},65);
    assert.equal(r.status,'UNRESOLVED',JSON.stringify(r));const record=Object.values((await state()).records)[0];assert.equal(record.unresolved,'VERIFICATION_INCOMPLETE');assert.equal(record.outcome.status,undefined);assert.equal(record.decision,null);}
  });
  await t.test('provider failure remains unresolved without retry',async()=>{await seed();let calls=0;const r=await run(async()=>{calls++;throw Error('offline');});assert.equal(calls,1);assert.equal(r.providerCalls,1);assert.equal(Object.values((await state()).records)[0].unresolved,'PROVIDER_FAILURE');});
  await t.test('TP1 then BE closes only the remainder and releases at T+1',async()=>{
   await seed();await run(provider(i=>i===0?{}:{open:105,low:101,high:111,close:108}),3);
   const r=await run(provider(()=>({open:105,low:99,high:109,close:100})),5);assert.equal(r.status,'COMPLETE');
   const s=await state(),record=Object.values(s.records)[0];assert.equal(record.closureRecorded,true);assert.equal(record.outcome.remainingPosition,0);
   assert.equal(record.outcome.exits.length,2);assert.equal(record.outcome.exits[1].initialFraction,0.5);assert.equal(s.occupancy.length,0);
  });
  await t.test('crash before admission commit replays the frozen intent exactly',async()=>{
   await seed();let interrupted=false;
   const broken=async cmd=>{
    const next=cmd.findLast(v=>typeof v==='string'&&v.startsWith('{')&&v.includes('forward-lifecycle-evidence-v1'));
    if(next&&JSON.parse(next).batches===1&&!interrupted){interrupted=true;throw Error('INJECTED_CRASH');}
    return io(cmd);
   };
   assert.equal((await run(provider(),5,broken)).reasonCode,'INJECTED_CRASH');
   const before=await state();assert.equal(before.batches,0);assert.ok(Object.values(before.events).some(e=>e.event.kind==='ADMISSION_INTENT'));
   const r=await run(provider(),5);assert.equal(r.status,'COMPLETE',JSON.stringify(r));
   const after=await state();assert.equal(after.batches,1);assert.equal(after.occupancy.length,1);
   assert.equal(Object.values(after.records)[0].decision.state,'ADMITTED');
  });
  await t.test('lost admission acknowledgement does not double-count the batch',async()=>{
   await seed();let interrupted=false;
   const broken=async cmd=>{
    const next=cmd.findLast(v=>typeof v==='string'&&v.startsWith('{')&&v.includes('forward-lifecycle-evidence-v1'));
    const answer=await io(cmd);
    if(next&&JSON.parse(next).batches===1&&!interrupted){interrupted=true;throw Error('LOST_REPLY');}
    return answer;
   };
   assert.equal((await run(provider(),5,broken)).reasonCode,'LOST_REPLY');
   assert.equal((await run(provider(),5)).status,'COMPLETE');assert.equal((await state()).batches,1);
  });
  await t.test('source mutation racing final admission fails closed atomically',async()=>{
   await seed();let changed=false;
   const racing=async cmd=>{
    const next=cmd.findLast(v=>typeof v==='string'&&v.startsWith('{')&&v.includes('forward-lifecycle-evidence-v1'));
    if(next&&JSON.parse(next).batches===1&&!changed){
     changed=true;const registry=JSON.parse(await io(['GET',REGISTRY_KEY]));Object.values(registry.reservations)[0].epochConflict=true;
     await io(['SET',REGISTRY_KEY,JSON.stringify(registry)]);
    }
    return io(cmd);
   };
   assert.equal((await run(provider(),5,racing)).status,'STALE');assert.equal((await state()).batches,0);
   assert.equal((await run(provider(),5)).reasonCode,'ADMISSION_SOURCE_CHANGED');assert.equal((await state()).occupancy.length,0);
  });
  await t.test('receipt/checkpoint/TP1/closure lost replies replay without duplicate exits',async()=>{
   for(const kind of ['PROVIDER','LIFECYCLE','CLOSURE']){
    await seed();let fired=false;
    const broken=async cmd=>{
     const raw=cmd.findLast(v=>typeof v==='string'&&v.startsWith('{')&&v.includes('forward-lifecycle-evidence-v1'));
     const reply=await io(cmd);
     if(raw&&!fired&&Object.values(JSON.parse(raw).events).some(e=>e.event.kind===kind)){fired=true;throw Error('AFTER_'+kind);}
     return reply;
    };
    const prices=provider(i=>i===0?{}:i===1?{open:105,high:111,low:101,close:108}:{open:105,high:109,low:99,close:100});
    assert.equal((await run(prices,4,broken)).reasonCode,'AFTER_'+kind);
    assert.equal((await run(prices,4)).status,'COMPLETE');
    const r=Object.values((await state()).records)[0];assert.equal(r.closureRecorded,true);assert.equal(r.outcome.exits.length,2);
    assert.equal(r.outcome.remainingPosition,0);assert.equal(r.decision.state,'ADMITTED');assert.equal((await state()).occupancy.length,0);
   }
  });
  await t.test('producer closure lost reply completes once on replay',async()=>{
   await seed();let fired=false;
   const broken=async cmd=>{
    const answer=await io(cmd);
    if(!fired&&cmd.some(v=>typeof v==='string'&&v.startsWith('{')&&v.includes('recordGenerationClosure')&&v.includes('expectedRevision'))){fired=true;throw Error('LOST_CLOSURE_REPLY');}
    return answer;
   };
   const prices=provider(()=>({low:89,close:89}));const first=await run(prices,5,broken);assert.equal(fired,true);assert.notEqual(first.status,'COMPLETE');
   assert.equal((await run(prices,5)).status,'COMPLETE');const r=Object.values((await state()).records)[0];
   assert.equal(r.closureRecorded,true);assert.equal(r.outcome.exits.length,1);assert.equal((await state()).occupancy.length,0);
  });
  await t.test('verified closed generation allows a new prospective birth without resetting the old one',async()=>{
   await seed();await run(provider(()=>({low:89,close:89})),5);
   const original=Object.values((await state()).records)[0];await publish(0,5);
   await run(provider(),7);const records=Object.values((await state()).records);assert.equal(records.length,2);
   assert.deepEqual(records.find(r=>r.identity.shadowCandidateId===original.identity.shadowCandidateId),original);
   assert.ok(records.some(r=>r.identity.originalCapturedAt===at(5)));
  });
  await t.test('unresolved epoch member blocks admission despite a verified entry',async()=>{
   await seed();assert.equal((await epoch.register('missing-source',at(-2),at(-1))).status,'EXPECTED');
   await run();const r=Object.values((await state()).records)[0];assert.equal(r.outcome.status,'Active');assert.equal(r.decision,null);
  });
  await t.test('three Long entries deterministically admit two and skip the third',async()=>{
   await seed(3);const r=await run();assert.equal(r.status,'COMPLETE',JSON.stringify(r));
   const records=Object.values((await state()).records).sort((a,b)=>a.identity.shadowCandidateId<b.identity.shadowCandidateId?-1:1);
   assert.equal(records.filter(r=>r.decision?.state==='ADMITTED').length,2);
   assert.equal(records.filter(r=>r.decision?.state==='SKIPPED_CAPACITY').length,1);
   assert.equal((await state()).occupancy.length,2);
  });
  await t.test('40-second cutoff prevents new phases and additional provider calls',async()=>{
   await seed();let elapsed=0,calls=0;
   const result=await runLifecycle({execute:io,lifecycle:core.handler.forwardLifecycle,now:()=>base+5*M+elapsed,
    provider:async req=>{calls++;const data=await provider()(req);elapsed=40000;return data;}});
   assert.equal(calls,1);assert.equal(result.status,'UNRESOLVED');assert.ok(['DEADLINE','PHASE_CUTOFF'].includes(result.reasonCode));
   assert.equal(await io(['GET',KEY]),null);
  });
  await t.test('F4 payload overflow preserves durable evidence',async()=>{
   await seed();const store=createLifecycleStore(io),before=await store.read();
   assert.equal((await store.commit(before,'oversize',{kind:'TEST',data:'x'.repeat(32768)})).status,'BLOCKED_STORAGE');
   assert.equal(await io(['GET',KEY]),before.raw);
  });
  await t.test('bounded generation count and provider paging',async()=>{
   await seed(4);const perSymbol={},prices=provider();const r=await run(async req=>{perSymbol[req.symbol]=(perSymbol[req.symbol]||0)+1;return prices(req);},1000);
   assert.equal(r.generationsProcessed,3);assert.equal(r.providerCalls,9);assert.deepEqual(Object.values(perSymbol),[3,3,3]);assert.equal(Object.keys((await state()).records).length,3);
  });
 }finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
