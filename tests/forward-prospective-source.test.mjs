import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {prepareProspectiveObservation} from '../lib/forward-validation/prospective-source.js';
import {validateCycle} from '../lib/forward-validation/observation-reader.js';
import {mapObservation} from '../lib/forward-validation/delayed-ingestion.js';
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const c=vm.createContext({Date,console,process:{env:{}}});vm.runInContext(source,c);
const membership={status:'EXPECTED',epochId:'test-epoch',reservationId:'test-reservation'};
const at='2026-10-19T10:00:13.000Z';
function scanner(time=at){
 const payload={time,price:100,dataSafety:{candles:{fresh:true,source:'OKX',timeframe:'1D',instrumentType:'SWAP',instId:'BTC-USDT-SWAP',lastConfirmedAt:'2026-10-19T00:00:00.000Z'}},technical:{
  probability:{score:100,confidence:{score:100},aiAssessment:{direction:'Long',tradeAllowed:true}},
  recommendation:{action:'Strong Buy'},tradeReadiness:{ready:true,score:100,status:'Ready'},
  marketEnvironment:{score:100,tradable:true},smartMoney:{score:100},
  tradePlan:{entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130,riskReward:3},
  bos:'Bullish BOS',choch:'No CHOCH',mss:'Bullish MSS',trend:'Strong Bullish',ema20:100,ema50:99,ema100:98,ema200:97,
  rsi14:60,macd:{macd:2,signal:1,histogram:1},volumeStats:{ratio:1,spike:false}}};
 const row=c.createScannerAnalysis(payload,'BTCUSDT');
 const opportunity=c.calculateScannerOpportunity(row);row.opportunityScore=opportunity.score;row.opportunityGrade=opportunity.grade;
 assert.equal(c.isConfirmedAPlusTrade(row),true);
 return {ok:true,status:'ready',mode:'global-ranking',version:'1.0',generatedAt:time,resultsFailed:0,globalRanking:[structuredClone(row)]};
}
test('real scanner projection creates strict-mappable immutable source birth; repeated analysis keeps plan',async()=>{
 let ledger=null;
 const execute=async cmd=>cmd[1].includes('forward-observations')?ledger:null;
 const snapshot=scanner(),before=JSON.stringify(snapshot);
 const first=await prepareProspectiveObservation(snapshot,c.isConfirmedAPlusTrade,c.createForwardFrozenCandidate,execute,membership);
 assert.equal(first.status,'PREPARED',JSON.stringify(first));assert.equal(JSON.stringify(snapshot),before);
 const cycle=validateCycle(first.raw,first.sourceCycleId),mapped=mapObservation(cycle,cycle.envelope.observations[0]);
 assert.equal(mapped.status,'MAPPED');const f=mapped.frozenCandidate;
 assert.equal(f.origin.detectedAt,at);assert.equal(f.initialPlan.createdAt,at);assert.equal(f.initialPlan.plannedAt,at);
 assert.equal(f.initialPlan.expiresAt,'2026-10-19T11:00:13.000Z');assert.equal(f.initialPlan.initialStopLoss,90);
 assert.equal(f.initialPlan.exitStrategy.version,'tp1-50-reanalyse-v1');
 ledger=JSON.stringify({schemaVersion:'forward-observation-ledger-v1',cycles:{[first.sourceCycleId]:first.raw},count:1,observations:1,payloadBytes:Buffer.byteLength(first.raw)});
 const repeated=await prepareProspectiveObservation(scanner('2026-10-19T10:05:00.000Z'),c.isConfirmedAPlusTrade,c.createForwardFrozenCandidate,execute,membership);
 assert.equal(repeated.status,'PREPARED');const second=validateCycle(repeated.raw,repeated.sourceCycleId);
 assert.deepEqual(mapObservation(second,second.envelope.observations[0]).frozenCandidate,f);
});

test('prospective source fails closed at the unchanged F2 32768-byte envelope bound',async()=>{
 const snapshot=scanner();snapshot.globalRanking[0].tradeReadiness.detail='x'.repeat(32768);
 const result=await prepareProspectiveObservation(snapshot,c.isConfirmedAPlusTrade,c.createForwardFrozenCandidate,async()=>null,membership);
 assert.equal(result.status,'BLOCKED_STORAGE');assert.equal(result.reason,'OVERSIZED_CYCLE');
});
test('missing source analysis timestamp is not fabricated',async()=>{
 const snapshot=scanner();delete snapshot.globalRanking[0].analysisContext.analysisAt;
 const result=await prepareProspectiveObservation(snapshot,c.isConfirmedAPlusTrade,c.createForwardFrozenCandidate,async()=>null,membership);
 assert.equal(result.status,'UNRESOLVED');
});
// Exercise actual Lua persistence and the production F3 worker, not a fabricated candidate.
test('scanner -> durable F2 -> reader -> F3 Shadow generation on isolated Redis',async()=>{
 const {spawn,execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {persistObservationCycle}=await import('../lib/forward-validation/observation-store.js');
 const {readObservations}=await import('../lib/forward-validation/observation-reader.js');
 const {runWorker,RUN_ID}=await import('../lib/forward-validation/worker.js');
 const {createShadowStore}=await import('../lib/forward-validation/store.js');
 const exec=promisify(execFile),dir=await mkdtemp(join(tmpdir(),'source-path-')),socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no'],{stdio:'ignore'});
 const execute=async command=>{const {stdout}=await exec('redis-cli',['-s',socket,'--json',...command.map(String)],{maxBuffer:16*1024*1024});if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);};
 try{
  for(let i=0;i<100;i++){try{await execute(['PING']);break;}catch{await new Promise(r=>setTimeout(r,20));}}
  const prepared=await prepareProspectiveObservation(scanner(),c.isConfirmedAPlusTrade,c.createForwardFrozenCandidate,execute,membership);
  assert.equal((await persistObservationCycle(prepared,execute)).status,'COMPLETE');
  assert.equal((await persistObservationCycle(prepared,execute)).status,'IDEMPOTENT');
  const changed=JSON.parse(prepared.raw);changed.observations[0].payload.confidence=99;
  assert.equal((await persistObservationCycle({...prepared,raw:JSON.stringify(changed)},execute)).status,'CONFLICT');
  const stale=await prepareProspectiveObservation(scanner('2026-10-19T10:06:00.000Z'),c.isConfirmedAPlusTrade,c.createForwardFrozenCandidate,execute,membership);
  const competing=await prepareProspectiveObservation(scanner('2026-10-19T10:05:00.000Z'),c.isConfirmedAPlusTrade,c.createForwardFrozenCandidate,execute,membership);
  assert.equal((await persistObservationCycle(competing,execute)).status,'COMPLETE');
  assert.equal((await persistObservationCycle(stale,execute)).status,'CONFLICT');
  const rows=await readObservations(execute);assert.equal(rows.length,2);
  assert.equal(mapObservation(rows[0],rows[0].envelope.observations[0]).status,'MAPPED');
  const result=await runWorker({execute,now:()=>Date.parse('2026-10-19T10:10:00.000Z')});
  assert.equal(result.status,'COMPLETE',JSON.stringify(result));
  const shadow=await createShadowStore(execute).read(RUN_ID);assert.equal(shadow.status,'OK');
  assert.equal(shadow.ledger.records.length,1);
  assert.equal(shadow.ledger.records[0].initialPlan.plannedAt,at);
  assert.equal(shadow.ledger.records[0].initialPlan.initialStopLoss,90);
 }finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
