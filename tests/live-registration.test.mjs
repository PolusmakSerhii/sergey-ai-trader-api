import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler');
const start = source.indexOf('    const liveOpportunity = calculateScannerOpportunity(executionAnalysis);');
const end = source.indexOf('  } catch (error) {\n    res.status(500)', start);
assert.ok(start > 0 && end > start);
const liveBlock = '(async()=>{' + source.slice(start, end) + '})()';
function runtime() {
  const c = vm.createContext({Date, URL, AbortSignal, setTimeout,
    process: {env: {}}, console: {error() {}}, fetch() {throw new Error('Network forbidden');}});
  vm.runInContext(source, c);
  // Inputs supplied by the analysis pipeline immediately before the real response block.
  const technical = source.slice(source.indexOf('technical: {', start), source.indexOf('\n   },', start));
  for (const line of technical.split('\n')) {
    const name = line.trim().replace(/,$/, '');
    if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) c[name] = null;
  }
  c.executionAnalysis = {symbol:'TESTUSDT', price:100, direction:'Long', score:90,
    confidence:95, recommendationConfidence:80, tradeAllowed:true,
    tradeReadiness:{ready:true,score:95,status:'Ready'}, marketEnvironmentScore:90,
    smartMoneyScore:80, riskReward:2, probabilities:{neutral:0}, action:'Strong Buy',
    entryZone:{from:99,to:101},stopLoss:90,takeProfit1:110,takeProfit2:120,takeProfit3:130};
  Object.assign(c, {req:{method:'GET',query:{},headers:{}},instrumentType:'SWAP',symbol:'TESTUSDT',
    coin:{name:'Test',symbol:'test',current_price:100},coinGlass:{errors:[]},
    coinGeckoError:null,derivativesHistory:{},okxDailyResponse:{ok:true},
    okxDailyCandles:[],okxConfirmedDailyCandles:[],fearGreed:null,
    res:{status(code){this.code=code;return this;},json(body){this.body=body;return this;}}});
  c.registrations = [];
  c.registerOpenTrade = async (item, capturedAt) => {
    c.registrations.push({item,capturedAt});
    return c.createFrozenTradeCandidate(item,capturedAt);
  };
  return c;
}
test('real single-market response block registers server canonical result and returns WaitingEntry', async()=>{
  const c=runtime(); await vm.runInContext(liveBlock,c);
  assert.equal(c.res.code,200);assert.equal(c.registrations.length,1);
  assert.equal(c.res.body.technical.confirmedAPlus,true);
  assert.equal(c.res.body.tradeRegistration.status,'WaitingEntry');
  assert.equal(c.registrations[0].capturedAt,c.res.body.time);
  assert.equal(c.registrations[0].item.opportunityScore,c.res.body.technical.opportunityScore);
  assert.equal(c.registrations[0].item.opportunityGrade,c.res.body.technical.opportunityGrade);
});
test('client confirmation cannot register noncanonical server analysis',async()=>{
  const c=runtime();c.req.query.confirmedAPlus='true';c.executionAnalysis.action='Buy';
  await vm.runInContext(liveBlock,c);
  assert.equal(c.res.code,200);assert.equal(c.res.body.technical.confirmedAPlus,false);
  assert.equal(c.registrations.length,0);assert.equal(c.res.body.tradeRegistration,null);
});
test('actual internal Scanner fetch supplies suppression marker; canonical response does not register',async()=>{
  const c=runtime();let called=0;
  c.fetch=async (url,options)=>{
    called++;assert.equal(new URL(url).searchParams.get('instrumentType'),'SWAP');
    assert.equal(options.headers['x-sm1m-analysis-source'],'scanner');
    c.req.headers=options.headers;
    await vm.runInContext(liveBlock,c);
    assert.equal(c.res.body.technical.confirmedAPlus,true);
    assert.equal(c.res.body.tradeRegistration,null);
    return {ok:true,json:async()=>c.res.body};
  };
  await c.fetchScannerSymbol('https://local.test','TESTUSDT');
  assert.equal(called,1);assert.equal(c.registrations.length,0);
});
test('SPOT does not enter SWAP candle lifecycle',async()=>{
  const c=runtime();c.instrumentType='SPOT';await vm.runInContext(liveBlock,c);
  assert.equal(c.registrations.length,0);assert.equal(c.res.code,200);
});
test('failed persistence returns 503 and never reports a registered trade',async()=>{
  const c=runtime();c.registerOpenTrade=async()=>{throw new Error('Redis unavailable');};
  await vm.runInContext(liveBlock,c);
  assert.equal(c.res.code,503);assert.equal(c.res.body.ok,false);
  assert.equal(c.res.body.tradeRegistration,undefined);
  assert.equal(c.res.body.error,'Live trade registration unavailable');
});
