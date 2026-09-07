import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";
import { BACKUP_KEYS as keys, createRestoreCommands, RESTORE_SCRIPT } from "../scripts/redis-backup-format.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const source = (await readFile(new URL("../api/market.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "")
  .replace("export default async function handler", "async function handler");
const signal = (id, resultR = 1) => ({
  tradeId: id, symbol: "TESTUSDT", direction: "Long", opportunityGrade: "A+",
  opportunityScore: 90, confidence: 90, riskReward: 2, action: "Strong Buy",
  initialPlan: { entryPrice: 100, stopLoss: 90, takeProfit1: 110 },
  outcome: { status: resultR > 0 ? "TP1Hit" : "Stopped", resultR,
    checkedAt: "2026-09-07T12:00:00.000Z" }
});

test("trade ledger and backups against isolated Redis (no TCP or production)", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sm1m-redis-test-"));
  const socket = join(directory, "redis.sock");
  const cli = process.env.REDIS_CLI || "redis-cli";
  const server = spawn(process.env.REDIS_SERVER || "redis-server", [
    "--port", "0", "--unixsocket", socket, "--unixsocketperm", "700",
    "--save", "", "--appendonly", "no", "--dir", directory
  ], { stdio: "ignore" });
  let serverError;
  server.on("error", error => { serverError = error; });
  const redis = async command => {
    const { stdout } = await exec(cli, ["-s", socket, "--json", ...command.map(String)],
      { maxBuffer: 4 * 1024 * 1024 });
    // Redis CLI emits errors as error:... instead of valid JSON.
    if (stdout.startsWith("error:")) throw new Error(stdout);
    return JSON.parse(stdout);
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      if (serverError) throw serverError;
      try { ready = await redis(["PING"]) === "PONG"; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(ready, "Install Redis or set REDIS_SERVER and REDIS_CLI");
    const context = vm.createContext({ console: { error() {} }, Date, URL, setTimeout,
      process: { env: { UPSTASH_REDIS_REST_URL: "audit-local", UPSTASH_REDIS_REST_TOKEN: "test" } },
      fetch() { throw new Error("Network forbidden in tests"); } });
    vm.runInContext(source, context);
    context.runRedisCommand = redis;
    const record = signals => context.recordCompletedTradeSignals(signals);
    const stats = async () => JSON.parse(await redis(["GET", keys.completedTradeStats]));
    const reset = () => redis(["FLUSHDB"]); // Only the private Unix socket above.

    await t.test("ranking lease excludes competitors and fences stale snapshot, ledger and checkpoint writes", async () => {
      await reset();
      const lock = "sergey-ai:ranking-refresh-lock:v1";
      assert.equal(await redis(["SET", lock, "owner-a", "NX", "EX", "900"]), "OK");
      assert.equal(await redis(["SET", lock, "owner-b", "NX", "EX", "900"]), null);
      const ownedA = command => context.rankingOwnerCommand("owner-a", command);
      await context.recordCompletedTradeSignals([signal("lease-trade")], ownedA);
      assert.equal((await stats()).completed, 1);
      await redis(["SET", lock, "owner-b", "EX", "900"]);
      await assert.rejects(() => ownedA(["SET", keys.openTrades, "[]"]), /lease lost/);
      await assert.rejects(() => context.recordCompletedTradeSignals([signal("stale-trade")], ownedA), /lease lost/);
      assert.equal(await context.writeGlobalRankingCache({ok:true}, ownedA), false);
      assert.equal(await context.writeRankingHistory({ok:true}, ownedA), false);
      assert.equal((await stats()).completed, 1);
      const releaseScript = vm.runInContext("RELEASE_RANKING_LOCK_SCRIPT", context);
      assert.equal(await redis(["EVAL", releaseScript, "1", lock, "owner-a"]), 0);
      assert.equal(await redis(["GET", lock]), "owner-b");
      assert.equal(await redis(["EVAL", releaseScript, "1", lock, "owner-b"]), 1);
    });

    await t.test("deduplicates retries and keeps totals beyond the 20 detail rows", async () => {
      await reset();
      const signals = Array.from({ length: 35 }, (_, i) => signal(`trade-${i}`));
      await record(signals);
      await record(signals);
      assert.equal((await stats()).completed, 35);
      assert.equal(await redis(["SCARD", keys.completedTradeIds]), 35);
      assert.equal(await redis(["LLEN", keys.completedTrades]), 20);
    });
    await t.test("concurrent overlapping batches do not lose or duplicate results", async () => {
      await reset();
      await Promise.all([record([signal("a"), signal("shared")]),
        record([signal("b", -1), signal("shared")])]);
      const result = await stats();
      assert.equal(result.completed, 3);
      assert.equal(result.netR, 1);
      assert.equal(await redis(["LLEN", keys.completedTrades]), 3);
    });
    await t.test("uncertain response after successful write is safe to retry", async () => {
      await reset();
      let failed = false;
      context.runRedisCommand = async command => {
        const result = await redis(command);
        if (!failed && command[0] === "EVAL" && command[2] === "3") {
          failed = true;
          throw new Error("response lost after commit");
        }
        return result;
      };
      await assert.rejects(record([signal("lost-response")]), /response lost/);
      context.runRedisCommand = redis;
      await record([signal("lost-response")]);
      assert.equal((await stats()).completed, 1);
    });
    await t.test("wrong Redis key type fails before changing IDs or aggregate", async () => {
      await reset();
      await redis(["SET", keys.completedTrades, "wrong-type"]);
      await assert.rejects(record([signal("wrong-type")]), /must be a list/);
      assert.equal(await redis(["SCARD", keys.completedTradeIds]), 0);
      assert.equal(await redis(["GET", keys.completedTradeStats]), null);
    });
    await t.test("read preserves a legacy aggregate larger than recent history", async () => {
      await reset();
      const legacy = { ...context.createEmptyPersistentTradeStats(), completed: 100,
        wins: 60, losses: 40, netR: 20 };
      const raw = JSON.stringify(legacy);
      await redis(["SET", keys.completedTradeStats, raw]);
      await redis(["LPUSH", keys.completedTrades, JSON.stringify(signal("recent"))]);
      const commands = [];
      context.runRedisCommand = async command => { commands.push(command[0]); return redis(command); };
      assert.equal((await context.readPersistentTradeData([])).stats.completed, 100);
      assert.ok(commands.every(command => ["GET", "LRANGE"].includes(command)));
      context.runRedisCommand = redis;
      assert.equal(await redis(["GET", keys.completedTradeStats]), raw);
      await record([signal("next")]);
      assert.equal((await stats()).completed, 101);
      assert.equal((await stats()).scope, undefined);
    });
    await t.test("statistics API keeps its contract and does not migrate legacy totals", async () => {
      const before = await redis(["GET", keys.completedTradeStats]);
      const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
        status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await context.handler({method:"GET",query:{mode:"statistics"}}, response);
      assert.equal(response.code, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.outcomes.completed, 101);
      assert.equal(response.body.outcomes.scope, "Legacy (unverified)");
      assert.equal(response.body.completedTradesLimit, 20);
      assert.ok(Array.isArray(response.body.history));
      assert.ok(Array.isArray(response.body.completedTrades));
      assert.equal(await redis(["GET", keys.completedTradeStats]), before);
    });
    await t.test("missing/corrupt aggregates are not silently rebuilt", async () => {
      await reset();
      await redis(["SADD", keys.completedTradeIds, "old"]);
      assert.equal((await context.readPersistentTradeData([])).stats, null);
      await assert.rejects(record([signal("new")]), /explicit recovery/);
      await redis(["SET", keys.completedTradeStats, "broken-json"]);
      await assert.rejects(record([signal("new")]));
      assert.equal(await redis(["GET", keys.completedTradeStats]), "broken-json");
      assert.equal(await redis(["SISMEMBER", keys.completedTradeIds, "new"]), 0);
    });
    await t.test("Expired, Grade A and missing R never become fabricated results", async () => {
      await reset();
      const expired = signal("expired"); expired.outcome.status = "Expired";
      await record([expired, { ...signal("grade-a"), opportunityGrade: "A" }]);
      assert.equal(await redis(["GET", keys.completedTradeStats]), null);
      const missing = signal("missing"); missing.outcome.resultR = null;
      await assert.rejects(record([missing]), /finite resultR/);
      assert.equal(await redis(["SCARD", keys.completedTradeIds]), 0);
    });
    await t.test("checkpoint does not advance when completed ledger fails", async () => {
      await reset();
      const initial = JSON.stringify({ generatedAt: "2026-09-07T11:00:00Z", readySignals: [] });
      await redis(["LPUSH", keys.history, initial]);
      await redis(["SET", keys.openTrades, "[]"]);
      const originalCreate = context.createRankingHistoryEntry;
      const originalRecord = context.recordCompletedTradeSignals;
      context.createRankingHistoryEntry = async () => ({ readySignals: [signal("checkpoint")] });
      context.recordCompletedTradeSignals = async () => { throw new Error("unavailable"); };
      assert.equal(await context.writeRankingHistory({}), false);
      assert.equal(await redis(["LINDEX", keys.history, "0"]), initial);
      assert.equal(await redis(["GET", keys.openTrades]), "[]");
      context.createRankingHistoryEntry = originalCreate;
      context.recordCompletedTradeSignals = originalRecord;
    });

    await t.test("candle lifecycle persists a win once and exposes it through statistics", async () => {
      await reset();
      const start = Date.parse("2026-09-07T10:00:00Z");
      const item = { symbol:"TESTUSDT", price:100, direction:"Long", grade:"A+",
        opportunityGrade:"A+", opportunityScore:90, confidence:90, riskReward:2,
        action:"Strong Buy", tradeAllowed:true, tradeReadiness:{ready:true},
        entryZone:{from:99,to:101}, stopLoss:90, takeProfit1:110, takeProfit2:120, takeProfit3:130 };
      const snapshot = minutes => ({ generatedAt:new Date(start+minutes*60000).toISOString(),globalRanking:[item] });
      assert.equal(await context.writeRankingHistory(snapshot(0)),true);
      const first = JSON.parse(await redis(["GET",keys.openTrades]));
      assert.equal(first[0].outcome.status,"WaitingEntry");
      const originalFetch = context.fetchOKXRecentPriceRange;
      context.fetchOKXRecentPriceRange = async () => ({source:"OKX 1m candles",data:[
        {timestamp:start,open:100,high:102,low:98,close:100,confirmed:true},
        {timestamp:start+60000,open:100,high:111,low:98,close:110,confirmed:true},
        {timestamp:start+120000,open:100,high:102,low:89,close:90,confirmed:true}
      ]});
      assert.equal(await context.writeRankingHistory(snapshot(6)),true);
      assert.equal((await stats()).wins,1);
      assert.equal((await stats()).losses,0);
      assert.equal(await redis(["GET",keys.openTrades]),"[]");
      const response={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
      await context.handler({method:"GET",query:{mode:"statistics"}},response);
      assert.equal(response.body.completedTrades[0].outcome.status,"TP1Hit");
      assert.equal(response.body.completedTrades[0].outcome.exitCheck.candle.timestamp,start+60000);
      assert.equal(response.body.outcomes.winRate,100);
      await record(response.body.completedTrades);
      assert.equal((await stats()).completed,1);
      context.fetchOKXRecentPriceRange=originalFetch;
    });

    // Run the actual CLI scripts with a test-only REST adapter to the Unix socket.
    const adapter = join(directory, "local-rest-adapter.mjs");
    await writeFile(adapter, `import { execFileSync } from 'node:child_process';
      globalThis.fetch = async (url, options) => {
        if (String(url) !== 'http://isolated-redis.test') throw Error('Unexpected network URL');
        const output = execFileSync(process.env.REDIS_CLI || 'redis-cli',
          ['-s', process.env.TEST_REDIS_SOCKET, '--json', ...JSON.parse(options.body).map(String)],
          {encoding:'utf8', maxBuffer:4194304});
        const payload = output.startsWith('error:') ? {error:output} : {result:JSON.parse(output)};
        return {ok:true,json:async()=>payload};
      };`);
    const runScript = (name, args = []) => exec(process.execPath,
      ["--import", adapter, join(root, "scripts", name), ...args], { env: {
        ...process.env, REDIS_CLI: cli, TEST_REDIS_SOCKET: socket,
        UPSTASH_REDIS_REST_URL: "http://isolated-redis.test", UPSTASH_REDIS_REST_TOKEN: "test"
      } });
    let backup;
    await t.test("v3 backup/restore preserves frozen open plans and all 35 IDs", async () => {
      await reset();
      await record(Array.from({length:35}, (_, i) => signal(`backup-${i}`)));
      const open = { ...signal("active"), outcome: { status: "Active", entryPrice: 100 } };
      await redis(["SET", keys.ranking, JSON.stringify({ generatedAt: "2026-09-07T12:00:00Z" })]);
      await redis(["LPUSH", keys.history, JSON.stringify({ readySignals: [open] })]);
      await redis(["SET", keys.openTrades, JSON.stringify([open])]);
      const path = join(directory, "backup.json");
      await runScript("backup-redis.mjs", [path]);
      backup = JSON.parse(await readFile(path, "utf8"));
      assert.equal(backup.version, 3);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      await assert.rejects(runScript("backup-redis.mjs", [path]), /EEXIST/);
      await reset();
      await runScript("restore-redis.mjs", [path, "--confirm=RESTORE"]);
      assert.deepEqual(JSON.parse(await redis(["GET", keys.openTrades])), [open]);
      assert.equal((await stats()).completed, 35);
      assert.equal(await redis(["SCARD", keys.completedTradeIds]), 35);
    });
    await t.test("v2 reconstructs open plans and replaces unrelated existing plans", async () => {
      const v2 = { ...backup, version: 2 }; delete v2.openTrades;
      await redis(["SET", keys.openTrades, '[{"tradeId":"unrelated"}]']);
      const commands = createRestoreCommands(v2);
      await redis(["EVAL", RESTORE_SCRIPT, "6", ...Object.values(keys), JSON.stringify(commands)]);
      assert.deepEqual(JSON.parse(await redis(["GET", keys.openTrades])), backup.openTrades);
      const empty = {...v2, history:[]};
      await redis(["EVAL", RESTORE_SCRIPT, "6", ...Object.values(keys), JSON.stringify(createRestoreCommands(empty))]);
      assert.deepEqual(JSON.parse(await redis(["GET", keys.openTrades])), []);
    });
    await t.test("v1 retains legacy ledger; invalid v3 and foreign keys fail validation", async () => {
      const commands = createRestoreCommands({...backup,version:1});
      assert.ok(!commands.some(command => command[1] === keys.completedTradeStats));
      assert.throws(() => createRestoreCommands({...backup, openTrades:null}), /Invalid open/);
      assert.throws(() => createRestoreCommands({...backup, keys:{...keys,history:'foreign'}}), /Unexpected/);
    });
  } finally {
    server.kill("SIGTERM");
    await new Promise(resolve => { if (server.exitCode !== null || serverError) resolve();
      else server.once("exit", resolve); });
    await rm(directory, { recursive: true, force: true });
  }
});
