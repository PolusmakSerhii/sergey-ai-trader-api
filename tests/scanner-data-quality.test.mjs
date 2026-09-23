import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const source = (await readFile(new URL('../api/market.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export default async function handler', 'async function handler');
function runtime() {
  const context = vm.createContext({ process: { env: {} }, console, URL,
    URLSearchParams, Date, AbortSignal, structuredClone, randomUUID });
  vm.runInContext(source, context);
  // Domain tests use an authorized transport; real auth is covered in private-access tests.
  Object.assign(context, { requirePrivateApi: () => true, privateBackendOrigin: () => "https://sergey-ai-trader-api.vercel.app", internalApiHeaders: () => ({Authorization:"Bearer test-only"}) });
  return context;
}
const candles = count => Array.from({ length: count }, () => ({ confirmed: true }));
function response() {
  return { code: 200, setHeader() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
}

test('200 confirmed days are required; an open candle does not complete the history', () => {
  const c = runtime();
  for (const count of [0, 1, 199]) {
    const result = c.assessScannerCandles({ ok: true,
      data: [...candles(count), { confirmed: false }] });
    assert.equal(result.status, 'Insufficient Data');
    assert.equal(result.confirmedCandles, count);
  }
  assert.equal(c.assessScannerCandles({ ok: true, data: candles(200) }).status, 'Available');
  assert.equal(c.assessScannerCandles({ ok: false, error: 'offline' }).status, 'Data Unavailable');
});

test('Scanner requests SWAP and returns short history without calculating a grade', async () => {
  const c = runtime();
  c.getCoinGlassMarketData = async () => ({});
  c.fetchOKXKlines = async (...args) => {
    assert.deepEqual(args, ['ASMLUSDT', '1D', 300, 'SWAP']);
    return { ok: true, data: candles(199) };
  };
  c.fetch = async url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('instrumentType'), 'SWAP');
    const res = response();
    await c.handler({ method: 'GET', query: Object.fromEntries(parsed.searchParams) }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.technical, undefined);
    return { ok: true, status: res.code, json: async () => res.body };
  };
  const result = await c.fetchScannerSymbol('https://example.test', 'ASMLUSDT');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'Insufficient Data');
  assert.equal(result.dataQuality.confirmedCandles, 199);
  assert.equal(result.opportunityScore, undefined);
  assert.equal(result.grade, undefined);
});

test('candle source errors remain failures, not short-history exclusions', async () => {
  const c = runtime();
  c.getCoinGlassMarketData = async () => ({});
  c.fetchOKXKlines = async () => ({ ok: false, error: 'upstream timeout', data: [] });
  const res = response();
  await c.handler({ method: 'GET', query: { symbol: 'ASMLUSDT', instrumentType: 'SWAP' } }, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.status, 'Data Unavailable');
  assert.equal(res.body.error, 'upstream timeout');
});

test('invalid instrument type is rejected before source requests', async () => {
  const c = runtime();
  c.getCoinGlassMarketData = async () => { throw new Error('must not fetch'); };
  const res = response();
  await c.handler({ method: 'GET', query: { symbol: 'FILUSDT', instrumentType: 'FUTURES' } }, res);
  assert.equal(res.code, 400);
});

test('Scanner separates short history from graded results and source failures', async () => {
  for (const outage of [false, true]) {
    const c = runtime();
    const items = ['FILUSDT', 'ASMLUSDT', ...(outage ? ['BTCUSDT'] : [])]
      .map(marketSymbol => ({ marketSymbol, volumeQuote24h: 100 }));
    c.fetchOKXSwapSymbols = async () => ({ ok: true, symbols: items });
    c.fetchOKXSwapTickers = async () => ({ ok: true, tickers: items });
    c.fetchScannerSymbol = async (url, symbol) => symbol === 'FILUSDT'
      ? { ok: true, symbol, score: 85, confidence: 85, tradeAllowed: true,
          tradeReadiness: { score: 85, ready: true, status: 'Ready' },
          marketEnvironmentScore: 85, smartMoneyScore: 85, riskReward: 2,
          probabilities: { neutral: 0 }, direction: 'Long', action: 'Strong Buy',
          entryZone: { from: 99, to: 101 }, stopLoss: 90,
          takeProfit1: 110, takeProfit2: 120, takeProfit3: 130 }
      : { ok: false, symbol, status: symbol === 'ASMLUSDT'
          ? 'Insufficient Data' : 'Data Unavailable', error: 'test' };
    const res = response();
    await c.handler({ method: 'GET', headers: { host: 'example.test' },
      query: { mode: 'scanner', global: 'true', fullGlobal: 'true' } }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.ok, !outage);
    assert.equal(res.body.failed, outage ? 1 : 0);
    assert.equal(res.body.resultsInsufficientData, 1);
    assert.equal(res.body.insufficientData[0].symbol, 'ASMLUSDT');
    assert.equal(res.body.globalBatchResults.length, 1);
    assert.equal(res.body.globalBatchResults[0].grade, 'A+');
    assert.equal(res.body.globalBatchResults[0].opportunityScore, 85);
  }
});
