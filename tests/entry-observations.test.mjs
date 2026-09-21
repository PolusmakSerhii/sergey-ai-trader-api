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
const epoch = Date.now() - 600000;
const iso = offset => new Date(epoch + offset).toISOString();
const signal = (id = 'TESTUSDT', status = 'WaitingEntry', direction = 'Long') => ({
  tradeId: id + ':original', symbol: id, setupKey: id + ':' + direction, direction,
  opportunityScore: 90, confidence: 95, action: direction === 'Long' ? 'Strong Buy' : 'Strong Sell',
  tradeAllowed: true, tradeReadiness: { ready: true }, riskReward: 2,
  initialPlan: { createdAt: iso(-60000), plannedAt: iso(0), expiresAt: iso(3600000),
    entryPrice: 100, entryZone: { from: 99, to: 101 }, stopLoss: direction === 'Long' ? 90 : 110,
    takeProfit1: direction === 'Long' ? 110 : 90, takeProfit2: direction === 'Long' ? 120 : 80,
    takeProfit3: direction === 'Long' ? 130 : 70 }, outcome: { status }
});
const snapshot = (offset = 0, price = 95, symbols = ['TESTUSDT']) => ({ generatedAt: iso(offset),
  globalRanking: symbols.map(symbol => ({ symbol, price, direction: 'Long', action: 'Buy',
    tradeAllowed: true, tradeReadiness: { ready: true }, grade: 'D', opportunityScore: 40, confidence: 80 })) });
const runtime = () => {
  const logs = [];
  const c = vm.createContext({ Date, setTimeout, URL, process: { env: {} },
    console: { error(...args) { logs.push(args); } }, fetch() { throw Error('Network forbidden'); } });
  vm.runInContext(source, c); c.getRedisConfig = () => ({});
  return { c, logs };
};

for (const status of ['WaitingEntry', 'Pending']) test(`builder collects ${status} without changing source`, () => {
  const { c } = runtime(), s = signal('TESTUSDT', status), snap = snapshot(), before = structuredClone(s);
  const batch = c.buildEntryObservationBatch(snap, [s], iso(1000));
  assert.equal(batch.length, 1); assert.equal(batch[0].tradeId, s.tradeId);
  assert.equal(batch[0].observation.entryStatus, 'PULLBACK');
  assert.equal(batch[0].observation.snapshotAgeMs, 1000);
  for (const key of ['tradeId', 'schemaVersion', 'policyVersion', 'location', 'pullbackR', 'currentRR', 'directionalSupport']) {
    assert.equal(batch[0].observation[key], undefined);
  }
  assert.deepEqual(s, before);
});
test('builder uses canonical frozen evidence and never current plan', () => {
  const { c } = runtime(), s = signal(), snap = snapshot();
  snap.globalRanking[0].stopLoss = 500;
  assert.equal(c.buildEntryObservationBatch(snap, [s], iso(0))[0].frozenReference.initialSL, 90);
  s.tradeReadiness.ready = false;
  assert.equal(c.buildEntryObservationBatch(snap, [s], iso(0)).length, 0);
});
test('no eligible batch means zero Redis calls', async () => {
  const { c } = runtime(); await c.collectEntryObservations(snapshot(), [], () => assert.fail());
});
test('multiple symbols persist through one EVAL without GET, market calls or redundant fields', async () => {
  const { c } = runtime(), calls = [];
  await c.collectEntryObservations(snapshot(0, 95, ['ONEUSDT', 'TWOUSDT']), [signal('ONEUSDT'), signal('TWOUSDT')], async command => { calls.push(command); return 1; });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'EVAL'); assert.equal(calls[0][2], '1');
  assert.equal(JSON.parse(calls[0][4]).length, 2);
});
test('post-CAS hook: conflicting attempt has no observation write; storage failure preserves trading success', async () => {
  const { c, logs } = runtime(), s = signal(), seen = [], trading = { lifecycle: 0, ledger: 0, cas: 0 };
  c.createRankingHistoryEntry = async () => { trading.lifecycle++; return { readySignals: [s] }; };
  c.recordCompletedTradeSignals = async () => { trading.ledger++; };
  c.writeOpenTradesCAS = async () => { trading.cas++; seen.push('CAS' + trading.cas); return trading.cas === 1 ? 0 : 1; };
  const before = structuredClone(s), commands = [];
  const result = await c.writeRankingHistory(snapshot(), async command => {
    commands.push(command[0]);
    if (command[0] === 'LINDEX' || command[0] === 'GET') return null;
    assert.equal(trading.cas, 2); seen.push('observation');
    throw Object.assign(new Error('secret must not be logged'), { name: 'TimeoutError' });
  });
  assert.equal(result, true); assert.deepEqual(seen, ['CAS1', 'CAS2', 'observation']);
  assert.deepEqual(trading, { lifecycle: 2, ledger: 2, cas: 2 });
  assert.deepEqual(commands, ['LINDEX', 'GET', 'LINDEX', 'GET', 'EVAL']);
  assert.deepEqual(s, before); assert.equal(logs.length, 1);
  assert.ok(JSON.stringify(logs).includes('timeout')); assert.ok(!JSON.stringify(logs).includes('secret'));
});
test('batch outside retention cannot resurrect a previously removed terminal record', () => {
  const { c } = runtime();
  assert.equal(c.buildEntryObservationBatch(snapshot(), [signal()], iso(91 * 86400000)).length, 0);
});
test('failed CAS never persists observation batch', async () => {
  const { c } = runtime(); let observations = 0;
  c.createRankingHistoryEntry = async () => ({ readySignals: [] }); c.recordCompletedTradeSignals = async () => {};
  c.writeOpenTradesCAS = async () => 0; c.collectEntryObservations = async () => { observations++; };
  assert.equal(await c.writeRankingHistory(snapshot(), async () => null), false);
  assert.equal(observations, 0);
});

