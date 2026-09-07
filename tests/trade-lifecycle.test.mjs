import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = (await readFile(new URL("../api/market.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "")
  .replace("export default async function handler", "async function handler");
function runtime() {
  const context = vm.createContext({ process: { env: {} }, console, URL, Date, setTimeout, AbortSignal,
    fetch() { throw new Error("Network is disabled in lifecycle tests"); } });
  vm.runInContext(source, context);
  return context;
}
const base = Date.parse("2026-09-07T10:00:00Z");
const minute = 60000;
const time = m => new Date(base + m * minute).toISOString();
const candle = (m, values = {}) => ({ timestamp: base + m * minute,
  open: 100, high: 102, low: 98, close: 100, confirmed: true, ...values });
const plan = direction => ({ entryPrice:100, entryZone:{from:99,to:101},
  stopLoss:direction === "Short" ? 110 : 90,
  takeProfit1:direction === "Short" ? 90 : 110,
  takeProfit2:direction === "Short" ? 80 : 120,
  takeProfit3:direction === "Short" ? 70 : 130,
  plannedAt:time(0), expiresAt:time(60) });
const active = () => ({ status:"Active", activatedAt:time(0), entryPrice:100,
  lastPriceCheckedAt:time(0) });
function evaluate(context, {direction="Long", data=[], previousOutcome={}, now=6,
  initialPlan=plan(direction), unavailable=false} = {}) {
  return context.evaluateTradeLifecycle({ initialPlan, direction, previousOutcome,
    capturedAt:time(now), priceRange:unavailable ? null : {source:"OKX 1m candles",data} });
}

for (const direction of ["Long", "Short"]) {
  const tp = direction === "Long" ? {high:111,close:110} : {low:89,close:90};
  const sl = direction === "Long" ? {low:89,close:90} : {high:111,close:110};
  test(`${direction}: TP before SL in different candles is a win`, () => {
    const result = evaluate(runtime(), {direction,previousOutcome:active(),
      data:[candle(1,sl),candle(0,tp)]});
    assert.equal(result.status,"TP1Hit");
    assert.equal(result.resultR,1);
    assert.equal(result.checkedAt,time(1));
    assert.equal(result.exitCheck.candle.timestamp,base);
    assert.equal(result.priceCheck.bothLevelsTouched,false);
  });
  test(`${direction}: SL before TP is a loss`, () => {
    const result = evaluate(runtime(), {direction,previousOutcome:active(),data:[candle(0,sl),candle(1,tp)]});
    assert.equal(result.status,"Stopped");
    assert.equal(result.resultR,-1);
  });
  test(`${direction}: both levels in one candle use conservative SL`, () => {
    const result = evaluate(runtime(), {direction,previousOutcome:active(),data:[candle(0,{high:111,low:89})]});
    assert.equal(result.status,"Stopped");
    assert.equal(result.priceCheck.bothLevelsTouched,true);
    assert.equal(result.exitCheck.rule,"same-candle-sl-first");
  });
  test(`${direction}: entry and target in the same closed candle are processed`, () => {
    const result = evaluate(runtime(), {direction,data:[candle(0,tp)]});
    assert.equal(result.status,"TP1Hit");
    assert.equal(result.entryPrice,100);
    assert.equal(result.activatedAt,time(0));
    assert.equal(result.entryCheck.candle.confirmed,true);
  });
  test(`${direction}: ambiguous entry-side extreme is not a fabricated result`, () => {
    const entry = direction === "Long"
      ? candle(0,{open:112,high:115,low:100,close:102})
      : candle(0,{open:88,high:100,low:85,close:98});
    const context=runtime();
    const first=evaluate(context,{direction,data:[entry]});
    assert.equal(first.status,"Active");
    assert.equal(first.priceCheck.status,"ambiguous_entry_candle");
    assert.equal(first.resultR,null);
    assert.equal(first.lastPriceCheckedAt,time(0));
    const retry=evaluate(context,{direction,previousOutcome:first,data:[entry,candle(1,sl)],now:12});
    assert.equal(retry.status,"Active");
    assert.equal(retry.priceCheck.status,"ambiguous_entry_candle");
    assert.equal(retry.checkedAt,null);
  });
}

test("new confirmed setup inside the zone waits without fetching past candles", async () => {
  const context=runtime();
  const item={...plan("Long"),symbol:"TESTUSDT",price:100,direction:"Long",grade:"A+",
    opportunityGrade:"A+",opportunityScore:90,confidence:90,riskReward:2,action:"Strong Buy",
    tradeAllowed:true,tradeReadiness:{ready:true}};
  const result=await context.createRankingHistoryEntry({generatedAt:time(0),globalRanking:[item]});
  assert.equal(result.readySignals[0].outcome.status,"WaitingEntry");
  assert.equal(result.readySignals[0].outcome.entryPrice,null);
});

test("open and future candles do not confirm entry or advance checkpoint", () => {
  const result=evaluate(runtime(),{now:0.5,data:[candle(0,{confirmed:false}),candle(1)]});
  assert.equal(result.status,"WaitingEntry");
  assert.equal(result.lastPriceCheckedAt,time(0));
  assert.equal(result.entryCheck,undefined);
});

test("entry is observed only in full minutes after plan creation", () => {
  const result=evaluate(runtime(),{initialPlan:{...plan("Long"),plannedAt:time(0.5)},now:2,
    data:[candle(0,{open:105,high:106,low:104,close:105}),candle(1)]});
  assert.equal(result.status,"Active");
  assert.equal(result.activatedAt,time(1));
  assert.equal(result.priceCheck.candles,2);
});

test("pre-entry TP highs are not reused to close the trade", () => {
  const result=evaluate(runtime(),{now:2,data:[
    candle(0,{open:115,high:120,low:112,close:114}),
    candle(1,{open:105,high:106,low:100,close:102})]});
  assert.equal(result.status,"Active");
  assert.equal(result.activatedAt,time(1));
  assert.equal(result.entryPrice,101);
  assert.equal(result.resultR,null);
});

test("zone boundary touch activates at the approached boundary", () => {
  const result=evaluate(runtime(),{now:1,data:[candle(0,{open:98,low:97,high:99,close:98})]});
  assert.equal(result.status,"Active");
  assert.equal(result.entryPrice,99);
});

test("no snapshot fallback on source failure, even after expiry", () => {
  const context=runtime();
  const waiting=evaluate(context,{unavailable:true,now:120});
  assert.equal(waiting.status,"WaitingEntry");
  assert.equal(waiting.lastPriceCheckedAt,time(0));
  assert.equal(waiting.priceCheck.status,"unavailable");
  const running=evaluate(context,{previousOutcome:active(),unavailable:true,now:120});
  assert.equal(running.status,"Active");
  assert.equal(running.resultR,null);
  assert.equal(running.lastPriceCheckedAt,time(0));
});

test("a gap stops chronology; recovery resumes from the first missing minute", () => {
  const context=runtime();
  const first=evaluate(context,{previousOutcome:active(),now:3,
    data:[candle(0),candle(2,{high:111})]});
  assert.equal(first.status,"Active");
  assert.equal(first.lastPriceCheckedAt,time(1));
  assert.equal(first.priceCheck.status,"incomplete_candles");
  const recovered=evaluate(context,{previousOutcome:first,now:3,
    data:[candle(1),candle(2,{high:111})]});
  assert.equal(recovered.status,"TP1Hit");
  assert.equal(recovered.checkedAt,time(3));
});

test("expiry requires verified non-entry coverage and is excluded from statistics", () => {
  const context=runtime();
  const data=Array.from({length:60},(_,i)=>candle(i,{open:105,high:106,low:104,close:105}));
  const expired=evaluate(context,{data,now:61});
  assert.equal(expired.status,"Expired");
  assert.equal(expired.resultR,null);
  assert.equal(expired.entryPrice,null);
  assert.equal(context.createOutcomeSummary([{readySignals:[{tradeId:"expired",outcome:expired}]}]).completed,0);
  const gap=evaluate(context,{data:data.filter((_,i)=>i!==30),now:61});
  assert.equal(gap.status,"WaitingEntry");
  assert.equal(gap.lastPriceCheckedAt,time(30));
});

test("a candle straddling expiry cannot activate after the verified window", () => {
  const result=evaluate(runtime(),{initialPlan:{...plan("Long"),expiresAt:time(1.5)},now:2,
    data:[candle(0,{open:105,high:106,low:104,close:105}),candle(1)]});
  assert.equal(result.status,"WaitingEntry");
  assert.equal(result.priceCheck.status,"ambiguous_expiry_candle");
  assert.equal(result.entryPrice,null);
});

test("already active trades do not expire", () => {
  const result=evaluate(runtime(),{previousOutcome:{...active(),lastPriceCheckedAt:time(60)},
    now:61,data:[candle(60)]});
  assert.equal(result.status,"Active");
});

test("malformed prices and geometry cannot produce outcomes", () => {
  const context=runtime();
  for (const initialPlan of [{...plan("Long"),stopLoss:null}, {...plan("Long"),stopLoss:105}]) {
    const result=evaluate(context,{initialPlan,data:[candle(0,{low:80,high:120})]});
    assert.equal(result.status,"Pending");
    assert.equal(result.priceCheck.status,"invalid_plan");
  }
  const bad=evaluate(context,{previousOutcome:active(),data:[candle(0,{low:101,high:99})]});
  assert.equal(bad.status,"Active");
  assert.equal(bad.lastPriceCheckedAt,time(0));
});

test("closed results remain immutable", () => {
  const previousOutcome={...active(),status:"TP1Hit",resultR:1,checkedAt:time(1),exitPrice:110};
  assert.equal(evaluate(runtime(),{previousOutcome,data:[candle(0,{low:80})]}),previousOutcome);
});

test("ranking changes preserve waiting/active plan, ID, grade and direction", async () => {
  const context=runtime();
  const item={...plan("Long"),symbol:"TESTUSDT",price:100,direction:"Long",grade:"A+",
    opportunityGrade:"A+",opportunityScore:90,confidence:90,riskReward:2,action:"Strong Buy",
    tradeAllowed:true,tradeReadiness:{ready:true}};
  const first=await context.createRankingHistoryEntry({generatedAt:time(0),globalRanking:[item]});
  const fixed=JSON.stringify(first.readySignals[0].initialPlan);
  let requestedFrom;
  context.fetchOKXRecentPriceRange=async (_,from)=>{requestedFrom=from;return {source:"OKX 1m candles",data:[candle(0)]};};
  const next=await context.createRankingHistoryEntry({generatedAt:time(1),globalRanking:[
    {...item,direction:"Short",grade:"A",opportunityGrade:"A",opportunityScore:70,confidence:70,
      action:"Sell",stopLoss:130,takeProfit1:80,entryZone:{from:109,to:111}}]},first);
  const tracked=next.readySignals.find(signal=>signal.tradeId===first.readySignals[0].tradeId);
  assert.equal(requestedFrom,time(0));
  assert.equal(tracked.outcome.status,"Active");
  assert.equal(tracked.direction,"Long");
  assert.equal(tracked.opportunityGrade,"A+");
  assert.equal(JSON.stringify(tracked.initialPlan),fixed);
  assert.equal(context.isConfirmedAPlusTradeSignal(tracked),true);
});

function okxRow(m, confirm="1") { return [String(base+m*minute),"100","102","98","100","1","1","100",confirm]; }
test("OKX pagination retrieves the oldest 300 unchecked minutes in at most 3 requests", async () => {
  const context=runtime();
  const requests=[];
  context.fetch=async (url,options)=>{
    requests.push(new URL(url));
    assert.ok(options.signal);
    const end=(Number(url.searchParams.get("after"))-base)/minute;
    const start=Math.max(0,end-Number(url.searchParams.get("limit")));
    return {ok:true,json:async()=>({code:"0",data:Array.from({length:end-start},(_,i)=>okxRow(end-i-1))})};
  };
  const result=await context.fetchOKXRecentPriceRange("TESTUSDT",time(0),time(700));
  assert.equal(requests.length,3);
  assert.equal(result.data.length,300);
  assert.equal(result.data[0].timestamp,base);
  assert.equal(result.data.at(-1).timestamp,base+299*minute);
  assert.equal(requests[0].searchParams.get("after"),String(base+300*minute));
  assert.equal(requests[0].searchParams.get("instId"),"TEST-USDT-SWAP");
  assert.equal(requests[0].searchParams.get("before"),String(base-1));
  assert.equal(requests[0].pathname,"/api/v5/market/history-candles");
});

test("OKX rejects unconfirmed/invalid candles and never fills gaps", async () => {
  const context=runtime();
  context.fetch=async()=>({ok:true,json:async()=>({code:"0",data:[okxRow(2),okxRow(1,"0"),okxRow(0)]})});
  const result=await context.fetchOKXRecentPriceRange("TESTUSDT",time(0),time(3));
  assert.equal(result.data.length,2);
  const outcome=context.evaluateTradeLifecycle({initialPlan:plan("Long"),direction:"Long",
    previousOutcome:active(),capturedAt:time(3),priceRange:result});
  assert.equal(outcome.lastPriceCheckedAt,time(1));
});

test("OKX errors, malformed payloads and timeouts return unavailable", async () => {
  const context=runtime();
  for (const fetch of [async()=>({ok:false,json:async()=>({code:"500"})}),
    async()=>({ok:true,json:async()=>({code:"0",data:null})}),
    async()=>{throw new Error("timeout");}]) {
    context.fetch=fetch;
    assert.equal(await context.fetchOKXRecentPriceRange("TESTUSDT",time(0),time(3)),null);
  }
});


test("touch in a candle straddling creation is not an invented entry or expiry", () => {
  const context=runtime();
  const initialPlan={...plan("Long"),plannedAt:time(0.5)};
  const first=evaluate(context,{initialPlan,now:2,data:[candle(0),candle(1)]});
  assert.equal(first.status,"WaitingEntry");
  assert.equal(first.priceCheck.status,"ambiguous_start_candle");
  assert.equal(first.lastPriceCheckedAt,time(0));
  const retry=evaluate(context,{initialPlan,previousOutcome:first,now:65,data:[candle(0),candle(1)]});
  assert.equal(retry.status,"WaitingEntry");
  assert.equal(retry.priceCheck.status,"ambiguous_start_candle");
});

test("legacy partial checkpoint cannot attribute an earlier level hit to a later interval", () => {
  const context=runtime();
  const previousOutcome={...active(),lastPriceCheckedAt:time(0.5)};
  const first=evaluate(context,{previousOutcome,now:2,data:[candle(0,{high:111}),candle(1)]});
  assert.equal(first.status,"Active");
  assert.equal(first.priceCheck.status,"ambiguous_checkpoint_candle");
  const retry=evaluate(context,{previousOutcome:first,now:3,data:[candle(0,{high:111}),candle(1)]});
  assert.equal(retry.status,"Active");
  assert.equal(retry.priceCheck.status,"ambiguous_checkpoint_candle");
});


test("new plans created mid-minute start a full 60-minute window at the next boundary", async () => {
  const context=runtime();
  const item={...plan("Long"),symbol:"TESTUSDT",price:100,direction:"Long",grade:"A+",
    opportunityGrade:"A+",opportunityScore:90,confidence:90,riskReward:2,action:"Strong Buy",
    tradeAllowed:true,tradeReadiness:{ready:true}};
  const first=await context.createRankingHistoryEntry({generatedAt:time(0.5),globalRanking:[item]});
  const trade=first.readySignals[0];
  assert.equal(trade.outcome.status,"WaitingEntry");
  assert.equal(trade.initialPlan.createdAt,time(0.5));
  assert.equal(trade.initialPlan.plannedAt,time(1));
  assert.equal(trade.initialPlan.expiresAt,time(61));
  context.fetchOKXRecentPriceRange=async()=>({source:"OKX 1m candles",data:[candle(1)]});
  const next=await context.createRankingHistoryEntry({generatedAt:time(2),globalRanking:[item]},first);
  assert.equal(next.readySignals[0].outcome.status,"Active");
  assert.equal(next.readySignals[0].outcome.activatedAt,time(1));
});
