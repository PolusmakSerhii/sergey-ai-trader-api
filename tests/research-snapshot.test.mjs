import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const json = x => JSON.parse(JSON.stringify(x));
const bytes = x => Buffer.byteLength(JSON.stringify(x), 'utf8');
const time = new Date(Math.floor(Date.now()/60000)*60000).toISOString();
const at = n => new Date(Date.parse(time)+n*60000).toISOString();
function runtime() {
  const c = vm.createContext({ Date, URL, AbortSignal, setTimeout, process:{env:{}}, console:{error(){}}, fetch(){throw Error('Provider request forbidden');} });
  vm.runInContext(source,c); c.getRedisConfig=()=>({}); return c;
}
function item() { return {symbol:'TESTUSDT',instrumentType:'SWAP',price:100,direction:'Long',action:'Strong Buy',
  opportunityScore:90,opportunityGrade:'A+',confidence:95,tradeAllowed:true,tradeReadiness:{ready:true},riskReward:2,
  entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130}; }
function input() {return {symbol:'TESTUSDT',instrumentType:'SWAP',analysisAt:at(-1),confirmedOnly:true,confirmedCount:300,
  opportunity:{score:90,grade:'A+',confirmedAPlus:true},dataSafety:{price:{source:'OKX',asOf:at(-1)},candles:{source:'OKX',timeframe:'1D',lastConfirmedAt:at(-60)}},
  technical:{rsi14:61,ema20:98,ema50:96,ema100:94,ema200:90,atr14:3,trend:'Strong Bullish',
  macd:{macd:1,signal:.8,histogram:.2,trend:'Bullish'},volumeStats:{current:100,sma20:80,ratio:1.25,spike:false},swingLevels:{swingHigh:110,swingLow:90},
  bos:'Inside Range',choch:'No CHOCH',liquiditySweep:'No Sweep',mss:'No MSS',fvg:[],orderBlocks:[],equalHighLow:{equalHighs:[],equalLows:[]},
  premiumDiscount:{high:110,low:90,equilibrium:100,zone:'Equilibrium'},imbalance:{type:'No Imbalance',bodyRatio:.2,candleRange:3},smartMoney:{score:50,rating:'Neutral'},
  probability:{version:'3.1',score:95,longScore:95,shortScore:5,scoreDifference:90,probabilities:{bullish:90,bearish:5,neutral:5},
  aiAssessment:{direction:'Long',tradeAllowed:true},confluence:{bullishFactors:8,bearishFactors:1},confidence:{score:95,components:{strength:40,separation:25,confluence:20,volume:10}}},
  recommendation:{action:'Strong Buy',confidence:85},tradePlan:{setupScore:95,riskReward:2},
  marketEnvironment:{version:'1.0',score:85,condition:'Excellent',tradable:true,components:{
    participation:{score:20,status:'Healthy',volumeRatio:1.25,volumeSpike:false},volatility:{score:25,status:'Normal',atrPercent:3},
    clarity:{score:25,status:'Strong',neutralProbability:5,confidence:95},dataQuality:{score:15,status:'Complete',coinGlassAvailable:true}}},
  tradeReadiness:{version:'1.0',score:95,ready:true,status:'Ready',direction:'Long',components:{environment:{score:35,sourceScore:85},confidence:{score:30,sourceScore:95},clarity:{score:20,neutralProbability:5},separation:{score:10,scoreDifference:90}},reasons:[],blockers:[]}}}; }
