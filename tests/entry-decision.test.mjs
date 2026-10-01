import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const json = x => JSON.parse(JSON.stringify(x));
const time = new Date(Math.floor(Date.now()/60000)*60000).toISOString();
const at = minutes => new Date(Date.parse(time)+minutes*60000).toISOString();
function runtime() {
 const c = vm.createContext({Date,URL,AbortSignal,setTimeout,process:{env:{}},console:{error(){}},fetch(){throw Error('Provider call forbidden');}});
 vm.runInContext(source,c); c.getRedisConfig=()=>({});return c;
}
function snapshot(direction='Long') {return {schemaVersion:'original-signal-research-v2',telemetryStatus:'captured',capturedAt:null,analysisAt:time,
 instrument:{symbol:'TESTUSDT',instrumentType:'SWAP'},decision:{confirmedAPlus:true,direction},originPrice:100,e20:direction==='Long'?1:-1,
 indicators:{ema20:98,atr14:2,rsi14:65,macd:{histogram:2}}};}
function plan(direction='Long') {return {initialStopLoss:direction==='Long'?90:110,takeProfit1:direction==='Long'?110:90};}
function row(direction='Long') {const p=plan(direction);return {symbol:'TESTUSDT',instrumentType:'SWAP',price:100,direction,
 action:direction==='Long'?'Strong Buy':'Strong Sell',opportunityScore:90,opportunityGrade:'A+',confidence:95,tradeAllowed:true,tradeReadiness:{ready:true},riskReward:2,
 entryZone:{from:99,to:101},stopLoss:p.initialStopLoss,takeProfit1:p.takeProfit1,takeProfit2:direction==='Long'?120:80,takeProfit3:direction==='Long'?130:70,
 researchProjectionJSON:JSON.stringify(snapshot(direction))};}
