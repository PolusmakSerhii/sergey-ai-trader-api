import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8'))
  .replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const c=vm.createContext({process:{env:{}},Date,console});vm.runInContext(source,c);
const start=Date.parse('2026-09-05T16:00:00Z'), hour=3600000, end=start+24*hour;
const candle=(close=110)=>({openTime:start,open:100,close,confirmed:true});
const history=(close=1100)=>({ok:true,data:Array.from({length:6},(_,i)=>({time:start+i*4*hour,open:'1000',close:String(i===5?close:1000)}))});
const calculate=(response=history(),candles=[candle()],now=end+hour)=>c.calculateOpenInterestPriceContext(response,candles,now);
test('four price/OI combinations use matching 24h boundaries and preserve raw evidence',()=>{
  for(const [price,oi,state] of [[110,1100,'PRICE_UP_OI_UP'],[110,900,'PRICE_UP_OI_DOWN'],[90,1100,'PRICE_DOWN_OI_UP'],[90,900,'PRICE_DOWN_OI_DOWN']]){
    const r=calculate(history(oi),[candle(price)]);
    assert.equal(r.available,true);assert.equal(r.state,state);assert.equal(r.observations,6);
    assert.equal(r.windowStart,new Date(start).toISOString());assert.equal(r.windowEnd,new Date(end).toISOString());
    assert.equal(r.openInterestStart,1000);assert.equal(r.openInterestEnd,oi);assert.equal(r.affectsTradingScore,false);
    assert.ok(Math.abs(Math.abs(r.priceChangePct)-10)<1e-8);
  }
  assert.equal(calculate(history(1000),[candle(100)]).state,'PRICE_FLAT_OI_FLAT');
});
test('gaps, duplicates, shifted windows and invalid values cannot confirm OI context',()=>{
  for(const alter of [r=>r.data.pop(),r=>r.data.push(r.data[0]),r=>r.data[0].time+=hour,
    r=>r.data[0].open=null,r=>r.data[0].open='',r=>r.data[5].close=0,r=>r.data[3].close=-2]){
    const h=history();alter(h);const r=calculate(h);assert.equal(r.available,false);assert.equal(r.priceChangePct,null);
  }
  assert.equal(calculate({ok:false,data:history().data}).available,false);
});
test('unconfirmed, stale, duplicate and future price windows remain unavailable',()=>{
  for(const candles of [[{...candle(),confirmed:false}],[{...candle(),openTime:end}],
    [candle(),candle()],[{...candle(),open:null}]])assert.equal(calculate(history(),candles).available,false);
  assert.equal(calculate(history(),[candle()],end+24*hour).available,false);
});
test('out-of-order history is aligned; unrelated intervals are ignored',()=>{
  const h=history();h.data.reverse();h.data.push({time:start-4*hour,open:'1',close:'2'});
  assert.equal(calculate(h).available,true);
});
test('new context does not change the scoring-facing derivatives signal',()=>{
  const input={available:true,openInterestHistoryResponse:history()};
  const a=c.calculateDerivativesHistory(input,[]),b=c.calculateDerivativesHistory(input,[candle()]);
  assert.deepEqual(a.probabilitySignal,b.probabilitySignal);
  assert.deepEqual(a.openInterest.openInterestAssessment,b.openInterest.openInterestAssessment);
});
