import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const repo=new URL('../',import.meta.url).pathname;
const before=execFileSync('git',['-C',repo,'show','6ac35e455797ef9bdff148a06a3eedc1fceb7b9e:api/market.js'],{encoding:'utf8'});
const after=readFileSync(new URL('../api/market.js',import.meta.url),'utf8');
const extract=s=>s.slice(s.indexOf('async function readRankingHistory() {'),s.indexOf('\nfunction createOutcomeSummary(',s.indexOf('async function readRankingHistory() {')));
async function run(source, rows, failureAt=Infinity){
 const calls=[],errors=[];
 const context=vm.createContext({GLOBAL_RANKING_HISTORY_LIMIT:240,GLOBAL_RANKING_HISTORY_KEY:'sergey-ai:global-ranking-history:v1',console:{error:(...x)=>errors.push(x)},runRedisCommand:async c=>{calls.push(c);if(Number(c[2])>=failureAt)throw Error('synthetic failure');return rows.slice(Number(c[2]),Number(c[3])+1);}});
 const result=await vm.runInContext(extract(source)+';readRankingHistory()',context);
 return {result:JSON.parse(JSON.stringify(result)),calls:JSON.parse(JSON.stringify(calls)),errors:errors.length};
}
const rows=n=>Array.from({length:n},(_,i)=>JSON.stringify({index:i}));
test('only batch constant changed; writer, key, observability, trading and lifecycle bytes preserved',()=>{
 assert.equal(after,before.replace('const chunkSize = 60;','const chunkSize = 10;'));
 assert.equal((before.match(/const chunkSize = 60;/g)||[]).length,1);
});
for(const n of [0,1,9,10,11,59,60,61,239,240,241,300])test(`full parity, order, cap and bounded ranges: ${n}`,async()=>{
 const a=await run(before,rows(n)),b=await run(after,rows(n));assert.deepEqual(b.result,a.result);assert.deepEqual(b.result,Array.from({length:Math.min(n,240)},(_,index)=>({index})));
 assert.ok(b.calls.length<=24);for(const [cmd,key,start,end] of b.calls){assert.equal(cmd,'LRANGE');assert.equal(key,'sergey-ai:global-ranking-history:v1');assert.ok(+end-+start+1<=10);assert.ok(+end<240);}
 if(n>=240)assert.equal(b.calls.length,24);
});
test('invalid JSON and falsy parsed values retain exact filtering',async()=>{
 const data=['bad','null','false','0','""','{}','[]','{"index":7}','"text"',...rows(70)];assert.deepEqual((await run(after,data)).result,(await run(before,data)).result);
});
for(const failureAt of [0,60,120,180])test(`read exception at ${failureAt} discards partial history as before`,async()=>{
 const a=await run(before,rows(240),failureAt),b=await run(after,rows(240),failureAt);assert.deepEqual(b.result,a.result);assert.deepEqual(b.result,[]);assert.equal(b.errors,1);
});
test('candidate-sized synthetic response stays under limit while 60 exceeds it',async()=>{
 const data=Array.from({length:240},(_,index)=>JSON.stringify({index,padding:'x'.repeat(197500)}));
 const limit=10485760;
 assert.ok(Buffer.byteLength(JSON.stringify(data.slice(0,60)))>limit);
 for(const size of [30,20,10])assert.ok(Buffer.byteLength(JSON.stringify(data.slice(0,size)))<limit);
 assert.deepEqual((await run(after,data)).result,(await run(before,data)).result);
});
