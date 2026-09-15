import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const page = start => Array.from({length:100}, (_,i) => [String(start-i), '10','12','9','11','20','0','220','1']);
function harness(statuses, header = null) {
  const calls=[], delays=[], timeouts=[];
  let successfulPages=0;
  const c=vm.createContext({process:{env:{}},console,URL,Date,
    AbortSignal:{timeout(ms){timeouts.push(ms);return {attempt:timeouts.length};}},
    setTimeout(fn,ms){delays.push(ms);fn();},
    fetch:async(url,options)=>{
      calls.push({url:new URL(url),signal:options.signal});
      const status=statuses[calls.length-1]; assert.ok(status,'unexpected request');
      return {status,ok:status===200,headers:{get:()=>header},json:async()=>status===200
        ? {code:'0',data:page(1000-100*successfulPages++)}
        : {code:'error',msg:`HTTP ${status}`}};
    }});
  vm.runInContext(source,c);
  return {calls,delays,timeouts,load:limit=>c.requestOKXKlines('BTCUSDT','1D',limit,'SWAP')};
}
for (const [name,statuses,ok,delays] of [
  ['200 immediately',[200],true,[]],
  ['429 then 200',[429,200],true,[500]],
  ['429 twice then 200',[429,429,200],true,[500,1000]],
  ['429 exhausted',[429,429,429],false,[500,1000]],
  ['500 does not retry',[500],false,[]]
]) test(name,async()=>{
  const h=harness(statuses);const r=await h.load(100);
  assert.equal(r.ok,ok);assert.equal(h.calls.length,statuses.length);assert.deepEqual(h.delays,delays);
  assert.deepEqual(h.timeouts,statuses.map(()=>8000));
  assert.equal(new Set(h.calls.map(x=>x.signal)).size,statuses.length);
  assert.equal(new Set(h.calls.map(x=>x.url.href)).size,1);
  if(!ok){assert.equal(r.status,statuses.at(-1));assert.equal(r.data.length,0);assert.equal(r.error,`HTTP ${statuses.at(-1)}`);}
});
test('300 candles preserve pagination and ascending output',async()=>{
 const h=harness([200,200,200]);const r=await h.load(300);
 assert.equal(r.ok,true);assert.equal(r.data.length,300);assert.deepEqual(h.delays,[]);
 assert.deepEqual(h.calls.map(x=>x.url.searchParams.get('after')),[null,'901','801']);
 assert.ok(h.calls.every(x=>x.url.searchParams.get('limit')==='100' && x.url.searchParams.get('instId')==='BTC-USDT-SWAP'));
 assert.equal(r.data[0].openTime,701);assert.equal(r.data.at(-1).openTime,1000);
});
test('failed later page never returns partial success',async()=>{
 const h=harness([200,429,429,429]);const r=await h.load(300);
 assert.equal(r.ok,false);assert.equal(r.data.length,0);assert.equal(r.status,429);
 assert.deepEqual(h.calls.slice(1).map(x=>x.url.searchParams.get('after')),['901','901','901']);
});
for (const [header,expected] of [['1',1000],['999',2000],['invalid',500],['0',500],['Wed, 01 Jan 2020 00:00:00 GMT',500],['Wed, 01 Jan 2099 00:00:00 GMT',2000]])
 test(`Retry-After ${header}`,async()=>{const h=harness([429,200],header);assert.equal((await h.load(100)).ok,true);assert.deepEqual(h.delays,[expected]);});
