import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const RANKING_KEY = "sergey-ai:global-ranking:v1";
const HISTORY_KEY = "sergey-ai:global-ranking-history:v1";

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
  if (typeof value !== "string") return null;

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

const [rankingRaw, historyRaw] = await Promise.all([
  redis(["GET", RANKING_KEY]),
  redis(["LRANGE", HISTORY_KEY, "0", "-1"])
]);

const history = Array.isArray(historyRaw)
  ? historyRaw.map((item, index) =>
      parseJson(item, `History item ${index}`)
    )
  : [];

const backup = {
  format: "sergey-ai-redis-backup",
  version: 1,
  exportedAt: new Date().toISOString(),
  keys: {
    ranking: RANKING_KEY,
    history: HISTORY_KEY
  },
  ranking: parseJson(rankingRaw, "Ranking"),
  history
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(backup, null, 2)}\n`,
  { mode: 0o600 }
);

console.log(`Backup written: ${outputPath}`);
console.log(`History entries: ${history.length}`);
