import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const at = n => new Date(Date.UTC(2026, 8, 22, 10, n)).toISOString();
function runtime() {
  const logs = [];
  const c = vm.createContext({ Date, setTimeout, URL, process: {env:{}},
    console: {error(...args) {logs.push(args);}}, fetch() {throw Error('Network forbidden');} });
  vm.runInContext(source,c);
  // Domain tests use an authorized transport; real auth is covered in private-access tests.
  Object.assign(c, { requirePrivateApi: () => true, privateBackendOrigin: () => "https://sergey-ai-trader-api.vercel.app", internalApiHeaders: () => ({Authorization:"Bearer test-only"}) }); c.getRedisConfig = () => ({}); return {c,logs};
}
function signal(id='TEST', status='WaitingEntry', direction='Long', minute=1) {
  const long=direction==='Long';
  return {tradeId:id, symbol:id+'USDT', direction, opportunityGrade:"A+", opportunityScore:90, confidence:95,
    action:long?'Strong Buy':'Strong Sell', tradeAllowed:true, tradeReadiness:{ready:true}, riskReward:2,
    initialPlan:{createdAt:at(1),plannedAt:at(2),expiresAt:at(60),entryPrice:100,
      entryZone:{from:99,to:101},stopLoss:long?90:110, initialStopLoss:long?90:110,
      takeProfit1:long?110:90,takeProfit2:long?120:80,takeProfit3:long?130:70,
      exitStrategy:{version:'partial-25-25-50-be-v1'}},
    outcome:{status,checkedAt:at(minute),lastPriceCheckedAt:at(minute),
      lifecycleVersion:'partial-candles-v1',exits:[]}};
}
const complete = (id, direction='Long', minute=10) => {
  const s=signal(id,'TP3Hit',direction,minute);
  Object.assign(s.outcome,{entryPrice:100,activatedAt:at(2),currentStopLoss:100,stopMovedAt:at(4),
    remainingPosition:0,realizedR:2.25,resultR:2.25,
    exits:[{target:'TP1',initialFraction:.25,realizedR:.25,checkedAt:at(4)},
      {target:'TP2',initialFraction:.25,realizedR:.5,checkedAt:at(6)},
      {target:'TP3',initialFraction:.5,realizedR:1.5,checkedAt:at(minute)}]});
  return s;
};
test('canonical projection copies evidence, not references or invented recommendation confidence',()=>{
  const {c}=runtime(), s=complete('X'), before=structuredClone(s), r=c.hydrateValidationTrade(c.projectValidationTrade(s));
  assert.equal(r.origin.confirmedAPlus,true); assert.equal(r.origin.recommendationConfidence,null);
  assert.deepEqual(JSON.parse(JSON.stringify(r.initialPlan)),s.initialPlan);
  assert.deepEqual(JSON.parse(JSON.stringify(r.outcome)),s.outcome);
  r.initialPlan.stopLoss=1; assert.deepEqual(s,before);
});
for (const field of ['ready','action','confidence','geometry']) test('reject unconfirmed '+field,()=>{
  const {c}=runtime(),s=signal();
  if(field==='ready')s.tradeReadiness.ready=false;
  if(field==='action')s.action='Buy';
  if(field==='confidence')s.confidence=84;
  if(field==='geometry')s.initialPlan.takeProfit3=null;
  assert.equal(c.projectValidationTrade(s),null);
});
test('batch uses one EVAL; no observation or per-symbol commands',async()=>{
  const {c}=runtime(),commands=[];
  assert.equal(await c.collectValidationArchive([signal('A'),signal('B')],async cmd=>{commands.push(cmd);return 1;}),true);
  assert.equal(commands.length,1); assert.equal(commands[0][0],'EVAL');
  assert.equal(commands[0][3],'sergey-ai:validation-archive:v1');
  assert.equal(JSON.parse(commands[0][4]).length,2);
});
test('archive error is safely logged and never exposes payload/secret',async()=>{
  const {c,logs}=runtime(); assert.equal(await c.collectValidationArchive([signal()],async()=>{throw Error('secret');}),false);
  assert.equal(logs.length,1);assert.ok(!JSON.stringify(logs).includes('secret'));
});
test('missing config or null Redis response never claims archive success',async()=>{
  const {c}=runtime();assert.equal(await c.collectValidationArchive([],async()=>null),false);
  c.getRedisConfig=()=>null;
  assert.equal(await c.collectValidationArchive([],async()=>assert.fail()),false);
  await assert.rejects(c.readValidationArchive({},async()=>assert.fail()));
});
test('CAS conflict never archives failed attempt, archive error cannot roll back success',async()=>{
  const {c}=runtime(),events=[];let attempts=0;
  c.createRankingHistoryEntry=async()=>({readySignals:[signal()]});
  c.recordCompletedTradeSignals=async()=>{};c.collectEntryObservations=async()=>{};
  c.writeOpenTradesCAS=async()=>{events.push('CAS');return ++attempts===1?0:1;};
  const ok=await c.writeRankingHistory({generatedAt:at(3)},async cmd=>{
    if(cmd[0]==='GET'||cmd[0]==='LINDEX')return null;
    events.push('archive');throw Error('Unavailable');
  });
  assert.equal(ok,true);assert.deepEqual(events,['CAS','CAS','archive']);
});
test('all failed CAS attempts produce no archive writes',async()=>{
  const {c}=runtime();c.createRankingHistoryEntry=async()=>({readySignals:[]});
  c.recordCompletedTradeSignals=async()=>{};c.writeOpenTradesCAS=async()=>0;
  c.collectValidationArchive=async()=>assert.fail('archive before commit');
  assert.equal(await c.writeRankingHistory({},async()=>null),false);
});
test('registration success survives archive failure; retry preserves frozen original',async()=>{
  const {c}=runtime(),s=signal();let raw=null;
  c.createFrozenTradeCandidate=()=>({...s,setupKey:'TEST:Long',initialPlan:{...s.initialPlan,expiresAt:new Date(Date.now()+3600000).toISOString()}});
  c.writeOpenTradesCAS=async(old,list)=>{raw=JSON.stringify(list);return 1;};
  const execute=async cmd=>{if(cmd[0]==='GET')return raw;throw Error('archive down');};
  const first=await c.registerOpenTrade({},at(1),execute);
  const second=await c.registerOpenTrade({},at(2),execute);
  assert.equal(first.tradeId,second.tradeId);assert.equal(first.outcome.status,'WaitingEntry');
  assert.deepEqual(JSON.parse(JSON.stringify(first.initialPlan)),JSON.parse(JSON.stringify(second.initialPlan)));
});
test('read endpoint is exclusively GET and has no registration/scanner path',async()=>{
  const {c}=runtime(),commands=[];c.runRedisCommand=async cmd=>{commands.push(cmd);return null;};
  const res={setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
  await c.handler({method:'GET',headers:{},query:{mode:'validation-archive'}},res);
  assert.equal(res.code,200);assert.equal(res.body.initialized,false);assert.equal(commands.length,1);
  assert.equal(commands[0][0],'GET');
});

test('validation archive real Lua on private Redis Unix socket, no TCP',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'sm1m-archive-')),socket=join(dir,'redis.sock');
  const server=spawn(process.env.REDIS_SERVER||'/opt/homebrew/bin/redis-server',
    ['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
  let error;server.on('error',e=>{error=e;});const exec=promisify(execFile);
  const redis=async command=>{
    const {stdout}=await exec(process.env.REDIS_CLI||'/opt/homebrew/bin/redis-cli',['-s',socket,'--json',...command.map(String)],{maxBuffer:20*1024*1024});
    if(stdout.startsWith('error:'))throw Error(stdout);return JSON.parse(stdout);
  };
  try {
    let ready=false;for(let i=0;i<100;i++){if(error)throw error;try{ready=await redis(['PING'])==='PONG';}catch{}if(ready)break;await new Promise(r=>setTimeout(r,20));}
    assert.ok(ready);const {c}=runtime(),script=vm.runInContext('WRITE_VALIDATION_ARCHIVE_SCRIPT',c);let n=0;
    const harness=()=>{const key='qa:archive:'+ ++n;return {key,
      read:async()=>{const d=JSON.parse(await redis(['GET',key]));d.tradesById=Object.fromEntries(Object.entries(d.tradesById).map(([id,r])=>[id,c.hydrateValidationTrade(r)]));return d;},raw:()=>redis(['GET',key]),
      write:(signals,time=at(0),limits={records:5000,bytes:16*1024*1024})=>redis(['EVAL',script,1,key,
        JSON.stringify(signals.map(c.projectValidationTrade).filter(Boolean)),time,JSON.stringify(limits)])};};
    await t.test('canonical first write, duplicate idempotency, boundary immutable',async()=>{
      const h=harness();await h.write([signal()]);const before=await h.raw();await h.write([signal()],at(5));
      assert.equal(await h.raw(),before);const d=await h.read();assert.equal(Object.keys(d.tradesById).length,1);
      assert.equal(d.validationStartAt,at(0));assert.equal(d.tradesById.TEST.cohort,'forward');
    });
    await t.test('legacy and unknown origin never silently forward; later new origin forward',async()=>{
      const h=harness(),old=signal('OLD'),unknown=signal('UNKNOWN'),fresh=signal('NEW');
      delete unknown.initialPlan.createdAt;fresh.initialPlan.createdAt=at(6);
      await h.write([old,unknown],at(5));await h.write([fresh],at(7));const d=await h.read();
      assert.equal(d.tradesById.OLD.cohort,'legacy');assert.equal(d.tradesById.UNKNOWN.cohort,'legacy');
      assert.equal(d.tradesById.NEW.cohort,'forward');assert.equal(d.validationStartAt,at(5));
    });
    await t.test('Waiting -> Active -> Completed, immutable origin/plan and canonical partial results',async()=>{
      const h=harness();await h.write([signal()]);const active=signal('TEST','Active','Long',5);
      active.outcome.entryPrice=100;active.initialPlan.entryPrice=100.5;active.confidence=99;
      await h.write([active],at(6));let d=await h.read();assert.equal(d.tradesById.TEST.outcome.status,'Active');
      assert.equal(d.tradesById.TEST.initialPlan.entryPrice,100);assert.equal(d.tradesById.TEST.origin.confidence,95);
      await h.write([complete('TEST')],at(11));d=await h.read();assert.equal(d.tradesById.TEST.result.resultR,2.25);
      assert.equal(d.tradesById.TEST.outcome.exits.length,3);assert.equal(d.tradesById.TEST.outcome.currentStopLoss,100);
      assert.equal(d.tradesById.TEST.result.completedAt,at(10));
    });
    await t.test('Completed cannot regress or change final result; duplicate completion counted once',async()=>{
      const h=harness();await h.write([complete('TEST')]);const before=await h.raw();
      await h.write([signal('TEST','Active','Long',20)],at(21));const altered=complete('TEST');altered.outcome.resultR=99;
      await h.write([altered],at(30));assert.equal(await h.raw(),before);
      const summary=c.summarizeValidationArchive(Object.values((await h.read()).tradesById));
      assert.equal(summary.completed,1);assert.equal(summary.netR,2.25);
    });
    await t.test('concurrent duplicate batches preserve one canonical id',async()=>{
      const h=harness();await Promise.all(Array.from({length:8},()=>h.write([signal()])));
      assert.equal(Object.keys((await h.read()).tradesById).length,1);
    });
    await t.test('older batches and lost partial exits cannot regress Active state',async()=>{
      const h=harness(),a=signal('TEST','Active','Long',10);a.outcome.exits=[{target:'TP1'}];
      await h.write([a]);await h.write([signal('TEST','Active','Long',5)],at(12));
      await h.write([signal('TEST','Active','Long',20)],at(21));
      assert.equal((await h.read()).tradesById.TEST.outcome.exits.length,1);
    });
    await t.test('Long/Short/TP analytics reuse canonical reducer; Expired excluded',async()=>{
      const h=harness();await h.write([complete('L'),complete('S','Short'),signal('E','Expired')]);
      const s=c.summarizeValidationArchive(Object.values((await h.read()).tradesById));
      assert.equal(s.completed,2);assert.equal(s.expired,1);assert.equal(s.netR,4.5);
      assert.equal(s.tradeAnalytics.directions.Long.count,1);assert.equal(s.tradeAnalytics.directions.Short.count,1);
      assert.equal(s.tradeAnalytics.hits.TP3,2);assert.equal(s.expectancy,2.25);
    });
    await t.test('delayed completion read summary is chronological checkedAt then tradeId',async()=>{
      const h=harness(),loss=complete('A','Long',5);loss.outcome.status='Stopped';loss.outcome.resultR=-1;
      const win=complete('B','Short',10);await h.write([win]);await h.write([loss]);
      const s=c.summarizeValidationArchive(Object.values((await h.read()).tradesById));
      assert.equal(s.netR,1.25);assert.equal(s.maxDrawdownR,1);assert.equal(s.currentStreak.type,'Win');
    });
    await t.test('120 full records survive recent-20 trimming and no expiry',async()=>{
      const h=harness();for(let i=0;i<120;i++)await h.write([complete('T'+i)]);
      for(let i=0;i<30;i++)await redis(['LPUSH','qa:recent',JSON.stringify(complete('T'+i))]);
      await redis(['LTRIM','qa:recent',0,19]);assert.equal(await redis(['LLEN','qa:recent']),20);
      assert.equal(Object.keys((await h.read()).tradesById).length,120);assert.equal(await redis(['TTL',h.key]),-1);
    });
    await t.test('lossless frozen precision and empty exit arrays survive multiple Lua writes',async()=>{
      const h=harness(),s=signal();s.initialPlan.entryPrice=100.12345678901234;
      await h.write([s]);await h.write([signal('OTHER')]);const r=(await h.read()).tradesById.TEST;
      assert.equal(r.initialPlan.entryPrice,s.initialPlan.entryPrice);assert.ok(Array.isArray(r.outcome.exits));
      assert.equal(r.outcome.exits.length,0);
    });
    await t.test('same closing timestamp uses stable tradeId order for streak/drawdown',async()=>{
      const a=complete('A'),b=complete('B');a.outcome.status='Stopped';a.outcome.resultR=-1;
      const h=harness();await h.write([b]);await h.write([a]);
      const stats=c.summarizeValidationArchive(Object.values((await h.read()).tradesById));
      assert.equal(stats.maxDrawdownR,1);assert.equal(stats.currentStreak.type,'Win');
      assert.equal(stats.maxConsecutiveLosses,1);
    });
    await t.test('real owned history CAS + completed ledger + archive remain exactly once together',async()=>{
      const local=runtime().c,s=complete('OWNED');local.runRedisCommand=redis;
      local.createRankingHistoryEntry=async()=>({readySignals:[s]});
      await redis(['SET','sergey-ai:ranking-refresh-lock:v1','qa-owner']);
      const execute=cmd=>local.rankingOwnerCommand('qa-owner',cmd);
      assert.equal(await local.writeRankingHistory({generatedAt:at(15),globalRanking:[]},execute),true);
      assert.equal(await local.writeRankingHistory({generatedAt:at(16),globalRanking:[]},execute),true);
      assert.equal(await redis(['SCARD','sergey-ai:completed-trade-ids:v1']),1);
      const stats=JSON.parse(await redis(['GET','sergey-ai:completed-trade-stats:v1']));
      assert.equal(stats.completed,1);assert.equal(stats.netR,2.25);
      assert.deepEqual(JSON.parse(await redis(['GET','sergey-ai:open-trades:v1'])),[]);
      const response=await local.readValidationArchive({},redis);
      assert.equal(response.records.filter(r=>r.tradeId==='OWNED').length,1);
      assert.equal(response.records.find(r=>r.tradeId==='OWNED').outcome.status,'TP3Hit');
    });
    await t.test('record cap rejects whole batch without eviction or partial mutation',async()=>{
      const h=harness();await h.write([signal('A')]);const before=await h.raw();
      assert.equal(await h.write([signal('B'),signal('C')],at(2),{records:2,bytes:100000}),-1);
      assert.equal(await h.raw(),before);
    });
    await t.test('actual serialized byte cap rejects whole batch unchanged',async()=>{
      const h=harness();await h.write([signal()]);const before=await h.raw();
      assert.equal(await h.write([complete('B')],at(2),{records:5000,bytes:Buffer.byteLength(before)+20}),-2);
      assert.equal(await h.raw(),before);
    });
    await t.test('wrong schema and Redis type are not overwritten',async()=>{
      const h=harness();await redis(['SET',h.key,'{"schemaVersion":99}']);
      assert.equal(await h.write([signal()]),-3);assert.equal(await h.raw(),'{"schemaVersion":99}');
      const other=harness();await redis(['LPUSH',other.key,'wrong']);await assert.rejects(other.write([signal()]));
      assert.equal(await redis(['TYPE',other.key]),'list');
    });
    await t.test('reconciliation repairs a recent missed completion without touching canonical/observation keys',async()=>{
      const s=complete('REPAIR'),recent='sergey-ai:completed-trades:v1';
      await redis(['LPUSH',recent,JSON.stringify(s)]);await redis(['SET','sergey-ai:entry-observations:v1','sentinel']);
      const before=await redis(['LRANGE',recent,0,-1]);
      assert.equal(await c.collectValidationArchive([],redis,true),true);
      const d=JSON.parse(await redis(['GET','sergey-ai:validation-archive:v1']));
      assert.equal(d.tradesById.REPAIR.result.resultR,2.25);
      assert.deepEqual(await redis(['LRANGE',recent,0,-1]),before);
      assert.equal(await redis(['GET','sergey-ai:entry-observations:v1']),'sentinel');
      const response=await c.readValidationArchive({limit:1},redis);
      assert.equal(response.records.length,1);assert.equal(response.legacySummary.completed,2);
      assert.equal(response.summary.completed,0);
    });
  } finally {try{await redis(['SHUTDOWN','NOSAVE']);}catch{}server.kill();await rm(dir,{recursive:true,force:true});}
});
