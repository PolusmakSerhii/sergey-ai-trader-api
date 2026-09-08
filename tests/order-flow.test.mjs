import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const s=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const c=vm.createContext({process:{env:{}},Date,console}); vm.runInContext(s,c);
const t=1788811200000, step=14400000;
const row=(time,buy,sell)=>({time,aggregated_buy_volume_usd:buy,aggregated_sell_volume_usd:sell});
const run=rows=>c.calculateOrderFlow({ok:true,data:rows},t+2*step+1000);
test('closed intervals sorted, actual delta accumulated, open interval excluded',()=>{
 const f=run([row(t+step,30,10),row(t,10,15),row(t+2*step,999,0)]);
 assert.equal(f.available,true);assert.equal(f.deltaUsd,20);assert.equal(f.cvdUsd,15);assert.equal(f.points.length,2);assert.equal(f.startTime,t);
});
test('missing values, gaps, duplicate and stale history remain unavailable',()=>{
 for(const bad of [null,undefined,'10',NaN,-1,Infinity]) assert.equal(run([row(t,10,bad)]).available,false);
 for(const rows of [[],[row(t,1,1),row(t,1,1)],[row(t-step,1,1),row(t+step,1,1)],[row(t-step,1,1)]]) assert.equal(run(rows).available,false);
 assert.equal(run([row(t,0,0),row(t+step,0,0)]).cvdUsd,0);
});
test('captured BTC OKX sample uses real buy and sell fields',()=>{
 const f=c.calculateOrderFlow({ok:true,data:[row(t,198508959.19937,228024133.99275)]},t+step+1);
 assert.equal(f.available,true);assert.ok(Math.abs(f.deltaUsd+29515174.79338)<.001);
});