test('observation Lua against isolated local Redis, private Unix socket only', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sm1m-observations-'));
  const socket = join(dir, 'redis.sock');
  const server = spawn(process.env.REDIS_SERVER || '/opt/homebrew/bin/redis-server',
    ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
  let serverError; server.on('error', error => { serverError = error; });
  const exec = promisify(execFile);
  const redis = async command => {
    const { stdout } = await exec(process.env.REDIS_CLI || '/opt/homebrew/bin/redis-cli', ['-s', socket, '--json', ...command.map(String)], { maxBuffer: 8 * 1024 * 1024 });
    if (stdout.startsWith('error:')) throw Error(stdout);
    return JSON.parse(stdout);
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (serverError) throw serverError;
      try { ready = await redis(['PING']) === 'PONG'; } catch {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(ready, 'Local Redis unavailable');
    const { c } = runtime();
    const script = vm.runInContext('WRITE_ENTRY_OBSERVATIONS_SCRIPT', c);
    const limits = vm.runInContext('ENTRY_OBSERVATION_LIMITS', c);
    let keyNo = 0;
    const harness = () => {
      const key = 'qa:observations:' + ++keyNo;
      return {
        key, raw: () => redis(['GET', key]), read: async () => JSON.parse(await redis(['GET', key])),
        write: async (s, offset = 0, price = 95, options = {}) => {
          const time = options.now ?? offset;
          const batch = c.buildEntryObservationBatch(snapshot(offset, price, s.map(x => x.symbol)), s, iso(time));
          for (const item of batch) if (item.collectionEnd) item.collectionEnd.epochMs = Date.parse(item.collectionEnd.at);
          return redis(['EVAL', script, 1, key, JSON.stringify(batch), JSON.stringify({ ...limits, ...options.limits }), epoch + time]);
        }
      };
    };
    await t.test('real owned Ranking CAS succeeds even when separate observation key has wrong type', async () => {
      const local = runtime(), cx = local.c;
      cx.runRedisCommand = redis;
      const s = signal('OWNEDUSDT');
      cx.createRankingHistoryEntry = async () => ({ readySignals: [s] });
      const lock = 'sergey-ai:ranking-refresh-lock:v1';
      const observations = 'sergey-ai:entry-observations:v1';
      await redis(['SET', lock, 'qa-owner']);
      await redis(['LPUSH', observations, 'wrong-type']);
      assert.equal(await cx.writeRankingHistory(snapshot(0, 95, ['OWNEDUSDT']), command => cx.rankingOwnerCommand('qa-owner', command)), true);
      assert.equal(JSON.parse(await redis(['GET', 'sergey-ai:open-trades:v1']))[0].tradeId, s.tradeId);
      assert.equal(await redis(['LLEN', 'sergey-ai:global-ranking-history:v1']), 1);
      assert.equal(await redis(['TYPE', observations]), 'list');
      assert.ok(local.logs.some(log => log[0] === '[entry-observations]'));
      await redis(['DEL', observations]); // Only isolated test socket.
      assert.equal(await cx.writeRankingHistory(snapshot(1000, 95, ['OWNEDUSDT']), command => cx.rankingOwnerCommand('qa-owner', command)), true);
      const doc = JSON.parse(await redis(['GET', observations]));
      assert.equal(doc.records[s.tradeId].summary.sampleCount, 1);
      assert.equal(await redis(['GET', 'sergey-ai:completed-trade-stats:v1']), null);
    });
    await t.test('WaitingEntry/Pending, mirrored sampled pullback, frozen identity, factual summary only', async () => {
      const h = harness(), a = signal(), b = signal('SHORTUSDT', 'Pending', 'Short');
      await h.write([a], 0, 95); await h.write([b], 1000, 105);
      const doc = await h.read();
      for (const s of [a, b]) {
        const r = doc.records[s.tradeId]; assert.equal(r.tradeId, s.tradeId);
        assert.equal(r.summary.firstPullbackAt, r.summary.firstObservedAt);
        assert.equal(r.summary.maxObservedPullbackR, .5); assert.equal(r.observations.length, 1);
        assert.equal(r.summary.firstRecoveryAt, undefined); assert.equal(r.summary.firstContinuationAt, undefined);
        assert.ok(!JSON.stringify(r).includes('IMPROVED ENTRY')); assert.ok(!JSON.stringify(r).includes('CONTINUATION'));
      }
    });
    await t.test('same identity retries, concurrent retries and timeout-after-commit retries deduplicate', async () => {
      const h = harness(), s = signal(); await Promise.all([h.write([s]), h.write([s])]);
      const first = await h.raw(); await h.write([s]); assert.equal(await h.raw(), first);
      assert.equal((await h.read()).records[s.tradeId].summary.sampleCount, 1);
    });
    await t.test('older batch preserves newer summary and flags missing ordered evidence', async () => {
      const h = harness(), s = signal(); await h.write([s], 2000, 94); await h.write([s], 1000, 96);
      const r = (await h.read()).records[s.tradeId]; assert.equal(r.summary.lastObservedAt, iso(2000));
      assert.equal(r.summary.sampleCount, 1); assert.equal(r.summary.maxObservedPullbackR, .6);
      assert.equal(r.summary.gap, true);
    });
    await t.test('16 events retained, factual first/max summary survives truncation', async () => {
      const h = harness(), s = signal();
      for (let i = 0; i < 18; i++) await h.write([s], i * 1000, i === 0 ? 91 : 95);
      const r = (await h.read()).records[s.tradeId]; assert.equal(r.observations.length, 16);
      assert.equal(r.summary.sampleCount, 18); assert.equal(r.summary.truncated, true);
      assert.equal(r.summary.firstPullbackAt, iso(0)); assert.equal(r.summary.maxObservedPullbackR, .9);
    });
    await t.test('analytical SL boundary stored as sampled fact, lifecycle untouched', async () => {
      const h = harness(), s = signal(); await h.write([s], 1000, 90);
      const r = (await h.read()).records[s.tradeId]; assert.equal(r.summary.firstAnalyticalInvalidationAt, iso(1000));
      assert.equal(r.observations[0].lifecycleStatus, 'WaitingEntry'); assert.equal(r.collectionEnd, null);
    });
    await t.test('Active boundary closes collection; repeated Active and later waiting cannot add prices/reopen', async () => {
      const h = harness(), s = signal(); await h.write([s]);
      s.outcome = { status: 'Active', activatedAt: iso(500) }; await h.write([s], 1000, 110);
      const first = await h.raw(); await h.write([s], 2000, 120); assert.equal(await h.raw(), first);
      s.outcome.status = 'WaitingEntry'; await h.write([s], 3000, 95);
      const r = (await h.read()).records[s.tradeId]; assert.equal(r.observations.length, 1);
      assert.equal(r.collectionEnd.at, iso(500)); assert.equal(r.summary.lastState, 'ENTRY COMPLETED');
    });
    await t.test('first seen Active has zero observations and honest boundary', async () => {
      const h = harness(), s = signal('TESTUSDT', 'Active'); await h.write([s]);
      const r = (await h.read()).records[s.tradeId]; assert.deepEqual(r.observations, []);
      assert.equal(r.collectionEnd.reasonCode, 'NO_PRE_ENTRY_OBSERVATIONS'); assert.equal(r.summary.firstPullbackAt, null);
    });
    await t.test('Expired boundary and later outcome reference contain no new market observation', async () => {
      const h = harness(), s = signal(); await h.write([s]);
      s.outcome = { status: 'Expired', checkedAt: iso(1000) }; await h.write([s], 2000);
      const r = (await h.read()).records[s.tradeId]; assert.equal(r.observations.length, 1);
      assert.equal(r.collectionEnd.lifecycleStatus, 'Expired'); assert.equal(r.outcomeReference.resultR, null);
    });
    await t.test('existing lifecycle result reference joins after Active without another P&L', async () => {
      const h = harness(), s = signal('TESTUSDT', 'Active'); s.outcome.activatedAt = iso(0); await h.write([s]);
      s.outcome = { ...s.outcome, status: 'Stopped', checkedAt: iso(1000), resultR: .25 }; await h.write([s], 2000);
      const r = (await h.read()).records[s.tradeId]; assert.equal(r.outcomeReference.resultR, .25);
      assert.equal(r.collectionEnd.lifecycleStatus, 'Active'); assert.deepEqual(r.observations, []);
    });
    await t.test('30-day detail / 90-day summary retention is explicit; ended trades do not resurrect', async () => {
      const h = harness(), s = signal(); await h.write([s]);
      s.outcome = { status: 'Active', activatedAt: iso(1000) }; await h.write([s], 1000);
      const trigger = signal('NEWUSDT'); trigger.initialPlan.createdAt = iso(0);
      await h.write([trigger], 31 * 86400000);
      let doc = await h.read(); assert.deepEqual(doc.records[s.tradeId].observations, []);
      assert.equal(doc.records[s.tradeId].summary.limitReason, 'DETAIL_RETENTION');
      await h.write([trigger, s], 91 * 86400000);
      doc = await h.read(); assert.equal(doc.records[s.tradeId], undefined); assert.equal(doc.metadata.SUMMARY_RETENTION, true);
      assert.ok(doc.records[trigger.tradeId]);
    });
    await t.test('trade cap rejects new records with metadata, never evicts unfinished records', async () => {
      const h = harness(), a = signal(), b = signal('OTHERUSDT');
      await h.write([a]); await h.write([b], 1000, 95, { limits: { trades: 1 } });
      const doc = await h.read(); assert.ok(doc.records[a.tradeId]); assert.equal(doc.records[b.tradeId], undefined);
      assert.equal(doc.metadata.MAX_TRADE_RECORDS, true); assert.equal(doc.metadata.gap, true);
    });
    await t.test('size guard keeps original records with explicit loss marker', async () => {
      const h = harness(), s = signal(); await h.write([s]); const old = (await h.read()).records;
      assert.equal(await h.write([signal('OTHERUSDT')], 1000, 95, { limits: { bytes: 5000 } }), 2);
      const doc = await h.read(); assert.deepEqual(doc.records, old); assert.equal(doc.metadata.MAX_DOCUMENT_BYTES, true);
    });
    await t.test('rules revision mismatch and invalid schema never silently reinterpret stored records', async () => {
      const h = harness(), s = signal(); await h.write([s]); let doc = await h.read();
      doc.records[s.tradeId].rulesRevision = 'old-rules'; await redis(['SET', h.key, JSON.stringify(doc)]);
      await h.write([s], 1000); doc = await h.read(); assert.equal(doc.records[s.tradeId].summary.sampleCount, 1);
      assert.equal(doc.metadata.RULES_REVISION_MISMATCH, true);
      await redis(['SET', h.key, '{"schemaVersion":"unknown"}']);
      await assert.rejects(() => h.write([s], 2000), /schema/);
      assert.equal(await h.raw(), '{"schemaVersion":"unknown"}');
    });
  } finally {
    try { await redis(['SHUTDOWN', 'NOSAVE']); } catch {}
    if (server.exitCode === null) { server.kill(); await new Promise(r => server.once('exit', r)); }
    await rm(dir, { recursive: true, force: true });
  }
});
