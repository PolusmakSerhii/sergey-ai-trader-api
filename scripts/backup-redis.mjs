import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const OPEN_TRADES_KEY = "sergey-ai:open-trades:v1";

const RANKING_KEY = "sergey-ai:global-ranking:v1";
const HISTORY_KEY = "sergey-ai:global-ranking-history:v1";
const COMPLETED_TRADES_KEY = "sergey-ai:completed-trades:v1";
const COMPLETED_TRADE_IDS_KEY = "sergey-ai:completed-trade-ids:v1";
const COMPLETED_TRADE_STATS_KEY = "sergey-ai:completed-trade-stats:v1";

const redisUrl = String(
  process.env.UPSTASH_REDIS_REST_URL || ""
).replace(/\/$/, "");
const redisToken = String(
  process.env.UPSTASH_REDIS_REST_TOKEN || ""
);

if (!redisUrl || !redisToken) {
  throw new Error(
    "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required"
  );
}

async function redis(command) {
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.error) {
    throw new Error(
      payload?.error || `Redis command failed: ${response.status}`
    );
  }

  return payload?.result ?? null;
}

function parseJson(value, label) {
  if (typeof value !== "string" || value === "") return null;

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

const safeTimestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-");
const outputPath = resolve(
  process.argv[2] ||
    `backups/sergey-ai-redis-${safeTimestamp}.json`
);

const [
  rankingRaw,
  historyRaw,
  completedTradesRaw,
  completedTradeIds,
  completedTradeStatsRaw,
  openTradesRaw
] = await redis([
  "EVAL", `return {
    redis.call("GET", KEYS[1]) or "",
    redis.call("LRANGE", KEYS[2], 0, -1),
    redis.call("LRANGE", KEYS[3], 0, -1),
    redis.call("SMEMBERS", KEYS[4]),
    redis.call("GET", KEYS[5]) or "",
    redis.call("GET", KEYS[6]) or ""
  }`, "6", RANKING_KEY, HISTORY_KEY, COMPLETED_TRADES_KEY,
  COMPLETED_TRADE_IDS_KEY, COMPLETED_TRADE_STATS_KEY, OPEN_TRADES_KEY
]);
const history = Array.isArray(historyRaw)
  ? historyRaw.map((item, index) =>
      parseJson(item, `History item ${index}`)
    )
  : [];

const backup = {
  format: "sergey-ai-redis-backup",
  version: 3,
  exportedAt: new Date().toISOString(),
  keys: {
    ranking: RANKING_KEY,
    history: HISTORY_KEY,
    completedTrades: COMPLETED_TRADES_KEY,
    completedTradeIds: COMPLETED_TRADE_IDS_KEY,
    completedTradeStats: COMPLETED_TRADE_STATS_KEY,
    openTrades: OPEN_TRADES_KEY
  },
  openTrades: parseJson(openTradesRaw, "Open trades") ??
    (history[0]?.readySignals || []).filter(signal =>
      ["Pending", "WaitingEntry", "Active"].includes(signal?.outcome?.status)
    ),
  ranking: parseJson(rankingRaw, "Ranking"),
  history,
  completedTrades: Array.isArray(completedTradesRaw)
    ? completedTradesRaw.map((item, index) =>
        parseJson(item, `Completed trade ${index}`)
      )
    : [],
  completedTradeIds: Array.isArray(completedTradeIds)
    ? completedTradeIds
    : [],
  completedTradeStats: parseJson(
    completedTradeStatsRaw,
    "Completed trade stats"
  )
};

if (!Array.isArray(backup.openTrades)) throw new Error("Invalid open trades");

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(backup, null, 2)}\n`,
  { mode: 0o600, flag: "wx" }
);

console.log(`Backup written: ${outputPath}`);
console.log(`History entries: ${history.length}`);
console.log(`Completed trades: ${backup.completedTradeIds.length}`);
