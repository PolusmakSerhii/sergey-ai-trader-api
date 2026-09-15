import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
 .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const c = vm.createContext({process:{env:{}},console,Date});
vm.runInContext(source,c);
const input = (direction, raw) => ({direction, smartMoneyScore:raw, score:90, confidence:90,
 marketEnvironmentScore:90, tradeReadiness:{score:90,ready:true,status:'Ready'},
 probabilities:{neutral:0},tradeAllowed:true,riskReward:2,
 action:direction==='Short'?'Strong Sell':'Strong Buy',entryZone:{from:99,to:101},
 stopLoss:direction==='Short'?110:90,takeProfit1:direction==='Short'?90:110,
 takeProfit2:direction==='Short'?80:120,takeProfit3:direction==='Short'?70:130});
for(const raw of [90,80,70,50,30,10]) test(`mirror Long ${raw} / Short ${100-raw}`,()=>{
 const long=input('Long',raw),short=input('Short',100-raw),before=structuredClone(short);
 const l=c.calculateScannerOpportunity(long),s=c.calculateScannerOpportunity(short);
 assert.equal(l.score,s.score);assert.equal(l.components.smartMoneyQuality,raw);
 assert.equal(s.components.smartMoneyQuality,raw);assert.equal(s.components.smartMoney,100-raw);
 assert.deepEqual(short,before);
 assert.equal(l.score,Math.round(90*.2+90*.25+90*.25+90*.1+raw*.1+85*.1));
});
for(const direction of ['Neutral','unknown',undefined]) test(`neutral quality for ${direction}`,()=>{
 assert.equal(c.calculateScannerOpportunity(input(direction,90)).components.smartMoneyQuality,50);
});
for(const raw of [undefined,null,'90',NaN,Infinity,-Infinity,-1,101]) test(`safe quality for ${String(raw)}`,()=>{
 const r=c.calculateScannerOpportunity(input('Short',raw));assert.equal(r.components.smartMoneyQuality,50);
 assert.ok(Number.isFinite(r.score));assert.equal(r.components.smartMoney,typeof raw==='number'?raw:50);
});
test('new score does not overwrite frozen Active score, grade or plan',async()=>{
 const oldItem={...input('Short',90),symbol:'TESTUSDT',price:100,opportunityScore:86,opportunityGrade:'A+',grade:'A+',confidence:98};
 const first=await c.createRankingHistoryEntry({generatedAt:'2026-09-15T00:00:00.000Z',globalRanking:[oldItem]});
 const old=first.readySignals[0];assert.ok(old);
 old.outcome={...old.outcome,status:'Active',entryPrice:100,activatedAt:'2026-09-15T00:01:00.000Z',lastPriceCheckedAt:'2026-09-15T00:01:00.000Z'};
 const frozen=JSON.stringify(old.initialPlan);
 c.fetchOKXRecentPriceRange=async()=>null;
 const live=input('Short',10),calculated=c.calculateScannerOpportunity(live);
 assert.notEqual(calculated.score,old.opportunityScore);
 const next=await c.createRankingHistoryEntry({generatedAt:'2026-09-15T00:06:00.000Z',globalRanking:[{...live,symbol:'TESTUSDT',price:100,opportunityScore:calculated.score,opportunityGrade:calculated.grade}]},{readySignals:[old]});
 const kept=next.readySignals.find(s=>s.symbol==='TESTUSDT');assert.ok(kept);
 assert.equal(kept.opportunityScore,86);assert.equal(kept.opportunityGrade,'A+');
 assert.equal(kept.confidence,98);assert.equal(kept.outcome.status,'Active');
 assert.equal(JSON.stringify(kept.initialPlan),frozen);
});
