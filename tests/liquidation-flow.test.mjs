import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
function runtime(code=source){const c=vm.createContext({process:{env:{}},Date,console});vm.runInContext(code,c);return c;}
const row=(long,short,total=long+short)=>({exchange:'All',longLiquidation_usd:long,shortLiquidation_usd:short,liquidation_usd:total});
test('24h shares and signed imbalance describe both liquidation sides',()=>{
  const c=runtime();
  for(const [long,short,side,imbalance] of [[75,25,'LONG',50],[25,75,'SHORT',-50],[50,50,'Balanced',0],[100,0,'LONG',100]]){
    const f=c.calculateLiquidationFlow(row(long,short));
    assert.equal(f.available,true);assert.equal(f.longSharePct,long);assert.equal(f.shortSharePct,short);
    assert.equal(f.dominantSide,side);assert.equal(f.imbalancePct,imbalance);assert.equal(f.affectsTradingScore,false);
    assert.equal(f.spikes.available,false);assert.equal(f.priceConfirmation.available,false);
  }
});
test('missing, negative, string and nonfinite amounts never become zeros',()=>{
  const c=runtime();
  for(const value of [null,undefined,-1,NaN,Infinity,'10']){
    const f=c.calculateLiquidationFlow(row(value,10));
    assert.equal(f.available,false);assert.equal(f.longUsd,null);assert.equal(f.imbalancePct,null);assert.equal(f.dominantSide,'N/A');
  }
  assert.equal(c.calculateLiquidationFlow(row(Number.MAX_VALUE,Number.MAX_VALUE)).available,false);
});
test('zero activity and mismatched reported total remain explicit',()=>{
  const c=runtime();const zero=c.calculateLiquidationFlow(row(0,0));
  assert.equal(zero.available,true);assert.equal(zero.longSharePct,null);assert.equal(zero.dominantSide,'N/A');
  const mismatch=c.calculateLiquidationFlow(row(75,25,120));
  assert.equal(mismatch.sideTotalUsd,100);assert.equal(mismatch.reportedTotalUsd,120);
  assert.equal(mismatch.totalDifferenceUsd,20);assert.equal(mismatch.longSharePct,75);
});
test('existing derivatives output stays identical after removing the additive flow field',()=>{
  const c=runtime();
  const previous=runtime(source.replace('      flow: calculateLiquidationFlow(aggregatedLiquidations),',''));
  for(const liquidations of [[],[row(75,25)],[{...row(75,25),exchange:'Binance'}],[row(null,10)]]){
    const input={available:true,liquidations};
    const current=JSON.parse(JSON.stringify(c.calculateDerivativesHistory(input)));
    const old=JSON.parse(JSON.stringify(previous.calculateDerivativesHistory(input)));
    assert.equal(current.liquidations.flow.available,liquidations[0]?.exchange==='All' && liquidations[0]?.longLiquidation_usd!==null);
    delete current.liquidations.flow;
    // Retrieval timestamps can differ by a millisecond between the two evaluations.
    for(const value of Object.values(current))if(value && typeof value==='object')delete value.lastUpdated;
    for(const value of Object.values(old))if(value && typeof value==='object')delete value.lastUpdated;
    assert.deepEqual(current,old);
  }
});
