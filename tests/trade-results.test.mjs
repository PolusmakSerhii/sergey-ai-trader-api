import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source=(await readFile(new URL('../api/market.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const c=vm.createContext({process:{env:{}},Date,console});vm.runInContext(source,c);
const signal=(id,r,status='Stopped')=>({tradeId:String(id),outcome:{status,resultR:r,checkedAt:`2026-09-08T00:0${id}:00Z`}});
test('closed results follow R rather than TP/SL label; missing R never becomes zero',()=>{
  assert.equal(c.classifyTradeResult(signal(0,0)),'BreakEven');
  assert.equal(c.classifyTradeResult(signal(0,0,'TP1Hit')),'BreakEven');
  assert.equal(c.classifyTradeResult(signal(0,0.5)),'Win');
  assert.equal(c.classifyTradeResult(signal(0,-0.5,'TP1Hit')),'Loss');
  for(const r of [null,undefined,'0',NaN,Infinity])assert.equal(c.classifyTradeResult(signal(0,r)),null);
  assert.equal(c.classifyTradeResult(signal(0,0,'Expired')),null);
  assert.equal(c.classifyTradeResult(signal(0,1,'Active')),null);
});
test('persistent and rolling totals agree for losses, break-even and profitable stop exits',()=>{
  const signals=[signal(0,-1),signal(1,0),signal(2,-1),signal(3,0.5)];
  let stats=c.createEmptyPersistentTradeStats();
  for(const trade of signals)stats=c.addTradeToPersistentStats(stats,trade);
  const summary=c.createOutcomeSummary([{readySignals:signals}]);
  for(const key of ['completed','wins','losses','breakEvens','netR','maxConsecutiveLosses'])assert.equal(stats[key],summary[key]);
  assert.equal(stats.completed,4);assert.equal(stats.losses,2);assert.equal(stats.breakEvens,1);assert.equal(stats.wins,1);
  assert.equal(stats.netR,-1.5);assert.equal(stats.maxConsecutiveLosses,1);assert.equal(summary.winRate,25);
  assert.equal(stats.resultClassificationSince,signals[0].outcome.checkedAt);
});
test('legacy totals are preserved while new break-even starts a dated counter',()=>{
  const stats=c.addTradeToPersistentStats({completed:100,wins:60,losses:40,netR:20},signal(1,0));
  assert.equal(stats.completed,101);assert.equal(stats.wins,60);assert.equal(stats.losses,40);assert.equal(stats.netR,20);assert.equal(stats.breakEvens,1);
});
