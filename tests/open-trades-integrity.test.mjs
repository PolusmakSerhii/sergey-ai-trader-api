import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { BACKUP_KEYS as keys, createRestoreCommands } from '../scripts/redis-backup-format.mjs';
const original = await readFile(new URL('../api/market.js', import.meta.url), 'utf8');
const source = original.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const trade = (id='one', setup='setup-one') => ({tradeId:id, setupKey:setup, initialPlan:{frozen:true}, outcome:{status:'Active'}});
function runtime() {
 const c = vm.createContext({console:{error(){},log(){}}, Date, URL, setTimeout,
  process:{env:{}}, fetch(){throw Error('Network forbidden');}});
 vm.runInContext(source,c); c.getRedisConfig=()=>({}); return c;
}
const cases = [
 ['duplicate tradeId', [trade(),trade('one','other')]],
 ['duplicate setupKey', [trade(),trade('other')]],
 ['conflicting duplicate', [trade(),{...trade(),initialPlan:{frozen:false}}]],
 ['non-string tradeId', [{...trade(),tradeId:123}]],
 ['non-string setupKey', [{...trade(),setupKey:{}}]],
 ['missing tradeId', [{...trade(),tradeId:''}]],
 ['missing setupKey', [{...trade(),setupKey:''}]],
 ['missing initialPlan', [{...trade(),initialPlan:null}]],
 ['invalid status', [{...trade(),outcome:{status:'other'}}]]
];
for(const [name,rows] of cases) test(`JS ${name}: rejects before transport and completed accounting`,async()=>{
 const c=runtime(); let commands=0, accounting=0;
 assert.throws(()=>c.writeOpenTradesCAS('[]',rows,()=>{commands++;}),/Invalid/);
 c.createRankingHistoryEntry=async()=>({readySignals:rows});
 c.recordCompletedTradeSignals=async()=>{accounting++;};
 assert.equal(await c.writeRankingHistory({},async command=>{
  assert.ok(['GET','LINDEX'].includes(command[0])); return command[0]==='GET'?'[]':null;
 }),false);
 assert.equal(commands,0);assert.equal(accounting,0);
});
test('invalid readySignals is rejected even when proposed open state is valid',()=>{
 const c=runtime(); assert.throws(()=>c.writeOpenTradesCAS('[]',[],()=>assert.fail('write'),
 {history:{readySignals:[trade(),trade()]}}),/Invalid/);
});

