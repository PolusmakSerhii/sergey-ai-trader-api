import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const s=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const c=vm.createContext({process:{env:{}},Date,console});vm.runInContext(s,c);
const step=14400000,t=1788811200000,now=t+7*step+1000;
const response=data=>({ok:true,data});
const rows=Array.from({length:7},(_,i)=>({time:t+i*step,aggregated_long_liquidation_usd:i===6?100:10,aggregated_short_liquidation_usd:10}));
test('liquidation baseline excludes latest interval and incomplete candle',()=>{
 const x=c.calculateLiquidationHistoryContext(response([...rows,{...rows[0],time:t+7*step}]),now);
 assert.equal(x.available,true);assert.equal(x.relativeToBaseline,5.5);assert.equal(x.baselineMeanUsd,20);assert.equal(x.dominantSide,'LONG');
 for(const data of [rows.slice(1),[...rows,rows[0]],rows.map((r,i)=>i===2?{...r,aggregated_long_liquidation_usd:null}:r)])assert.equal(c.calculateLiquidationHistoryContext(response(data),now).available,false);
 const zero=c.calculateLiquidationHistoryContext(response(rows.map(r=>({...r,aggregated_long_liquidation_usd:0,aggregated_short_liquidation_usd:0}))),now);
 assert.equal(zero.relativeToBaseline,null);assert.equal(zero.dominantSide,'NONE');
});
test('OI price four combinations match exact closed time and reject missing values',()=>{
 const time=t+6*step;
 for(const oi of [90,110])for(const price of [90,110]){
 const x=c.calculateOIPrice4h(response([{time,open:'100',close:String(oi)}]),response([{time,open:'100',close:String(price)}]),now);
 assert.equal(x.available,true);assert.equal(x.state,`PRICE_${price>100?'UP':'DOWN'}_OI_${oi>100?'UP':'DOWN'}`);
 }
 for(const close of [null,'',0,-1,'bad'])assert.equal(c.calculateOIPrice4h(response([{time,open:100,close}]),response([{time,open:100,close:110}]),now).available,false);
 assert.equal(c.calculateOIPrice4h(response([{time:time-step,open:100,close:110}]),response([{time,open:100,close:110}]),now).available,false);
});
