import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../api/market.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default async function handler','async function handler');
const runtime=()=>{const c=vm.createContext({process:{env:{}},Date,console});vm.runInContext(source,c);return c;};
const fixture=(direction='Long')=>({tradeId:'original-id',setupKey:'TESTUSDT:'+direction,symbol:'TESTUSDT',direction,
 opportunityScore:90,confidence:95,action:direction==='Long'?'Strong Buy':'Strong Sell',tradeAllowed:true,tradeReadiness:{ready:true},riskReward:2,
 initialPlan:{createdAt:'2026-09-19T00:00:00Z',plannedAt:'2026-09-19T00:01:00Z',expiresAt:'2026-09-19T01:01:00Z',entryPrice:100,entryZone:{from:99,to:101},stopLoss:direction==='Long'?90:110,takeProfit1:direction==='Long'?110:90,takeProfit2:direction==='Long'?120:80,takeProfit3:direction==='Long'?130:70},outcome:{status:'Active'}});
const ranking={generatedAt:'2026-09-20T00:00:00Z',globalRanking:[{symbol:'TESTUSDT',price:95,opportunityScore:50,grade:'D',confidence:40}]};
for(const [name,mutate] of [
 ['missing readiness',s=>delete s.tradeReadiness],['missing permission',s=>delete s.tradeAllowed],
 ['low confidence',s=>s.confidence=84],['low score',s=>s.opportunityScore=84],['weak action',s=>s.action='Buy'],
 ['low RR',s=>s.riskReward=1],['broken plan',s=>s.initialPlan.takeProfit3=95],
 ['missing origin timestamp',s=>delete s.initialPlan.createdAt],['closed trade',s=>s.outcome.status='Stopped']
])test('exclude ambiguous origin: '+name,()=>{const s=fixture();s.grade='A+';mutate(s);assert.equal(runtime().projectEntrySetup(s,ranking,'now'),null);});
for(const dir of ['Long','Short'])test('verified '+dir+' preserves frozen identity and Active despite current D',()=>{
 const c=runtime(),s=fixture(dir),before=structuredClone(s),r=c.projectEntrySetup(s,ranking,'2026-09-20T00:01:00Z');
 assert.equal(r.tradeId,s.tradeId);assert.equal(r.origin.confirmedAPlus,true);assert.equal(r.current.currentGrade,'D');assert.equal(r.lifecycleStatus,'Active');assert.deepEqual(s,before);
 assert.equal(r.entryAnalysis.status,null);assert.equal(r.entryAnalysis.structureValid,null);assert.equal(r.entryAnalysis.quality,undefined);
 assert.equal(r.origin.detectedAt,s.initialPlan.createdAt);assert.equal(r.current.asOf,ranking.generatedAt);assert.notEqual(r.origin.detectedAt,r.current.asOf);
});
test('current C and absent ranking retain origin without fabricated current values',()=>{const c=runtime();assert.equal(c.projectEntrySetup(fixture(),{...ranking,globalRanking:[{...ranking.globalRanking[0],grade:'C'}]},'now').current.currentGrade,'C');const r=c.projectEntrySetup(fixture(),null,'now');assert.equal(r.current.price,null);assert.equal(r.current.currentGrade,null);assert.equal(r.entryAnalysis.currentRR,null);});
test('directionally mirrored arithmetic',()=>{const c=runtime();const a=c.calculateEntryLocationDiagnostics('Long',100,90,120,95),b=c.calculateEntryLocationDiagnostics('Short',100,110,80,105);assert.equal(a.pullbackR,.5);assert.equal(a.currentRR,5);assert.deepEqual(a,b);});
test('invalid geometry never looks profitable',()=>{const c=runtime();for(const price of [90,80,120,130,0,null,NaN])assert.equal(c.calculateEntryLocationDiagnostics('Long',100,90,120,price).currentRR,null);assert.equal(c.calculateEntryLocationDiagnostics('Short',100,110,80,110).currentRR,null);});
test('endpoint only reads two existing keys; never invokes trading paths',async()=>{
 const c=runtime(),commands=[];c.getRedisConfig=()=>({});c.runRedisCommand=async command=>{commands.push(command);assert.equal(command[0],'GET');return JSON.stringify(command[1].includes('open-trades')?[fixture()]:ranking);};
 for(const name of ['registerOpenTrade','registerLiveAnalysisTrade','evaluateTradeLifecycle','writeRankingHistory','calculateScannerOpportunity','fetchOKXKlines'])c[name]=()=>{throw new Error('FORBIDDEN '+name);};
 const res={setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
 await c.handler({method:'GET',query:{mode:'entry-setups'},headers:{}},res);
 assert.equal(res.code,200);assert.equal(res.body.setups.length,1);assert.equal(commands.length,2);
 assert.equal(commands[0][1],'sergey-ai:open-trades:v1');assert.equal(commands[1][1],'sergey-ai:global-ranking:v1');
});
test('storage unavailable fails closed',async()=>{const c=runtime(),res={setHeader(){},status(n){this.code=n;return this;},json(b){this.body=b;}};await c.handler({method:'GET',query:{mode:'entry-setups'},headers:{}},res);assert.equal(res.code,503);assert.equal(res.body.ok,false);});
