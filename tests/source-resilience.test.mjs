import { randomUUID } from "node:crypto";
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
function runtime(fetch) {
  const context = vm.createContext({ process:{env:{COINGLASS_API_KEY:'test'}}, console, URL,
    URLSearchParams, Date, AbortSignal, structuredClone, randomUUID, fetch });
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
test('source caches never call Redis, including misses, hits and expiry',async()=>{
  let redisCalls=0, loads=0;
  const c=runtime(async()=>response([1]));
  c.runRedisCommand=async()=>{redisCalls++;throw new Error('Redis must not be used');};
  const valid=value=>value?.ok===true;
  const load=async()=>{loads++;return {ok:true,data:[loads]};};
  await c.cachedSource('example',60,load,valid);
  await c.cachedSource('example',60,load,valid);
  vm.runInContext('for (const entry of sourceResponses.values()) entry.expiresAt = 0',c);
  await c.cachedSource('example',60,load,valid);
  assert.equal(loads,2);
  await c.fetchCoinGlass('/funding');
  c.requestOKXSwapSymbols=async()=>({ok:true,symbols:[{symbol:'BTC'}]});
  c.requestOKXSwapTickers=async()=>({ok:true,tickers:[{price:1}]});
  c.requestOKXKlines=async()=>({ok:true,data:[{close:1}]});
  await c.fetchOKXSwapSymbols();await c.fetchOKXSwapTickers();await c.fetchOKXKlines('BTCUSDT');
  c.fetch=async()=>({ok:true,json:async()=>({data:[{value:'50',value_classification:'Neutral'}]})});
  assert.equal((await c.fetchFearGreed()).value,'50');
  assert.equal(redisCalls,0);
});
test('new server instances fetch independently and local cache is bounded',async()=>{
  let calls=0;
  const fetch=async()=>{calls++;return response([calls]);};
  const first=runtime(fetch), second=runtime(fetch);
  await first.fetchCoinGlass('/funding');await first.fetchCoinGlass('/funding');
  await second.fetchCoinGlass('/funding');
  assert.equal(calls,2);
  for(let i=0;i<150;i++)await first.cachedSource(`test:${i}`,60,async()=>({ok:true}),value=>value.ok);
  assert.equal(vm.runInContext('sourceResponses.size',first),128);
  await first.fetchCoinGlass('/funding');assert.equal(calls,3);
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
    c.runRedisCommand=async command=>command[0] === "SET" ? "OK" : 1;
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
    c.runRedisCommand=async command=>command[0] === "SET" ? "OK" : 1;
  const writes=[];
  c.writeGlobalRankingCache=async snapshot=>{writes.push(snapshot);return true;};
  c.writeRankingHistory=async snapshot=>{writes.push(snapshot);return true;};
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await c.handler({method:'GET',headers:{host:'test.local'},query:{mode:'scanner',globalRank:'true',refresh:'true'}},res);
  assert.equal(res.code,200);assert.equal(writes.length,2);assert.equal(res.body.globalRanking[0].symbol,'BTCUSDT');
});
const rankingRequest = () => ({method:'GET',headers:{host:'test.local'},query:{mode:'scanner',globalRank:'true',refresh:'true'}});
const result = () => ({setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
test('public cache miss never starts a scanner request',async()=>{
  let calls=0;
  const c=runtime(async()=>{calls++;throw new Error('no upstream expected');});
  const req=rankingRequest();delete req.query.refresh;
  const res=result();await c.handler(req,res);
  assert.equal(res.code,503);assert.equal(calls,0);
});
test('public cache hit keeps the existing response contract',async()=>{
  const c=runtime(async()=>{throw new Error('no upstream expected');});
  c.readGlobalRankingCache=async()=>({ok:true,generatedAt:'original',globalRanking:[{symbol:'BTCUSDT'}]});
  const req=rankingRequest();delete req.query.refresh;
  const res=result();await c.handler(req,res);
  assert.equal(res.code,200);assert.equal(res.body.generatedAt,'original');assert.equal(res.body.cache.status,'hit');
});
test('busy or unavailable refresh lock prevents all upstream work',async()=>{
  for(const unavailable of [false,true]) {
    let calls=0;
    const c=runtime(async()=>{calls++;throw new Error('no upstream expected');});
    c.verifyQStashRequest=async()=>true;
    c.runRedisCommand=async()=>{if(unavailable)throw new Error('offline');return null;};
    const res=result();await c.handler(rankingRequest(),res);
    assert.equal(res.code,503);assert.equal(calls,0);
  }
});
test('batch failure releases acquired lock and preserves stored state',async()=>{
  const commands=[];
  const c=runtime(async()=>{throw new Error('upstream timeout');});
  c.verifyQStashRequest=async()=>true;
  c.runRedisCommand=async command=>{commands.push(command);return command[0]==='SET'?'OK':1;};
  c.writeGlobalRankingCache=async()=>{throw new Error('must not write');};
  c.writeRankingHistory=async()=>{throw new Error('must not write');};
  const res=result();await c.handler(rankingRequest(),res);
  assert.equal(res.code,503);
  assert.match(commands.at(-1)[1],/redis.call\('DEL'/);
  assert.equal(commands.at(-1)[4],commands[0][2]);
});
test('lost lease before persistence rejects the refresh',async()=>{
  const c=runtime(async()=>({ok:true,json:async()=>({ok:true,totalBatches:1,failed:0,globalBatchResults:[{symbol:'BTCUSDT'}]})}));
  c.verifyQStashRequest=async()=>true;let renewals=0;
  c.runRedisCommand=async command=>{
    if(command[0]==='SET')return 'OK';
    if(command.includes('EXPIRE') && ++renewals>1)throw new Error('lease lost');
    return 1;
  };
  let writes=0;c.writeGlobalRankingCache=c.writeRankingHistory=async()=>{writes++;return true;};
  const res=result();await c.handler(rankingRequest(),res);
  assert.equal(res.code,503);assert.equal(writes,0);
});
test('daily candle cache separates instrument and limit and does not cache intraday candles',async()=>{
  const c=runtime(async()=>{throw new Error('no live network');});
  const calls=[];
  c.requestOKXKlines=async(...args)=>{calls.push(args);return {ok:true,data:[{close:100}]};};
  await c.fetchOKXKlines('BTCUSDT');await c.fetchOKXKlines('BTCUSDT');
  assert.equal(calls.length,1);
  await c.fetchOKXKlines('BTCUSDT','1D',1200,'SWAP');
  await c.fetchOKXKlines('BTCUSDT','1D',100,'SPOT');
  await c.fetchOKXKlines('ETHUSDT');
  assert.equal(calls.length,4);
  await c.fetchOKXKlines('BTCUSDT','1m');await c.fetchOKXKlines('BTCUSDT','1m');
  assert.equal(calls.length,6);
});
test('OKX symbols and tickers cache only valid nonempty responses',async()=>{
  const c=runtime(async()=>{throw new Error('no live network');});
  let symbols=0,tickers=0;
  c.requestOKXSwapSymbols=async()=>({ok:true,symbols:++symbols===1?[]:[{symbol:'BTC'}]});
  c.requestOKXSwapTickers=async()=>({ok:true,tickers:[{price:++tickers}]});
  await c.fetchOKXSwapSymbols();await c.fetchOKXSwapSymbols();await c.fetchOKXSwapSymbols();
  await c.fetchOKXSwapTickers();await c.fetchOKXSwapTickers();
  assert.equal(symbols,2);assert.equal(tickers,1);
});