function candidate(c, data=input()) {return c.createFrozenTradeCandidate({...item(),researchProjectionJSON:JSON.stringify(c.projectOriginalResearch(data))},time);}
const without = trade => {const copy=json(trade);delete copy.researchSnapshot;return copy;};
test('same-analysis projection binds only a new canonical candidate; metadata and exact source scalars',()=>{
 const c=runtime(),s=candidate(c);assert.equal(s.researchSnapshot.telemetryStatus,'captured');
 assert.equal(s.researchSnapshot.schemaVersion,'original-signal-research-v2');assert.equal(s.researchSnapshot.tradeId,undefined);assert.equal(s.researchSnapshot.capturedAt,s.initialPlan.createdAt);
 assert.equal(s.researchSnapshot.analysisAt,at(-1));assert.equal(s.researchSnapshot.instrument.symbol,s.symbol);
 assert.equal(s.researchSnapshot.instrument.instrumentType,'SWAP');assert.equal(s.researchSnapshot.indicators.rsi14,61);
 assert.equal(s.researchSnapshot.decision.opportunityScore,90);assert.equal(s.outcome.status,'WaitingEntry');
 assert.throws(()=>c.createFrozenTradeCandidate({...item(),action:'Buy'},time),/Canonical/);
});
test('unavailable, false, zero, neutral and bounded returned structures remain distinguishable',()=>{
 const c=runtime(),i=input();i.technical.rsi14=null;i.technical.ema20=0;const s=c.projectOriginalResearch(i);
 assert.equal(s.indicators.rsi14,null);assert.equal(s.indicators.ema20,0);assert.equal(s.indicators.volumeStats.spike,false);
 assert.equal(s.structure.smartMoneyRating,'Neutral');assert.equal(s.structure.fvgSummary.bullish,0);
 i.technical.fvg=null;i.technical.swingLevels=null;const missing=c.projectOriginalResearch(i);
 assert.equal(missing.structure.fvgSummary,null);assert.equal(missing.structure.bos,null);assert.equal(missing.structure.choch,null);
});
test('allowlist rejects raw/circular/provider/secret fields; malformed feature is safe',()=>{
 const c=runtime(),i=input();i.request={headers:{authorization:'SECRET'}};i.coinGlass=i;i.technical.raw=i;
 i.technical.rsi14=Infinity;i.technical.macd={macd:NaN,signal:{secret:'SECRET'},histogram:0,trend:'Neutral'};
 const s=c.projectOriginalResearch(i);assert.equal(s.telemetryStatus,'captured');assert.equal(s.indicators.rsi14,null);
 assert.equal(s.indicators.macd.signal,null);assert.doesNotMatch(JSON.stringify(s),/SECRET|authorization|headers/);
 Object.defineProperty(i,'technical',{get(){throw Error('SECRET')}});
 assert.equal(c.projectOriginalResearch(i).reasonCode,'PROJECTION_ERROR');
});
test('byte guard is UTF-8, oversized valid fields yield unavailable, all strings and arrays bounded',()=>{
 const c=runtime(),i=input();i.technical.trend='界'.repeat(48);i.technical.marketEnvironment.condition='界'.repeat(48);i.technical.tradeReadiness.status='界'.repeat(48);i.technical.smartMoney.rating='界'.repeat(48);
 const s=c.projectOriginalResearch(i);assert.equal(s.telemetryStatus,'unavailable');assert.equal(s.reasonCode,'SIZE_LIMIT');assert.ok(bytes(s)<=2304);
 const bound=c.bindOriginalResearch({...item(),researchProjectionJSON:JSON.stringify(s)},candidate(c));assert.equal(bound.reasonCode,'SIZE_LIMIT');
 assert.equal(bound.tradeId,candidate(c).tradeId);
});
test('projection is a detached JSON value and mismatched identity fails telemetry only',()=>{
 const c=runtime(),i=input(),s=candidate(c,i);i.technical.rsi14=1;assert.equal(s.researchSnapshot.indicators.rsi14,61);
 i.instrumentType='SPOT';assert.equal(candidate(c,i).researchSnapshot.reasonCode,'IDENTITY_MISMATCH');
 const missing=c.createFrozenTradeCandidate(item(),time);assert.equal(missing.researchSnapshot.telemetryStatus,'unavailable');assert.equal(missing.outcome.status,'WaitingEntry');
});
for(const status of ['WaitingEntry','Active','TP3Hit','Stopped']) test('refresh preserves snapshot exactly and never backfills legacy '+status,()=>{
 const c=runtime(),s=candidate(c);s.outcome.status=status;if(status==='Active')Object.assign(s.outcome,{entryPrice:100,activatedAt:at(1)});
 const before=JSON.stringify(s.researchSnapshot);const changed={...item(),opportunityScore:10,grade:'D',confidence:1,action:'Sell',researchProjectionJSON:'{}'};
 const next=c.buildTrackedTradeSignal(changed,at(3),s);assert.equal(JSON.stringify(next.researchSnapshot),before);
 delete s.researchSnapshot;assert.equal(c.buildTrackedTradeSignal(changed,at(3),s).researchSnapshot,undefined);
});
test('activation, TP1/TP2/TP3 and stop preserve telemetry; lifecycle and stats identical',()=>{
 const c=runtime(); const candles=[{o:100,h:101,l:99,c:100},{o:105,h:111,l:104,c:110},{o:111,h:121,l:110,c:120},{o:121,h:131,l:120,c:130}];
 for(const stop of [false,true]) {let a=candidate(c),b=c.createFrozenTradeCandidate(item(),time);const frozen=JSON.stringify(a.researchSnapshot);
 for(let k=0;k<candles.length;k++){const x=stop&&k===1?{o:100,h:101,l:89,c:90}:candles[k];
 const bar={timestamp:Date.parse(at(k)),open:x.o,high:x.h,low:x.l,close:x.c,confirmed:true};
 a=c.buildTrackedTradeSignal(item(),at(k+1),a,{source:'OKX 1m candles',data:[bar]});b=c.buildTrackedTradeSignal(item(),at(k+1),b,{source:'OKX 1m candles',data:[bar]});
 assert.deepEqual(without(a),without(b));assert.equal(JSON.stringify(a.researchSnapshot),frozen);}
 assert.equal(a.outcome.status,stop?'Stopped':'TP3Hit');
 assert.deepEqual(json(c.addTradeToPersistentStats(c.createEmptyPersistentTradeStats(),a)),json(c.addTradeToPersistentStats(c.createEmptyPersistentTradeStats(),b)));
 }
});
test('A+, opportunity, recommendation, confidence, readiness and plan ignore telemetry',()=>{
 const c=runtime(),a={...item(),score:95,smartMoneyScore:80,marketEnvironmentScore:80,probabilities:{neutral:5}},b={...a,researchSnapshot:{opportunityScore:0}};
 assert.deepEqual(json(c.calculateScannerOpportunity(a)),json(c.calculateScannerOpportunity(b)));
 assert.equal(c.isConfirmedAPlusTrade(a),c.isConfirmedAPlusTrade(b));
 assert.deepEqual(without(c.createFrozenTradeCandidate(a,time)),without(c.createFrozenTradeCandidate(b,time)));
 for(const fn of ['calculateRecommendation','calculateSignalConfidence','calculateTradeReadiness','calculateTradePlan','calculateAccountRisk','evaluateTradeLifecycle','addTradeToPersistentStats']) assert.doesNotMatch(String(c[fn]),/researchSnapshot|researchProjection/);
});
test('scanner carries only projection on existing request; new Ranking candidate binds original analysisAt',async()=>{
 const c=runtime(),i=input(),projection=JSON.stringify(c.projectOriginalResearch(i));let requests=0;
 c.internalApiHeaders=()=>({});c.fetch=async()=>{requests++;return {ok:true,json:async()=>({ok:true,technical:i.technical,price:100,researchProjectionJSON:projection})};};
 const row=await c.fetchScannerSymbol('https://test.invalid',i.symbol);assert.equal(requests,1);assert.equal(row.researchProjectionJSON,projection);
 const history=await c.createRankingHistoryEntry({generatedAt:time,globalRanking:[{...item(),researchProjectionJSON:row.researchProjectionJSON}]});
 assert.equal(history.readySignals[0].researchSnapshot.analysisAt,at(-1));
 assert.match(source,/researchProjectionJSON: item.researchProjectionJSON/);
});
test('CAS retry, concurrent winner and archive failure do not lose frozen telemetry or add calls',async()=>{
 const c=runtime(); const projection=JSON.stringify(c.projectOriginalResearch(input()));let raw=null;const commands=[];
 const execute=async cmd=>{commands.push(cmd[0]);if(cmd[0]==='GET')return raw;
 if(cmd[3]==='sergey-ai:open-trades:v1'){if((raw??'')!==cmd[6])return 0;raw=cmd[7];return 1;}
 throw Error('archive unavailable');};
 const a={...item(),researchProjectionJSON:projection};
 const [one,two]=await Promise.all([c.registerOpenTrade(a,time,execute),c.registerOpenTrade(a,time,execute)]);
 assert.equal(JSON.parse(raw).length,1);assert.equal(JSON.stringify(one.researchSnapshot),JSON.stringify(two.researchSnapshot));
 const winner=JSON.stringify(one.researchSnapshot);const retry=await c.registerOpenTrade({...a,researchProjectionJSON:'{}'},at(1),execute);assert.equal(JSON.stringify(retry.researchSnapshot),winner);
 const measure=async enabled=>{let state=null;const calls=[];await c.registerOpenTrade(enabled?a:item(),time,async cmd=>{calls.push(cmd[0]);if(cmd[0]==='GET')return state;if(cmd[3]==='sergey-ai:open-trades:v1'){state=cmd[7];return 1;}return 1;});return calls;};
 assert.deepEqual(await measure(true),await measure(false));
 c.writeOpenTradesCAS=async()=>0;c.collectValidationArchive=async()=>assert.fail('orphan');await assert.rejects(c.registerOpenTrade(a,time,async()=>null));
});
test('representative byte measurements, full archived record delta and bound',()=>{
 const c=runtime(),minimal=candidate(c,{symbol:'TESTUSDT',instrumentType:'SWAP',analysisAt:at(-1),opportunity:{confirmedAPlus:true},technical:{}}),normal=candidate(c);
 assert.equal(minimal.researchSnapshot.telemetryStatus,'captured');assert.equal(normal.researchSnapshot.telemetryStatus,'captured');
 let maximal=normal.researchSnapshot;
 for(let length=0;length<=48;length++)for(let extra=0;extra<=6;extra++){
   const i=input();i.technical.trend='界'.repeat(length);i.technical.marketEnvironment.condition='界'.repeat(length);
   i.technical.tradeReadiness.status='x'.repeat(length);i.technical.smartMoney.rating='y'.repeat(Math.min(48,length+extra));
   const s=candidate(c,i).researchSnapshot;if(s.telemetryStatus==='captured'&&bytes(s)>bytes(maximal))maximal=s;
 }
 // A real modelled entry followed by an initial stop, including persisted candle/exit evidence.
 let closed=normal;
 for(const [k,x] of [[0,[100,101,99,100]],[1,[100,101,89,90]]]){
   const bar={timestamp:Date.parse(at(k)),open:x[0],high:x[1],low:x[2],close:x[3],confirmed:true};
   closed=c.buildTrackedTradeSignal(item(),at(k+1),closed,{source:'OKX 1m candles',data:[bar]});
 }
 assert.equal(closed.outcome.status,'Stopped');assert.equal(closed.outcome.exits.length,1);
 const base=c.projectValidationTrade(without(closed)),full=c.projectValidationTrade(closed);
 const marker=c.createFrozenTradeCandidate(item(),time).researchSnapshot;
 const report={minimal:bytes(minimal.researchSnapshot),normal:bytes(normal.researchSnapshot),maximal:bytes(maximal),marker:bytes(marker),archiveWithout:bytes(base),archiveWith:bytes(full),delta:bytes(full)-bytes(base)};
 console.log('RESEARCH_SIZE_BYTES',JSON.stringify(report));assert.equal(report.maximal,2304);assert.ok(report.normal<=2048);
 const document=n=>{const tradesById={};for(let k=0;k<n;k++){
   const id=full.tradeId+':'+String(k).padStart(4,'0');
   tradesById[id]={...full,tradeId:id,cohort:'forward',createdAt:time,updatedAt:time};
 }return {schemaVersion:1,rulesRevision:'canonical-trade-archive-v1',validationStartAt:time,
   boundaryPolicy:'origin-at-or-after-first-successful-archive-write',tradesById};};
 const docSizes=Object.fromEntries([100,500,1000,5000].map(n=>[n,bytes(document(n))]));
 const overhead=bytes(document(0)),perRecord=bytes(document(1))-overhead;
 console.log('RESEARCH_ARCHIVE_DOCUMENT_BYTES',JSON.stringify({sizes:docSizes,perRecord,overhead,
   approximateCapacity:Math.floor((16*1024*1024-overhead)/perRecord)}));

});
test('archive actual Lua preserves original telemetry across outcome updates and legacy records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sm1m-research-')),socket=join(dir,'redis.sock');
 const server=spawn('/opt/homebrew/bin/redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});let error;server.on('error',e=>{error=e});
 const exec=promisify(execFile),redis=async args=>{const {stdout}=await exec('/opt/homebrew/bin/redis-cli',['-s',socket,'--json',...args.map(String)]);if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);};
 try{let ready=false;for(let i=0;i<100;i++){if(error)throw error;try{ready=await redis(['PING'])==='PONG'}catch{}if(ready)break;await new Promise(r=>setTimeout(r,20));}assert.ok(ready);
 const c=runtime(),s=candidate(c),legacy=without(s);legacy.tradeId='LEGACY';
 const write=rows=>redis(['EVAL',vm.runInContext('WRITE_VALIDATION_ARCHIVE_SCRIPT',c),1,'test:archive',JSON.stringify(rows.map(c.projectValidationTrade)),time,JSON.stringify({records:5000,bytes:16*1024*1024})]);
 await write([s,legacy]);const original=JSON.stringify(s.researchSnapshot);
 s.researchSnapshot={different:true};s.outcome={...s.outcome,status:'Stopped',checkedAt:at(5),resultR:-1};await write([s]);
 const doc=JSON.parse(await redis(['GET','test:archive']));const hydrated=c.hydrateValidationTrade(doc.tradesById[s.tradeId]);assert.equal(JSON.stringify(hydrated.researchSnapshot),original);assert.equal(hydrated.outcome.resultR,-1);
 assert.equal(c.hydrateValidationTrade(doc.tradesById.LEGACY).researchSnapshot,undefined);
 // Exercise the actual open-trades Lua conflict path with two distinct original analyses.
 c.runRedisCommand=redis;c.fetchOKXRecentPriceRange=async()=>null;
 const firstInput=input(),laterInput=input();firstInput.technical.rsi14=60;laterInput.technical.rsi14=70;
 const live={...item(),researchProjectionJSON:JSON.stringify(c.projectOriginalResearch(firstInput))};
 const ranking={...item(),researchProjectionJSON:JSON.stringify(c.projectOriginalResearch(laterInput))};
 let winner=null,attempts=0;
 assert.equal(await c.writeRankingHistory({generatedAt:time,globalRanking:[ranking]},async cmd=>{
   if(cmd[0]==='EVAL'&&cmd[1]===vm.runInContext('WRITE_OPEN_TRADES_SCRIPT',c)){
     attempts++;if(!winner)winner=await c.registerOpenTrade(live,time,redis);
   }
   return redis(cmd);
 }),true);
 assert.equal(attempts,2);
 const open=JSON.parse(await redis(['GET','sergey-ai:open-trades:v1']));assert.equal(open.length,1);
 assert.equal(open[0].researchSnapshot.indicators.rsi14,60);
 assert.equal(JSON.stringify(open[0].researchSnapshot),JSON.stringify(winner.researchSnapshot));
 const retry=await c.registerOpenTrade(ranking,at(1),redis);assert.equal(retry.researchSnapshot.indicators.rsi14,60);
 const archived=JSON.parse(await redis(['GET','sergey-ai:validation-archive:v1']));
 assert.equal(c.hydrateValidationTrade(archived.tradesById[winner.tradeId]).researchSnapshot.indicators.rsi14,60);

 }finally{if(server.exitCode===null&&!error){try{await redis(['SHUTDOWN','NOSAVE'])}catch{}server.kill();}await rm(dir,{recursive:true,force:true});}
});