function withoutObservation(t) {const x=json(t);delete x.entryDecision;return x;}
for(const direction of ['Long','Short']) test(direction+' normalized observational evidence and no permission state',()=>{
 const c=runtime(),trade=c.createFrozenTradeCandidate(row(direction),time),d=trade.entryDecision;
 assert.equal(d.version,'entry-decision-v1');assert.equal(d.mode,'observational');assert.equal(d.status,'AVAILABLE');assert.deepEqual(json(d.reasonCodes),[]);
 assert.equal(d.evidence.directionalRsi,direction==='Long'?65:35);assert.equal(d.evidence.macdSign,direction==='Long'?'SUPPORTING':'OPPOSING');assert.equal(d.evidence.geometryValid,true);
 assert.doesNotMatch(JSON.stringify(d),/ENTER|WAIT|AVOID|score|weight/i);
 for(const key of ['originPrice','ema20','atr14','rsi14','histogram','direction']) assert.equal(d.evidence[key],undefined);
});
for(const direction of ['Long','Short']) for(const [histogram,sign] of [[2,'SUPPORTING'],[0,'NEUTRAL'],[-2,'OPPOSING']]) test(direction+' MACD '+sign,()=>{
 const c=runtime(),s=snapshot(direction);s.indicators.macd.histogram=(direction==='Long'?1:-1)*histogram;
 assert.equal(c.createObservationalEntryDecision(s,plan(direction)).evidence.macdSign,sign);
});
const invalids=[
 ['INVALID_DIRECTION',s=>s.decision.direction='Neutral'],
 ['INVALID_ORIGIN_PRICE',s=>s.originPrice=0],
 ['INVALID_ATR',s=>s.indicators.atr14=0],
 ['INVALID_EMA20',s=>s.indicators.ema20=-1],
 ['INVALID_E20',s=>s.e20=null],
 ['INVALID_RSI',s=>s.indicators.rsi14=101],
 ['INVALID_MACD',s=>s.indicators.macd.histogram=null]
];
for(const [code,mutate] of invalids) test(code+' is unavailable but not a registration gate',()=>{
 const c=runtime(),s=snapshot();mutate(s);
 const d=c.createObservationalEntryDecision(s,plan());assert.equal(d.status,'UNAVAILABLE');assert.ok(d.reasonCodes.includes(code));
 const r=row();r.researchProjectionJSON=JSON.stringify(s);const trade=c.createFrozenTradeCandidate(r,time);
 assert.equal(trade.outcome.status,'WaitingEntry');assert.equal(trade.entryDecision.status,'UNAVAILABLE');
 const control=runtime();control.createObservationalEntryDecision=()=>undefined;
 assert.deepEqual(withoutObservation(trade),withoutObservation(control.createFrozenTradeCandidate(r,time)));
});
test('strict finite evidence validation, no coercion, deterministic reasons',()=>{
 const c=runtime();for(const value of [undefined,null,NaN,Infinity,'2']) for(const path of ['originPrice','e20','atr14','ema20','rsi14','histogram']){
  const s=snapshot();if(['originPrice','e20'].includes(path))s[path]=value;
  else if(path==='histogram')s.indicators.macd.histogram=value;else s.indicators[path]=value;
  assert.equal(c.createObservationalEntryDecision(s,plan()).status,'UNAVAILABLE');
 }
 for(const rsi of [0,100]){const s=snapshot();s.indicators.rsi14=rsi;assert.equal(c.createObservationalEntryDecision(s,plan()).status,'AVAILABLE');}
 const all=c.createObservationalEntryDecision(null,null);
 assert.deepEqual(json(all.reasonCodes),['INVALID_DIRECTION','INVALID_ORIGIN_PRICE','INVALID_ATR','INVALID_EMA20','INVALID_E20','INVALID_RSI','INVALID_MACD','INVALID_GEOMETRY']);
 const bad={get decision(){throw Error('bad evidence');}};
 assert.equal(c.createObservationalEntryDecision(bad,plan()).status,'UNAVAILABLE');assert.deepEqual(json(c.createObservationalEntryDecision(bad,plan()).reasonCodes),['EVIDENCE_ERROR']);
});
for(const direction of ['Long','Short']) test(direction+' directed geometry uses origin price, initial SL and only TP1',()=>{
 const c=runtime(),s=snapshot(direction),p=plan(direction);
 for(const key of ['initialStopLoss','takeProfit1'])for(const value of [undefined,null,0,-1,100,NaN,Infinity,'90']){
  const d=c.createObservationalEntryDecision(s,{...p,[key]:value});assert.equal(d.status,'UNAVAILABLE');assert.ok(d.reasonCodes.includes('INVALID_GEOMETRY'));
 }
 assert.equal(c.createObservationalEntryDecision(s,{...p,entryPrice:1000,currentStopLoss:100,takeProfit2:null,takeProfit3:null}).status,'AVAILABLE');
 const swapped={initialStopLoss:p.takeProfit1,takeProfit1:p.initialStopLoss};assert.ok(c.createObservationalEntryDecision(s,swapped).reasonCodes.includes('INVALID_GEOMETRY'));
});
test('registration AVAILABLE and UNAVAILABLE uses identical IO and canonical execution outputs',async()=>{
 const c=runtime();const register=async available=>{let stored=null;const calls=[];const r=row();if(!available){const s=snapshot();s.indicators.atr14=0;r.researchProjectionJSON=JSON.stringify(s);}
  const trade=await c.registerOpenTrade(r,time,async cmd=>{calls.push(cmd[0]);if(cmd[0]==='GET')return stored;if(cmd[3]==='sergey-ai:open-trades:v1'){stored=cmd[7];return 1;}return 1;});return {trade,calls};};
 const a=await register(true),b=await register(false);assert.deepEqual(a.calls,b.calls);
 assert.equal(a.trade.entryDecision.status,'AVAILABLE');assert.equal(b.trade.entryDecision.status,'UNAVAILABLE');
 const strip=t=>{const x=withoutObservation(t);delete x.researchSnapshot;return x;};assert.deepEqual(strip(a.trade),strip(b.trade));
 assert.equal(c.isConfirmedAPlusTrade(row()),true);
 for(const fn of ['calculateScannerOpportunity','isConfirmedAPlusTrade','calculateTradePlan','evaluateTradeLifecycle','calculateContinuationDecision','addTradeToPersistentStats'])assert.doesNotMatch(String(c[fn]),/entryDecision|createObservationalEntryDecision/);
});
test('refresh and archive preserve origin decision; legacy absence is never backfilled',()=>{
 const c=runtime(),original=c.createFrozenTradeCandidate(row(),time),before=JSON.stringify(original.entryDecision);
 for(const status of ['WaitingEntry','Active','Closed']){
  const old=json(original);old.outcome.status=status;
  const next=c.buildTrackedTradeSignal({...row(),price:1000,entryDecision:{status:'different'}},at(5),old);
  assert.equal(JSON.stringify(next.entryDecision),before);
  assert.equal(JSON.stringify(c.hydrateValidationTrade(c.projectValidationTrade(next)).entryDecision),before);
 }
 delete original.entryDecision;
 const next=c.buildTrackedTradeSignal(row(),at(1),original);
 assert.equal(next.entryDecision,undefined);assert.equal(c.hydrateValidationTrade(c.projectValidationTrade(next)).entryDecision,undefined);
});
test('decision does not consume the research snapshot byte budget; bounded metadata',()=>{
 const c=runtime(),r=row(),s=snapshot();s.padding='x'.repeat(2304-Buffer.byteLength(JSON.stringify({...s,capturedAt:time,padding:''})));
 r.researchProjectionJSON=JSON.stringify(s);const trade=c.createFrozenTradeCandidate(r,time);
 assert.equal(Buffer.byteLength(JSON.stringify(trade.researchSnapshot)),2304);assert.equal(trade.entryDecision.status,'AVAILABLE');
 assert.equal(trade.researchSnapshot.entryDecision,undefined);
 const available=Buffer.byteLength(JSON.stringify(trade.entryDecision));const unavailable=Buffer.byteLength(JSON.stringify(c.createObservationalEntryDecision(null,null)));
 console.log('ENTRY_DECISION_BYTES',JSON.stringify({available,allInvalid:unavailable,researchLimit:2304}));assert.ok(available<256);assert.ok(unavailable<512);
});
