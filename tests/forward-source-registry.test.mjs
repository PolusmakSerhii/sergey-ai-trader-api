import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSourceRegistry,deriveRegistryFrontier,reservationIdentity,REGISTRY_KEY,VERSION,RUN_ID} from '../lib/forward-validation/source-registry.js';
import {prepareObservationCycle,persistObservationCycle,OBSERVATION_KEY} from '../lib/forward-validation/observation-store.js';
const exec=promisify(execFile);
const source=await readFile(new URL('../api/market.js',import.meta.url),'utf8');
const snapshot=(at,n=0)=>({ok:true,status:'ready',mode:'global-ranking',version:'1.0',generatedAt:at,resultsFailed:0,globalRanking:Array.from({length:n},(_,i)=>({symbol:'S'+i,direction:'Long',entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,opportunityScore:90,confidence:90,action:'Strong Buy',tradeAllowed:true,tradeReadiness:{ready:true},riskReward:3}))});
test('stable lease identity, distinct attempts, no raw token',()=>{assert.equal(reservationIdentity('a'),reservationIdentity('a'));assert.notEqual(reservationIdentity('a'),reservationIdentity('b'));assert.match(reservationIdentity('a'),/^[a-f0-9]{64}$/);});
test('reservation transport unknown or invalid response: one command, no retries',async()=>{
 for(const result of ['throw',null,['unexpected']]){let n=0;const s=createSourceRegistry(async()=>{n++;if(result==='throw')throw Error('timeout');return result;});assert.equal((await s.reserve('a',new Date().toISOString())).status,'UNRESOLVED');assert.equal(n,1);}
});
test('pre-snapshot integration precedes build, bind precedes Core writes, no activation',()=>{
 const reserve=source.indexOf('await forwardRegistry.reserve('),build=source.indexOf('const globalRankingSnapshot ='),bind=source.indexOf('await forwardRegistry.bind('),cache=source.indexOf('const cacheSaved =',build),f2=source.indexOf('await persistObservationCycle('),observe=source.indexOf('await forwardRegistry.observe(');
 assert.ok(reserve<build&&build<bind&&bind<cache&&cache<f2&&f2<observe);
 assert.match(source,/forwardRegistry.reserve\(refreshToken,/);assert.doesNotMatch(source,/forwardRegistry.activate/);
 assert.match(source,/const trackedItems = readyItems.slice\(0, 20\)/);
});
test('registry on isolated Unix-socket Redis',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-registry-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 let commands=[];
 const redis=async cmd=>{commands.push(cmd);const {stdout}=await exec('redis-cli',['-s',socket,'--json',...cmd.map(String)],{maxBuffer:12*1024*1024});if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);};
 const store=createSourceRegistry(redis),start=Date.now()+60000,at=i=>new Date(start+i*60000).toISOString();
 const meta={registryVersion:VERSION,runId:RUN_ID,activatedAt:at(0),activationSourceBoundary:at(0),protocolVersion:'1.1'};
 const fresh=async()=>{await redis(['FLUSHDB']);assert.equal((await store.activate(meta)).status,'ACTIVATED');};
 const fixture=async(i=1,n=0)=>{const s=snapshot(at(i),n),p=prepareObservationCycle(s,()=>true),r=await store.reserve('lease-'+i,at(i)),b=await store.bind(r,s,p);return {s,p,r,b};};
 const observe=async x=>store.observe(x.b,x.p,await persistObservationCycle(x.p,redis));
 try{
  let ready=false;for(let i=0;i<100;i++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  await t.test('disabled without activation; no state created',async()=>{assert.equal((await store.reserve('a',at(1))).status,'NOT_STARTED');assert.equal(await store.read(),null);});
  await t.test('activation immutable and idempotent, historical activation rejected',async()=>{
   assert.equal((await store.activate({...meta,activatedAt:'2020-01-01T00:00:00.000Z',activationSourceBoundary:'2020-01-01T00:00:00.000Z'})).status,'CONFLICT');
   await fresh();const before=await redis(['GET',REGISTRY_KEY]);assert.equal((await store.activate(meta)).status,'IDEMPOTENT');assert.equal((await store.activate({...meta,protocolVersion:'2'})).status,'CONFLICT');assert.equal(await redis(['GET',REGISTRY_KEY]),before);
   assert.equal((await store.reserve('old',at(-1))).status,'NOT_STARTED');
  });
  for(const n of [0,1])await t.test(`${n} canonical observations: expected-bind-durable F2-observed`,async()=>{
   await fresh();const x=await fixture(1,n);assert.equal(x.r.status,'EXPECTED');assert.equal(x.b.status,'BOUND');
   assert.equal((await store.read()).reservations[x.r.reservationId].status,'EXPECTED');
   commands=[];assert.equal((await observe(x)).status,'OBSERVED');assert.equal(commands.filter(c=>c[0]==='EVAL'&&c[3]===REGISTRY_KEY).length,1);
   assert.equal((await observe(x)).status,'IDEMPOTENT');
  });
  await t.test('binding immutable, conflicting reservation and changed snapshot rejected',async()=>{
   await fresh();const x=await fixture();assert.equal((await store.bind(x.r,x.s,x.p)).status,'IDEMPOTENT');
   assert.equal((await store.bind(x.r,snapshot(at(2)),prepareObservationCycle(snapshot(at(2)),()=>true))).status,'CONFLICT');
   assert.equal((await store.bind(x.r,{...x.s,resultsCollected:99},x.p)).status,'CONFLICT');
   const other=await store.reserve('other',at(1));assert.equal((await store.bind(other,x.s,x.p)).status,'CONFLICT');
  });
  await t.test('snapshot failure and missing F2 remain durable unresolved, no silent skipping',async()=>{
   await fresh();const r=await store.reserve('no-snapshot',at(1));const x=await fixture(2);assert.equal((await store.observe(x.b,x.p,{status:'COMPLETE',sourceCycleId:x.p.sourceCycleId})).status,'UNRESOLVED');
   assert.equal((await observe(x)).status,'OBSERVED');const f=deriveRegistryFrontier(await store.read(),at(3));assert.equal(f.unresolved[0].reservationId,r.reservationId);assert.equal(f.observedFrontier,null);assert.equal(f.sourceFence.closed,false);
  });
  await t.test('F2 timeout and definite failure never mark observed',async()=>{
   await fresh();const x=await fixture();for(const status of ['UNRESOLVED','BLOCKED_STORAGE','CONFLICT']){assert.equal((await store.observe(x.b,x.p,{status})).status,status);assert.equal((await store.read()).reservations[x.r.reservationId].status,'EXPECTED');}
  });
  await t.test('uncommitted reservation failure cannot self-heal after later success',async()=>{
   await fresh();const failed=createSourceRegistry(async()=>{throw Error('unavailable');});assert.equal((await failed.reserve('lost',at(1))).status,'UNRESOLVED');const x=await fixture(2);await observe(x);
   const f=deriveRegistryFrontier(await store.read(),at(3));assert.equal(f.unresolved.length,0);assert.ok(f.observedFrontier);assert.equal(f.status,'UNRESOLVED');assert.equal(f.sourceFence.closed,false);assert.equal(f.barrierFrom,at(0));assert.equal(f.futureSourceTimeLowerBound,null);
  });
  await t.test('unknown committed reservation remains expected after lost reply',async()=>{
   await fresh();const uncertain=createSourceRegistry(async c=>{await redis(c);throw Error('lost reply');});const r=await uncertain.reserve('lost-reply',at(1));assert.equal(r.status,'UNRESOLVED');assert.equal((await store.read()).reservations[r.reservationId].status,'EXPECTED');
  });
  await t.test('wrong F2 bytes do not become observed',async()=>{
   await fresh();const x=await fixture();await persistObservationCycle(x.p,redis);const l=JSON.parse(await redis(['GET',OBSERVATION_KEY]));l.cycles[x.p.sourceCycleId]+=' ';await redis(['SET',OBSERVATION_KEY,JSON.stringify(l)]);
   assert.equal((await store.observe(x.b,x.p,{status:'COMPLETE',sourceCycleId:x.p.sourceCycleId})).status,'CONFLICT');
  });
  await t.test('deterministic order and late missing predecessor block observed frontier',async()=>{
   await fresh();const x=await fixture(2);await observe(x);await store.reserve('earlier',at(1));const f=deriveRegistryFrontier(await store.read(),at(3));assert.equal(f.ordered[0].boundaryAt,at(1));assert.equal(f.observedFrontier,null);
  });
  await t.test('overflow preserves all old bytes and barrier',async()=>{
   await fresh();const s=await store.read();s.receipts=50000;await redis(['SET',REGISTRY_KEY,JSON.stringify(s)]);const before=await redis(['GET',REGISTRY_KEY]);assert.equal((await store.reserve('full',at(1))).status,'BLOCKED_STORAGE');assert.equal(await redis(['GET',REGISTRY_KEY]),before);
  });
 }finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