test('exact Lua independently validates proposals against isolated Redis',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'integrity-test-'));const socket=join(dir,'redis.sock');
 const server=spawn('redis-server',['--port','0','--unixsocket',socket,'--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 let startupError;server.on('error',e=>{startupError=e;});const exec=promisify(execFile);
 const redis=async command=>{const {stdout}=await exec('redis-cli',['-s',socket,'--json',...command.map(String)]);if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);};
 try{
  let ready=false;for(let i=0;i<100;i++){if(startupError)throw startupError;try{ready=await redis(['PING'])==='PONG';}catch{}if(ready)break;await new Promise(r=>setTimeout(r,20));}assert.ok(ready);
  const c=runtime(),script=vm.runInContext('WRITE_OPEN_TRADES_SCRIPT',c);
  // Synthetic keys on a private Unix socket only.
  const open='test:open',history='test:history',ids='test:ids',stats='test:stats';
  await redis(['SET',open,'[]']);await redis(['LPUSH',history,'baseline']);await redis(['SET',stats,'baseline']);
  const run=(rows,entry={readySignals:rows},preimage='[]')=>redis(['EVAL',script,'3',open,history,ids,preimage,JSON.stringify(rows),'',JSON.stringify(entry),'100']);
  const unchanged=async()=>{assert.equal(await redis(['GET',open]),'[]');assert.deepEqual(await redis(['LRANGE',history,'0','-1']),['baseline']);assert.equal(await redis(['GET',stats]),'baseline');assert.equal(await redis(['SCARD',ids]),0);};
  for(const [name,rows] of cases)await t.test(`Lua ${name}: all stores unchanged`,async()=>{await assert.rejects(run(rows),/Invalid/);await unchanged();});
  await t.test('Lua rejects invalid history independently',async()=>{await assert.rejects(run([],{readySignals:[trade(),trade()]}),/Invalid/);await unchanged();});
  await t.test('Lua rejects non-array prepared state and malformed JSON',async()=>{
   for(const raw of ['{}','null','{broken','[{"tradeId":"x"}]']) {
    await assert.rejects(redis(['EVAL',script,'3',open,history,ids,'[]',raw,'','','100']),/Invalid/);await unchanged();
   }
  });
  await t.test('CAS mismatch preserves preimage and history',async()=>{assert.equal(await run([trade()],undefined,'stale'),0);await unchanged();});
  await t.test('real cjson accepts empty array and rejects empty object without writes',async()=>{
   assert.equal(await run([]),1);
   assert.equal(await redis(['GET',open]),'[]');
   assert.equal(await redis(['LINDEX',history,'0']),JSON.stringify({readySignals:[]}));
   const before=await redis(['LRANGE',history,'0','-1']);
   await assert.rejects(redis(['EVAL',script,'3',open,history,ids,'[]','{}','','','100']),/Invalid/);
   assert.equal(await redis(['GET',open]),'[]');
   assert.deepEqual(await redis(['LRANGE',history,'0','-1']),before);
   await redis(['DEL',history]);await redis(['LPUSH',history,'baseline']);
  });
  await t.test('valid nonempty current state survives every invalid proposal byte-for-byte',async()=>{
   const current=JSON.stringify([trade('existing','existing-setup')]);
   await redis(['SET',open,current]);
   const beforeHistory=await redis(['LRANGE',history,'0','-1']);
   const withoutId=trade();delete withoutId.tradeId;
   const withoutSetup=trade();delete withoutSetup.setupKey;
   for(const rows of [ [withoutId], [withoutSetup], [null], ...cases.map(([,rows])=>rows) ]) {
    await assert.rejects(run(rows,undefined,current),/Invalid/);
    assert.equal(await redis(['GET',open]),current);
    assert.deepEqual(await redis(['LRANGE',history,'0','-1']),beforeHistory);
    assert.equal(await redis(['GET',stats]),'baseline');
    assert.equal(await redis(['SCARD',ids]),0);
   }
   await redis(['SET',open,'[]']);
  });
  await t.test('valid proposal atomically persists open state and history',async()=>{assert.equal(await run([trade()]),1);assert.equal(await redis(['GET',open]),JSON.stringify([trade()]));assert.equal(await redis(['LLEN',history]),2);assert.equal(await redis(['GET',stats]),'baseline');});
 }finally{server.kill();if(server.exitCode===null&&!startupError)await new Promise(r=>server.once('exit',r));await rm(dir,{recursive:true,force:true});}
});
const backup=rows=>({format:'sergey-ai-redis-backup',version:3,keys,ranking:{ok:true},history:[],completedTrades:[],completedTradeIds:[],completedTradeStats:null,openTrades:rows});
for(const [name,rows] of cases.slice(0,2))test(`restore ${name} rejected before commands`,()=>assert.throws(()=>createRestoreCommands(backup(rows)),/duplicate/));
test('valid restore preserves serialized open trades exactly',()=>{const rows=[trade()];const commands=createRestoreCommands(backup(rows));assert.deepEqual(commands.find(c=>c[1]===keys.openTrades),['SET',keys.openTrades,JSON.stringify(rows)]);});

test('scanner overlap chooses lowest page then first occurrence without changing fields',()=>{
 const c=runtime();const a={symbol:'A',opportunityScore:10,confidence:20,probabilities:{up:90},grade:'A+'};
 const b={symbol:'B',opportunityScore:20,confidence:30};
 const result=c.aggregateScannerBatches([
  {page:2,totalAvailableSymbols:4,globalBatchResults:[{...a,opportunityScore:100},b]},
  {page:1,totalAvailableSymbols:4,globalBatchResults:[a,{...a,confidence:100}]}]);
 assert.equal(result.rows.length,2);assert.equal(result.rows[0],a);assert.equal(result.rows[1],b);
 assert.equal(new Set(result.rows.map(r=>r.symbol)).size,2);
 assert.deepEqual(JSON.parse(JSON.stringify(result.coverage)),{rawRowsCount:4,uniqueSymbolsCount:2,duplicateRowsRemoved:2,totalAvailableSymbols:4,coverageDelta:-2});
 // Execute the existing comparator/rank pipeline, not a second implementation.
 const start=original.indexOf(' const globalRanking =\n'),end=original.indexOf('const globalTop10',start);
 assert.ok(start>0&&end>start);c.combinedResults=result.rows;
 vm.runInContext(original.slice(start,end)+';globalThis.ranked=globalRanking;',c);
 assert.equal(c.ranked[0].symbol,'B');assert.equal(c.ranked[1].symbol,'A');
 assert.equal(a.opportunityScore,10);assert.equal(a.grade,'A+');assert.equal(a.probabilities.up,90);
 assert.match(original,/const trackedItems = readyItems\.slice\(0, 20\)/);
});
test('unique complete scanner batches remain unchanged, missing total is unknown',()=>{
 const c=runtime(),rows=[{symbol:'A'},{symbol:'B'}];const result=c.aggregateScannerBatches([{batch:1,totalAvailableSymbols:2,globalBatchResults:rows}]);
 assert.equal(result.rows[0],rows[0]);assert.equal(result.rows[1],rows[1]);assert.equal(result.coverage.coverageDelta,0);assert.equal(result.coverage.duplicateRowsRemoved,0);
 assert.equal(c.aggregateScannerBatches([{globalBatchResults:rows}]).coverage.coverageDelta,null);
});
