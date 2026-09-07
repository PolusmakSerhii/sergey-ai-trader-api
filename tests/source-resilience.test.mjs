import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
function runtime(fetch) {
  const context = vm.createContext({ process:{env:{COINGLASS_API_KEY:'test'}}, console, URL,
    URLSearchParams, Date, AbortSignal, structuredClone, fetch });
  vm.runInContext(source,context);
  return context;
}
const response = data => ({ok:true,status:200,json:async()=>({code:'0',data})});
test('concurrent identical CoinGlass requests coalesce and cached results cannot be mutated', async()=>{
  let calls=0;
  const c=runtime(async(url,options)=>{calls++;assert.ok(options.signal);return response([{value:1}]);});
  const results=await Promise.all(Array.from({length:20},()=>c.fetchCoinGlass('/funding',{symbol:'BTC'})));
  assert.equal(calls,1);
  results[0].data[0].value=99;
  assert.equal(results[1].data[0].value,1);
  assert.equal((await c.fetchCoinGlass('/funding',{symbol:'BTC'})).data[0].value,1);
  await c.fetchCoinGlass('/funding',{symbol:'ETH'});
  assert.equal(calls,2);
});
test('expired cache is refetched; failures are not cached or replaced with stale success',async()=>{
  let calls=0;
  const c=runtime(async()=>{calls++;if(calls===2)throw new Error('offline');return response([calls]);});
  await c.fetchCoinGlass('/funding');
  vm.runInContext('for (const entry of sourceResponses.values()) entry.expiresAt = 0',c);
  assert.equal((await c.fetchCoinGlass('/funding')).ok,false);
  assert.equal((await c.fetchCoinGlass('/funding')).data[0],3);
  assert.equal(calls,3);
});
test('shared Redis cache avoids upstream calls on a fresh instance and uses expiring keys',async()=>{
  const records=new Map();let calls=0;
  const redis=async command=>{
    if(command[0]==='GET')return records.get(command[1])??null;
    assert.equal(command[3],'EX');assert.equal(command[4],60);
    records.set(command[1],command[2]);return 'OK';
  };
  const first=runtime(async()=>{calls++;return response([1]);});first.runRedisCommand=redis;
  await first.fetchCoinGlass('/funding');
  const second=runtime(async()=>{calls++;throw new Error('must use Redis');});second.runRedisCommand=redis;
  assert.equal((await second.fetchCoinGlass('/funding')).data[0],1);assert.equal(calls,1);
});
test('corrupt or unavailable Redis does not disable upstream',async()=>{
  for(const raw of ['invalid JSON',JSON.stringify({expiresAt:Date.now()+99999,value:{ok:false}})]){
    const c=runtime(async()=>response([7]));c.runRedisCommand=async command=>{
      if(command[0]==='GET')return raw;throw new Error('write unavailable');
    };
    assert.equal((await c.fetchCoinGlass('/funding')).data[0],7);
  }
  const c=runtime(async()=>response([8]));c.runRedisCommand=async()=>{throw new Error('offline');};
  assert.equal((await c.fetchCoinGlass('/funding')).data[0],8);
});
test('Fear & Greed failures produce N/A and a later success recovers',async()=>{
  let calls=0;
  const c=runtime(async()=>{calls++;if(calls===1)throw new Error('timeout');return {ok:true,json:async()=>({data:[{value:'54',value_classification:'Neutral'}]})};});
  assert.equal((await c.fetchFearGreed()).value,null);
  assert.equal((await c.fetchFearGreed()).value,'54');
  assert.equal((await c.fetchFearGreed()).classification,'Neutral');assert.equal(calls,2);
});
test('malformed Fear & Greed data is not converted into a fabricated value',async()=>{
  const c=runtime(async()=>({ok:true,json:async()=>({data:[{value:null}]})}));
  assert.equal((await c.fetchFearGreed()).classification,'N/A');
});
test('failed or empty ranking batches preserve both previous cache and trade history',async()=>{
  for(const batch of [
    {ok:true,totalBatches:1,failed:1,globalBatchResults:[{symbol:'BTCUSDT'}]},
    {ok:true,totalBatches:1,failed:0,globalBatchResults:[]},
    {ok:false,totalBatches:1,failed:0}
  ]){
    const c=runtime(async()=>({ok:true,json:async()=>batch}));
    c.verifyQStashRequest=async()=>true;
    c.writeGlobalRankingCache=async()=>{throw new Error('must preserve cache');};
    c.writeRankingHistory=async()=>{throw new Error('must preserve history');};
    const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await c.handler({method:'GET',headers:{host:'test.local'},query:{mode:'scanner',globalRank:'true',refresh:'true'}},res);
    assert.equal(res.code,502);assert.equal(res.body.ok,false);
  }
});
test('complete ranking still persists normally',async()=>{
  const c=runtime(async()=>({ok:true,json:async()=>({ok:true,totalBatches:1,failed:0,globalBatchResults:[{symbol:'BTCUSDT',opportunityScore:90}]})}));
  c.verifyQStashRequest=async()=>true;
  const writes=[];
  c.writeGlobalRankingCache=async snapshot=>{writes.push(snapshot);return true;};
  c.writeRankingHistory=async snapshot=>{writes.push(snapshot);return true;};
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await c.handler({method:'GET',headers:{host:'test.local'},query:{mode:'scanner',globalRank:'true',refresh:'true'}},res);
  assert.equal(res.code,200);assert.equal(writes.length,2);assert.equal(res.body.globalRanking[0].symbol,'BTCUSDT');
});
