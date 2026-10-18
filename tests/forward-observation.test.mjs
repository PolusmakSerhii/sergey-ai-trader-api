import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {buildObservationCycle,prepareObservationCycle,persistObservationCycle,OBSERVATION_KEY,OBSERVATION_LUA,MAX_ENVELOPE_BYTES,digest} from '../lib/forward-validation/observation-store.js';
import {canonicalJSON} from '../lib/forward-validation/source-contract.js';
const exec=promisify(execFile), source=await readFile(new URL('../api/market.js',import.meta.url),'utf8');
const ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function isConfirmedAPlusTrade(signal) {'),source.indexOf('\nfunction isConfirmedAPlusTradeSignal')),ctx);
const gate=ctx.isConfirmedAPlusTrade;
const row=(symbol='BTCUSDT')=>({symbol,direction:'Long',opportunityScore:90,confidence:90,
 tradeAllowed:true,tradeReadiness:{ready:true},action:'Strong Buy',entryZone:{from:99,to:101},
 stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,riskReward:3});
const snapshot=(n=1,time='2026-10-18T10:00:00.000Z')=>({ok:true,status:'ready',mode:'global-ranking',version:'1.0',
 generatedAt:time,resultsFailed:0,globalRanking:Array.from({length:n},(_,i)=>row(`X${i}`))});
const prep=s=>prepareObservationCycle(s,gate);
test('canonical gate excludes noncanonical regardless of high score/grade',()=>{
 const s=snapshot(2);s.globalRanking[1].action='Wait';s.globalRanking[1].grade='A+';
 assert.equal(buildObservationCycle(s,gate).observations.length,1);
});
test('all 25 candidates enumerated; Core cap remains 20',()=>{
 assert.equal(buildObservationCycle(snapshot(25),gate).expectedObservationCount,25);
 assert.match(source,/const trackedItems = readyItems.slice\(0, 20\)/);
 assert.ok(source.indexOf('const forwardObservation =')<source.indexOf('const historySaved ='));
});
test('immutable snapshot replay and new snapshot identity',()=>{
 const s=snapshot(),before=structuredClone(s);const a=prep(s),b=prep(structuredClone(s));
 assert.deepEqual(a,b);assert.deepEqual(s,before);
 assert.notEqual(a.sourceCycleId,prep(snapshot(1,'2026-10-18T10:01:00.000Z')).sourceCycleId);
 assert.equal(buildObservationCycle(s,gate).observations[0].payload.createdAt,null);
});
test('stable ordering, canonical hash, distinct observation vs generation',()=>{
 const s=snapshot(3),a=prep(s);s.globalRanking.reverse();assert.deepEqual(prep(s),a);
 const e=JSON.parse(a.raw);for(const o of e.observations)assert.equal(o.payloadHash,digest(o.payload));
 assert.ok(!a.raw.includes('generationId'));assert.ok(!a.raw.includes('shadowCandidateId'));
});
test('same cycle changed payload retains IDs and changes hash',()=>{
 const s=snapshot(),a=JSON.parse(prep(s).raw);s.globalRanking[0].confidence=91;const b=JSON.parse(prep(s).raw);
 assert.equal(a.sourceCycleId,b.sourceCycleId);assert.equal(a.observations[0].observationId,b.observations[0].observationId);
 assert.notEqual(a.observations[0].payloadHash,b.observations[0].payloadHash);
});
test('duplicate candidate fails closed; invalid/incomplete snapshot not complete',()=>{
 const s=snapshot();s.globalRanking.push(structuredClone(s.globalRanking[0]));assert.equal(prep(s).status,'UNRESOLVED');
 assert.equal(prep({...snapshot(),resultsFailed:1}).status,'UNRESOLVED');
 assert.equal(prep({...snapshot(),generatedAt:null}).status,'UNRESOLVED');
});
test('timeout is unresolved, one attempt, source data unchanged',async()=>{
 const s=snapshot(),before=structuredClone(s);let calls=0;
 const r=await persistObservationCycle(prep(s),async c=>{calls++;assert.equal(c[0],'EVAL');throw Error('timeout');});
 assert.equal(r.status,'UNRESOLVED');assert.equal(calls,1);assert.deepEqual(s,before);
});
test('missing/mismatched durable receipt is not success',async()=>{
 for(const response of [null,['COMPLETE','wrong'],['OK','anything']])assert.equal((await persistObservationCycle(prep(snapshot()),async()=>response)).status,'UNRESOLVED');
});
test('integration preserves Core branches and does not call Forward lifecycle',async()=>{
 const helper=await readFile(new URL('../lib/forward-validation/observation-store.js',import.meta.url),'utf8');
 assert.doesNotMatch(helper,/getOrCreateGeneration|recordGenerationClosure|createCaptureAdapter|createShadowStore|reduceMinute|fetch\(|setTimeout/);
 assert.match(source,/await persistObservationCycle\(forwardObservation, runRedisCommand\)/);
 assert.ok(source.indexOf('const forwardReceipt =')>source.indexOf('error: "Ranking refresh persistence incomplete"'));
 const {stdout:old}=await exec('git',['show','HEAD:api/market.js'],{cwd:new URL('..',import.meta.url),maxBuffer:2e6});
 for(const [start,end] of [['function isConfirmedAPlusTrade(signal) {','\nfunction isConfirmedAPlusTradeSignal'],
 ['async function createRankingHistoryEntry(','\nconst WRITE_OPEN_TRADES_SCRIPT'],
 ['async function writeRankingHistory(','\n// Read-only, user-declared']]) {
  const extract=s=>{const a=s.indexOf(start),b=s.indexOf(end,a);assert.ok(a>=0&&b>a);return s.slice(a,b);};
  assert.equal(extract(source),extract(old));
 }
});
test('atomic observation store on isolated Unix-socket Redis',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-observation-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 const redis=async cmd=>{const {stdout}=await exec('redis-cli',['-s',socket,'--json',...cmd.map(String)],{maxBuffer:12*1024*1024});if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);};
 const send=async p=>{let calls=0;const r=await persistObservationCycle(p,async c=>{calls++;return redis(c);});assert.equal(calls,p.status==='PREPARED'?1:0);return r;};
 try{
  let ready=false;for(let i=0;i<100;i++){try{await redis(['PING']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,20));}}assert.ok(ready);
  await t.test('zero observations complete and exact replay idempotent',async()=>{
   const p=prep(snapshot(0));assert.equal((await send(p)).status,'COMPLETE');const old=await redis(['GET',OBSERVATION_KEY]);
   assert.equal((await send(p)).status,'IDEMPOTENT');assert.equal(await redis(['GET',OBSERVATION_KEY]),old);
  });
  await t.test('conflicting whole-cycle replay preserves original bytes',async()=>{
   const old=await redis(['GET',OBSERVATION_KEY]);assert.equal((await send(prep(snapshot(1)))).status,'CONFLICT');assert.equal(await redis(['GET',OBSERVATION_KEY]),old);
  });
  await t.test('25 observations one atomic request; per-observation conflicting replay',async()=>{
   const s=snapshot(25,'2026-10-18T10:01:00.000Z'),p=prep(s);assert.equal((await send(p)).status,'COMPLETE');
   const old=await redis(['GET',OBSERVATION_KEY]);s.globalRanking[0].confidence=99;
   assert.equal((await send(prep(s))).status,'CONFLICT');assert.equal(await redis(['GET',OBSERVATION_KEY]),old);
  });
  await t.test('exactly 32768 accepted, 32769 blocked with no write/request',async()=>{
   const s=snapshot(1,'2026-10-18T10:02:00.000Z');s.globalRanking[0].researchProjectionJSON='';
   const base=Buffer.byteLength(prep(s).raw);s.globalRanking[0].researchProjectionJSON='x'.repeat(MAX_ENVELOPE_BYTES-base);
   const p=prep(s);assert.equal(Buffer.byteLength(p.raw),32768);assert.equal((await send(p)).status,'COMPLETE');
   const old=await redis(['GET',OBSERVATION_KEY]);s.globalRanking[0].researchProjectionJSON+='x';
   assert.equal((await send(prep(s))).status,'BLOCKED_STORAGE');assert.equal(await redis(['GET',OBSERVATION_KEY]),old);
  });
  await t.test('Lua invalid observation rejects whole cycle',async()=>{
   const p=prep(snapshot(2,'2026-10-18T10:03:00.000Z')),e=JSON.parse(p.raw);e.observations[1].observationId=e.observations[0].observationId;
   const old=await redis(['GET',OBSERVATION_KEY]);assert.equal((await send({...p,raw:canonicalJSON(e)})).status,'CONFLICT');assert.equal(await redis(['GET',OBSERVATION_KEY]),old);
  });
  await t.test('atomic concurrent identical writers yield complete + idempotent',async()=>{
   const p=prep(snapshot(1,'2026-10-18T10:04:00.000Z'));const r=await Promise.all([send(p),send(p)]);
   assert.deepEqual(r.map(x=>x.status).sort(),['COMPLETE','IDEMPOTENT']);
  });
  await t.test('event/cycle budget exhausted preserves old evidence',async()=>{
   // Synthetic prior ledger only, no production data or transport.
   const cycles={};let bytes=0;for(let i=0;i<10000;i++){const id=i.toString(16).padStart(64,'0');const raw=JSON.stringify({sourceCycleId:id,expectedObservationCount:0});cycles[id]=raw;bytes+=Buffer.byteLength(raw);}
   const ledger=JSON.stringify({schemaVersion:'forward-observation-ledger-v1',cycles,count:10000,observations:0,payloadBytes:bytes});
   // stdin avoids OS argv size limits.
   await new Promise((resolve,reject)=>{const c=spawn('redis-cli',['-s',socket,'-x','SET',OBSERVATION_KEY]);c.on('error',reject);c.on('exit',n=>n===0?resolve():reject(Error('seed')));c.stdin.end(ledger);});
   const old=await redis(['GET',OBSERVATION_KEY]);assert.equal((await send(prep(snapshot(1,'2026-10-18T10:05:00.000Z')))).status,'BLOCKED_STORAGE');assert.equal(await redis(['GET',OBSERVATION_KEY]),old);
  });
 }finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