test('v2 stable compact contract preserves core categories and removes only documented v1 fields',()=>{
 const c=runtime(),i=input();i.technical.tradeReadiness.reasons=['verbose reason'];i.technical.tradeReadiness.blockers=['verbose blocker'];
 i.technical.fvg=[{type:'Bullish FVG',from:99,to:100},{type:'Bearish FVG',from:100,to:101}];
 i.technical.orderBlocks=[{type:'Bullish Order Block',from:90,to:95}];
 const s=candidate(c,i).researchSnapshot;
 assert.equal(s.schemaVersion,'original-signal-research-v2');assert.doesNotMatch(source,/original-signal-research-v1/);
 assert.deepEqual(json(s.structure.fvgSummary),{bullish:1,bearish:1});assert.deepEqual(json(s.structure.orderBlockSummary),{bullish:1,bearish:0});
 assert.equal(s.indicators.swingLevels,undefined);assert.equal(s.readiness.reasons,undefined);assert.equal(s.readiness.blockers,undefined);
 assert.equal(s.structure.premiumDiscount.high,undefined);assert.equal(s.tradeId,undefined);
 for(const [group,keys] of Object.entries({decision:['opportunityScore','signalConfidence','recommendationConfidence','direction','action','tradeAllowed','setupScore','riskReward'],
 indicators:['rsi14','ema20','ema50','ema100','ema200','macd','atr14','volumeStats'],
 structure:['bos','choch','liquiditySweep','mss','premiumDiscount','imbalance','fvgSummary','orderBlockSummary','equalHighLowSummary','smartMoneyScore','smartMoneyRating'],
 probability:['longScore','shortScore','scoreDifference','bullish','bearish','neutral','confidenceComponents'],
 environment:['score','condition','tradable','components','trend'],readiness:['score','ready','status','components'],
 provenance:['dailySource','dailyBar','confirmedOnly','dailyLastConfirmedAt','priceSource','priceTimestamp']}))
 for(const key of keys)assert.notEqual(s[group][key],undefined,group+'.'+key);
 i.technical.fvg=[{invalid:true}];assert.equal(c.projectOriginalResearch(i).structure.fvgSummary,null);
});
